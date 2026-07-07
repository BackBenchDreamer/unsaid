-- ============================================================
-- Migration 007 — Memory Tables (Milestone 3: Memory Before Intelligence)
-- ============================================================
-- Adds the four memory foundation tables:
--   life_chapters      — meaningful episodes recognized across entries
--   chapter_entries    — join table linking entries to chapters
--   context_memory     — recurring entities (people, places, topics, etc.)
--   memory_extractions — idempotency guard for extract-memory Edge Function
--
-- Run after: 006_weekly_summary_index.sql
-- Run before: any Milestone 4 migrations
-- ============================================================

-- ─── life_chapters ─────────────────────────────────────────
-- A life chapter is a meaningful collection of related journal entries
-- representing a distinct episode (e.g. "IBM Internship", "Thailand Trip").
-- Chapters are discovered automatically by the extract-memory Edge Function
-- and are never created directly by users or the client.
--
-- status lifecycle: forming → active → dormant
--   forming:  candidate detected, not yet structurally stable
--   active:   structurally stable, LLM-named, ready for future UX display
--   dormant:  no new entries for CHAPTER_DORMANCY_DAYS (60); chapter has ended
--
-- entry_count and last_change_at are maintained by extract-memory to avoid
-- expensive COUNT(*) queries during every promotion stability check.
--
-- signals stores the JSONB audit of which signals fired during candidate
-- scoring (entity_overlap, theme_overlap, entry_count). Unused by UI in M3.
CREATE TABLE IF NOT EXISTS public.life_chapters (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name            TEXT,                    -- LLM-generated; NULL until promoted to active
  summary         TEXT,                    -- LLM-generated 1–2 sentence summary; NULL until promoted
  chapter_start   DATE NOT NULL,           -- entry_date of the first linked entry
  chapter_end     DATE,                    -- set when status becomes dormant
  status          TEXT NOT NULL DEFAULT 'forming'
                  CHECK (status IN ('forming', 'active', 'dormant')),
  theme_tags      TEXT[] NOT NULL DEFAULT '{}',   -- deduplicated themes across all linked entries
  entry_count     INT NOT NULL DEFAULT 0,          -- count of linked entries; maintained by extract-memory
  last_change_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- updated on every new entry join
  signals         JSONB,                   -- audit: which signals fired during candidate scoring
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_life_chapters_user
  ON public.life_chapters(user_id, status);

CREATE TRIGGER trg_life_chapters_updated_at
  BEFORE UPDATE ON public.life_chapters
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─── chapter_entries ───────────────────────────────────────
-- Join table: many-to-many between life_chapters and entries.
-- An entry may belong to at most one chapter (enforced by application logic,
-- not by a DB constraint, to allow future chapter-merge operations in M4).
-- The UNIQUE constraint prevents duplicate linkage.
CREATE TABLE IF NOT EXISTS public.chapter_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chapter_id  UUID NOT NULL REFERENCES public.life_chapters(id) ON DELETE CASCADE,
  entry_id    UUID NOT NULL REFERENCES public.entries(id) ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_chapter_entry UNIQUE (chapter_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_chapter_entries_chapter
  ON public.chapter_entries(chapter_id);

CREATE INDEX IF NOT EXISTS idx_chapter_entries_entry
  ON public.chapter_entries(entry_id);

-- ─── context_memory ────────────────────────────────────────
-- Recurring entities extracted from reflected journal entries.
-- Used to enrich future reflection prompts with a compact, relevant
-- context block (≤ 500 tokens) — avoiding the need to send full entry history.
--
-- entity_type: 'person' | 'place' | 'project' | 'organization' | 'topic'
--   topics     come from ReflectionPayload.themes (always extracted)
--   others     come from Groq entity extraction (only when Groq is configured)
--
-- mention_count is incremented on each appearance (never reset).
-- emotional_tags accumulates emotions co-occurring with this entity.
--
-- importance_score is NULL in M3 and reserved for future retrieval ranking.
-- When populated (M4+), it will allow retrieval to prefer meaningful memories
-- over merely frequent ones, without requiring another schema migration.
CREATE TABLE IF NOT EXISTS public.context_memory (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL
                   CHECK (entity_type IN ('person', 'place', 'project', 'organization', 'topic')),
  entity_value     TEXT NOT NULL,          -- lowercase normalized entity name
  mention_count    INT NOT NULL DEFAULT 1, -- incremented on each new appearance
  last_seen_date   DATE NOT NULL,          -- entry_date of the most recent mention
  emotional_tags   TEXT[] NOT NULL DEFAULT '{}', -- emotions co-occurring with this entity
  importance_score NUMERIC,               -- reserved for future retrieval ranking; NULL in M3
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotent upsert key: one row per (user, type, value).
  CONSTRAINT uq_context_memory_entity UNIQUE (user_id, entity_type, entity_value)
);

CREATE INDEX IF NOT EXISTS idx_context_memory_user
  ON public.context_memory(user_id, entity_type);

CREATE TRIGGER trg_context_memory_updated_at
  BEFORE UPDATE ON public.context_memory
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─── memory_extractions ────────────────────────────────────
-- Idempotency guard for the extract-memory Edge Function.
-- One row is written as the FINAL step of a successful extraction.
-- If the row is absent for a given (user_id, entry_id), the extraction
-- has not completed and will be retried on the next call.
--
-- Deleting a row forces re-extraction for that entry (e.g. after a
-- prompt version bump or a schema change to context_memory).
--
-- prompt_version records the AI_CONFIG.promptVersion from the
-- ReflectionPayload._meta.version at extraction time — not a hardcoded
-- constant. This allows future migrations to identify which extractions
-- were produced under which prompt version.
--
-- This table has no updated_at — rows are immutable once written.
CREATE TABLE IF NOT EXISTS public.memory_extractions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_id       UUID NOT NULL REFERENCES public.entries(id) ON DELETE CASCADE,
  extracted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_version TEXT NOT NULL,

  -- Ensures each entry is extracted at most once per user.
  -- Delete this row to force re-extraction.
  CONSTRAINT uq_memory_extraction UNIQUE (user_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_extractions_user
  ON public.memory_extractions(user_id);

-- ─── RLS enablement ────────────────────────────────────────
ALTER TABLE public.life_chapters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_extractions ENABLE ROW LEVEL SECURITY;

-- ─── RLS policies ──────────────────────────────────────────
-- All four tables follow the same pattern as `insights`:
--   - Users can SELECT their own rows (approved users only)
--   - No INSERT/UPDATE/DELETE policies = only service_role (Edge Functions) can write

DROP POLICY IF EXISTS "Approved users can read own life chapters" ON public.life_chapters;
CREATE POLICY "Approved users can read own life chapters"
  ON public.life_chapters FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can read own chapter entries" ON public.chapter_entries;
CREATE POLICY "Approved users can read own chapter entries"
  ON public.chapter_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.life_chapters lc
      WHERE lc.id = chapter_entries.chapter_id
        AND lc.user_id = auth.uid()
        AND public.auth_status() = 'approved'
    )
  );

DROP POLICY IF EXISTS "Approved users can read own context memory" ON public.context_memory;
CREATE POLICY "Approved users can read own context memory"
  ON public.context_memory FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can read own memory extractions" ON public.memory_extractions;
CREATE POLICY "Approved users can read own memory extractions"
  ON public.memory_extractions FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );
