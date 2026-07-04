# Milestone 2 — Patterns Over Time: Implementation Plan

## Top-Level Overview

**Goal:** Evolve UnSaid from helping users understand a single journal entry to helping them notice emotional patterns across multiple entries — without making AI feel intrusive or automatic.

**Approach:**
1. Introduce weekly synthesis as a new insight type (`'summary'`) that builds on existing per-entry reflections.
2. Redesign the Insights dashboard to answer "What has my recent emotional journey looked like?" using a narrative-first layout — storytelling first, lightweight CSS visualizations second.
3. Keep the journal as the primary experience. AI actions remain explicit and user-triggered. No automatic inference.

**Non-goals for this milestone:**
- Entity memory, people/place tracking, relationship tracking
- Monthly reviews, Year in Review
- Automatic AI analysis after autosave
- Adding a charting library
- "Summarize This Week" in the JournalEditor AI menu

**Architecture principle:**
```
Journal Entry
      ↓
Per-entry Reflection (type='reflection', entry_id=UUID)     ← M1, unchanged
      ↓
Weekly Synthesis     (type='summary',    entry_id=NULL, period_start/end=week)  ← M2
```

**Cache design for weekly summaries:**
Weekly `source_hash` = SHA-256 of `JSON.stringify({ weekStart, weekEnd, weeklyPromptVersion, model, entryHashes })` where `entryHashes` is a sorted list of per-entry reflection `source_hash` values (or entry content hashes for unreflected entries). This means the weekly cache invalidates only when:
- A contributing entry's content changes (new autosave creates new entry hash)
- A contributing entry gets reflected for the first time (switching from entry hash to reflection hash)
- The `weeklyPromptVersion` is bumped
- The user changes their Groq model

**Versioning:** Per-entry `promptVersion` stays at `'2.0.0'`. Weekly summaries use an independent `weeklyPromptVersion` starting at `'1.0.0'` in their own `_meta`.

**Minimum entries threshold:** Introduced as `WEEKLY_REFLECTION_MIN_ENTRIES = 3` (a named constant in `src/shared/constants.ts`). This threshold controls when the weekly invitation card appears. Do not hardcode `3` in any business logic.

**Weekly staleness model:** Mirrors the per-entry staleness system. After a weekly summary exists, the system computes a fresh `source_hash` based on current contributing entry hashes. If it differs from the stored `source_hash`, a "Weekly reflection may be outdated" notice appears alongside a secondary Regenerate action. The invitation card is NOT shown once a summary exists — only the staleness notice if relevant.

---

## Sub-Tasks

---

### Sub-Task 1 — Git Branch Setup

**Status:** `[ ] pending`

**Intent:** Create the feature branch before any code changes. All work must happen on `feature/patterns-over-time`, never on `main`.

**Expected Outcomes:**
- Branch `feature/patterns-over-time` exists and is checked out locally.
- All subsequent commits land on this branch.

**Todo List:**
1. Run `git checkout -b feature/patterns-over-time` from the root of the repository.
2. Verify with `git branch` that the new branch is active.

**Relevant Context:**
- Repository root: `/Users/jeyadheepv/grepo/PERSONA/unsaid`
- The branch must not be merged into `main` — only pushed and left for review.

---

### Sub-Task 2 — Database Migration: Weekly Summary Index

**Status:** `[ ] pending`

**Intent:** Add the partial unique index for period-based insight rows (`entry_id IS NULL`) that was documented but intentionally deferred in migration 003. This enforces one weekly summary per user per week range.

**Expected Outcomes:**
- File `src/db/migrations/006_weekly_summary_index.sql` created.
- Migration is idempotent (safe to re-run).
- The index enforces `UNIQUE (user_id, type, period_start, period_end) WHERE entry_id IS NULL`.

**Todo List:**
1. Create `src/db/migrations/006_weekly_summary_index.sql`.
2. Use a `DO $$ ... IF NOT EXISTS ...` block to make it idempotent.
3. Create `UNIQUE INDEX uq_insight_summary_period ON public.insights (user_id, type, period_start, period_end) WHERE entry_id IS NULL`.
4. Add a comment referencing migration 003 as context.

**Relevant Context:**
- Migration 003 (`src/db/migrations/003_reflection_type.sql`, lines 57-68) documents exactly this index but defers it to M2.
- Pattern follows existing migrations (idempotent `DO $$ IF NOT EXISTS` blocks).
- This migration must be applied in Supabase SQL Editor before the new Edge Function can write weekly rows.

---

### Sub-Task 3 — New Entity Types: WeeklyPayload and EntryInsight Extension

**Status:** `[ ] pending`

**Intent:** Define the TypeScript shape for weekly summary payloads and extend `EntryInsight` with `periodStart`/`periodEnd` so weekly insights can be correctly identified and rendered.

**Expected Outcomes:**
- `WeeklyPayload` interface defined in `src/entities/insight.ts`.
- `WeeklyPayload` includes an optional `suggestedReflection?: string` field for future coaching/prompts — not used in M2 UI but future-proofs the schema without a payload migration.
- `isWeeklyPayload()` type guard added.
- `EntryInsight` extended with optional `periodStart: string | null` and `periodEnd: string | null` fields.
- `InsightRow` in `insightsService.ts` updated to include `period_start` and `period_end`.
- `insightsService.getInsights()` mapper updated to include `periodStart`/`periodEnd`.

**Todo List:**
1. In [`src/entities/insight.ts`](src/entities/insight.ts:1), add after the `ReflectionResult` interface:
   - `WeeklyPayload` interface with: `narrative: string`, `dominantEmotions: ReflectionEmotion[]`, `recurringThemes: string[]`, `emotionalArc: string`, `suggestedReflection?: string` (optional — reserved for future use), `_meta: InsightMeta` (with `weeklyPromptVersion: string` added to `_meta` or as a sibling field).
   - `isWeeklyPayload()` type guard checking structural shape (do NOT require `suggestedReflection` — it is optional).
2. Extend `EntryInsight` interface to add `periodStart: string | null` and `periodEnd: string | null`.
3. In [`src/services/insightsService.ts`](src/services/insightsService.ts:52), extend `InsightRow` to include `period_start: string | null` and `period_end: string | null`.
4. Update the `.select()` query to fetch `period_start, period_end`.
5. Update the mapper to include `periodStart: r.period_start, periodEnd: r.period_end`.

**Relevant Context:**
- `InsightMeta` is at [`src/entities/insight.ts:54`](src/entities/insight.ts:54) — `weeklyPromptVersion` can be added as an optional field here.
- `EntryInsight` is at [`src/entities/insight.ts:140`](src/entities/insight.ts:140).
- `InsightRow` mapper is at [`src/services/insightsService.ts:52`](src/services/insightsService.ts:52).
- `TypeScript verbatimModuleSyntax` is on — use `import type` for type-only imports.
- `noUnusedLocals`/`noUnusedParameters` enforced — do not add unused fields.

---

### Sub-Task 4 — New Edge Function: generate-weekly-summary

**Status:** `[ ] pending`

**Intent:** Implement the Supabase Edge Function that synthesizes a week's worth of journal entries (using existing per-entry reflections where available, falling back to raw entry content) into a narrative weekly reflection.

**Expected Outcomes:**
- File `supabase/functions/generate-weekly-summary/index.ts` created.
- Accepts `POST { weekStart: "YYYY-MM-DD" }` (ISO Monday of the target week).
- Follows the exact same structure as [`supabase/functions/generate-reflection/index.ts`](supabase/functions/generate-reflection/index.ts:1).
- Fetches all entries for the user in `[weekStart, weekEnd]` date range.
- For each entry: uses the stored `reflection` insight's summary if it exists, otherwise uses the first 300 chars of the raw entry content.
- Computes `source_hash` = SHA-256 of `JSON.stringify({ weekStart, weekEnd, weeklyPromptVersion, model, entryHashes })` where `entryHashes` is a deterministically sorted list.
- Cache-hit logic: if an existing `summary` insight with matching `source_hash` exists for this week, return it immediately.
- On cache miss: calls Groq LLM with a synthesizing prompt that produces `narrative`, `dominantEmotions`, `recurringThemes`, `emotionalArc`. The Edge Function does NOT produce `suggestedReflection` in M2 — the field may appear in future prompt versions.
- Upserts result with `entry_id=NULL`, `period_start=weekStart`, `period_end=weekEnd`, `type='summary'`.
- Returns `{ result: WeeklyResult, meta: { cached: boolean, generationMs: number } }`.
- Error codes: `WEEKLY_NOT_CONFIGURED` (Groq not set), `INSUFFICIENT_ENTRIES` (fewer than 1 entry in week), `GROQ_PROVIDER_ERROR`, `SHAPE_ERROR`.

**Todo List:**
1. Create `supabase/functions/generate-weekly-summary/index.ts`.
2. Copy the structural template from `generate-reflection/index.ts` (JWT validation, service-role client, CORS helpers, decryptToken, sha256Hex, sourceEnvelope helpers).
3. Define local `weeklyPromptVersion = '1.0.0'` (independent of `promptVersion`).
4. Parse and validate `weekStart` body parameter; compute `weekEnd` = weekStart + 6 days.
5. Fetch all entries for the user where `entry_date BETWEEN weekStart AND weekEnd`.
6. Guard: if 0 entries → return `INSUFFICIENT_ENTRIES` (HTTP 422).
7. For each entry, fetch its `reflection` insight if present (use `maybeSingle()` per entry, or a single query with `entry_id IN (...)` and `type = 'reflection'`).
8. Build `entryHashes`: for each entry, use `reflection.source_hash` if available, otherwise compute `sha256Hex(sourceEnvelope(entry.content, 'entry', entry.id))` as a stable entry identifier.
9. Sort `entryHashes` deterministically (by entry_date ascending).
10. Compute weekly `source_hash` = `sha256Hex(JSON.stringify({ weekStart, weekEnd, weeklyPromptVersion, model: groqModel, entryHashes }))`.
11. Cache check: query `insights` for `user_id`, `type='summary'`, `period_start=weekStart`, `period_end=weekEnd`; if `source_hash` matches and `isWeeklyResult()` passes → return cached.
12. Build the Groq prompt: provide a structured summary of available per-entry reflections (or entry excerpts). The prompt must elicit narrative prose, NOT bullet statistics.
13. Parse and validate Groq response with `isWeeklyResult()` guard.
14. Build full payload with `_meta` including `weeklyPromptVersion`.
15. Upsert to `insights` with `entry_id=NULL`, `period_start`, `period_end`, `type='summary'`, `source_hash`, `updated_at=now()`. Use `onConflict: 'user_id,type,period_start,period_end'` (matches the partial index).
16. Return `{ result, meta }`.

**Relevant Context:**
- Template: [`supabase/functions/generate-reflection/index.ts`](supabase/functions/generate-reflection/index.ts:1) — full structure reference.
- `AI_CONFIG.defaultGroqModel = 'llama-3.1-8b-instant'` — same default.
- `onConflict` key must match the partial unique index created in Sub-Task 2.
- Provider error bodies must never be forwarded to the client (log server-side only).
- The Groq prompt should produce a response in this shape (no `suggestedReflection` in M2 — prompt does not request it):
  ```json
  {
    "narrative": "This week began with uncertainty...",
    "dominantEmotions": [{"label": "Joy", "score": 0.42}],
    "recurringThemes": ["Work", "Family"],
    "emotionalArc": "from uncertainty toward quiet optimism"
  }
  ```
- Do NOT add any new `ImportMap` or `deno.json` — follow existing Edge Function pattern (bare `https://esm.sh/` imports only).

---

### Sub-Task 5 — Service Layer: generateWeeklySummary

**Status:** `[ ] pending`

**Intent:** Add the `generateWeeklySummary(weekStart)` method to `insightsService` following the same pattern as `generateReflection()`.

**Expected Outcomes:**
- `insightsService.generateWeeklySummary(weekStart: string)` method added.
- Returns `{ ok: true; data: WeeklyResult } | { ok: false; code: 'WEEKLY_NOT_CONFIGURED' | 'INSUFFICIENT_ENTRIES' }`.
- All non-graceful error codes thrown as `ServiceError`.
- `WeeklyResult` type (wire return type without `_meta`) defined in `src/entities/insight.ts`. `WeeklyResult` includes `suggestedReflection?: string` (optional) so future prompt versions that produce it are handled gracefully without a client code change.

**Todo List:**
1. Add `WeeklyResult` interface to `src/entities/insight.ts` (mirrors `WeeklyPayload` minus `_meta`).
2. Add `GenerateWeeklySummaryResult` discriminated union type to `src/services/insightsService.ts`.
3. Add `generateWeeklySummary(weekStart: string)` method to `insightsService` in `src/services/insightsService.ts`.
4. Follow the `generateReflection()` pattern exactly: `FunctionsHttpError` handling, graceful return for expected error codes, `ServiceError` throw for unexpected codes.
5. Add DEV-mode `console.debug` logging for cache/timing observability.

**Relevant Context:**
- `generateReflection()` pattern: [`src/services/insightsService.ts:170`](src/services/insightsService.ts:170).
- `GenerateReflectionResult` type: [`src/services/insightsService.ts:66`](src/services/insightsService.ts:66) — follow exactly.
- `FunctionsHttpError` import already present.

---

### Sub-Task 6 — React Query Hooks: Weekly Summary

**Status:** `[ ] pending`

**Intent:** Add `useWeeklyInsights()` (a derived query that extracts weekly summaries from the existing insights cache), `useGenerateWeeklySummary()` (the mutation hook), and `useCurrentWeekInsight()` (which mirrors the per-entry staleness model for weekly summaries) to the insights hooks file.

**Expected Outcomes:**
- `useWeeklyInsights()` hook that derives weekly summary insights from `useInsights()` data — no extra network call.
- `useGenerateWeeklySummary()` mutation hook following the same pattern as `useGenerateReflection()`.
- `useCurrentWeekInsight(entryDates: string[], allInsights: EntryInsight[])` hook that derives the full weekly state: whether enough entries exist, whether a summary exists, and — critically — whether the existing summary is stale.
- Staleness: the hook re-computes the `source_hash` inputs (the sorted list of contributing entry/reflection hashes) on the client and compares against the stored weekly `source_hash`. If they differ, `isWeeklyStale = true`. This mirrors `useEntryInsight`'s `isStale` computation.
- Hooks exported from `src/features/insights/hooks.ts`.

**Todo List:**
1. Add `WEEKLY_REFLECTION_MIN_ENTRIES` constant to `src/shared/constants.ts` with value `3`. All threshold logic must reference this constant — never a hardcoded `3`.
2. Add `useWeeklyInsights()` to `src/features/insights/hooks.ts`:
   - Filters `useInsights()` data for `type === 'summary'` with `isWeeklyPayload()` guard.
   - Sorts by `periodStart` descending.
3. Add `useCurrentWeekInsight(entryDates: string[], allInsights: EntryInsight[])` hook:
   - Computes current week range (Monday to Sunday) using `date-fns` `startOfWeek` / `endOfWeek` with `weekStartsOn: 1`.
   - Counts entries in the current week range from `entryDates`.
   - Finds the existing weekly `summary` insight for this week (matching `periodStart`/`periodEnd`).
   - Re-computes `currentEntryHashes` from the contributing entries' reflection source_hashes (or entry hashes for unreflected entries) — same deterministic sort as the Edge Function.
   - Computes `freshSourceHash` = SHA-256 of `JSON.stringify({ weekStart, weekEnd, weeklyPromptVersion, model, entryHashes: currentEntryHashes })` asynchronously (same pattern as `useEntryInsight`'s `savedHash` state).
   - Returns `{ weekStart, weekEnd, entryCount, summary: EntryInsight | undefined, hasEnough: boolean, isWeeklyStale: boolean }`.
   - `hasEnough`: `entryCount >= WEEKLY_REFLECTION_MIN_ENTRIES`.
   - `isWeeklyStale`: `!!summary && freshSourceHash !== '' && (summary.sourceHash === null || freshSourceHash !== summary.sourceHash)`.
4. Add `useGenerateWeeklySummary()` mutation:
   - Calls `insightsService.generateWeeklySummary(weekStart)`.
   - On success: invalidates `insightKeys.user(user.id)`.
   - Handles graceful `WEEKLY_NOT_CONFIGURED` and `INSUFFICIENT_ENTRIES` codes (no error state shown).
5. Export all new hooks and the `WEEKLY_REFLECTION_MIN_ENTRIES` constant.

**Relevant Context:**
- `useInsights()` at [`src/features/insights/hooks.ts:66`](src/features/insights/hooks.ts:66) — derive from this, not a new query.
- `useEntryInsight()` at [`src/features/insights/hooks.ts:94`](src/features/insights/hooks.ts:94) — this is the exact staleness model to mirror for weekly summaries.
- `useGenerateReflection()` at [`src/features/insights/hooks.ts:167`](src/features/insights/hooks.ts:167) — follow this pattern for the mutation.
- `date-fns` is already installed — use `startOfWeek`, `endOfWeek`, `format`, `isWithinInterval`, `parseISO`.
- `journalKeys.dates()` query provides all entry dates for week counting.
- `sha256Hex` and `sourceEnvelope` from `src/shared/utils/hash.ts` — use for client-side hash recomputation.
- `AI_CONFIG` from `src/entities/insight.ts` — the weekly version is independent but the same hash utility applies.
- `WEEKLY_REFLECTION_MIN_ENTRIES` must be imported from `src/shared/constants.ts` (added in this sub-task).

---

### Sub-Task 7 — Redesigned Insights Dashboard

**Status:** `[ ] pending`

**Intent:** Rebuild `InsightsPage.tsx` as a genuine patterns dashboard. The journal must remain primary; the Insights page answers "What has my recent emotional journey looked like?" using storytelling first, lightweight visuals second.

**Expected Outcomes:**
- InsightsPage redesigned with the following sections **in storytelling order**:
  1. **Weekly Reflection section** — the primary section:
     - If `hasEnough && !summary`: show an invitation card ("You've written on N days this week. Your week is ready for reflection.") with a single "Reflect on this week" button.
     - If `summary` exists AND `!isWeeklyStale`: show the `WeeklyPayload.narrative` as the primary text, `emotionalArc` as a subheading, `recurringThemes` as pills. No generation prompt — the summary IS the content.
     - If `summary` exists AND `isWeeklyStale`: show the narrative as above, plus a subtle "Weekly reflection may be outdated" notice and a secondary "Regenerate" action. Do NOT show a prominent regenerate button when the summary is fresh.
     - If `!hasEnough && !summary`: show nothing, or a very subtle hint ("Write on at least `WEEKLY_REFLECTION_MIN_ENTRIES` days this week to unlock a weekly reflection"). This must not feel like a call to action — it is informational only.
  2. **Recurring themes section** — aggregated across all reflection insights:
     - Collect all `themes` arrays from reflection payloads.
     - Count frequency of each theme string.
     - Render the top 8 themes as pills with relative size (font-size or opacity scaled by frequency).
  3. **Emotional balance over time** — CSS-only stacked bar visualization:
     - For the last 10 reflected entries (sorted by entry date), render a horizontal timeline of small stacked bars (positive/neutral/negative segments) using inline `div` + CSS `flex`.
     - Each bar is clickable/hoverable showing the date and dominant emotion.
     - No chart library. Pure CSS flexbox.
     - This section is intentionally subordinate to Weekly Reflection and Recurring Themes — it supports the narrative, it does not lead it.
  4. **Recent reflections** — the existing `InsightCard` section, preserved.
- The four progressive empty states (A/B/C/D) are updated to account for the new sections.
- All existing M1 rendering (sentiment cards, reflection cards, distribution bar) is preserved or improved.
- **Section order rationale:** Weekly Reflection → Recurring Themes → Emotional Timeline → Recent Reflections reflects the storytelling hierarchy: "what happened this week" → "what keeps coming up" → "how have my emotions shifted over time" → "entry-level detail".

**Todo List:**
1. Import new hooks: `useWeeklyInsights`, `useCurrentWeekInsight`, `useGenerateWeeklySummary`, `useEntryDates`.
2. Import `WEEKLY_REFLECTION_MIN_ENTRIES` from `src/shared/constants.ts`.
3. Add `WeeklySummaryCard` component (inline in InsightsPage.tsx) that handles all three weekly states:
   - Invitation (enough entries, no summary yet)
   - Fresh summary (narrative + emotionalArc + recurringThemes pills, no regenerate prompt)
   - Stale summary (narrative + emotionalArc + recurringThemes pills + subtle outdated notice + secondary Regenerate button)
   - Insufficient entries (very subtle hint or nothing)
4. Add `RecurringThemesSection` component (theme frequency aggregation + pill cloud).
5. Add `EmotionalTimelineSection` component (CSS-only stacked bars for last 10 entries).
6. Update the page structure: Weekly → Recurring Themes → Emotional Timeline → Recent Reflections.
7. Update progressive state D to include all sections in this order.
8. Preserve states A, B, C unchanged (they are pre-insights guard states).
9. Update the page subtitle from "Emotional patterns from your writing." to something that reflects narrative-first.
10. Mobile pass: ensure all new sections stack correctly at ≤ 680px.

**Relevant Context:**
- Existing `InsightsPage.tsx`: [`src/features/insights/InsightsPage.tsx`](src/features/insights/InsightsPage.tsx:1).
- CSS variables available: `--success`, `--danger`, `--text-muted`, `--text-secondary`, `--space-xs`, `--space-sm`, `--space-md`, `--space-xl`, `--space-2xl`.
- `insight-distribution-bar` and `insight-distribution-segment` CSS classes already exist in `index.css` — reuse for the timeline bars.
- `useEntryDates()` is in `src/features/journal/hooks.ts` — import from there.
- `isWeeklyPayload()` guard from `src/entities/insight.ts`.
- `WEEKLY_REFLECTION_MIN_ENTRIES` from `src/shared/constants.ts`.
- **Staleness display rule:** Only show "outdated" notice and Regenerate when `isWeeklyStale === true`. Never show a Regenerate button when the summary is current. This mirrors the per-entry "Re-reflect" / "Reflected today" UX pattern.

---

### Sub-Task 8 — Remove Dead Code

**Status:** `[ ] pending`

**Intent:** The `getEmotionValence()` helper is currently duplicated between `InsightsPage.tsx` and `JournalEditor.tsx`. With the redesign, consolidate it into a shared utility. Also remove any other dead code made obsolete by the redesign.

**Expected Outcomes:**
- `getEmotionValence()` extracted to `src/shared/utils/emotions.ts` (new file).
- Both `InsightsPage.tsx` and `JournalEditor.tsx` import from the shared location.
- `POSITIVE_EMOTIONS` and `NEGATIVE_EMOTIONS` sets moved to the same shared utility.
- No dead code left in the redesigned InsightsPage (e.g. `sentimentInsights` variable if it becomes unused).

**Todo List:**
1. Create `src/shared/utils/emotions.ts` with `POSITIVE_EMOTIONS`, `NEGATIVE_EMOTIONS`, and `getEmotionValence()`.
2. Update `src/features/insights/InsightsPage.tsx` to import from the new shared utility.
3. Update `src/features/journal/JournalEditor.tsx` to import from the new shared utility.
4. Remove the duplicated declarations from both files.
5. Check for any other unused variables or imports in files touched during this milestone.

**Relevant Context:**
- Comment in `InsightsPage.tsx` line 36: `// Note: duplicated from JournalEditor.tsx intentionally — deduplication deferred until a third callsite warrants a shared util.` — M2 creates that third callsite (the EmotionalTimelineSection uses valence).
- `src/shared/utils/dates.ts` and `src/shared/utils/hash.ts` are the existing shared utility files to follow for style and export pattern.

---

### Sub-Task 9 — README Update

**Status:** `[ ] pending`

**Intent:** Update the README to document all M2 architecture changes, new features, new migration, and new Edge Function.

**Expected Outcomes:**
- README features list updated to include weekly reflections and patterns dashboard.
- AI Insights section updated with a "Milestone 2 — Patterns Over Time" subsection.
- `WeeklyPayload` schema documented (mirroring the `ReflectionPayload` example).
- `generate-weekly-summary` call flow documented.
- New migration `006_weekly_summary_index.sql` added to the migration table.
- New Edge Function `generate-weekly-summary` added to the deployment instructions.
- Project structure section updated to reflect new files (`src/shared/utils/emotions.ts`, new Edge Function).
- Changelog entry added for Milestone 2.

**Todo List:**
1. Add `generate-weekly-summary` to the deploy step (section "5. Deploy Edge Functions").
2. Add `006_weekly_summary_index.sql` to the migrations table.
3. Add a "Milestone 2 — Patterns Over Time" section under AI Insights.
4. Document `WeeklyPayload` schema.
5. Document `generate-weekly-summary` call flow.
6. Update the Features list at the top.
7. Update the Project Structure section.
8. Add Changelog entry.

**Relevant Context:**
- [`README.md`](README.md:1) — full file, ~503 lines.
- Existing sections to update: Features (line 12), Project Structure (line 139), AI Insights (line 218), Deploy Edge Functions (line 86), Changelog (line 476).

---

### Sub-Task 10 — Quality Verification: Build, Lint, Type-Check, Tests

**Status:** `[ ] pending`

**Intent:** Ensure the milestone is complete, regression-free, and production-ready before committing.

**Expected Outcomes:**
- `npm run build` succeeds with zero TypeScript errors.
- `npm run lint` passes with zero warnings or errors.
- `npm run test` passes all existing tests.
- No regressions to journaling, autosave, offline sync, or per-entry reflection.
- `npm run dev` starts without console errors.

**Todo List:**
1. Run `npm run build` — fix any TypeScript errors before proceeding.
2. Run `npm run lint` — fix any ESLint errors or warnings.
3. Run `npm run test` — verify all existing tests pass.
4. Manually start `npm run dev` and verify:
   - Journal editor opens and autosaves correctly.
   - Per-entry Reflect still works end-to-end.
   - Insights page renders without console errors in all four states (A/B/C/D).
   - New weekly section renders correctly in State D.
5. Verify `src/__tests__/domain.test.ts` and `src/__tests__/sync.test.ts` still pass.

**Relevant Context:**
- Test files in `src/__tests__/` — not co-located with source.
- `verbatimModuleSyntax` enforced — all type-only imports must use `import type`.
- `noUnusedLocals`/`noUnusedParameters` enforced — verify no unused symbols remain.

---

### Sub-Task 11 — Commit and Push

**Status:** `[ ] pending`

**Intent:** Commit all changes with a descriptive message and push the branch to GitHub for review.

**Expected Outcomes:**
- All changes committed to `feature/patterns-over-time`.
- Branch pushed to GitHub remote.
- Branch is NOT merged into `main`.

**Todo List:**
1. `git add -A` — stage all changes.
2. `git commit -m "feat(m2): Patterns Over Time — weekly synthesis, emotional timeline, recurring themes dashboard"` with a multi-line body describing the key changes.
3. `git push -u origin feature/patterns-over-time`.
4. Confirm push with `git log --oneline -5`.

---

## Deliverables Summary

When the implementation is complete, the following must be provided:

1. **Architectural summary** — what changed from M1 to M2.
2. **SQL migrations** — `006_weekly_summary_index.sql` (must be applied in Supabase before the new Edge Function is deployed).
3. **Edge Function deployment** — `supabase functions deploy generate-weekly-summary`.
4. **Manual deployment steps** — any Supabase secrets or schema cache reloads required.
5. **Follow-up recommendations** — suggestions for Milestone 3.
6. **Branch confirmation** — `feature/patterns-over-time` committed and pushed.

---

## Implementation Notes (Context for Agent Mode)

- **Always run one sub-task at a time**, starting from Sub-Task 1, and update its `Status` field to `[x] done` before proceeding.
- **Read the plan file at the start of each sub-task** to get current status and any context notes added by previous sub-tasks.
- **Do not merge into main** — the branch is for review only.
- **Edge Function pattern**: follow [`supabase/functions/generate-reflection/index.ts`](supabase/functions/generate-reflection/index.ts:1) exactly for structure, error handling, CORS, and cache logic.
- **TypeScript strictness**: `verbatimModuleSyntax` + `noUnusedLocals` — use `import type` for all type-only imports, and ensure no symbols are unused after refactoring.
- **No new dependencies**: do not introduce a charting library or any package not already in `package.json`.
- **CSS only for visualizations**: use existing CSS variables and the `.insight-distribution-*` classes as a model.
- **Mobile pass required**: every new UI component must work at ≤ 680px.
