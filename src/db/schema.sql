-- ============================================================
-- UnSaid — Supabase Schema
-- ============================================================
-- Run this against a fresh Supabase project (or as a migration).
-- After running this file, run rls.sql, then user_settings.sql,
-- then user_settings_rls.sql (in that order).
-- ============================================================

-- ─── Enable required extensions ────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Profiles ──────────────────────────────────────────────
-- Mirrors auth.users, extended with app-specific fields.
-- Provisioned on first verified sign-in (email_confirmed_at trigger),
-- never on OTP request, to avoid phantom rows from typo emails.
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  display_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user'
              CHECK (role IN ('user', 'admin')),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_role   ON public.profiles(role);

-- ─── Journal Entries ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  mood        TEXT CHECK (mood IN ('terrible', 'bad', 'meh', 'good', 'great')),
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- INVARIANT: one entry per user per calendar day.
  CONSTRAINT uq_user_entry_date UNIQUE (user_id, entry_date)
);

-- Indexes for dashboard, heatmap, history views.
CREATE INDEX IF NOT EXISTS idx_entries_user_date  ON public.entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_mood   ON public.entries(user_id, mood);
CREATE INDEX IF NOT EXISTS idx_entries_date        ON public.entries(entry_date);

-- ─── Waitlist ──────────────────────────────────────────────
-- Tracks invite requests before they become profiles.
CREATE TABLE IF NOT EXISTS public.waitlist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT NOT NULL UNIQUE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES public.profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_waitlist_status ON public.waitlist(status);

-- ─── Insights (AI reflection cache) ────────────────────────
-- One row per (user_id, entry_id, type) — enforced by uq_insight_entry_type.
-- payload stores the full result + _meta: { promptVersion, model, generatedAt, generationMs }
-- source_hash is SHA-256 of sourceEnvelope(content, promptVersion, model);
--   NULL on legacy rows (treated as always-stale until re-reflected).
--
-- FUTURE VERSIONING NOTE: to support multiple reflections per entry, you must:
--   1. DROP CONSTRAINT uq_insight_entry_type
--   2. ADD COLUMN reflected_at TIMESTAMPTZ DEFAULT now() (or version INT)
--   3. Change Edge Function upserts to inserts
--   4. Update dashboard queries to aggregate latest per (entry_id, type)
-- This is a schema migration, not an app-only change.
CREATE TABLE IF NOT EXISTS public.insights (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_id     UUID REFERENCES public.entries(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  source_hash  TEXT,           -- SHA-256 of sourceEnvelope(content, promptVersion, model)
  period_start DATE,           -- Weekly/monthly summary window start (Milestone 2+); NULL for entry insights
  period_end   DATE,           -- Weekly/monthly summary window end (Milestone 2+); NULL for entry insights
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),  -- set explicitly on every upsert

  -- Named constraint so it can be dropped/replaced without querying pg_constraint.
  CONSTRAINT insights_type_check CHECK (type IN ('sentiment', 'summary', 'pattern', 'reflection')),

  -- Enables idempotent upsert ON CONFLICT (user_id, entry_id, type).
  -- Drop before implementing reflection versioning (see note above).
  -- NOTE: This constraint does NOT enforce uniqueness when entry_id IS NULL
  -- (Postgres treats NULLs as distinct). Weekly/monthly summary rows (entry_id IS NULL)
  -- require a separate partial unique index — see migration 003 for the index definition.
  CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type)
);

CREATE INDEX IF NOT EXISTS idx_insights_user ON public.insights(user_id, type);

-- ─── Auto-update updated_at trigger ────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entries_updated_at
  BEFORE UPDATE ON public.entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─── Profile provisioning — first verified sign-in only ────
--
-- The trigger fires on UPDATE (not INSERT) of auth.users, guarded by the
-- email_confirmed_at transition NULL → non-null.  This ensures profiles are
-- created only after the user clicks their magic link, never on the bare
-- OTP request.  Both inserts use ON CONFLICT DO NOTHING so the function is
-- fully idempotent (safe to replay on subsequent sign-ins or retries).
--
-- Drop the old INSERT trigger if it exists from a previous schema version.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Guard: only run when email_confirmed_at transitions NULL → set.
  -- This fires exactly once per user (on their first verified sign-in).
  IF (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL) THEN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Idempotent trigger creation: drop-and-recreate is the cleanest pattern
-- for UPDATE triggers (IF NOT EXISTS only works for CREATE TRIGGER on PG 14+
-- and is not yet available in all Supabase runtime versions).
DROP TRIGGER IF EXISTS on_auth_user_verified ON auth.users;

CREATE TRIGGER on_auth_user_verified
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ─── RPC: ensure_profile ────────────────────────────────────
--
-- Application-level resilience fallback.  Called by the client after every
-- successful sign-in to guarantee the profile and user_settings rows exist,
-- even if the trigger was somehow missed (e.g. during a Supabase maintenance
-- window, or for users who signed up before this migration was applied).
--
-- The function uses SECURITY DEFINER so it can write to both tables without
-- requiring the calling user to have INSERT rights (which RLS forbids).
-- It is intentionally a no-op when the rows already exist.

CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS void AS $$
DECLARE
  v_user_id   UUID;
  v_email     TEXT;
BEGIN
  -- Resolve the calling user from the JWT; aborts if not authenticated.
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Look up the email from auth.users (requires SECURITY DEFINER).
  SELECT email INTO v_email
  FROM auth.users
  WHERE id = v_user_id;

  -- Upsert profile — no-op if it already exists.
  INSERT INTO public.profiles (id, email)
  VALUES (v_user_id, v_email)
  ON CONFLICT (id) DO NOTHING;

  -- Upsert user_settings — no-op if it already exists.
  INSERT INTO public.user_settings (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── RPC: Heatmap data ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_heatmap(
  p_user_id UUID,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TABLE(date DATE, has_entry BOOLEAN, mood TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d::DATE AS date,
    EXISTS(
      SELECT 1 FROM public.entries e
      WHERE e.user_id = p_user_id
        AND e.entry_date = d::DATE
    ) AS has_entry,
    (
      SELECT e.mood FROM public.entries e
      WHERE e.user_id = p_user_id
        AND e.entry_date = d::DATE
      LIMIT 1
    ) AS mood
  FROM generate_series(p_start_date, p_end_date, '1 day'::INTERVAL) d;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── RPC: Memories ("on this day") ────────────────────────
CREATE OR REPLACE FUNCTION public.get_memories(
  p_user_id UUID,
  p_today DATE
)
RETURNS TABLE(id UUID, entry_date DATE, snippet TEXT, mood TEXT, days_ago INT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.entry_date,
    LEFT(e.content, 200) AS snippet,
    e.mood,
    (p_today - e.entry_date)::INT AS days_ago
  FROM public.entries e
  WHERE e.user_id = p_user_id
    AND EXTRACT(MONTH FROM e.entry_date) = EXTRACT(MONTH FROM p_today)
    AND EXTRACT(DAY FROM e.entry_date) = EXTRACT(DAY FROM p_today)
    AND e.entry_date < p_today
  ORDER BY e.entry_date DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
