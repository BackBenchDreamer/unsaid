# Milestone 1 — Foundation of Reflection

## Overview

Transform the AI reflection experience from a single sentiment pill into a genuinely
valuable reading experience, while preserving the writing-first philosophy.

**Scope of this milestone:**
- HuggingFace remains the only provider for emotion analysis (unchanged from current).
- Groq is the only provider for reflection generation (new).
- No provider selection, no configurable base URLs, no provider abstraction in the UI.
- The Settings page names providers explicitly: "Emotion Analysis (HuggingFace)" and
  "Reflection Generation (Groq)". Provider abstraction is deferred to a future milestone.
- The `encrypt-token` Edge Function gains a `provider` parameter (`'hf' | 'groq'`) so
  the infrastructure can extend cleanly later without redesigning it — but this detail
  is invisible to the UI.

**What changes:**
- The HuggingFace model returns 7 emotion scores. Instead of collapsing them into a
  single label, the `generate-reflection` Edge Function preserves all 7 and uses them
  as grounding context for a Groq LLM call.
- The Groq LLM produces: a 2–3 sentence reflection paragraph, the top-4 emotions with
  human-readable labels, 1–3 detected themes, and one follow-up question.
- This output is stored as a new `type = 'reflection'` insight row.
- The AI panel in JournalEditor renders a rich reflection card when a `'reflection'`
  insight exists. When only a legacy `'sentiment'` insight exists, the existing pill
  is preserved with a subtle notice: "Richer reflections available — configure Groq in
  Settings."
- The InsightsPage `SentimentCard` is updated to render reflection insights with summary
  + top emotions; legacy sentiment insight rendering is unchanged.
- The `insights` table gains future-proof nullable columns (`period_start`, `period_end`,
  `updated_at`) that are unused in this milestone but prevent future data migrations.
- `AI_CONFIG.promptVersion` bumps to `'2.0.0'`, intentionally invalidating all cached
  `'sentiment'` source hashes. Users will see "Re-reflect" on their next visit. This is
  intentional — the reflection experience is fundamentally different.
- A `feature/foundation-of-reflection` Git branch is used throughout.

**What does NOT change:**
- Mood picker — completely untouched.
- Autosave — no AI runs automatically; reflection remains an explicit user action.
- `source_hash` caching — extended to `'reflection'` type.
- `analyze-sentiment` Edge Function — unchanged, still used as the HF-only fallback path.
- RLS policies — no changes needed (service-role writes work for all insight types).
- Sync engine, journal service, auth flow — untouched.
- `isSentimentPayload`, `SentimentPayload`, `SentimentResult` — unchanged.
- `useGenerateInsight` hook — kept as the fallback path called inside `useGenerateReflection`.

**Deferred to future milestones:**
- Multiple LLM provider support / provider selection UI
- Configurable base URLs
- Automatic background metadata collection
- Weekly / monthly / annual summaries
- Entity memory and longitudinal observations

---

## Architecture: Two insight types, one panel

### Insight types

| `type` | Payload shape | Produced by | When |
|---|---|---|---|
| `'sentiment'` | `SentimentPayload` | `analyze-sentiment` Edge Fn | Existing; also fallback when Groq not configured |
| `'reflection'` | `ReflectionPayload` | `generate-reflection` Edge Fn | New; requires both HF + Groq tokens |

No rows are deleted or migrated. Both types coexist.

### Panel priority rule

The AI panel in JournalEditor resolves which insight to display in this order:
1. `reflectionInsight` (type = `'reflection'`) — if present, render reflection card.
2. `sentimentInsight` (type = `'sentiment'`) — if present, render legacy pill + notice.
3. Neither — render "Reflect ▾" button.

### Reflect action behaviour

When the user clicks "Reflect":
1. `useGenerateReflection` calls `insightsService.generateReflection(entryId)`.
2. If Groq is not configured → service returns `{ ok: false, code: 'REFLECTION_NOT_CONFIGURED' }`.
3. Hook silently falls back: calls `insightsService.generateInsight(entryId)` (existing HF path).
4. The user never sees an error in step 2 — the fallback is transparent.
5. On success (either path): invalidate `insightKeys.user(userId)` → panel re-renders.

### Source hash consistency

Two separate source hash envelopes exist — one per insight type:

| Insight type | `sourceEnvelope(content, promptVersion, model)` |
|---|---|
| `'sentiment'` | model = `settings.aiModel` (HF model, from `hf_model` column) |
| `'reflection'` | model = `settings.reflectionModel` (Groq model, from `groq_model` column) |

`useEntryInsight` computes `savedHash` using **whichever model corresponds to the
active insight type** (`reflectionInsight` preferred, else `sentimentInsight`).
This is explicit in Sub-Task 11.

`AI_CONFIG.promptVersion = '2.0.0'` is used in both envelopes. Bumping it invalidates
all cached insights of both types simultaneously.

### `promptVersion` bump rationale

Bumping from `'1.0.0'` to `'2.0.0'` makes all existing `'sentiment'` source hashes stale.
Users see "Journal updated since this insight." on their next visit. This is intentional:
the new reflection experience supersedes the old single-label output. The promptVersion
is the correct mechanism for this — no data migration is needed.

---

## Naming reference table

All names used in this milestone. A new engineer should use this as the ground truth.

| Concern | Name |
|---|---|
| DB column: HF token | `hf_token_encrypted` (existing, unchanged) |
| DB column: HF model | `hf_model` (existing, unchanged) |
| DB column: Groq token | `groq_token_encrypted` (new) |
| DB column: Groq model | `groq_model` (new, default `'llama-3.1-8b-instant'`) |
| `encrypt-token` provider value: HF | `'hf'` |
| `encrypt-token` provider value: Groq | `'groq'` |
| `UserSettings` field: HF configured | `aiConfigured` (existing, unchanged) |
| `UserSettings` field: HF model | `aiModel` (existing, unchanged) |
| `UserSettings` field: Groq configured | `reflectionConfigured` (new) |
| `UserSettings` field: Groq model | `reflectionModel` (new) |
| Service method: save HF token | `saveHFToken()` (existing, unchanged) |
| Service method: save Groq token | `saveGroqToken()` (new) |
| Service method: update Groq model | `updateGroqModel(userId, model)` (new) |
| Settings hook: save HF token | `useSaveHFToken()` (existing, unchanged) |
| Settings hook: save Groq token | `useSaveGroqToken()` (new) |
| Settings hook: update Groq model | `useUpdateGroqModel()` (new) |
| Insight type value: sentiment | `'sentiment'` (existing) |
| Insight type value: reflection | `'reflection'` (new) |
| Entity type guard: sentiment | `isSentimentPayload()` (existing, unchanged) |
| Entity type guard: reflection | `isReflectionPayload()` (new) |
| Entity type: reflection emotions | `ReflectionEmotion` (new) |
| Entity type: reflection DB payload | `ReflectionPayload` (new) |
| Entity type: reflection wire result | `ReflectionResult` (new) |
| Service result type: generate reflection | `GenerateReflectionResult` (new) |
| Hook: generate reflection | `useGenerateReflection()` (new) |
| Service method: generate reflection | `generateReflection(entryId)` (new) |
| Edge Function: sentiment (existing) | `analyze-sentiment` |
| Edge Function: reflection (new) | `generate-reflection` |
| Groq endpoint (hardcoded, no config) | `https://api.groq.com/openai/v1/chat/completions` |
| `_meta.provider` for reflection rows | `'groq'` |
| `AI_CONFIG.promptVersion` | `'2.0.0'` (bumped from `'1.0.0'`) |
| Migration: insights table | `003_reflection_type.sql` |
| Migration: user_settings Groq cols | `004_groq_provider_settings.sql` |
| Settings section heading | `"AI Configuration"` |
| Settings sub-section: HF | `"Emotion Analysis (HuggingFace)"` |
| Settings sub-section: Groq | `"Reflection Generation (Groq)"` |
| CSS class: reflection card container | `.reflection-card` |
| CSS class: reflection emotion chip | `.reflection-emotion-pill` |
| CSS class: fallback notice | `.reflection-richer-notice` |

---

## Database changes

### Migration 003 — `src/db/migrations/003_reflection_type.sql`

```sql
-- ============================================================
-- Migration 003 — Add 'reflection' insight type + future-proof columns
--
-- Run in Supabase SQL Editor AFTER migrations 001 and 002.
-- Safe to run multiple times (idempotent).
-- ============================================================

-- ── 1. Expand type CHECK to include 'reflection' ────────────
-- The inline CHECK on the type column is unnamed (Postgres auto-generates the
-- name). LIKE '%''sentiment''%' quotes the literal so it matches only the type
-- check definition and not any future constraint that incidentally contains the
-- word "sentiment" in a different position.
-- The ADD CONSTRAINT block is also guarded with an existence check so the
-- migration is safe to re-run (idempotent as stated in the header comment).
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.insights'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%''sentiment''%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.insights DROP CONSTRAINT %I', v_conname);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insights_type_check'
      AND conrelid = 'public.insights'::regclass
  ) THEN
    ALTER TABLE public.insights
      ADD CONSTRAINT insights_type_check
        CHECK (type IN ('sentiment', 'summary', 'pattern', 'reflection'));
  END IF;
END;
$$;

-- ── 2. Future-proof columns (nullable, unused in Milestone 1) ──
-- period_start / period_end: weekly and monthly summary windows (Milestone 2+)
-- updated_at: tracks last regeneration time when an upsert overwrites a row.
--   Added as nullable first, backfilled from created_at so existing rows carry
--   a meaningful timestamp (not the migration run date), then DEFAULT set.
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS period_end   DATE;
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE public.insights SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE public.insights ALTER COLUMN updated_at SET DEFAULT now();
```

**Also update `src/db/schema.sql`** insights table definition to match:
- CHECK includes `'reflection'`
- `period_start DATE` column added (nullable)
- `period_end DATE` column added (nullable)
- `updated_at TIMESTAMPTZ` column added (nullable in CREATE TABLE; migration backfills and sets DEFAULT)

### Migration 004 — `src/db/migrations/004_groq_provider_settings.sql`

```sql
-- ============================================================
-- Migration 004 — Add Groq provider columns to user_settings
--
-- groq_token_encrypted: AES-256-GCM ciphertext of the user's Groq API key.
--   Never returned to the client. Read only by Edge Functions via service role.
-- groq_model: the Groq model to use for reflection generation.
--   Default is 'llama-3.1-8b-instant' (fast, low-cost Groq model).
--
-- Run in Supabase SQL Editor AFTER migration 003.
-- Safe to run multiple times (idempotent).
-- ============================================================

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS groq_token_encrypted TEXT;
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS groq_model TEXT DEFAULT 'llama-3.1-8b-instant';
```

**Also update `src/db/user_settings.sql`** to include both new columns.

---

## `encrypt-token` Edge Function — provider-agnostic extension

**File:** `supabase/functions/encrypt-token/index.ts`

**Change:** Accept an optional `provider` field in the JSON body.
Valid values: `'hf'` (default) | `'groq'`.
The field is optional for backward compatibility — omitting it defaults to `'hf'`,
meaning all existing callers continue to work unchanged.

**Column mapping:**

| `provider` value | DB column written |
|---|---|
| `'hf'` (default) | `hf_token_encrypted` |
| `'groq'` | `groq_token_encrypted` |

**All other logic is unchanged:** same AES-256-GCM encryption, same `APP_ENCRYPTION_KEY`
secret, same auth validation, same response shape `{ success: true }`.

**Error on invalid provider:** HTTP 400 `{ error: "provider must be 'hf' or 'groq'" }`.

**Callers:**
- `settingsService.saveHFToken()` — calls with `{ token }` (no `provider`; defaults to `'hf'`). Unchanged.
- `settingsService.saveGroqToken()` — calls with `{ token, provider: 'groq' }`. New.

---

## `generate-reflection` Edge Function

**File:** `supabase/functions/generate-reflection/index.ts`

Follows the exact structural pattern of `analyze-sentiment`:
auth → parse body → fetch entry → assert ownership → fetch settings →
check Groq configured → compute source_hash → cache check → generate → validate → store → return.

### Full pipeline

1. **Auth validation**: verify JWT; resolve `user_id`.
2. **Body parsing**: extract and validate `entryId` (non-empty string).
3. **Fetch entry**: service-role client; assert `entry.user_id === user_id`.
4. **Fetch settings**: query `user_settings` for `hf_token_encrypted`, `hf_model`,
   `groq_token_encrypted`, `groq_model`.
5. **Guard**: if `groq_token_encrypted` is null → return HTTP 422:
   `{ error: "Reflection not configured", code: "REFLECTION_NOT_CONFIGURED" }`.
6. **Source hash**: `SHA-256(JSON.stringify({ content: entry.content, promptVersion: '2.0.0', model: groq_model }))`.
7. **Cache check**: query `insights` for `(user_id, entry_id, type = 'reflection')`.
   If found AND `source_hash` matches AND `isReflectionResult(existing.payload)` passes
   → return `{ result: { summary, emotions, themes, question }, meta: { cached: true, generationMs: 0 } }`.
8. **Decrypt HF token**: AES-256-GCM decrypt `hf_token_encrypted` using `APP_ENCRYPTION_KEY`.
9. **HF call**: POST to `https://router.huggingface.co/hf-inference/models/${hf_model}` with
   `{ inputs: entry.content.slice(0, 512) }`. Same response-normalisation logic as
   `analyze-sentiment` (handles both flat and nested HF response shapes). Result: 7 emotion scores.
10. **Decrypt Groq token**: AES-256-GCM decrypt `groq_token_encrypted`.
11. **Groq call**: POST to `https://api.groq.com/openai/v1/chat/completions` with:
    - `Authorization: Bearer <decrypted_groq_token>`
    - Model: `groq_model`
    - Messages: system + user (see Prompt section below)
    - `response_format: { type: "json_object" }` (Groq supports this; enforces JSON output)
12. **Parse + validate**: extract content from `choices[0].message.content`; `JSON.parse()`; validate with `isReflectionResult()`.
13. **Build payload**:
    ```
    ReflectionPayload = {
      summary, emotions, themes, question,  // from LLM
      _meta: {
        provider: 'groq',
        model: groq_model,
        promptVersion: '2.0.0',
        generatedAt: new Date().toISOString(),
        generationMs: <wall-clock ms from step 9 start to step 12 end>
      }
    }
    ```
14. **Upsert**:
    ```sql
    INSERT INTO insights (user_id, entry_id, type, payload, source_hash, updated_at)
    VALUES (user_id, entry_id, 'reflection', payload, source_hash, now())
    ON CONFLICT (user_id, entry_id, type)
    DO UPDATE SET
      payload    = EXCLUDED.payload,
      source_hash = EXCLUDED.source_hash,
      updated_at  = now()
    ```
    `updated_at` is explicitly set to `now()` on both insert and conflict-update so it
    always reflects when the row was last written, not when the table column default was set.
15. **Return**: `{ result: { summary, emotions, themes, question }, meta: { cached: false, generationMs } }`

### Prompt

```
System:
You are a thoughtful journaling companion. You help people understand themselves
through their writing. Be honest and gentle. Never be prescriptive or preachy.

User:
Given the journal entry excerpt and its emotional composition, write a short reflection
(2–3 sentences) that reveals something the writer may not have explicitly noticed.
End with exactly one open-ended follow-up question.

Emotional composition:
joy=0.42, surprise=0.08, anger=0.02, disgust=0.01, fear=0.06, sadness=0.11, neutral=0.30

Journal excerpt (first 600 characters):
"<entry.content.slice(0, 600)>"

Respond ONLY with valid JSON in exactly this shape:
{
  "summary": "2–3 sentence reflection here.",
  "emotions": [
    { "label": "Joy", "score": 0.42 },
    { "label": "Neutral", "score": 0.30 },
    { "label": "Sadness", "score": 0.11 },
    { "label": "Fear", "score": 0.06 }
  ],
  "themes": ["Work", "Family"],
  "question": "One open-ended question here?"
}

Rules:
- emotions: list the top 4 by score, human-readable capitalised labels.
- themes: 1–3 one-word or short-phrase topics.
- summary and question must be non-empty strings.
- Do not include any text outside the JSON object.
```

### `isReflectionResult()` validation

```ts
function isReflectionResult(v: unknown): v is ReflectionResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.summary === 'string' && r.summary.trim().length > 0 &&
    Array.isArray(r.emotions) &&
    r.emotions.length > 0 &&
    (r.emotions as unknown[]).every(
      (e) => typeof (e as Record<string,unknown>).label === 'string' &&
             typeof (e as Record<string,unknown>).score === 'number'
    ) &&
    Array.isArray(r.themes) &&
    typeof r.question === 'string' && r.question.trim().length > 0
  );
}
```

### Local AI_CONFIG mirror

```ts
// Mirror of src/entities/insight.ts AI_CONFIG.
// Keep in sync when bumping promptVersion and redeploying.
const AI_CONFIG = {
  promptVersion: '2.0.0',
  defaultHFModel: 'j-hartmann/emotion-english-distilroberta-base',
  defaultGroqModel: 'llama-3.1-8b-instant',
} as const;
```

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `REFLECTION_NOT_CONFIGURED` | 422 | `groq_token_encrypted` is null — expected condition |
| `HF_PROVIDER_ERROR` | 502 | HF model returned non-200 |
| `GROQ_PROVIDER_ERROR` | 502 | Groq API returned non-200 |
| `SHAPE_ERROR` | 502 | Groq returned unparseable or structurally invalid JSON |

---

## Settings page — "AI Configuration"

The existing `"AI Integration"` section is renamed to `"AI Configuration"` and
restructured into two sub-sections. No "AI Providers" framing. No provider selection,
no base URL field, no provider name label.

### Sub-section 1: Emotion Analysis (HuggingFace)

Functionally **identical** to the existing "AI Integration" section.
The HF token form, the replace/cancel UX pattern, and the model display are completely
unchanged. Only the section heading text changes.

**State flow (unchanged):**
- `tokenSaved` / `isReplacing` / `tokenError` — existing state variables, unchanged.
- Submit: calls `useSaveHFToken(plainToken)` — unchanged.

**One new element:** after the model display line, when `aiConfigured = true` AND
`reflectionConfigured = false`, show:
```
"Configure Groq below to unlock richer reflections."
```
Styled as small muted text. Disappears once Groq is configured.

### Sub-section 2: Reflection Generation (Groq)

New UI. Mirrors the HF section's UX pattern exactly.

Fields:
- **API key** (password input, write-only after save). Submit calls `useSaveGroqToken(plainToken)`.
- **Model** (text input, default populated from `settings.reflectionModel`).
  Submit calls `useUpdateGroqModel(model)`.

State variables (new, parallel to HF section):
- `groqTokenInput: string` — controlled input for the API key
- `groqTokenSaved: boolean` — true immediately after a successful save (shows confirmation)
- `isReplacingGroq: boolean` — true while replacing a previously saved token
- `groqTokenError: string` — error message from `useSaveGroqToken`
- `groqModelInput: string` — controlled input for the model name
- `groqModelSaved: boolean` — true immediately after a successful model save
- `groqModelError: string` — error from `useUpdateGroqModel`

UX behaviour (mirrors HF exactly):
- If `reflectionConfigured && !isReplacingGroq` → show "✓ Token configured" + [Replace] button.
- If `groqTokenSaved` → show "✓ Token saved successfully".
- Otherwise → show password input + [Save Token] button (or [Save New Token] if replacing).
- [Cancel] button appears when `isReplacingGroq`.
- Model field is always visible (not a secret); pre-filled from `settings.reflectionModel`.
- Saving the model is a separate submit action from saving the API key.

Note: `groqModelInput` is initialized from `settings.reflectionModel` in a `useEffect`
when settings load (same pattern as any controlled input seeded from server state).

---

## AI panel redesign (JournalEditor)

The panel's 7-state model is completely preserved. Only the inner rendering of
states 5 and 6 changes. The loading and error states (3, 4, 7) are unchanged.

### State 5 — fresh insight, reflection exists

```
┌──────────────────────────────────────────────────────┐
│  Reflection                         Reflected today  │
│                                                      │
│  Although today started with frustration, most of   │
│  your writing focused on gratitude and meaningful    │
│  conversations.                                      │
│                                                      │
│  ● Joy 42%   ● Neutral 30%   ● Sadness 11%          │
│                                                      │
│  Work · Family · Personal growth                    │
│                                                      │
│  ──────────────────────────────────────────────────  │
│  What part of today are you most likely to          │
│  remember a year from now?                          │
└──────────────────────────────────────────────────────┘
             [View insights →]  [↻ Re-reflect ▾]
```

- Header: `.reflection-header-label` ("Reflection") left, `.reflection-header-time`
  (`formatReflectedAt(reflectionInsight.createdAt)`) right.
- Summary: `.reflection-summary` — full text, no truncation.
- Emotions: `.reflection-emotions` flex row. Each chip: `.reflection-emotion-pill`
  with valence class (`.positive`, `.negative`, or `.neutral`) based on HF category.
- Themes: `.reflection-themes` — joined with ` · ` separator.
- Separator: `.reflection-divider` (thin horizontal rule).
- Question: `.reflection-question` — italic, muted, `cursor: pointer`.
  On click: append `\n\n${question}` to Lexical editor (see Sub-Task 12 for exact
  Lexical API pattern).

**Emotion valence mapping for CSS class:**
- `.positive`: joy, surprise
- `.negative`: anger, disgust, fear, sadness
- `.neutral`: neutral

### State 5 fallback — fresh insight, only sentiment exists

- Existing sentiment pill + confidence% + `formatReflectedAt(sentimentInsight.createdAt)` + "View insights →"
- Below pill row (only when `settings?.reflectionConfigured === false`):
  ```
  "Richer reflections available — configure Groq in Settings."
  ```
  Styled as `.reflection-richer-notice`. Includes a tappable "Settings →" inline link.

### State 6 — stale insight

Same inner rendering as state 5, but:
- Reflection card or sentiment pill rendered at 0.5 opacity.
- "Journal updated since this insight." notice shown.
- `.reflection-richer-notice` is **suppressed** (avoid visual noise when stale).

### AiMenu update

- Primary action label: `'Reflect'` (id stays `'generate-insight'` for stability).
- `invoke`: calls `generateReflectionMutation.mutate(existingEntry.id)`.
- `enabled`: `!generateReflectionMutation.isPending`.
- Loading/error state displayed via `generateReflectionMutation.isPending` /
  `generateReflectionMutation.isError` / error string — same as current `generateMutation`.
- Other menu items (Summarize, Reflection Prompt, Find Patterns) remain `enabled: false`.

---

## InsightsPage changes

### SentimentCard (handles both types)

```
if isReflectionPayload(insight.payload):
  - Entry date (formatDisplayDate)
  - Truncated summary (max 120 chars + "…")
  - Top 2 emotions as .reflection-emotion-pill chips
  - formatReflectedAt(insight.createdAt)
  - "Open entry →" button

else if isSentimentPayload(insight.payload):
  - [unchanged existing rendering]
```

### Distribution bar

Updated to include reflection insights. For each reflection insight:
- Sum `emotions` scores by valence group:
  - positive: joy + surprise
  - negative: anger + disgust + fear + sadness
  - neutral: neutral
- The group with the highest sum wins; increment that label's count by 1.

For legacy sentiment insights: existing logic unchanged.

---

## Complete sub-task list

---

### Sub-Task 1 — Create feature branch

**Intent:** Establish the Git branch before any code is written. All subsequent commits
land on this branch. The branch is never merged to `main` without review.

**Expected Outcomes:**
- `feature/foundation-of-reflection` branch exists locally and is the active branch.

**Todo:**
1. `git checkout main && git pull`
2. `git checkout -b feature/foundation-of-reflection`

**Status:** [ ] pending

---

### Sub-Task 2 — Database migration: insights table

**Intent:** Extend the `insights` table with the `'reflection'` type and three
future-proof nullable columns. The existing inline CHECK constraint is anonymous in
Postgres; it must be located by querying `pg_constraint` and dropped before the
named replacement constraint can be added.

**Expected Outcomes:**
- `src/db/migrations/003_reflection_type.sql` exists with the exact SQL from the
  "Migration 003" section above (including the `DO $$` block).
- `src/db/schema.sql` insights table definition updated:
  - `CHECK (type IN ('sentiment', 'summary', 'pattern', 'reflection'))` (or equivalent named constraint)
  - `period_start DATE` column added (nullable)
  - `period_end DATE` column added (nullable)
  - `updated_at TIMESTAMPTZ DEFAULT now()` column added

**Todo:**
1. Create `src/db/migrations/003_reflection_type.sql` with the SQL from this plan.
2. In `src/db/schema.sql` lines 77–89: update the `insights` table `CREATE TABLE`
   statement to replace the inline `CHECK (type IN ('sentiment', 'summary', 'pattern'))`
   with `CHECK (type IN ('sentiment', 'summary', 'pattern', 'reflection'))` and add the
   three new columns.
3. At the bottom of `src/db/migrations/003_reflection_type.sql`, add a comment block
   documenting the NULL uniqueness gap for future weekly summary rows:
   ```sql
   -- ── Future summary rows note ──────────────────────────────────
   -- The uq_insight_entry_type UNIQUE constraint (user_id, entry_id, type) does NOT
   -- enforce uniqueness when entry_id IS NULL (Postgres treats NULLs as distinct).
   -- Weekly and monthly summary insights (entry_id IS NULL) require a separate
   -- partial unique index. Add this when implementing summary insights:
   --
   -- CREATE UNIQUE INDEX uq_insight_summary_period
   --   ON public.insights (user_id, type, period_start, period_end)
   --   WHERE entry_id IS NULL;
   --
   -- Do NOT add this index in Migration 003 — period_start/period_end are not
   -- yet used and the index would be vacuous until summary rows are written.
   ```

**Relevant Context:**
- `src/db/schema.sql` lines 77–89 — current insights table
- `src/db/migrations/001_insights_source_hash.sql` — reference for idempotent migration style

**Status:** [ ] pending

---

### Sub-Task 3 — Database migration: user_settings Groq columns

**Intent:** Add `groq_token_encrypted` and `groq_model` to `user_settings`.

**Expected Outcomes:**
- `src/db/migrations/004_groq_provider_settings.sql` exists with the exact SQL from the
  "Migration 004" section above.
- `src/db/user_settings.sql` table `CREATE TABLE` statement updated to include:
  - `groq_token_encrypted TEXT` (nullable, no default)
  - `groq_model TEXT DEFAULT 'llama-3.1-8b-instant'`

**Todo:**
1. Create `src/db/migrations/004_groq_provider_settings.sql`.
2. Update `src/db/user_settings.sql` table definition.

**Relevant Context:**
- `src/db/user_settings.sql` — current user_settings table (standalone file,
  not part of `schema.sql`)

**Status:** [ ] pending

---

### Sub-Task 4 — Extend `supabase/functions/encrypt-token/index.ts`

**Intent:** Add a `provider` field to the request body so the function can write to
either `hf_token_encrypted` or `groq_token_encrypted`. This is an infrastructure
change only — the encryption algorithm, `APP_ENCRYPTION_KEY` secret, auth logic, and
response shape are completely unchanged.

**Expected Outcomes:**
- Function accepts `{ token: string, provider?: 'hf' | 'groq' }`.
- `provider` defaults to `'hf'` when omitted (full backward compatibility).
- `provider = 'hf'` → writes to `hf_token_encrypted` (existing behaviour).
- `provider = 'groq'` → writes to `groq_token_encrypted` (new).
- Any other `provider` value → HTTP 400 `{ error: "provider must be 'hf' or 'groq'" }`.
- Function header comment updated to document the `provider` parameter.

**Exact code change (lines 118–154):**
After parsing `token` from the body, add:
```ts
const provider: string = (body.provider as string) ?? 'hf';
if (provider !== 'hf' && provider !== 'groq') {
  return json({ error: "provider must be 'hf' or 'groq'" }, 400);
}
```
Replace line 148:
```ts
// Before:
.update({ hf_token_encrypted: ciphertext })
// After:
.update(provider === 'groq'
  ? { groq_token_encrypted: ciphertext }
  : { hf_token_encrypted: ciphertext }
)
```

**Security fix (line 151–153):** The existing error response leaks `updateError.message`
(Supabase DB error strings can contain schema information — table names, column names,
constraint names). Change:
```ts
// Before (line 153):
return json({ error: 'Failed to save token', detail: updateError.message }, 500);
// After:
console.error('Failed to update user_settings:', updateError.message);
return json({ error: 'Failed to save token' }, 500);
```
The `console.error` call on line 152 already logs `updateError` as an object — remove or
deduplicate as appropriate. The point is: `detail` must NOT appear in the HTTP response body.

**Relevant Context:**
- `supabase/functions/encrypt-token/index.ts` lines 118–154 — body parsing + DB update

**Status:** [ ] pending

---

### Sub-Task 5 — Update `src/entities/insight.ts`

**Intent:** Add `ReflectionEmotion`, `ReflectionPayload`, `ReflectionResult`,
`isReflectionPayload`. Extend `InsightType`. Bump `AI_CONFIG.promptVersion` to `'2.0.0'`.

**Expected Outcomes:**

`InsightType`:
```ts
export type InsightType = 'sentiment' | 'summary' | 'pattern' | 'reflection';
```

`AI_CONFIG`:
```ts
export const AI_CONFIG = {
  promptVersion: '2.0.0',  // bumped from '1.0.0' — invalidates all cached sentiment hashes
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;
```
Add a comment: `// promptVersion bump from 1.0.0 → 2.0.0: existing 'sentiment' source hashes
// become stale. Users see "Re-reflect" on next visit. This is intentional.`

New exports:
```ts
export interface ReflectionEmotion {
  label: string;   // human-readable capitalised label, e.g. "Joy"
  score: number;   // 0–1 probability from HF model
}

export interface ReflectionPayload {
  summary: string;                // 2–3 sentence reflection
  emotions: ReflectionEmotion[];  // top 4 emotions by score
  themes: string[];               // 1–3 detected topics
  question: string;               // one follow-up question
  _meta: InsightMeta;             // provider='groq', model, promptVersion, generatedAt, generationMs
}

export interface ReflectionResult {
  // Wire type — what the Edge Function returns to the client.
  // Identical to ReflectionPayload minus _meta.
  summary: string;
  emotions: ReflectionEmotion[];
  themes: string[];
  question: string;
}

export function isReflectionPayload(p: unknown): p is ReflectionPayload {
  if (typeof p !== 'object' || p === null) return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.summary === 'string' &&
    Array.isArray(v.emotions) &&
    Array.isArray(v.themes) &&
    typeof v.question === 'string'
  );
}
```

**Unchanged:** `SentimentPayload`, `SentimentResult`, `isSentimentPayload`, `InsightMeta`,
`EntryInsight`, `AiAction`, `Memory`, `HeatmapCell`.

**Relevant Context:**
- `src/entities/insight.ts` — full file (173 lines)

**Status:** [ ] pending

---

### Sub-Task 6 — Update `src/services/settingsService.ts`

**Intent:** Add Groq provider fields to `UserSettings`. Add `saveGroqToken()` and
`updateGroqModel()` service methods. Update `getSettings` SELECT to include new columns.

**Changes to `UserSettings` interface:**
```ts
// ADD these two fields:
reflectionConfigured: boolean;  // true when groq_token_encrypted IS NOT NULL
reflectionModel: string;         // from groq_model column
```
No existing fields change.

**Changes to `SettingsRow` interface:**
```ts
// ADD:
groq_token_encrypted: string | null;
groq_model: string;
```

**Changes to `getSettings`:**
Update SELECT string from:
`'user_id, theme, hf_model, hf_token_encrypted, updated_at'`
to:
`'user_id, theme, hf_model, hf_token_encrypted, groq_token_encrypted, groq_model, updated_at'`

**Changes to `settingsFromRow`:**
```ts
// ADD:
reflectionConfigured: row.groq_token_encrypted !== null,
reflectionModel: row.groq_model,
```

**New methods:**
```ts
async saveGroqToken(plainToken: string): Promise<void>
// Calls encrypt-token with { token: plainToken, provider: 'groq' }.
// Error handling identical to saveHFToken().

async updateGroqModel(userId: string, model: string): Promise<void>
// Direct supabase .update({ groq_model: model }).eq('user_id', userId).
// Throws ServiceError on DB error.
```

**Unchanged:** `saveHFToken`, `hasHFToken`, `updateTheme`, all existing types.

**Relevant Context:**
- `src/services/settingsService.ts` — full file read
- `src/services/errors.ts` — `ServiceError` pattern

**Status:** [ ] pending

---

### Sub-Task 7 — Update `src/features/settings/hooks.ts`

**Intent:** Add `useSaveGroqToken` and `useUpdateGroqModel` mutation hooks,
mirroring the `useSaveHFToken` and `useUpdateTheme` patterns exactly.

**New hooks:**
```ts
export function useSaveGroqToken() {
  // mutationFn: settingsService.saveGroqToken(plainToken)
  // onSuccess: invalidate settingsKeys.user(userId)
}

export function useUpdateGroqModel() {
  // mutationFn: settingsService.updateGroqModel(userId, model)
  // onSuccess: invalidate settingsKeys.user(userId)
}
```

**Unchanged:** `useSettings`, `useUpdateTheme`, `useSaveHFToken`.

**Relevant Context:**
- `src/features/settings/hooks.ts` — full file read

**Status:** [ ] pending

---

### Sub-Task 8 — Update `src/features/settings/SettingsPage.tsx`

**Intent:** Rename "AI Integration" → "AI Configuration". Restructure into two
sub-sections. Add the Groq sub-section. Add the subtle "configure Groq" notice in the
HF sub-section.

**New state variables (add alongside existing):**
```ts
const [groqTokenInput, setGroqTokenInput] = useState('');
const [groqTokenSaved, setGroqTokenSaved] = useState(false);
const [isReplacingGroq, setIsReplacingGroq] = useState(false);
const [groqTokenError, setGroqTokenError] = useState('');
const [groqModelInput, setGroqModelInput] = useState('');
const [groqModelSaved, setGroqModelSaved] = useState(false);
const [groqModelError, setGroqModelError] = useState('');
```

`groqModelInput` must be seeded from `settings.reflectionModel` when settings load.
Use a `hasInitialized` ref to prevent the settings refetch (which happens after saving
the Groq token) from overwriting a value the user has already typed but not yet saved:
```ts
const groqModelInitialized = useRef(false);
useEffect(() => {
  if (!groqModelInitialized.current && settings?.reflectionModel) {
    setGroqModelInput(settings.reflectionModel);
    groqModelInitialized.current = true;
  }
}, [settings?.reflectionModel]);
```
Without this guard, `useSaveGroqToken().onSuccess` → `invalidateQueries` → settings
refetch → `useEffect` re-fires → typed model value is overwritten mid-edit.

**New hooks to import:**
```ts
const saveGroqToken = useSaveGroqToken();
const updateGroqModel = useUpdateGroqModel();
```

**Handler functions to add:**
- `handleSaveGroqToken(e)` — calls `saveGroqToken.mutateAsync(groqTokenInput.trim())`;
  sets `groqTokenSaved = true`, `isReplacingGroq = false` on success.
- `handleReplaceGroq()` — sets `isReplacingGroq = true`.
- `handleCancelReplaceGroq()` — sets `isReplacingGroq = false`.
- `handleSaveGroqModel(e)` — calls `updateGroqModel.mutateAsync({ userId, model: groqModelInput.trim() })`;
  sets `groqModelSaved = true` on success.

**Section structure:**
```
<section className="settings-section">
  <h2 className="settings-section-title">AI Configuration</h2>

  {/* ── Emotion Analysis (HuggingFace) ─── */}
  <h3 className="settings-subsection-title">Emotion Analysis (HuggingFace)</h3>
  <p className="settings-section-desc">
    Used to detect the emotional tone of your journal entries.
    Your token is encrypted server-side and never returned to this device.
  </p>
  [existing HF token configured/form/replace UI — logic unchanged]
  <div className="settings-model-info">
    <span className="settings-label">Model</span>
    <code className="settings-model-name">{settings?.aiModel ?? '...'}</code>
  </div>
  {settings?.aiConfigured && !settings?.reflectionConfigured && (
    <p className="settings-hint" style={{ marginTop: 'var(--space-sm)' }}>
      Configure Groq below to unlock richer reflections.
    </p>
  )}

  {/* ── Reflection Generation (Groq) ─── */}
  <h3 className="settings-subsection-title" style={{ marginTop: 'var(--space-xl)' }}>
    Reflection Generation (Groq)
  </h3>
  <p className="settings-section-desc">
    Used to generate reflection summaries and follow-up questions from your entries.
    Your token is encrypted server-side and never returned to this device.
  </p>
  [Groq token configured/form/replace UI — mirrors HF pattern]
  <div className="settings-model-info">
    [groqModelInput text input + Save Model button]
    {groqModelSaved && <span className="token-status-icon">✓ Model saved</span>}
    {groqModelError && <p className="form-error">{groqModelError}</p>}
  </div>
</section>
```

**Expected Outcomes:**
- Section heading is "AI Configuration".
- HF sub-section heading is "Emotion Analysis (HuggingFace)".
- HF token/model logic is functionally unchanged.
- "Configure Groq" notice appears only when appropriate.
- Groq sub-section has working token save/replace/cancel flow.
- Groq model input is persisted to DB via `updateGroqModel`.
- No provider selection field, no base URL field.

**Relevant Context:**
- `src/features/settings/SettingsPage.tsx` — full file read
- `src/features/settings/hooks.ts` — new hooks from Sub-Task 7

**Status:** [ ] pending

---

### Sub-Task 9 — New `supabase/functions/generate-reflection/index.ts`

**Intent:** Create the Edge Function that produces `ReflectionPayload`. Follows the
`analyze-sentiment` structural pattern. The full pipeline is documented in the
"generate-reflection Edge Function" section above — implement it exactly.

**Checklist of items that must appear in the function:**
- `AI_CONFIG` local mirror (promptVersion = `'2.0.0'`, defaultGroqModel = `'llama-3.1-8b-instant'`).
  Comment pointing to `src/entities/insight.ts` as canonical source.
- `sha256Hex()` and `sourceEnvelope()` inlined (identical to `src/shared/utils/hash.ts` —
  Deno cannot import from `src/`).
- `hexToBytes()` and `decryptToken()` inlined (identical to `analyze-sentiment` — same reason).
- HF response normalisation (flat + nested shape handling) — copy from `analyze-sentiment`.
- `mapHFToSentiment()` — copy from `analyze-sentiment`; used to get 7 emotion scores
  for the prompt but not stored as `SentimentResult`.
- `isReflectionResult()` — exact implementation from this plan's spec.
- Cache check must call `isReflectionResult(existing.payload)` (not `isSentimentResult`).
- `_meta.provider` must be `'groq'`.
- Groq endpoint is hardcoded: `https://api.groq.com/openai/v1/chat/completions`.
  No base URL field; no configurable endpoint.
- `response_format: { type: "json_object" }` included in Groq request body.
- Error codes are `REFLECTION_NOT_CONFIGURED` (422), `HF_PROVIDER_ERROR` (502),
  `GROQ_PROVIDER_ERROR` (502), `SHAPE_ERROR` (502).
- CORS headers identical to `analyze-sentiment`.
- **Security (error response hygiene):** Provider error response bodies (from HF or Groq)
  must NEVER be forwarded verbatim to the client. Log full provider error detail to
  `console.error` for Edge Function logs. Return only structured `{ error: string, code: string }`.
  Example:
  ```ts
  // ✅ Correct
  console.error('[generate-reflection] Groq error:', rawBody);
  return json({ error: 'Reflection generation failed. Please try again.', code: 'GROQ_PROVIDER_ERROR' }, 502);
  // ❌ Wrong — never do this:
  return json({ error: rawBody }, 502);
  ```

**Expected Outcomes:**
- Function file exists and compiles without Deno type errors.
- All 15 pipeline steps from the spec are implemented.
- Cache hits return immediately without HF or Groq calls.
- `REFLECTION_NOT_CONFIGURED` returns 422, not 500.
- `_meta.provider = 'groq'` in all stored rows.

**Relevant Context:**
- `supabase/functions/analyze-sentiment/index.ts` — structural template (full file read)

**Status:** [ ] pending

---

### Sub-Task 10 — Update `src/services/insightsService.ts`

**Intent:** Add `generateReflection(entryId)`. The `REFLECTION_NOT_CONFIGURED` case
returns a typed result value (not a thrown error) so the hook can silently fall back
to the legacy sentiment path without showing an error state.

**New export:**
```ts
export type GenerateReflectionResult =
  | { ok: true; data: ReflectionResult }
  | { ok: false; code: 'REFLECTION_NOT_CONFIGURED' };
```

**New method:**
```ts
async generateReflection(entryId: string): Promise<GenerateReflectionResult>
```

Behaviour:
- Calls `supabase.functions.invoke('generate-reflection', { body: { entryId } })`.
- If Edge Function returns code `'REFLECTION_NOT_CONFIGURED'` (parsed from error body,
  same parsing logic as `generateInsight`) → return `{ ok: false, code: 'REFLECTION_NOT_CONFIGURED' }`.
- Any other error → throw `ServiceError` (same as `generateInsight`).
- On success → return `{ ok: true, data: response.result }`.

**Scalability note (add as TODO comment in the method):**
`getInsights` currently fetches all user insights with no upper bound. After one year of
daily journaling with two insight types, this can be 730+ rows. Add:
```ts
// TODO: add LIMIT and pagination support when InsightsPage adds infinite scroll or
// when the user base reaches 1+ year of daily usage. Current cap: unbounded.
```
This is a documentation-only change for Milestone 1 — no functional change to the query.

**Unchanged:** `getInsights`, `generateInsight`, all existing types.

**Relevant Context:**
- `src/services/insightsService.ts` — full file read; `generateInsight` as the pattern
- `src/services/errors.ts` — `ServiceError`, error parsing pattern

**Status:** [ ] pending

---

### Sub-Task 11 — Update `src/features/insights/hooks.ts`

**Intent:** Add `useGenerateReflection`. Extend `useEntryInsight` to separately expose
`reflectionInsight`, `sentimentInsight`, and use the correct model for stale detection.

**`useGenerateReflection()` mutation:**
```ts
mutationFn: async (entryId: string) => {
  const result = await insightsService.generateReflection(entryId);
  if (!result.ok) {
    // REFLECTION_NOT_CONFIGURED — Groq not set up yet.
    // Silently fall back to legacy HF sentiment.
    await insightsService.generateInsight(entryId);
  }
  // result.ok === true: reflection generated. No explicit return needed.
},
onSuccess: () => {
  if (user) queryClient.invalidateQueries({ queryKey: insightKeys.user(user.id) });
},
// onError fires if generateInsight() (fallback) throws, or if generateReflection()
// throws on a non-REFLECTION_NOT_CONFIGURED error. Error is surfaced to component
// via mutation.isError / mutation.error (same as useGenerateInsight).
```

**`useEntryInsight` — extended return type:**
```ts
{
  insight: EntryInsight | undefined;           // reflectionInsight ?? sentimentInsight
  reflectionInsight: EntryInsight | undefined; // type === 'reflection'
  sentimentInsight: EntryInsight | undefined;  // type === 'sentiment'
  isStale: boolean;
}
```

**`isStale` computation — IMPORTANT:**
The source hash must use the model that matches the active insight type:

```ts
const activeInsight = reflectionInsight ?? sentimentInsight;

useEffect(() => {
  if (!savedContent || !settings || !activeInsight) {
    setSavedHash('');
    return;
  }
  // Use reflectionModel for 'reflection' insights, aiModel for 'sentiment' insights.
  const model = activeInsight.type === 'reflection'
    ? settings.reflectionModel
    : settings.aiModel;
  let cancelled = false;
  sha256Hex(sourceEnvelope(savedContent, AI_CONFIG.promptVersion, model))
    .then((h) => { if (!cancelled) setSavedHash(h); });
  return () => { cancelled = true; };
}, [savedContent, settings, activeInsight?.type, activeInsight?.sourceHash]);

const isStale =
  !!activeInsight &&
  savedHash !== '' &&
  (activeInsight.sourceHash === null || savedHash !== activeInsight.sourceHash);
```

**Unchanged:** `insightKeys`, `useInsights`, `useGenerateInsight`, `formatReflectedAt`.

**Relevant Context:**
- `src/features/insights/hooks.ts` — full file read
- `src/entities/insight.ts` — `AI_CONFIG.promptVersion` (updated in Sub-Task 5)
- `src/services/insightsService.ts` — `generateReflection` (Sub-Task 10)

**Status:** [ ] pending

---

### Sub-Task 12 — Redesign AI panel in `src/features/journal/JournalEditor.tsx`

**Intent:** Render the reflection card when `reflectionInsight` exists; fall back to
legacy pill + notice when only `sentimentInsight` exists. Replace the `generateMutation`
reference with `generateReflectionMutation`. All 7 panel states are preserved.

**New hooks/imports to add:**
```ts
import { useGenerateReflection } from '../insights/hooks';
import { isReflectionPayload, type ReflectionPayload } from '../../entities/insight';
// type ReflectionPayload needed for type narrowing inside the render
```

**Replace:**
```ts
// Before:
const generateMutation = useGenerateInsight();
// After:
const generateReflectionMutation = useGenerateReflection();
```

**`useEntryInsight` destructuring update:**
```ts
// Before:
const { insight, isStale } = useEntryInsight(existingEntry?.id, lastSavedContent);
// After:
const { insight, reflectionInsight, sentimentInsight, isStale } =
  useEntryInsight(existingEntry?.id, lastSavedContent);
```

**Derived rendering helpers (inside component):**
```ts
const reflectionData = reflectionInsight && isReflectionPayload(reflectionInsight.payload)
  ? reflectionInsight.payload
  : null;
const sentimentData = sentimentInsight && isSentimentPayload(sentimentInsight.payload)
  ? sentimentInsight.payload
  : null;
```

**State 4 (loading):**
Update to check `generateReflectionMutation.isPending` instead of `generateMutation.isPending`.

**State 5 rendering (fresh insight):**
```tsx
{reflectionData ? (
  <div className="reflection-card">
    <div className="reflection-header">
      <span className="reflection-header-label">Reflection</span>
      <span className="reflection-header-time">
        {formatReflectedAt(reflectionInsight!.createdAt)}
      </span>
    </div>
    <p className="reflection-summary">{reflectionData.summary}</p>
    <div className="reflection-emotions">
      {reflectionData.emotions.map((e) => (
        <span
          key={e.label}
          className={`reflection-emotion-pill ${getEmotionValence(e.label)}`}
        >
          ● {e.label} {Math.round(e.score * 100)}%
        </span>
      ))}
    </div>
    <p className="reflection-themes">
      {reflectionData.themes.join(' · ')}
    </p>
    <div className="reflection-divider" />
    <p
      className="reflection-question"
      onClick={() => appendQuestionToEditor(reflectionData.question)}
      role="button"
      tabIndex={0}
    >
      {reflectionData.question}
    </p>
  </div>
) : sentimentData ? (
  <>
    <div className="ai-panel-result">
      {/* existing pill rendering */}
    </div>
    {!settings?.reflectionConfigured && !isStale && (
      <p className="reflection-richer-notice">
        Richer reflections available —{' '}
        <button type="button" className="ai-panel-link" onClick={() => navigate('/settings')}>
          configure Groq in Settings
        </button>.
      </p>
    )}
  </>
) : null}
```

**`getEmotionValence` helper (add inside component file):**
```ts
const POSITIVE_EMOTIONS = new Set(['joy', 'surprise']);
const NEGATIVE_EMOTIONS = new Set(['anger', 'disgust', 'fear', 'sadness']);
function getEmotionValence(label: string): 'positive' | 'negative' | 'neutral' {
  const l = label.toLowerCase();
  if (POSITIVE_EMOTIONS.has(l)) return 'positive';
  if (NEGATIVE_EMOTIONS.has(l)) return 'negative';
  return 'neutral';
}
```

**`appendQuestionToEditor` — confirmed Lexical pattern (AI panel is outside LexicalComposer):**

`JournalEditor.tsx` has been read in full. The AI panel `<div className="ai-panel">` renders
**before** the `<LexicalComposer>` in the component tree. `useLexicalComposerContext()` cannot
be called from the panel directly — it would throw "cannot find a LexicalComposerContext".

**Required pattern: expose the editor instance via a ref through `InitPlugin`.**

```ts
// 1. In JournalEditor, declare a ref at the top of the component:
import type { LexicalEditor } from 'lexical';
const editorRef = useRef<LexicalEditor | null>(null);

// 2. Update InitPlugin to accept and populate the ref:
interface InitPluginProps {
  initialContent: string;
  onReady: () => void;
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}
function InitPlugin({ initialContent, onReady, editorRef }: InitPluginProps) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  // ... existing initialisation logic unchanged
}

// 3. Pass editorRef to InitPlugin inside LexicalComposer:
<InitPlugin
  initialContent={initialContent}
  onReady={handleEditorReady}
  editorRef={editorRef}
/>

// 4. Define appendQuestionToEditor using the ref:
const appendQuestionToEditor = useCallback((question: string) => {
  editorRef.current?.update(() => {
    const root = $getRoot();
    const emptyPara = $createParagraphNode();
    root.append(emptyPara);
    const questionPara = $createParagraphNode();
    questionPara.append($createTextNode(question));
    root.append(questionPara);
  });
}, []);
```

`$createParagraphNode` and `$createTextNode` are already imported in the file.
`LexicalEditor` type is imported from `'lexical'` (add to the existing Lexical import line).
The `editorRef.current` is `null` before the editor mounts; the `?.` guard handles this safely.

**AiMenu update:**
```ts
// Rename label and point invoke at new mutation:
{
  id: 'generate-insight',
  label: 'Reflect',
  description: 'Generate a reflection on this entry',
  insightType: 'reflection',
  invoke: () => {
    generateReflectionMutation.mutate(existingEntry!.id);
    setMenuOpen(false);
  },
  enabled: !generateReflectionMutation.isPending,
}
```

**State 7 (error):**
```ts
// Replace generateMutation.isError / generateMutation.error with:
generateReflectionMutation.isError / generateReflectionMutation.error
```

**Also required in this sub-task: update `supabase/functions/analyze-sentiment/index.ts`**

The local `AI_CONFIG.promptVersion` in `analyze-sentiment` is currently `'1.0.0'` (line 55
of the file). It must be bumped to `'2.0.0'` to match the client-side `AI_CONFIG` being
updated in Sub-Task 5.

**Why this is critical:** The client's `useEntryInsight` computes `savedHash` using
`promptVersion = '2.0.0'`. If `analyze-sentiment` continues to write rows with
`source_hash` computed from `'1.0.0'`, those rows will never match the client hash — all
`'sentiment'` insights will appear permanently stale, showing "Journal updated since this
insight." even on fresh reflections.

```ts
// In supabase/functions/analyze-sentiment/index.ts, change:
const AI_CONFIG = {
  promptVersion: '1.0.0',  // ← change to '2.0.0'
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;
```

`analyze-sentiment` must be redeployed after this change. Sub-Task 16 already includes
the redeployment step; this addition must be confirmed there.

**Relevant Context:**
- `src/features/journal/JournalEditor.tsx` — full file read; AI panel confirmed outside
  `LexicalComposer`. The `editorRef` pattern described above is the correct implementation.
- `supabase/functions/analyze-sentiment/index.ts` line 55 — `promptVersion: '1.0.0'`
- `src/features/insights/hooks.ts` — `useEntryInsight` updated return type (Sub-Task 11)

**Status:** [ ] pending

---

### Sub-Task 13 — Add CSS to `src/index.css`

**Intent:** Add styles for the reflection card and the fallback notice.
No existing classes are modified.

**Location:** Add after the existing `.ai-stale-notice` class block.

**New classes:**
```css
/* ─── Reflection Card ────────────────────────────────────────── */
.reflection-card {
  /* container; padding, border, border-radius using existing vars */
  padding: var(--space-md);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.reflection-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.reflection-header-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent);
}

.reflection-header-time {
  font-size: 0.73rem;
  color: var(--text-muted);
}

.reflection-summary {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.65;
  margin: 0;
}

.reflection-emotions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs, 0.25rem);
}

.reflection-emotion-pill {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: var(--radius-full, 9999px);
  font-weight: 500;
}
.reflection-emotion-pill.positive {
  background: rgba(74, 222, 128, 0.15);  /* --success tint */
  color: var(--success);
}
.reflection-emotion-pill.negative {
  background: rgba(248, 113, 113, 0.15); /* --danger tint */
  color: var(--danger);
}
.reflection-emotion-pill.neutral {
  background: rgba(86, 83, 79, 0.25);    /* --text-muted tint */
  color: var(--text-muted);
}

.reflection-themes {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.reflection-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: var(--space-xs, 0.25rem) 0;
}

.reflection-question {
  font-size: 0.88rem;
  font-style: italic;
  color: var(--text-secondary);
  cursor: pointer;
  margin: 0;
  line-height: 1.5;
}
.reflection-question:hover {
  color: var(--accent);
}

.reflection-richer-notice {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin-top: var(--space-xs, 0.25rem);
}
```

**Expected Outcomes:**
- No existing styles are broken.
- Reflection card is visually distinct from the editor's writing area.
- Emotion pills are colour-coded by valence (green tint / red tint / grey tint).
- Question is visually italic and cursor changes on hover.

**Relevant Context:**
- `src/index.css` — existing `.ai-panel`, `.ai-stale-notice`, `.sentiment-pill` classes

**Status:** [ ] pending

---

### Sub-Task 14 — Update `src/features/insights/InsightsPage.tsx`

**Intent:** Update `SentimentCard` to handle `ReflectionPayload` rows. Update the
distribution bar to include reflection insights in its counts. The 4 progressive
states and the overall page structure are unchanged.

**`SentimentCard` — updated logic:**
```tsx
function SentimentCard({ insight, entryDate }: SentimentCardProps) {
  const navigate = useNavigate();

  if (isReflectionPayload(insight.payload)) {
    const r = insight.payload;
    const truncated = r.summary.length > 120
      ? r.summary.slice(0, 120) + '…'
      : r.summary;
    const topTwo = [...r.emotions].sort((a, b) => b.score - a.score).slice(0, 2);
    return (
      <div className="insight-card">
        <div style={{ flex: 1 }}>
          {entryDate && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.4rem', fontWeight: 500 }}>
              {formatDisplayDate(entryDate)}
            </div>
          )}
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
            {truncated}
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
            {topTwo.map((e) => (
              <span key={e.label} className={`reflection-emotion-pill ${getEmotionValence(e.label)}`}>
                {e.label}
              </span>
            ))}
          </div>
          <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
            {formatReflectedAt(insight.createdAt)}
          </span>
        </div>
        {entryDate && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => navigate(`/journal/${entryDate}`)}>
            Open entry →
          </button>
        )}
      </div>
    );
  }

  if (isSentimentPayload(insight.payload)) {
    // [existing SentimentCard rendering — completely unchanged]
  }

  return null;
}
```

**`getEmotionValence` helper** — define at the top of the file (same logic as JournalEditor):
```ts
const POSITIVE_EMOTIONS = new Set(['joy', 'surprise']);
const NEGATIVE_EMOTIONS = new Set(['anger', 'disgust', 'fear', 'sadness']);
function getEmotionValence(label: string): 'positive' | 'negative' | 'neutral' {
  const l = label.toLowerCase();
  if (POSITIVE_EMOTIONS.has(l)) return 'positive';
  if (NEGATIVE_EMOTIONS.has(l)) return 'negative';
  return 'neutral';
}
```

Note: this is duplicated from `JournalEditor.tsx`. Do not extract into a shared util
file in this milestone — premature abstraction. The two callsites use the same logic
but are in different features. Deduplication is a future refactor.

**Distribution bar update — `counts` computation:**
```ts
// For each insight in sentimentInsights (existing code, unchanged):
//   counts[s.label]++

// ADD: for each reflection insight:
const reflectionInsights = (insights ?? []).filter(
  (i) => i.type === 'reflection' && isReflectionPayload(i.payload)
);

for (const insight of reflectionInsights) {
  const payload = insight.payload as ReflectionPayload;
  const pos = payload.emotions
    .filter(e => POSITIVE_EMOTIONS.has(e.label.toLowerCase()))
    .reduce((s, e) => s + e.score, 0);
  const neg = payload.emotions
    .filter(e => NEGATIVE_EMOTIONS.has(e.label.toLowerCase()))
    .reduce((s, e) => s + e.score, 0);
  const neu = payload.emotions
    .filter(e => e.label.toLowerCase() === 'neutral')
    .reduce((s, e) => s + e.score, 0);
  if (pos >= neg && pos >= neu) counts.positive++;
  else if (neg >= pos && neg >= neu) counts.negative++;
  else counts.neutral++;
}
```

The `total` used for the distribution bar proportions = `counts.positive + counts.neutral + counts.negative`.

**Updated imports to add:**
```ts
import { isReflectionPayload, type ReflectionPayload } from '../../entities/insight';
```

**Relevant Context:**
- `src/features/insights/InsightsPage.tsx` — full structure read
- `src/entities/insight.ts` — `isReflectionPayload`, `ReflectionPayload` (Sub-Task 5)

**Status:** [ ] pending

---

### Sub-Task 15 — Update `README.md`

**Intent:** Document the Milestone 1 architecture so that a new engineer joining the
project can understand the full AI pipeline without relying on undocumented context.

**Sections to add/update under `## AI Insights`:**

Add `### Milestone 1 — Foundation of Reflection` containing:

1. **Overview paragraph**: two-provider architecture — HF for emotion classification,
   Groq for reflection generation. Explicit about which Edge Function handles each.

2. **`ReflectionPayload` shape** (the full stored JSON schema with field descriptions).

3. **`generate-reflection` call flow**: numbered list matching the 15-step pipeline
   in this plan.

4. **Groq endpoint**: `https://api.groq.com/openai/v1/chat/completions` (hardcoded).
   Note that it is OpenAI-compatible but Groq-specific. No configurable base URL in
   this milestone.

5. **Two-token setup**: HF token for emotion analysis, Groq token for reflection
   generation. Each is AES-256-GCM encrypted by `encrypt-token` using the `provider`
   parameter. Users configure both in Settings → "AI Configuration".

6. **`encrypt-token` `provider` parameter**: document `'hf'` vs `'groq'` values and
   which DB column each writes to.

7. **Fallback behaviour**: if Groq token is not configured, Reflect falls back to
   `analyze-sentiment` (HF only), generating a `'sentiment'` insight. Panel shows
   the legacy pill with a "configure Groq" notice.

8. **`AI_CONFIG.promptVersion` bump note**: `'1.0.0'` → `'2.0.0'`. Explains that
   all cached `'sentiment'` source hashes become stale. Users see "Re-reflect" on
   next visit. This is intentional.

9. **Database migrations table**: update to include 003 and 004.

10. **Naming reference**: point reader to `foundation-of-reflection-plan.md` for the
    full naming reference table.

**Sections to update:**
- "How it works" — add a note about `generate-reflection` as a second path.
- "Token setup" — update to describe two tokens (HF + Groq).
- "Database migrations" table — add 003 and 004 rows.
- `AI_CONFIG` note — update promptVersion to `'2.0.0'`.

**Status:** [ ] pending

---

### Sub-Task 16 — Verify, build, commit, and push

**Intent:** Validate the full implementation before pushing the branch.

**Todo:**
1. `npm run lint` — zero errors.
2. `npm run build` — zero TypeScript or build errors.
3. `npm run test` — zero test regressions.
4. `npm run dev` — manually verify every user-facing state:

   **Settings page:**
   - [ ] Section heading is "AI Configuration".
   - [ ] HF sub-section works identically to before.
   - [ ] "Configure Groq below" notice appears when HF configured + Groq not.
   - [ ] Groq API key can be saved (token status shows "✓ Token configured").
   - [ ] Groq API key can be replaced (Replace → new input → Save New Token → confirm).
   - [ ] Groq model input is pre-filled from settings and can be saved.
   - [ ] No provider name field, no base URL field visible.

   **Journal editor — AI panel:**
   - [ ] Panel hidden until entry is saved.
   - [ ] "Configure your AI token in Settings" notice when neither token configured.
   - [ ] "Reflect ▾" button when AI configured but no insight exists.
   - [ ] Spinner + "Reflecting…" during generation.
   - [ ] Reflection card renders (summary, emotions, themes, question) when Groq configured.
   - [ ] Legacy sentiment pill renders when only HF configured.
   - [ ] "Richer reflections available — configure Groq in Settings." notice shows on
     legacy pill when Groq not configured (and insight is fresh, not stale).
   - [ ] Notice absent when stale.
   - [ ] Clicking the question appends it to the editor.
   - [ ] Stale notice appears after editing the entry.
   - [ ] Error state shows on provider errors; auto-clears.
   - [ ] "Re-reflect ▾" triggers re-generation.

   **Insights page:**
   - [ ] Reflection insight cards show summary + top-2 emotion pills + "Open entry →".
   - [ ] Legacy sentiment insight cards unchanged.
   - [ ] Distribution bar includes reflection insights in counts.
   - [ ] All 4 progressive states (no entries, no AI, no reflections, dashboard) work.

5. Run migration SQL in Supabase SQL Editor (migrations 003 + 004 in order).
6. Deploy updated `encrypt-token` Edge Function.
7. Deploy updated `analyze-sentiment` Edge Function (`promptVersion` bumped to `'2.0.0'`
   in Sub-Task 12 — **required** to prevent all sentiment insights becoming permanently stale).
8. Deploy new `generate-reflection` Edge Function.
9. Re-verify the reflection flow end-to-end with real Groq API call.
9. `git add -A`
10. `git commit -m "feat: milestone 1 — foundation of reflection"`
11. `git push origin feature/foundation-of-reflection`
12. Do NOT merge into main.

**Status:** [ ] pending

---

## Implementation order

```
Sub-Task 1  (branch)
     ↓
Sub-Task 2  (DB: insights table)      ← run SQL manually after creating file
Sub-Task 3  (DB: user_settings)       ← run SQL manually after creating file
     ↓
Sub-Task 4  (encrypt-token Fn)
Sub-Task 5  (entities/insight.ts)     [parallel with Sub-Task 4]
     ↓
Sub-Task 6  (settingsService.ts)      ← needs Sub-Task 5 (ReflectionResult types)
Sub-Task 9  (generate-reflection Fn)  ← needs Sub-Task 4 (column names confirmed)
     ↓
Sub-Task 7  (settings/hooks.ts)       ← needs Sub-Task 6
Sub-Task 10 (insightsService.ts)      ← needs Sub-Task 5 (ReflectionResult)
     ↓
Sub-Task 8  (SettingsPage.tsx)        ← needs Sub-Task 7
Sub-Task 11 (insights/hooks.ts)       ← needs Sub-Task 10
     ↓
Sub-Task 12 (JournalEditor.tsx)       ← needs Sub-Task 11 + 13
Sub-Task 13 (index.css)               [can start parallel with Sub-Task 12]
Sub-Task 14 (InsightsPage.tsx)        ← needs Sub-Task 5 + 11
     ↓
Sub-Task 15 (README.md)
     ↓
Sub-Task 16 (verify + build + push)
```

---

## What is NOT changing

- Mood picker — completely untouched
- Autosave — completely untouched
- Lexical editor configuration — untouched (question-append is a new Lexical command,
  not a configuration change)
- Sync engine — completely untouched
- Auth flow — completely untouched
- RLS policies — no changes needed (service-role writes cover all insight types)
- `journalService.ts` / `journal/hooks.ts` — completely untouched
- `hf_model`, `hf_token_encrypted` DB columns — not renamed
- `analyze-sentiment` Edge Function — unchanged; used as fallback path
- `isSentimentPayload` / `SentimentPayload` / `SentimentResult` — unchanged
- `useGenerateInsight` hook — unchanged; called inside `useGenerateReflection` as fallback
- All existing RLS policies on `insights` — unchanged

---

## Self-review checklist (resolved issues)

All 14 issues from the design review plus 5 issues from the final architectural
production-readiness review have been resolved in this version:

**Design review (14 issues):**

1. ✅ All `openai_*` references replaced with `groq_*`
2. ✅ Settings UI uses "AI Configuration" + sub-sections; no "AI Providers" framing
3. ✅ `encrypt-token` uses `'hf' | 'groq'` (not `'hf' | 'openai'`)
4. ✅ `settingsService.saveLLMToken()` replaced with `saveGroqToken()`; calls `provider: 'groq'`
5. ✅ `updateLLMSettings(userId, baseUrl, model)` replaced with `updateGroqModel(userId, model)`;
   `openai_base_url` removed entirely
6. ✅ `UserSettings.reflectionBaseUrl` removed; only `reflectionConfigured` + `reflectionModel`
7. ✅ `useUpdateLLMSettings` replaced with `useUpdateGroqModel()`; no baseUrl parameter
8. ✅ Overview updated: Settings UI explicitly names HF and Groq; abstraction is deferred
9. ✅ Edge Function uses hardcoded Groq endpoint; `openai_base_url` removed from pipeline
10. ✅ `_meta.provider = 'groq'` explicitly specified
11. ✅ DB constraint migration uses `DO $$` block to locate and drop the anonymous inline
    CHECK before adding the named replacement
12. ✅ `useGenerateReflection` error behaviour fully specified; component uses
    `generateReflectionMutation` for all loading/error states
13. ✅ `isStale` computation explicitly uses `reflectionModel` for reflection insights
    and `aiModel` for sentiment insights; documented in Sub-Task 11
14. ✅ `llmBaseUrl` state variable removed from Sub-Task 8; `groqModelInput` and
    `groqModelSaved` added instead

**Architectural production-readiness review (5 issues):**

15. ✅ `groqModelInput` initialization uses `hasInitialized` ref to prevent settings
    refetch from overwriting a typed-but-not-yet-saved model value (Sub-Task 8)
16. ✅ NULL uniqueness gap for future weekly summary rows documented in Migration 003;
    partial unique index noted as required when summary insights are implemented (Sub-Task 2)
17. ✅ `getInsights()` unbounded growth documented with TODO comment in Sub-Task 10;
    no functional change for Milestone 1
18. ✅ `encrypt-token` error response body no longer leaks `detail: updateError.message`
    to the client (Sub-Task 4)
19. ✅ `generate-reflection` error response hygiene explicitly specified: provider error
    bodies logged server-side, never forwarded verbatim to client (Sub-Task 9)
