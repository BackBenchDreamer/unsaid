# AI Insights Architecture Plan

## Philosophy (non-negotiable)

Writing is the primary experience. AI is a quiet enhancement.

- Autosave = persistence only. AI never runs automatically.
- "Reflect" = explicit user action, after writing is done.
- Cache every analysis — never re-infer what hasn't changed.
- AI should feel like thoughtful reflection, not background automation.
- Respect the user's attention and AI quota equally.
- Provider-specific logic stays isolated inside Edge Functions.
  The client never knows whether inference comes from HuggingFace,
  OpenAI, Anthropic, Gemini, Ollama, or any future provider.

---

## Architecture overview

```
Write entry → autosave (persistence only)
                    ↓
         Entry exists in DB (existingEntry.id is non-null)
                    ↓
         User opens "Reflect" menu → selects action (explicit)
                    ↓
         Edge Function:
           sourceHash(content, promptVersion, model) == stored source_hash?
             → return cached insight immediately (no inference call)
           hash differs or no insight?
             → call AI provider, store { payload: { ...result, _meta }, source_hash }
                    ↓
         Insight stored with type="sentiment" + source_hash
                    ↓
         Editor shows pill + relative time + stale notice if saved content changed
                    ↓
         Insights page aggregates all past insights → dashboard
```

---

## Key design decisions

### Provider-agnostic naming

Client-facing types and UI copy never reference a specific AI provider.
DB columns (`hf_token_encrypted`, `hf_model`) keep their names — a migration
would be disproportionate. Only the *TypeScript mapping* in `UserSettings`
uses provider-agnostic names:

| DB column          | `UserSettings` field |
|--------------------|----------------------|
| `hf_token_encrypted` | — (never returned to client) |
| `hf_model`         | `aiModel: string`    |
| computed           | `aiConfigured: boolean` |

`settingsService.ts`: `settingsFromRow` maps `hf_model → aiModel` and
`hf_token_encrypted !== null → aiConfigured`.

`SettingsPage.tsx`: replaces `settings?.hasHFToken` with `settings?.aiConfigured`
and `settings?.hfModel` with `settings?.aiModel`.

### Centralised AI configuration — `AI_CONFIG`

A single object in `src/entities/insight.ts` replaces the scattered `PROMPT_VERSION`:

```ts
export const AI_CONFIG = {
  promptVersion: '1.0.0',
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;
```

- `AI_CONFIG.promptVersion` is used by `useEntryInsight` to build the source envelope.
- `AI_CONFIG.defaultModel` is a fallback only — the actual model comes from `settings.aiModel`.
- The Edge Function has a local `AI_CONFIG` mirror (Deno cannot import from `src/`).
  It is intentional that it must be bumped separately when the Edge Function is redeployed.
  The two versions should stay in sync — a comment in the Edge Function points back to
  `src/entities/insight.ts` as the canonical source.

### source_hash over content_hash

`source_hash` is a SHA-256 hex digest of a deterministic JSON envelope of
every input that influences AI output:

```ts
const envelope = sourceEnvelope(
  entry.content,
  AI_CONFIG.promptVersion,
  settings.aiModel,
);
const source_hash = await sha256Hex(envelope);
```

When any of content, prompt version, or model changes, the hash changes
automatically. No new schema columns needed.

### SHA-256 everywhere — no djb2

`crypto.subtle.digest('SHA-256', …)` is natively available in both browsers
(Web Crypto API) and Deno with identical semantics. No dependency.
The client-side stale detection runs post-autosave (not on keystrokes),
so async SHA-256 is entirely acceptable. djb2 is not used anywhere.

### prompt_version + model + generationMs stored in payload._meta

```json
{
  "score": 0.4,
  "label": "positive",
  "confidence": 0.78,
  "_meta": {
    "promptVersion": "1.0.0",
    "model": "j-hartmann/emotion-english-distilroberta-base",
    "generatedAt": "2026-07-03T08:00:00Z",
    "generationMs": 842
  }
}
```

`generationMs` measures wall-clock time from HF call start to response.
It is 0 for cache hits (no inference occurred).
These keys make every insight row self-describing and support future
analytics (cache hit rate, inference latency, quota consumed).

### Cache observability — response wrapper

The Edge Function returns a response envelope instead of the bare result:

```json
{
  "result": { "score": 0.4, "label": "positive", "confidence": 0.78 },
  "meta": { "cached": true, "generationMs": 0 }
}
```

`insightsService.generateInsight()` returns `SentimentResult` (extracted from
`data.result`). The `meta` is logged at debug level for observability but
not surfaced in the UI.

`cached: true` = identical source_hash found → no HF call made.
`cached: false` + `generationMs > 0` = fresh inference.

### "Reflect" as a true extension point

`AiAction` interface:

```ts
export interface AiAction {
  id: string;
  label: string;
  description?: string;
  insightType: InsightType;
  invoke: () => void;
  enabled: boolean;           // replaces optional disabled
  disabledReason?: string;    // shown as tooltip or subtext when !enabled
}
```

v1 menu built with all four actions registered:

| id | label | enabled | disabledReason |
|---|---|---|---|
| `generate-insight` | Generate Insight | true | — |
| `summarize-entry` | Summarize Entry | false | `'Coming soon'` |
| `reflection-prompt` | Reflection Prompt | false | `'Coming soon'` |
| `find-patterns` | Find Patterns | false | `'Coming soon'` |

Adding a new capability later = add an Edge Function + flip `enabled: true`.
No changes to `AiMenu`, `JournalEditor`, or the trigger button.

### Relative time display

The AI panel shows relative time via `date-fns/formatDistanceToNow`:

| Time since reflection | Displayed as |
|---|---|
| < 1 minute | Reflected just now |
| < 24 hours | Reflected today |
| 1 day ago | Reflected yesterday |
| 2–6 days | Reflected N days ago |
| 7+ days | Reflected N weeks ago |

Implemented via a small helper `formatReflectedAt(isoString): string`.

### Modular Edge Function structure

One Edge Function per AI capability — each in its own `supabase/functions/` directory:

```
supabase/functions/
  analyze-sentiment/index.ts   ← v1 (exists)
  generate-summary/index.ts    ← v2 (future)
  reflection-prompt/index.ts   ← v3 (future)
  find-patterns/index.ts       ← v4 (future)
  encrypt-token/index.ts       ← exists
  approve-waitlist/index.ts    ← exists
```

Internally, `analyze-sentiment/index.ts` is structured with a thin
`Deno.serve` handler that delegates to a `generateSentiment()` function.
Provider interaction is isolated inside that function, not mixed with
auth/validation logic.

### source_hash nullability + future versioning

`source_hash` is nullable in v1 to preserve existing data (pre-migration
insights have no hash and will show as stale until re-reflected).

Future migration (after all historical insights regenerated):
```sql
ALTER TABLE public.insights
  ALTER COLUMN source_hash SET NOT NULL;
```

**Reflection versioning TODO:**
The current `UNIQUE(user_id, entry_id, type)` constraint enforces LWW
(Last-Write-Wins) — re-reflecting overwrites the previous insight. This is
intentional for v1. A future versioning feature would require:
1. Dropping `uq_insight_entry_type`
2. Adding a `reflected_at TIMESTAMPTZ DEFAULT now()` column (or `version INT`)
3. Changing upserts to inserts in the Edge Function
4. The Insights dashboard aggregating the latest per `(entry_id, type)`
This is a schema migration, not an application-only change. Plan accordingly.

---

## Database changes

### insights table — add source_hash + UNIQUE constraint

```sql
-- source_hash: SHA-256 of sourceEnvelope(content, promptVersion, model)
-- Nullable for existing rows; source of truth for cache invalidation.
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- Enables idempotent upsert ON CONFLICT (user_id, entry_id, type).
-- NOTE (future versioning): dropping this constraint is required before
-- supporting multiple reflections per entry.
ALTER TABLE public.insights
  ADD CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type);
```

Local schema file `src/db/schema.sql` must be updated to match.

---

## Implementation order

Sub-tasks are ordered by dependency:

1. **Sub-Task 1** — `src/shared/utils/hash.ts` (sha256Hex + sourceEnvelope)
2. **Sub-Task 2** — DB migration (run in Supabase SQL Editor — manual step)
3. **Sub-Task 3** — `src/db/schema.sql` local sync
4. **Sub-Task 4** — `src/entities/insight.ts` (AI_CONFIG, InsightType, EntryInsight, SentimentPayload, AiAction, InsightMeta, isSentimentPayload)
5. **Sub-Task 5** — `src/services/settingsService.ts` + `UserSettings` (aiConfigured, aiModel)
6. **Sub-Task 6** — `src/features/settings/SettingsPage.tsx` (update field references)
7. **Sub-Task 7** — `src/services/insightsService.ts` (entry_id + source_hash in SELECT; rename generateInsight; response envelope)
8. **Sub-Task 8** — `src/features/insights/hooks.ts` (insightKeys, useInsights, useEntryInsight, useGenerateInsight)
9. **Sub-Task 9** — `src/features/journal/JournalEditor.tsx` AI panel + AiMenu
10. **Sub-Task 10** — `src/features/journal/HistoryPage.tsx` sentiment pills
11. **Sub-Task 11** — `src/features/insights/InsightsPage.tsx` 4-state dashboard
12. **Sub-Task 12** — `supabase/functions/analyze-sentiment/index.ts` (source_hash + cache check + _meta + response envelope)
13. **Sub-Task 13** — `src/index.css` additions (can run in parallel with Sub-Task 9)

---

## What is NOT changing

- Autosave — completely untouched
- Mood selector — completely untouched
- Tag management — completely untouched
- Lexical editor — completely untouched
- `journalService.ts` — completely untouched
- `journal/hooks.ts` — completely untouched
- Sync engine — completely untouched
- Auth flow — completely untouched
- DB column names (`hf_model`, `hf_token_encrypted`) — renaming only in TypeScript mapping
- RLS policies — no changes needed

---

## Sub-Task 1: Create `src/shared/utils/hash.ts`

**Intent:**
Two exports shared between the browser client and the Edge Function:
- `sha256Hex(input)` — async SHA-256 via Web Crypto API
- `sourceEnvelope(content, promptVersion, model)` — deterministic JSON serialisation
  ensuring hash parity between client and Edge Function with zero drift risk

`crypto.subtle` is native in both browsers and Deno — no imports needed.

**New file:** `src/shared/utils/hash.ts`

```ts
/**
 * SHA-256 hashing utilities for AI source-hash computation.
 *
 * Uses Web Crypto API — available natively in browsers and Deno.
 * No external dependencies.
 */

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the deterministic envelope hashed to produce source_hash.
 * Every input that influences AI output must appear here.
 * Changing any field automatically invalidates all cached hashes
 * that were computed with different values.
 */
export function sourceEnvelope(
  content: string,
  promptVersion: string,
  model: string,
): string {
  return JSON.stringify({ content, promptVersion, model });
}
```

**Expected outcomes:**
- `sha256Hex` returns a deterministic 64-character hex string
- `sourceEnvelope` produces stable, ordered JSON
- Identical inputs → identical hashes on client and Deno

**Status:** [ ] pending

---

## Sub-Task 2: Run DB migration in Supabase SQL Editor

**Intent:**
Apply schema changes to the live database before any client code or Edge
Function attempts to read/write `source_hash` or rely on the unique constraint.

**SQL to run (copy-paste into Supabase SQL Editor):**
```sql
-- source_hash: SHA-256 of sourceEnvelope(content, promptVersion, model)
-- Nullable: existing insight rows have NULL; will be set on next Reflect.
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- Enables idempotent upsert ON CONFLICT (user_id, entry_id, type).
-- FUTURE NOTE: drop this constraint before implementing reflection versioning.
ALTER TABLE public.insights
  ADD CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type);
```

**Expected outcomes:**
- `public.insights` has a nullable `source_hash TEXT` column
- `UNIQUE(user_id, entry_id, type)` constraint exists
- Existing rows have `source_hash = NULL` (not broken — treated as always-stale)

**Status:** [ ] pending

---

## Sub-Task 3: Update `src/db/schema.sql`

**Intent:**
Keep the local schema file in sync with the live DB.

**Changes:**
- In the `public.insights` table definition, add `source_hash TEXT` column
- Add `CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type)` inline
- Add a comment pointing to the future versioning note

**Status:** [ ] pending

---

## Sub-Task 4: Update `src/entities/insight.ts`

**Intent:**
Define the canonical AI configuration object and extend the type system.
This file is the single source of truth for AI configuration on the client.

**Complete new contents of `src/entities/insight.ts`:**

```ts
// ─── AI Configuration ────────────────────────────────────────

/**
 * Canonical AI configuration for UnSaid.
 *
 * promptVersion: bump this string whenever prompt logic changes in the
 *   Edge Function. All existing source_hash values become stale automatically —
 *   users will see "Re-reflect" on their next visit.
 *
 * defaultModel: fallback if user has not set a model in settings.
 *   The actual model used comes from settings.aiModel (user_settings.hf_model).
 *
 * EDGE FUNCTION NOTE: supabase/functions/analyze-sentiment/index.ts has a
 *   local AI_CONFIG mirror. Keep them in sync when bumping promptVersion.
 */
export const AI_CONFIG = {
  promptVersion: '1.0.0',
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;

// ─── Insight types ───────────────────────────────────────────

/**
 * InsightType is open for extension: adding a new type requires
 * a new Edge Function + adding the type to this union.
 * No schema change needed — `type` CHECK constraint already covers
 * 'sentiment' | 'summary' | 'pattern'.
 */
export type InsightType = 'sentiment' | 'summary' | 'pattern';

/**
 * Stored inside every insight payload._meta.
 * Makes each DB row self-describing — no need to join other tables
 * to understand how an insight was generated.
 */
export interface InsightMeta {
  promptVersion: string;  // e.g. "1.0.0"
  model: string;          // AI model identifier (provider-specific internally)
  generatedAt: string;    // ISO 8601 timestamp
  generationMs: number;   // wall-clock ms for the inference call; 0 = cache hit
}

/** Typed payload for type='sentiment'. */
export interface SentimentPayload {
  score: number;           // -1 to 1
  label: 'negative' | 'neutral' | 'positive';
  confidence: number;      // 0 to 1
  _meta: InsightMeta;
}

/** Edge Function wire return type (no _meta — client only needs result). */
export interface SentimentResult {
  score: number;
  label: 'negative' | 'neutral' | 'positive';
  confidence: number;
}

/** A typed DB row from the insights table. */
export interface EntryInsight {
  id: string;
  entryId: string | null;
  type: InsightType;
  payload: Record<string, unknown>;
  sourceHash: string | null;  // SHA-256 of sourceEnvelope(content, promptVersion, model)
  createdAt: string;
}

/** Type-narrowing guard for SentimentPayload. */
export function isSentimentPayload(p: Record<string, unknown>): p is SentimentPayload {
  return typeof p.score === 'number'
    && typeof p.label === 'string'
    && typeof p.confidence === 'number';
}

/**
 * A single item in the "Reflect" AI menu.
 *
 * v1 menu items:
 *   { id: 'generate-insight',   label: 'Generate Insight',    enabled: true }
 *   { id: 'summarize-entry',    label: 'Summarize Entry',     enabled: false, disabledReason: 'Coming soon' }
 *   { id: 'reflection-prompt',  label: 'Reflection Prompt',   enabled: false, disabledReason: 'Coming soon' }
 *   { id: 'find-patterns',      label: 'Find Patterns',       enabled: false, disabledReason: 'Coming soon' }
 *
 * Adding a new capability requires only: a new Edge Function + flipping enabled: true.
 * No changes to AiMenu or JournalEditor are needed.
 */
export interface AiAction {
  id: string;
  label: string;
  description?: string;
  insightType: InsightType;
  invoke: () => void;
  enabled: boolean;
  disabledReason?: string;  // shown as subtext when !enabled
}

// ─── Memory + Heatmap (unchanged) ────────────────────────────

export interface Memory {
  id: string;
  entryDate: string;
  snippet: string;
  mood: string | null;
  daysAgo: number;
}

export interface HeatmapCell {
  date: string;  // "YYYY-MM-DD"
  count: number; // 0 or 1
  mood: string | null;
}
```

**Status:** [ ] pending

---

## Sub-Task 5: Update `src/services/settingsService.ts`

**Intent:**
Make `UserSettings` provider-agnostic. The DB column names stay as-is;
only the TypeScript mapping is renamed.

**Changes to `UserSettings` interface:**
- `hasHFToken: boolean` → `aiConfigured: boolean`
- `hfModel: string` → `aiModel: string`

**Changes to `settingsFromRow`:**
- `hasHFToken: row.hf_token_encrypted !== null` → `aiConfigured: row.hf_token_encrypted !== null`
- `hfModel: row.hf_model` → `aiModel: row.hf_model`

**No other changes.** `settingsService.saveHFToken`, `settingsService.hasHFToken` —
method names stay as-is (they're internal implementation details of the HF provider,
isolated inside the service).

**Status:** [ ] pending

---

## Sub-Task 6: Update `src/features/settings/SettingsPage.tsx`

**Intent:**
Update all field references to use the renamed `UserSettings` fields.

**Changes:**
- `settings?.hasHFToken` → `settings?.aiConfigured` (2 occurrences)
- `settings?.hfModel` → `settings?.aiModel` (1 occurrence)

**Status:** [ ] pending

---

## Sub-Task 7: Update `src/services/insightsService.ts`

**Intent:**
Align the service with new entity types and the response envelope from the Edge Function.

**Changes:**
- Import `type EntryInsight, type SentimentResult` from `../entities/insight`
- `getInsights` SELECT: `'id, entry_id, type, payload, source_hash, created_at'`
- `getInsights` internal row type: add `entry_id: string | null` and `source_hash: string | null`
- `getInsights` map: add `entryId: r.entry_id, sourceHash: r.source_hash`
- `getInsights` return type: `Promise<EntryInsight[]>`
- Rename `analyzeEntrySentiment` → `generateInsight(entryId: string): Promise<SentimentResult>`
- `generateInsight`: extract `data.result` from the response envelope; log `data.meta` at debug

**Status:** [ ] pending

---

## Sub-Task 8: Create `src/features/insights/hooks.ts`

**Intent:**
Centralise all insights data-fetching and mutation logic. Pattern mirrors
`journalKeys` / `useUpsertEntry` from `src/features/journal/hooks.ts`.

**`insightKeys` factory:**
```ts
export const insightKeys = {
  all: ['insights'] as const,
  user: (userId: string) => [...insightKeys.all, userId] as const,
};
```

**`useInsights()`**
- Fetches `insightsService.getInsights(userId)` for the current user
- `enabled: !!user`
- Used by: InsightsPage, HistoryPage, useEntryInsight

**`useEntryInsight(entryId, savedContent)`**
- `entryId: string | undefined`, `savedContent: string`
- Derives insight from `useInsights()` data — no extra network call
- `savedContent` = last successfully saved content (not live keystrokes)
- Stale detection (async SHA-256):
  ```ts
  const { data: settings } = useSettings();
  const [savedHash, setSavedHash] = useState('');
  useEffect(() => {
    if (!savedContent || !settings) return;
    sha256Hex(sourceEnvelope(
      savedContent,
      AI_CONFIG.promptVersion,
      settings.aiModel,
    )).then(setSavedHash);
  }, [savedContent, settings]);
  const isStale = !!insight && !!insight.sourceHash
    && savedHash !== '' && savedHash !== insight.sourceHash;
  ```
- Returns `{ insight: EntryInsight | undefined, isStale: boolean }`

**`useGenerateInsight()`**
- `mutationFn: (entryId: string) => insightsService.generateInsight(entryId)`
- `onSuccess`: invalidates `insightKeys.user(userId)`
- Error is surfaced as-is (Edge Function returns readable message strings)

**`formatReflectedAt(isoString: string): string`** — local helper using `date-fns`:
```ts
// < 1 min   → "Reflected just now"
// same day  → "Reflected today"
// yesterday → "Reflected yesterday"
// ≤ 6 days  → "Reflected N days ago"
// ≥ 7 days  → "Reflected N weeks ago"
```

**Status:** [ ] pending

---

## Sub-Task 9: Update `src/features/journal/JournalEditor.tsx` — AI panel + AiMenu

**Intent:**
Add the AI reflection panel and the extensible AiMenu. Writing experience
is completely unchanged.

### `lastSavedContentRef` wiring
- `const lastSavedContentRef = useRef('')`
- Seeded in `useEffect` that watches `existingEntry`: `lastSavedContentRef.current = existingEntry.content`
- Updated in `saveEntry()` after `mutateAsync` resolves: `lastSavedContentRef.current = content`
- Passed to `useEntryInsight` as `savedContent={lastSavedContentRef.current}`

### AiMenu component (same file or `AiMenu.tsx`)
- Props: `actions: AiAction[]`, `isOpen: boolean`, `onClose: () => void`
- Renders popover anchored below trigger
- Each `action`: label + optional `disabledReason` subtext when `!action.enabled`
- Closes on outside click (document mousedown listener in `useEffect`)
- Bottom of popover: footer text "More coming soon" only if any disabled items

### AI panel states (7 states, in render order)
```
1. !existingEntry         → nothing rendered
2. !settings.aiConfigured → notice + [Open Settings →]
3. hasToken, no insight, idle → [✦ Reflect ▾] → AiMenu
4. generateMutation.isPending → [Reflecting…] disabled + spinner
5. insight exists, NOT stale → pill + formatReflectedAt + [View insights →] + [↻ Re-reflect ▾]
6. insight exists, IS stale → dimmed pill + "Journal updated since this insight" + [↻ Re-reflect ▾]
7. generateMutation.isError → inline error (auto-clears after 5s)
```

### v1 AiAction array (built inside JournalEditor)
```ts
const aiActions: AiAction[] = [
  {
    id: 'generate-insight',
    label: 'Generate Insight',
    description: 'Analyse the emotional tone of this entry',
    insightType: 'sentiment',
    invoke: () => { generateMutation.mutate(existingEntry.id); setMenuOpen(false); },
    enabled: !generateMutation.isPending,
  },
  {
    id: 'summarize-entry',
    label: 'Summarize Entry',
    insightType: 'summary',
    invoke: () => {},
    enabled: false,
    disabledReason: 'Coming soon',
  },
  {
    id: 'reflection-prompt',
    label: 'Reflection Prompt',
    insightType: 'pattern',
    invoke: () => {},
    enabled: false,
    disabledReason: 'Coming soon',
  },
  {
    id: 'find-patterns',
    label: 'Find Patterns',
    insightType: 'pattern',
    invoke: () => {},
    enabled: false,
    disabledReason: 'Coming soon',
  },
];
```

### Imports to add
```ts
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../settings/hooks';
import { useEntryInsight, useGenerateInsight, formatReflectedAt } from '../insights/hooks';
import { isSentimentPayload, MOOD_EMOJIS } from '../../entities/insight';
import type { AiAction } from '../../entities/insight';
```

Note: `MOOD_EMOJIS` already imported from constants — no duplicate.

### No changes to
- Autosave logic, debounce, mood/tags save timer
- Mood selector or tag management
- Lexical editor configuration or plugins

**Status:** [ ] pending

---

## Sub-Task 10: Update `src/features/journal/HistoryPage.tsx` — sentiment pills

**Intent:**
Read-only sentiment pills on entry cards that have been analysed.
No Reflect button on History — analysis is intentional and done from the editor.

**Changes:**
- `import { useInsights } from '../insights/hooks'`
- `import { isSentimentPayload } from '../../entities/insight'`
- `import type { EntryInsight } from '../../entities/insight'`
- Remove `useAuth` import if only used for userId (useInsights handles auth internally)
- `const { data: insights } = useInsights()`
- `const insightByEntryId = useMemo(() => { const m = new Map<string, EntryInsight>(); (insights ?? []).forEach(i => { if (i.entryId) m.set(i.entryId, i); }); return m; }, [insights])`
- After each entry card's tags row: look up insight, render sentiment pill if `isSentimentPayload`

**Status:** [ ] pending

---

## Sub-Task 11: Redesign `src/features/insights/InsightsPage.tsx`

**Intent:**
Remove UUID form entirely. Progressive disclosure based on user journey state.

**Four states (evaluated in order):**

**State A — no entries**
- Detected: `entries.length === 0` using `useEntries(1)`
- "Write your first journal entry to begin discovering patterns." + [Go to Journal]

**State B — entries exist, AI not configured**
- Detected: `!settings?.aiConfigured`
- "AI Insights not enabled. Configure your AI token to unlock emotional analysis." + [Open Settings]

**State C — AI configured, no insights**
- Detected: `insights.length === 0`
- "✦ Nothing reflected yet. Open any journal entry and press Reflect." + [Go to Journal]

**State D — insights exist (dashboard)**
- Page title: "Insights" / subtitle: "Emotional patterns from your writing."
- Mood distribution bar: three proportional flex segments (positive / neutral / negative)
  derived from insights with `isSentimentPayload` payloads
- Distribution labels: "N positive · N neutral · N negative"
- Recent reflections list: `SentimentCard` per insight
  - `formatDisplayDate(entryDate)` — entry date from `entriesById: Map<entryId, entryDate>`
  - Sentiment pill + confidence %
  - `formatReflectedAt(insight.createdAt)`
  - [Open entry →] navigates to `/journal/{entryDate}`

**Imports:**
```ts
import { useInsights, formatReflectedAt } from './hooks';
import { useSettings } from '../settings/hooks';
import { useEntries } from '../journal/hooks';
import { useNavigate } from 'react-router-dom';
import { isSentimentPayload } from '../../entities/insight';
import { formatDisplayDate } from '../../shared/utils/dates';
```

**Status:** [ ] pending

---

## Sub-Task 12: Update `supabase/functions/analyze-sentiment/index.ts`

**Intent:**
Add source_hash caching, `_meta` storage, `generationMs` measurement, response
envelope with `cached` flag, and a modular internal structure.

### Local AI_CONFIG mirror
```ts
// Mirror of src/entities/insight.ts AI_CONFIG.
// Keep in sync when bumping promptVersion or defaultModel.
const AI_CONFIG = {
  promptVersion: '1.0.0',
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;
```

### sha256Hex + sourceEnvelope (inlined — Deno cannot import from src/)
```ts
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sourceEnvelope(content: string, promptVersion: string, model: string): string {
  return JSON.stringify({ content, promptVersion, model });
}
```

### Modular internal structure
```ts
async function generateSentiment(
  content: string,
  hfToken: string,
  model: string,
): Promise<{ result: SentimentResult; generationMs: number }> { ... }
```

The `Deno.serve` handler is a thin router that:
1. Validates auth + parses body
2. Fetches entry + asserts ownership
3. Fetches user_settings (needs `hf_model` for hash)
4. Computes `source_hash`
5. Checks cache (SELECT from insights)
6. If cache hit → return `{ result: cachedPayload, meta: { cached: true, generationMs: 0 } }`
7. Decrypts HF token
8. Calls `generateSentiment()` with timing
9. Builds `fullPayload = { ...result, _meta: { promptVersion, model, generatedAt, generationMs } }`
10. Upserts `{ user_id, entry_id, type: 'sentiment', payload: fullPayload, source_hash }`
    `ON CONFLICT (user_id, entry_id, type) DO UPDATE SET payload = EXCLUDED.payload, source_hash = EXCLUDED.source_hash`
11. Returns `{ result, meta: { cached: false, generationMs } }`

**Cache check order note:** source_hash must be computed AFTER fetching user_settings
because `hf_model` is part of the envelope. The cache check comes after step 4.

**Status:** [ ] pending

---

## Sub-Task 13: Add CSS to `src/index.css`

**Intent:**
Add styles for the AI panel, AiMenu popover, and InsightsPage distribution bar.
Do not modify any existing classes.

**New classes to add after the existing `.analyze-btn` block (around line 1097):**

```css
/* ─── AI Panel (JournalEditor) ──────────────────────────── */
.ai-panel {
  padding: var(--space-md) 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.ai-panel-notice {
  font-size: 0.82rem;
  color: var(--text-muted);
}
.ai-panel-notice .ai-panel-link {
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  font-size: inherit;
  text-decoration: underline;
  padding: 0;
  font-family: inherit;
}

.ai-panel-result {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.ai-panel-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.ai-stale-notice {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}

/* AI Menu (popover) */
.ai-menu-wrapper {
  position: relative;
  display: inline-flex;
}

.ai-menu-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  min-width: 200px;
  padding: var(--space-xs) 0;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

.ai-menu-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
  font-family: var(--font-sans);
}
.ai-menu-item:hover:not(:disabled) { background: var(--bg-hover); }
.ai-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ai-menu-item-reason {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.ai-menu-footer {
  padding: var(--space-xs) var(--space-md);
  font-size: 0.72rem;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
  margin-top: var(--space-xs);
}

/* ─── Insight Distribution Bar (InsightsPage) ───────────── */
.insight-distribution-bar {
  display: flex;
  height: 8px;
  border-radius: var(--radius-full);
  overflow: hidden;
  gap: 2px;
  margin: var(--space-sm) 0;
}

.insight-distribution-segment {
  height: 100%;
  border-radius: var(--radius-full);
  min-width: 4px;
  transition: flex var(--transition-base);
}
.insight-distribution-segment.positive { background: var(--success); }
.insight-distribution-segment.negative { background: var(--danger); }
.insight-distribution-segment.neutral  { background: var(--text-muted); }

.insight-distribution-labels {
  display: flex;
  gap: var(--space-md);
  font-size: 0.75rem;
  color: var(--text-muted);
  flex-wrap: wrap;
}
.insight-distribution-label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.insight-distribution-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
```

**Status:** [ ] pending

---

## SQL to run in Supabase (Sub-Task 2)

```sql
-- Step 1: add source_hash column (nullable — existing rows unaffected)
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- Step 2: add unique constraint for idempotent upserts
-- NOTE: drop this before implementing reflection versioning
ALTER TABLE public.insights
  ADD CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type);
```
