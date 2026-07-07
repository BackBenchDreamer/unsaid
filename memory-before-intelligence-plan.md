# Milestone 3 — Memory Before Intelligence

## Top-Level Overview

This milestone builds the **memory foundation** that every future intelligence feature depends on. It does not add visible AI features for users. It establishes two durable data structures — **Context Memory** and **Life Chapters** — and the extraction pipeline that populates them silently from existing reflection data.

**Goal:** After every reflection, the system quietly asks: "Is there something here worth remembering?" If yes, it stores it. It does not tell the user. It does not surface it yet. It simply remembers.

**Scope:**
- Two new database tables: `life_chapters` + `context_memory` (with supporting join table `chapter_entries`)
- A chapter candidate staging mechanism (column on `life_chapters` with `status = 'forming'`)
- A new Edge Function `extract-memory` that runs after `generate-reflection` completes
- Updated `generate-reflection` to inject relevant context memory into prompts (the efficiency gain)
- No new visible UI in this milestone — the existing Insights dashboard is unchanged
- A new `src/features/memory/` feature module with service + hooks (foundation for M4 UX)

**Non-goals for this milestone:**
- Memory browsing UI (M4)
- Chapter merge/split logic (M4)
- User-facing chapter naming (M4)
- Weekly/monthly summaries using memory (M5)
- Any notification or badge for memory creation

**Philosophy constraints hard-coded into implementation:**
- Memory is conservative: minimum 3 distinct entries sharing a theme before a chapter candidate is promoted
- Memory is quiet: no user-facing effect in this milestone
- Memory reduces cost: `generate-reflection` prompt shrinks when context memory exists
- LLMs propose, rules commit: chapter promotion is gated by structural thresholds, not LLM confidence alone

---

## Architecture

### New Database Tables

```
life_chapters
  id               UUID PK
  user_id          UUID FK → profiles
  name             TEXT           -- LLM-generated, e.g. "IBM Internship"
  summary          TEXT           -- LLM-generated 1–2 sentence summary
  chapter_start    DATE           -- entry_date of first linked entry
  chapter_end      DATE nullable  -- null until dormant/complete
  status           TEXT           -- 'forming' | 'active' | 'dormant'
  theme_tags       TEXT[]         -- deduplicated themes across all entries
  entry_count      INT NOT NULL DEFAULT 0  -- maintained by extract-memory; used in stability check
  last_change_at   TIMESTAMPTZ    -- updated whenever a new entry joins; used in stability check
  signals          JSONB nullable -- debug/audit: which signals fired during candidate scoring
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

chapter_entries
  id               UUID PK
  chapter_id       UUID FK → life_chapters
  entry_id         UUID FK → entries
  joined_at        TIMESTAMPTZ

context_memory
  id               UUID PK
  user_id          UUID FK → profiles
  entity_type      TEXT           -- 'person' | 'place' | 'project' | 'organization' | 'topic'
  entity_value     TEXT           -- the extracted value, lowercase normalized
  mention_count    INT            -- incremented on each new appearance
  last_seen_date   DATE           -- entry_date of most recent mention
  emotional_tags   TEXT[]         -- emotions co-occurring with this entity
  importance_score NUMERIC nullable  -- reserved for future retrieval ranking; unused in M3
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  UNIQUE (user_id, entity_type, entity_value)

-- Append-only processing guard: tracks which entries have been processed by extract-memory.
-- Prevents re-processing the same entry on retry or backfill.
-- Deleting a row forces re-extraction for that entry (useful after prompt version bumps).
memory_extractions
  id               UUID PK
  user_id          UUID FK → profiles
  entry_id         UUID FK → entries  UNIQUE  -- one extraction record per entry, ever
  extracted_at     TIMESTAMPTZ
  prompt_version   TEXT                       -- AI_CONFIG.promptVersion at time of extraction
```

**Append-only invariant:** `extract-memory` always checks `memory_extractions` first. If a record exists for `(user_id, entry_id)`, the function exits early. This means:
- Retrying a failed extraction is safe (insert of `memory_extractions` row is the final step)
- Backfilling historical reflections is safe (pass `{ backfill: true }` to process all entries lacking a row)
- Forced re-processing after a prompt version bump: delete the relevant `memory_extractions` rows

### Edge Function Pipeline

```
User clicks Reflect
  → generate-reflection Edge Function (existing)
      → calls HuggingFace + Groq
      → saves ReflectionPayload to insights table
      → [NEW] fires extract-memory Edge Function asynchronously (non-blocking)
  → returns reflection to client immediately

extract-memory Edge Function (new, async)
  → reads saved ReflectionPayload for entry
  → reads entry content
  → Step 1: extract entities → upsert context_memory (increment counts)
      → source: ReflectionPayload.themes → entity_type='topic' (always)
      → source: Groq entity extraction if configured → entity_type='person'|'place'|'project'|'organization'
      → if Groq not configured: topics only; no fallback heuristic
  → Step 2: score chapter candidates (multi-signal)
      → signals evaluated:
          (a) recurring entities: entries sharing ≥1 context_memory entity with this entry
          (b) temporal proximity: entries within CHAPTER_CANDIDATE_WINDOW_DAYS=90 days
          (c) theme overlap: entries sharing ≥1 theme with this entry
          (d) semantic similarity: cosine similarity of ReflectionPayload.summary embeddings (if available; deferred to M4 if not)
      → candidate cluster: entry_ids satisfying ≥2 of signals (a)(b)(c), within temporal window
      → if cluster size ≥ CHAPTER_MIN_ENTRIES:
          → record fired signals in candidate for audit
          → check if a 'forming' or 'active' chapter already covers these entries
          → if no chapter: create life_chapter (status='forming'), link entries, set entry_count, last_change_at
          → if forming chapter: link new entry, increment entry_count, update last_change_at
              → run structural stability check (see below)
          → if active chapter: link new entry, increment entry_count, update theme_tags, last_change_at
  → Step 3: dormancy sweep
      → mark chapters 'dormant' if last linked entry > CHAPTER_DORMANCY_DAYS=60 days ago

Structural stability check (forming → active promotion):
  ALL of the following must be true:
  1. entry_count >= CHAPTER_MIN_ENTRIES (sufficient evidence)
  2. (now - last_change_at) >= CHAPTER_STABILITY_DAYS=7 (no new entries recently; chapter is settling)
  3. No conflicting theme drift: theme_tags have not changed by more than 50% since chapter was created
  Only then: call Groq to generate name+summary, set status='active'
```

### Updated generate-reflection Prompt Injection

When `generate-reflection` is called:
1. Extract current entry's themes and entity values (from the just-completed HuggingFace step)
2. Query `context_memory` for user: entities with `mention_count ≥ 3`; **score each by relevance** to current entry (overlap between entity_value/emotional_tags and current themes) — not simply recency or frequency; take top-scoring entities up to token budget
3. Query `life_chapters` for user: chapters with `status = 'active'`; score each by recency of linked entries AND theme overlap with current entry; take top 1
4. Build context block (≤ `CONTEXT_MEMORY_MAX_TOKENS` = 500 tokens): relevant entities + active chapter name/summary if any
5. Inject into Groq system prompt as a named section: `"Context about this person:"` — only if non-empty
6. If context is empty or Groq not configured: function behaves exactly as before (zero regression)
7. The retrieval strategy (relevance scoring) is an extension point: the query and scoring logic lives in an isolated `getRelevantContext()` helper that can be upgraded in future milestones without touching the prompt construction

---

## Sub-Tasks

---

### Sub-Task 1 — Git Branch Setup

**Status:** [ ] pending

**Intent:**
Create the feature branch for all Milestone 3 work. All commits stay isolated until milestone review.

**Expected Outcomes:**
- Branch `feature/memory-before-intelligence` exists and is checked out
- No files changed from `main`

**Todo List:**
1. Create and checkout branch: `git checkout -b feature/memory-before-intelligence`
2. Verify clean status: `git status`
3. Push tracking branch: `git push -u origin feature/memory-before-intelligence`

**Relevant Context:**
- Same git workflow as M1 (`feature/foundation-of-reflection`) and M2 (`feature/patterns-over-time`)

---

### Sub-Task 2 — Database Migration: Memory Tables

**Status:** [ ] pending

**Intent:**
Add `life_chapters`, `chapter_entries`, `context_memory`, and `memory_extractions` tables to the schema. Add RLS policies. The schema must be consistent with the existing patterns in [`src/db/schema.sql`](src/db/schema.sql) and [`src/db/rls.sql`](src/db/rls.sql).

**Expected Outcomes:**
- `src/db/schema.sql` includes all four new tables with correct FK constraints, indexes, and triggers
- `src/db/rls.sql` includes RLS policies for all four new tables
- A migration file `src/db/migrations/005_memory_tables.sql` contains the forward-only migration SQL
- All new tables follow the existing pattern: UUID PKs, `created_at`/`updated_at` with trigger, user-scoped RLS
- `memory_extractions` has a `UNIQUE (user_id, entry_id)` constraint as the idempotency guard

**Todo List:**
1. Write migration SQL in `src/db/migrations/005_memory_tables.sql`:
   - `life_chapters` table: all columns including `entry_count INT NOT NULL DEFAULT 0`, `last_change_at TIMESTAMPTZ`, `signals JSONB nullable`; `updated_at` trigger
   - `chapter_entries` join table with `UNIQUE (chapter_id, entry_id)`
   - `context_memory` table: all columns including `importance_score NUMERIC nullable` (unused in M3, reserved for future ranking); `UNIQUE (user_id, entity_type, entity_value)`, `updated_at` trigger; add SQL comment: `-- importance_score: reserved for future retrieval ranking; not populated in M3`
   - `memory_extractions` table with `UNIQUE (user_id, entry_id)`, no `updated_at` (immutable record)
   - Indexes: `idx_life_chapters_user` on `(user_id, status)`, `idx_context_memory_user` on `(user_id, entity_type)`, `idx_chapter_entries_chapter` on `(chapter_id)`, `idx_chapter_entries_entry` on `(entry_id)`, `idx_memory_extractions_user` on `(user_id)`
2. Add all new tables and triggers to `src/db/schema.sql` (sync with migration)
3. Add RLS policies to `src/db/rls.sql`:
   - `life_chapters`: SELECT for own approved user; INSERT/UPDATE/DELETE blocked (service_role only, same as insights)
   - `chapter_entries`: SELECT for own approved user; INSERT/DELETE blocked (service_role only)
   - `context_memory`: SELECT for own approved user; INSERT/UPDATE/DELETE blocked (service_role only)
   - `memory_extractions`: SELECT for own approved user; INSERT/DELETE blocked (service_role only)
4. No UI or service changes in this sub-task

**Relevant Context:**
- [`src/db/schema.sql`](src/db/schema.sql) — follow exact patterns for triggers and constraints
- [`src/db/rls.sql`](src/db/rls.sql) — `auth_status()` helper used in all entry-level policies; replicate for new tables
- RLS pattern for service_role-only writes: no INSERT policy = only service_role can write (same as `insights`)

---

### Sub-Task 3 — Entity Types: Memory Domain

**Status:** [ ] pending

**Intent:**
Define the TypeScript domain types for Life Chapters and Context Memory. These follow the same entity pattern as [`src/entities/entry.ts`](src/entities/entry.ts) and [`src/entities/insight.ts`](src/entities/insight.ts): row types, domain types, mappers, and type guards co-located.

**Expected Outcomes:**
- `src/entities/memory.ts` exists with all types, mappers, and constants
- `src/entities/index.ts` exports the new types
- Zero references to DB column names outside the mapper functions

**Todo List:**
1. Create `src/entities/memory.ts` with:
   - `ChapterStatus` type: `'forming' | 'active' | 'dormant'`
   - `ContextEntityType` type: `'person' | 'place' | 'project' | 'organization' | 'topic'`
   - `LifeChapterRow` (DB row shape — snake_case; includes `entry_count`, `last_change_at`, `signals`)
   - `LifeChapter` (domain type — camelCase; includes `entryCount: number`, `lastChangeAt: string`, `signals: Record<string, unknown> | null`)
   - `ChapterEntryRow` (DB row shape)
   - `ChapterEntry` (domain type)
   - `ContextMemoryRow` (DB row shape — includes `importance_score: number | null`)
   - `ContextMemory` (domain type — includes `importanceScore: number | null`)
   - `MemoryExtractionRow` (DB row shape — includes `prompt_version TEXT`)
   - `MemoryExtraction` (domain type — includes `promptVersion: string`)
   - `lifeChapterFromRow(row: LifeChapterRow): LifeChapter` mapper
   - `contextMemoryFromRow(row: ContextMemoryRow): ContextMemory` mapper
   - `memoryExtractionFromRow(row: MemoryExtractionRow): MemoryExtraction` mapper
   - Constants: `CHAPTER_MIN_ENTRIES = 3`, `CHAPTER_DORMANCY_DAYS = 60`, `CHAPTER_CANDIDATE_WINDOW_DAYS = 90`, `CHAPTER_STABILITY_DAYS = 7`, `CONTEXT_MEMORY_MIN_MENTIONS = 3`, `CONTEXT_MEMORY_MAX_TOKENS = 500`
2. Add barrel exports to `src/entities/index.ts`
3. Note: the `ReflectionPayload._meta.version` field (from `InsightMeta`) already stores the prompt version at generation time — this is the existing pattern the new `MemoryExtraction.promptVersion` mirrors for the extraction pipeline
4. Note: `importanceScore` is `null` for all rows written in M3 — it is a reserved field for future retrieval ranking (M4+). The type must accommodate `null` cleanly.

**Relevant Context:**
- [`src/entities/entry.ts`](src/entities/entry.ts) — exact pattern to follow for row/domain/mapper
- [`src/entities/insight.ts`](src/entities/insight.ts) — constants pattern (`AI_CONFIG`, `WEEKLY_PROMPT_VERSION`)
- `verbatimModuleSyntax` is on — use `import type` for type-only imports

---

### Sub-Task 4 — Memory Service Layer

**Status:** [ ] pending

**Intent:**
Create `src/services/memoryService.ts` with read-only queries for both `life_chapters` and `context_memory`. Write operations only happen via Edge Functions (service_role). The service follows the same pattern as [`src/services/insightsService.ts`](src/services/insightsService.ts).

**Expected Outcomes:**
- `src/services/memoryService.ts` exists with typed query functions
- All functions map through entity mappers before returning
- All errors extend `ServiceError` using `unwrap()`
- `src/services/index.ts` exports `memoryService`

**Todo List:**
1. Create `src/services/memoryService.ts` with:
   - `getLifeChapters(userId, status?: ChapterStatus): Promise<LifeChapter[]>` — query `life_chapters`, optionally filter by status, order by `chapter_start DESC`
   - `getChapterEntries(chapterId: string): Promise<ChapterEntry[]>` — query `chapter_entries` for a chapter, order by `joined_at ASC`
   - `getContextMemory(userId, entityType?: ContextEntityType): Promise<ContextMemory[]>` — query `context_memory`, filter by minimum `mention_count >= CONTEXT_MEMORY_MIN_MENTIONS`, order by `last_seen_date DESC`
   - `getActiveChapterSummaries(userId): Promise<ContextBlock>` — convenience method that fetches active chapters and top context memory, formats them into a `ContextBlock` object for use in prompt injection (≤ `CONTEXT_MEMORY_MAX_TOKENS` tokens estimated)
2. Define `ContextBlock` type in `src/entities/memory.ts`: `{ contextText: string; chapterCount: number; entityCount: number; tokenEstimate: number }`
3. Export from `src/services/index.ts`

**Relevant Context:**
- [`src/services/insightsService.ts`](src/services/insightsService.ts) — error handling with `unwrap()`, result type patterns
- [`src/services/errors.ts`](src/services/errors.ts) — `ServiceError`, `unwrap()`
- [`src/entities/memory.ts`](src/entities/memory.ts) — mappers created in Sub-Task 3

---

### Sub-Task 5 — `extract-memory` Edge Function

**Status:** [ ] pending

**Intent:**
Create the `supabase/functions/extract-memory/` Edge Function. This is the heart of Milestone 3. It runs after a reflection is saved, extracts entities and themes from the `ReflectionPayload`, updates `context_memory`, and manages chapter candidate lifecycle. It runs asynchronously — the client never waits for it.

**Expected Outcomes:**
- `supabase/functions/extract-memory/index.ts` exists and handles the full extraction pipeline
- Function accepts `{ entryId, userId }` in the request body
- Reads the saved `ReflectionPayload` from `insights` table for the given `entryId`
- Upserts `context_memory` rows for all extracted entities (people, places, themes)
- Scores chapter candidates and manages `life_chapters` lifecycle (forming → active)
- Marks chapters dormant when stale
- Uses service_role key for all writes
- Errors are logged server-side; no error propagates to client

**Todo List:**
1. Create `supabase/functions/extract-memory/index.ts`:
   - Parse `{ entryId, userId, backfill?: boolean }` from request body
   - **Idempotency guard (before any work):**
     - If `backfill` is false (default): query `memory_extractions` for `(user_id, entry_id)` — if row exists, return `{ ok: true, skipped: true }` immediately
     - If `backfill` is true: process all entries for the user that have a `reflection` insight but NO row in `memory_extractions`; loop and call the single-entry pipeline for each
   - Fetch `ReflectionPayload` from `insights` WHERE `entry_id = entryId AND type = 'reflection'`
   - Fetch the entry itself (for `entry_date` and `content`)
   - **Entity extraction (Step 1) — structured sources only:**
     - Always: extract `themes` from `ReflectionPayload.themes` → upsert into `context_memory` with `entity_type = 'topic'`
     - If Groq is configured: call a lightweight Groq extraction prompt asking for people, places, organizations, and projects mentioned in the entry content → upsert each into `context_memory` with the appropriate `entity_type`
     - If Groq is not configured: extract topics only; do not use regex or heuristics as fallback
     - For each entity: `INSERT INTO context_memory (user_id, entity_type, entity_value, mention_count, last_seen_date, emotional_tags, importance_score) VALUES (...) ON CONFLICT (user_id, entity_type, entity_value) DO UPDATE SET mention_count = mention_count + 1, last_seen_date = GREATEST(excluded.last_seen_date, context_memory.last_seen_date), emotional_tags = ..., updated_at = NOW()` — `importance_score` is always NULL in M3
   - **Chapter candidate scoring (Step 2) — multi-signal:**
     - Collect signal data for this entry from `context_memory` (entities), `entry_date` (temporal), `ReflectionPayload.themes` (themes)
     - Query recent `insights` for this user: `type = 'reflection'` within `CHAPTER_CANDIDATE_WINDOW_DAYS = 90` days; build a map of `entry_id → { themes, entity_values, entry_date }`
     - For each recent entry, compute signal overlap with the current entry:
       - Signal (a) entity overlap: shares ≥1 `context_memory` entity (person/place/project/org — topics excluded from this signal)
       - Signal (b) temporal proximity: entry_date within the 90-day window (always true for this query; used to exclude outliers)
       - Signal (c) theme overlap: shares ≥1 theme from `ReflectionPayload.themes`
     - A candidate entry passes if it satisfies ≥2 of signals (a) and (c) — temporal (b) is a prerequisite filter, not a signal
     - Build candidate cluster: all passing entry_ids plus the current entry
     - If cluster size < `CHAPTER_MIN_ENTRIES`: no chapter action for this entry
     - If cluster size ≥ `CHAPTER_MIN_ENTRIES`:
       - Record fired signals in a `signals` JSONB object: `{ "entity_overlap": [...], "theme_overlap": [...], "entry_count": N }`
       - Check if any `forming` or `active` chapter already covers a majority (>50%) of these entry IDs (via `chapter_entries` join)
       - If no existing chapter: create `life_chapters` row (status='forming', entry_count=cluster size, last_change_at=now, signals=signals JSONB); insert `chapter_entries` rows for all cluster entries
       - If existing `forming` chapter: insert new `chapter_entry` if not already linked; increment `entry_count`; update `last_change_at`, `theme_tags`, `signals`; run **structural stability check**
       - If existing `active` chapter: insert new `chapter_entry` if not already linked; increment `entry_count`; update `theme_tags`, `last_change_at`
   - **Structural stability check (forming → active promotion):**
     - Condition 1: `entry_count >= CHAPTER_MIN_ENTRIES` ✓ (already passed)
     - Condition 2: `(now - last_change_at) >= CHAPTER_STABILITY_DAYS` (chapter has been quiet for ≥ 7 days)
     - Condition 3: theme drift check — `theme_tags` overlap with initial `theme_tags` at creation ≥ 50% (chapter identity has not shifted)
     - If ALL three conditions pass AND Groq is configured: call Groq to generate `name` and `summary`; set `status = 'active'`
     - If ALL three conditions pass AND Groq is NOT configured: set `status = 'active'` with placeholder `name = NULL`, `summary = NULL`; name/summary will be generated when Groq becomes available (next extraction call will re-check)
   - **Dormancy sweep (Step 3):**
     - Query `life_chapters` for user with `status = 'active'`
     - For each: check `last_change_at` — if `(now - last_change_at) > CHAPTER_DORMANCY_DAYS`: UPDATE `status = 'dormant'`, `chapter_end = last_change_at::date`
   - **Write extraction record (final step — only on success):**
     - `INSERT INTO memory_extractions (user_id, entry_id, extracted_at, prompt_version) VALUES (...)`
     - The `prompt_version` is read from `ReflectionPayload._meta.version` — not a hardcoded constant
     - This insert is the last operation: if anything before it failed, no record exists, and the next call will retry
   - Return `{ ok: true }` on success; errors caught and logged, return `{ ok: false, error }` without re-throwing
2. Mirror `CHAPTER_MIN_ENTRIES = 3`, `CHAPTER_CANDIDATE_WINDOW_DAYS = 90`, `CHAPTER_DORMANCY_DAYS = 60`, `CHAPTER_STABILITY_DAYS = 7` as local constants (cannot import from src/ in Edge Functions)
3. Handle the case where Groq is not configured: entity extraction is topics-only; chapter naming is deferred but chapter structure is still built
4. Add `supabase/functions/extract-memory/` to Supabase function registry (if config.toml exists)

**Relevant Context:**
- [`supabase/functions/generate-reflection/`](supabase/functions/generate-reflection/) — existing Edge Function structure to follow
- [`src/entities/insight.ts`](src/entities/insight.ts) — `ReflectionPayload` shape for reading themes and emotions
- [`src/entities/memory.ts`](src/entities/memory.ts) — constants defined in Sub-Task 3 (mirror them locally)
- Edge Functions use Deno runtime, service_role key from env vars

---

### Sub-Task 6 — Update `generate-reflection` for Context Injection

**Status:** [ ] pending

**Intent:**
Modify the existing `generate-reflection` Edge Function to query `context_memory` and `life_chapters` before constructing the Groq prompt. When relevant context exists, inject a compact context block into the system prompt. When no context exists, behavior is identical to current (zero regression).

**Expected Outcomes:**
- `generate-reflection` queries `context_memory` for the user before calling Groq
- Queries `life_chapters` for active chapters
- Builds a context block (≤ 500 tokens) from the most relevant entities
- Relevance is determined by theme overlap with current entry's detected themes (from HuggingFace step)
- Injects context block into Groq system prompt as a new section
- If context is empty or Groq not configured: function behaves exactly as before
- `source_hash` for the reflection includes a hash of the context block (so reflections regenerate if memory changes significantly)

**Todo List:**
1. Read current `supabase/functions/generate-reflection/index.ts` to understand prompt construction
2. Add `getRelevantContext(userId, currentThemes, currentEntityValues)` helper inside the function:
   - **Retrieval is relevance-based, not recency/frequency-based:**
   - Query all `context_memory` for user WHERE `mention_count >= CONTEXT_MEMORY_MIN_MENTIONS`; for each entity compute a relevance score: +2 if `entity_value` appears in current entry content or themes, +1 if any `emotional_tags` overlaps with current themes, +0 otherwise; keep entities with score > 0, sorted by score DESC, then `mention_count` DESC as tiebreaker; take up to token budget
   - Query `life_chapters` WHERE `user_id = userId AND status = 'active'`; for each chapter compute relevance: count of theme_tags overlapping with current themes; take the highest-scoring chapter (tie: most recent `last_change_at`)
   - Build context string: `"About this person: [comma-separated entity_values by type]. [If active chapter: 'They are currently in a chapter called \"[name]\": [summary].']"`
   - Estimate token count (rough: 1 token ≈ 4 chars); truncate gracefully to stay under `CONTEXT_MEMORY_MAX_TOKENS = 500` tokens
   - Return `{ contextText: string; isEmpty: boolean }` — if `isEmpty`, skip injection entirely
   - **This helper is the retrieval extension point** — its signature and return type must not couple to a specific scoring strategy; document it as such
3. Inject context block into existing system prompt: add new section "Context about this person:" before the journaling instruction
4. Update `sourceEnvelope` call to include a hash of the context block text (so the source_hash changes when memory changes, triggering re-reflection invitation)
5. Fire `extract-memory` Edge Function asynchronously after saving insight: `fetch(extractMemoryUrl, { method: 'POST', body: JSON.stringify({ entryId, userId }) })` — do NOT await, do NOT let failure affect response
6. Update prompt version constant (`AI_CONFIG.promptVersion` bump — treat this as a rare architectural event, not a routine edit; the version is stored in every `ReflectionPayload._meta.version` and in every `MemoryExtraction.promptVersion` row)
7. Sync the bumped `promptVersion` to `src/entities/insight.ts` `AI_CONFIG.promptVersion` — client-side stale detection reads this value to determine if cached reflections are fresh

**Relevant Context:**
- [`supabase/functions/generate-reflection/`](supabase/functions/generate-reflection/) — existing file to modify
- [`src/shared/utils/hash.ts`](src/shared/utils/hash.ts) — `sourceEnvelope` pattern (replicate logic in Deno)
- [`src/entities/insight.ts`](src/entities/insight.ts) — `AI_CONFIG.promptVersion` is the canonical version; bump here and sync with Edge Function local mirror
- The prompt version bump will cause `useEntryInsight.isStale = true` for all existing reflections — this is intentional and correct; context-aware reflections are a meaningful upgrade
- Prompt version bumps are **rare architectural events** — only bump when the reflection output is meaningfully different due to a structural change (like context injection). Do not bump for wording adjustments.

---

### Sub-Task 7 — React Query Hooks: Memory Feature

**Status:** [ ] pending

**Intent:**
Create `src/features/memory/hooks.ts` with React Query hooks for querying life chapters and context memory. These hooks are the foundation for M4's discovery UI. In M3 they have no UI consumer — they exist to establish the pattern and verify the service/DB layer works.

**Expected Outcomes:**
- `src/features/memory/` directory exists with `hooks.ts`
- `memoryKeys` query key factory follows `journalKeys` pattern
- `useLifeChapters(status?)` hook — queries life chapters, optionally filtered by status
- `useContextMemory(entityType?)` hook — queries context memory
- `useActiveChapterCount()` hook — derived count, useful for future badge indicators
- All hooks follow existing error handling and cache invalidation patterns
- No UI component yet — hooks only

**Todo List:**
1. Create `src/features/memory/hooks.ts`:
   - `memoryKeys` factory: `all`, `chapters(status?)`, `chapter(id)`, `context(entityType?)`
   - `useLifeChapters(status?: ChapterStatus)`: calls `memoryService.getLifeChapters()`, staleTime 5 minutes
   - `useContextMemory(entityType?: ContextEntityType)`: calls `memoryService.getContextMemory()`, staleTime 5 minutes
   - `useActiveChapterCount()`: derived from `useLifeChapters('active')`, returns count
2. No mutations in this file — all writes are service_role only via Edge Functions
3. Consider: should `useUpsertEntry` in journal hooks invalidate `memoryKeys.chapters()` after a successful write? — No. Memory is updated by Edge Functions, not by entry saves. Cache invalidation for memory hooks happens on a timer (staleTime), not on mutation.

**Relevant Context:**
- [`src/features/journal/hooks.ts`](src/features/journal/hooks.ts) — `journalKeys` pattern to follow exactly
- [`src/features/insights/hooks.ts`](src/features/insights/hooks.ts) — staleTime and error handling patterns
- [`src/services/memoryService.ts`](src/services/memoryService.ts) — service created in Sub-Task 4

---

### Sub-Task 8 — Domain Tests: Memory Entities and Service

**Status:** [ ] pending

**Intent:**
Write unit tests for the memory entity mappers, constants, and the chapter candidate scoring logic. Following the project's test pattern in `src/__tests__/`. This is the only milestone that should invest in tests before UI exists, because the promotion logic is rule-based and easily testable in isolation.

**Expected Outcomes:**
- `src/__tests__/memory.test.ts` exists and passes `npm run test`
- Tests cover: `lifeChapterFromRow` mapper, `contextMemoryFromRow` mapper, chapter dormancy threshold logic, context block token estimation
- Tests do not require network calls or Supabase (pure unit tests)

**Todo List:**
1. Create `src/__tests__/memory.test.ts`:
   - Test `lifeChapterFromRow`: verify camelCase mapping, status values, nullable `chapter_end`
   - Test `contextMemoryFromRow`: verify mapper, type values
   - Test `CHAPTER_DORMANCY_DAYS` threshold logic (standalone function if extracted, or logic test)
   - Test context block token estimation in `memoryService.getActiveChapterSummaries` (mock Supabase client)
2. Run `npm run test` and fix any failures
3. Run `npm run lint` and fix any lint errors

**Relevant Context:**
- [`src/__tests__/domain.test.ts`](src/__tests__/domain.test.ts) — existing test file for reference on style and setup
- [`src/__tests__/sync.test.ts`](src/__tests__/sync.test.ts) — reference for mock patterns
- `vitest` with `globals: true` and `environment: 'jsdom'` — no imports needed for `describe`/`it`/`expect`
- Test files live in `src/__tests__/`, never co-located

---

### Sub-Task 9 — README and Schema Documentation Update

**Status:** [ ] pending

**Intent:**
Update `README.md` with Milestone 3 context. Update inline comments in `src/db/schema.sql` to document the memory table design decisions. This keeps the documentation consistent with the codebase across milestones.

**Expected Outcomes:**
- `README.md` includes a Milestone 3 section describing the memory architecture (not implementation details — philosophy and what changed)
- `src/db/schema.sql` has inline comments on new tables explaining their purpose and relationship
- No functional code changes in this sub-task

**Todo List:**
1. Add Milestone 3 section to `README.md`:
   - What memory is and why it precedes intelligence
   - The two memory types (Context Memory vs Life Chapters)
   - That memory is invisible to users in this milestone
2. Add table-level comments to `src/db/schema.sql` for all four new tables (including `memory_extractions`)
3. Update `AGENTS.md` with new invariants:
   - `context_memory`, `life_chapters`, `chapter_entries`, `memory_extractions` are all service_role-only writes — no client mutations allowed
   - `memory_extractions` is the idempotency guard for `extract-memory` — deleting a row forces re-extraction
   - Prompt version bumps (`AI_CONFIG.promptVersion`) are **rare architectural events**: only bump when reflection output is structurally different (e.g., context injection added). Version is stored in `ReflectionPayload._meta.version` and `MemoryExtraction.promptVersion` for traceability.
   - Memory tables are **append-only** wherever possible: `context_memory` uses upsert-with-increment (never replace), `chapter_entries` only adds rows, `memory_extractions` rows are never updated

**Relevant Context:**
- [`README.md`](README.md) — existing structure
- [`AGENTS.md`](AGENTS.md) — existing agent guidance
- [`src/db/schema.sql`](src/db/schema.sql) — existing table comments style

---

### Sub-Task 10 — Quality Verification

**Status:** [ ] pending

**Intent:**
Verify the full build, lint, and test pipeline passes cleanly before the milestone is considered complete. Catch any TypeScript strictness violations, unused imports, or broken references introduced across the milestone's changes.

**Expected Outcomes:**
- `npm run build` completes without errors
- `npm run lint` reports zero errors
- `npm run test` passes all tests
- No `any` types introduced without explicit justification
- No `noUnusedLocals` / `noUnusedParameters` violations

**Todo List:**
1. Run `npm run build` — fix all TypeScript errors
2. Run `npm run lint` — fix all ESLint errors
3. Run `npm run test` — fix any test failures
4. Review all new files for `import type` compliance (`verbatimModuleSyntax`)
5. Verify no raw DB column names leak past mappers into UI-layer types

**Relevant Context:**
- [`tsconfig.json`](tsconfig.json) — strict mode settings
- [`AGENTS.md`](AGENTS.md) — `verbatimModuleSyntax`, `noUnusedLocals`, `erasableSyntaxOnly` are all enforced

---

### Sub-Task 11 — Commit and Push

**Status:** [ ] pending

**Intent:**
Clean commit history for the milestone on the feature branch. Each logical group of changes in a single commit. Push to remote for review.

**Expected Outcomes:**
- All Milestone 3 changes committed to `feature/memory-before-intelligence`
- Commits are logically grouped and descriptively messaged
- Branch is pushed to remote
- No merge to `main`

**Todo List:**
1. Stage and commit in logical groups:
   - `feat(db): add memory tables migration 005`
   - `feat(entities): add memory domain types and mappers`
   - `feat(services): add memoryService with read queries`
   - `feat(functions): add extract-memory edge function`
   - `feat(functions): inject context memory into generate-reflection`
   - `feat(memory): add memory feature hooks`
   - `test(memory): add memory entity and service tests`
   - `docs: update README and schema comments for milestone 3`
2. Run `git push origin feature/memory-before-intelligence`
3. Verify branch is visible on remote

---

## Dependency Order

```
Sub-Task 1  (branch)
    ↓
Sub-Task 2  (DB migration)
    ↓
Sub-Task 3  (entities)
    ↓
Sub-Task 4  (service)
    ↓
Sub-Task 5  (extract-memory Edge Function)
Sub-Task 6  (generate-reflection update)    ← both depend on Sub-Task 4
Sub-Task 7  (memory hooks)
    ↓
Sub-Task 8  (tests)
    ↓
Sub-Task 9  (docs)
    ↓
Sub-Task 10 (quality verification)
    ↓
Sub-Task 11 (commit + push)
```

Sub-Tasks 5, 6, and 7 can proceed in parallel after Sub-Task 4 is complete.

---

## Key Design Decisions (recorded for implementation)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Chapter candidate signals | ≥2 of: entity co-occurrence, theme overlap (temporal is prerequisite filter) | Discovers life episodes, not just emotional clusters |
| Chapter promotion trigger | entry_count ≥ 3 AND stability ≥ 7 days AND theme drift ≤ 50% | Multi-factor; avoids premature naming |
| Chapter stability window | CHAPTER_STABILITY_DAYS = 7 — one factor in a multi-condition check | Time alone does not promote; evidence and stability together do |
| Dormancy threshold | CHAPTER_DORMANCY_DAYS = 60 days since last_change_at | Chapter is over but not deleted |
| Context memory min mentions | CONTEXT_MEMORY_MIN_MENTIONS = 3 | Entities below threshold are noise |
| Context injection budget | CONTEXT_MEMORY_MAX_TOKENS = 500 tokens | Keeps reflection costs bounded |
| Entity extraction — Groq available | Groq lightweight prompt: people, places, orgs, projects + themes | Structured extraction without heuristics |
| Entity extraction — Groq unavailable | Topics from ReflectionPayload.themes only; no regex fallback | Avoids introducing throwaway heuristics |
| Context injection retrieval | Relevance-scored, not recency/frequency; extension point for future upgrade | Retrieval strategy can evolve without architecture change |
| importance_score on context_memory | Nullable NUMERIC, unused in M3 | Reserved for future retrieval ranking without schema migration |
| signals JSONB on life_chapters | Stores which signals fired; unused by UI in M3 | Audit trail and future chapter quality scoring |
| entry_count + last_change_at on life_chapters | Maintained by extract-memory; used in stability check | Avoids expensive COUNT(*) queries on every promotion check |
| extract-memory invocation | Fire-and-forget from generate-reflection | Memory never blocks reflection response time |
| source_hash for context injection | Context block hash included | Forces re-reflection when memory changes significantly |
| Chapter merge | Deferred to M4 | Reduces scope; M3 builds structure only |
| Chapter naming | LLM-generated after promotion; deferred if Groq unavailable | Human-readable; never generated from insufficient evidence |
| User-facing UX | None in M3 | Memory foundation before memory discovery |
| Extraction idempotency | memory_extractions table as guard; final insert is commit point | Safe retry, safe backfill, no double-processing |
| Memory as append-only | context_memory uses increment-upsert; chapter_entries only adds rows | Preserves history; no silent data loss |
| Prompt version traceability | Version stored in ReflectionPayload._meta.version AND MemoryExtraction.prompt_version | Debugging and future migrations know exactly which version produced each artifact |
| Prompt version bump policy | Rare architectural events only; not for wording changes | Prevents unnecessary stale storms for users |
| Backfill mechanism | { backfill: true } flag on extract-memory; processes entries with reflection but no extraction record | Opt-in, manual; not automatic on deploy |

---

## Open Questions (resolved before implementation)

These were decided during planning:

1. **Should users be able to manually tag entries as chapter-worthy?** — No, not in M3. Manual promotion is M4 UX. M3 is fully automatic.
2. **Should `extract-memory` run on historical reflections retroactively?** — Yes, but as a one-time backfill triggered manually (not automatic on deploy). Add a `backfill` flag to the Edge Function that processes all existing reflections for a user when called with `{ backfill: true }`.
3. **Should the prompt version bump in Sub-Task 6 affect the weekly reflection prompt too?** — No. Weekly prompt version (`WEEKLY_PROMPT_VERSION`) is independent. Only per-entry reflection prompt version changes.
4. **What if Groq is not configured when extract-memory tries to name a chapter?** — Chapter stays `forming` indefinitely. Name + summary generation is gated on Groq availability. The chapter structure (entry links, theme tags) is saved. When Groq becomes available and the next reflection is triggered, the stability check re-runs and generates the name.
