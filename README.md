# UnSaid

> *Your private journal. Unspoken thoughts given form.*

UnSaid is an invite-only personal journaling app with offline-first sync, mood tracking, streaks, year-in-review heatmaps, and AI-powered emotional reflection. Built with React 19, TypeScript, and Supabase.

> **AI pipeline status (as of 2026-07-03):** fully operational and end-to-end verified. See [AI Insights](#ai-insights) for operational notes.

> **Milestone 3 (Memory Before Intelligence) branch:** `feature/memory-before-intelligence` — see [Changelog](#changelog) for what changed.

## Features

- **Daily journal** — one entry per calendar day; distraction-free writing (Lexical editor) with autosave (1.5 s debounce) and offline queuing
- **Mood tracking** — tag each entry: terrible / bad / meh / good / great
- **Tagging** — free-form lowercase tags per entry (max 20)
- **Streaks** — current and longest consecutive-day streak, computed from local calendar dates
- **Year heatmap** — mood-coloured GitHub-style activity grid via a Postgres RPC
- **"On This Day" memories** — entries from the same day in past years
- **Per-entry AI reflection** — opt-in emotional analysis via HuggingFace + Groq; explicit user action, never automatic; cached with `source_hash`
- **Weekly reflection** — synthesises a week's entries (using existing per-entry reflections where available) into a narrative emotional arc; invitation-only when ≥ 3 entries exist; staleness-aware
- **Patterns dashboard** — Insights page answers "What has my recent emotional journey looked like?" with: weekly narrative, recurring themes (frequency-weighted pills), emotional timeline (CSS stacked bars), and per-entry reflection cards
- **Offline-first sync** — writes queue to IndexedDB and drain on reconnect; last-write-wins per day
- **Invite-only access** — new signups land in a waitlist; an admin approves/rejects from the admin panel
- **Settings** — per-user theme (dark/light) and HF + Groq tokens stored encrypted server-side

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 6, Vite 8 |
| Routing | React Router v7 |
| Data fetching | TanStack React Query v5 |
| Editor | Lexical (plain text) |
| Offline queue | IndexedDB via `idb` |
| Date math | `date-fns` |
| Backend | Supabase (Postgres, Auth, Edge Functions) |
| Deploy | Vercel (frontend) + Supabase (backend) |

## Getting Started

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for deploying Edge Functions)

### 1. Clone and install

```bash
git clone <repo-url>
cd unsaid
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your Supabase project values in `.env`:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

Both values are available in your Supabase dashboard under **Project Settings → API**.

### 3. Apply the database schema

In your Supabase **SQL Editor**, run the following files **in order**:

1. [`src/db/schema.sql`](src/db/schema.sql) — core tables (`profiles`, `entries`, `waitlist`, `insights`), indexes, triggers (`set_updated_at`, `handle_new_user`), and RPCs (`get_heatmap`, `get_memories`)
2. [`src/db/rls.sql`](src/db/rls.sql) — row-level security policies for all tables
3. [`src/db/user_settings.sql`](src/db/user_settings.sql) — `user_settings` table (1:1 with profiles, stores theme + encrypted HF token)
4. [`src/db/user_settings_rls.sql`](src/db/user_settings_rls.sql) — RLS for `user_settings`

### 4. Configure Supabase Auth

In the Supabase dashboard → **Authentication → Settings**:

- Enable **Email OTP** (magic link) provider
- Set **Site URL** to your production domain (e.g. `https://unsaid.vercel.app`)
- Add your domain + `http://localhost:5173` to the **Redirect URLs** allowlist

### 5. Deploy Edge Functions

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy analyze-sentiment
supabase functions deploy generate-reflection
supabase functions deploy generate-weekly-summary
supabase functions deploy encrypt-token
supabase functions deploy approve-waitlist
```

Edge Functions require the `SUPABASE_SERVICE_ROLE_KEY` secret to be set in your Supabase project's **Edge Function secrets** (Settings → Edge Functions → Secrets). This is set automatically when you link your project.

### 6. Seed the first admin user

After your first sign-in, promote your account to admin in the Supabase SQL editor:

```sql
UPDATE public.profiles
SET role = 'admin', status = 'approved'
WHERE email = 'you@example.com';
```

This is the only way to create an admin — by design.

### 7. Run locally

```bash
npm run dev
```

## Development Commands

```bash
npm run dev          # Vite dev server (http://localhost:5173)
npm run build        # Type-check + production build
npm run lint         # ESLint
npm run test         # Run all tests once (vitest)
npm run test:watch   # Run tests in watch mode
```

Run a single test file:

```bash
npx vitest run src/__tests__/domain.test.ts
```

## Deploying to Vercel

1. Push the repository to GitHub
2. Import the project in [Vercel](https://vercel.com) — it will detect Vite automatically
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as **Environment Variables** in the Vercel project settings
4. Deploy — Vercel serves `dist/` as a static site; `vercel.json` ensures all routes serve `index.html` for client-side routing

## Project Structure

```
src/
├── app/              # App shell: providers, router, layout
│   ├── providers/    # AuthProvider, SyncProvider
│   └── router.tsx    # Route definitions + guards
├── entities/         # Domain types, DB row types, mappers, validators
├── features/         # Page-level components + per-feature React Query hooks
│   ├── auth/         # LoginPage, WaitlistPage
│   ├── dashboard/    # Streak, heatmap, "On This Day" memories
│   ├── journal/      # Editor (Lexical), history, hooks
│   ├── insights/     # AI reflection dashboard (per-entry + weekly patterns)
│   ├── settings/     # Theme + HF/Groq token settings
│   └── admin/        # Admin waitlist panel
├── services/         # Supabase calls — always return domain types, never raw rows
├── shared/
│   ├── constants.ts  # App-wide constants incl. WEEKLY_REFLECTION_MIN_ENTRIES
│   └── utils/
│       ├── dates.ts      # getTodayLocal, formatDisplayDate, etc.
│       ├── hash.ts       # sha256Hex, sourceEnvelope (used for cache keys)
│       └── emotions.ts   # getEmotionValence, POSITIVE_EMOTIONS, NEGATIVE_EMOTIONS
├── sync/             # Offline queue (IndexedDB) + sync engine
└── db/               # SQL files — apply manually in Supabase SQL editor

supabase/
└── functions/
    ├── analyze-sentiment/        # POST {entryId} → HF emotion model → SentimentPayload
    ├── generate-reflection/      # POST {entryId} → HF + Groq → ReflectionPayload
    ├── generate-weekly-summary/  # POST {weekStart} → Groq → WeeklyPayload (M2)
    ├── encrypt-token/            # POST {token, provider} → AES-GCM ciphertext
    └── approve-waitlist/         # POST {waitlistId, action} → admin-only approval
```

## Access Control

UnSaid is invite-only. The auth flow has two gates:

1. **Authentication** — magic link (OTP) via Supabase Auth
2. **Approval** — `profiles.status` must be `'approved'`; new signups start as `'pending'`

Unapproved users are redirected to `/waitlist` after sign-in. All data access is enforced at the database level via RLS — the approval check runs on every query.

Admin users (`profiles.role = 'admin'`) can approve/reject waitlist applicants from `/admin`. Admin role is enforced by RLS — the `AdminRoute` component is a UI-only guard.

## Offline Sync

Writes queue to IndexedDB (`unsaid-sync` database, version 1) before being sent to Supabase. The queue drains automatically on reconnect, every 30 seconds while online, or after each write attempt. Mutation IDs are deterministic (`userId:entryDate:action`) — rapid edits to the same entry replace the pending mutation rather than queuing duplicates. The server uses `UPSERT ON CONFLICT (user_id, entry_date)`, so replayed mutations are idempotent.

## Journal Workflow

### One entry per day

The database enforces `UNIQUE (user_id, entry_date)`. All writes use `UPSERT ON CONFLICT (user_id, entry_date)`, so writing to the same day always updates the existing entry — it is impossible to create a duplicate.

### Opening an existing entry

The History page (`/history`) lists all past entries grouped by month. Clicking any entry navigates to `/journal/YYYY-MM-DD`. The editor:

1. Fetches the entry for that date via `useEntryByDate(date)`.
2. Waits for the fetch to resolve before mounting the Lexical editor — this prevents a race condition where the editor initialises with empty content before the DB response arrives.
3. Seeds the Lexical editor with the stored content, mood, and tags from the DB.
4. Sets `lastSavedContent` to the fetched content so the AI stale-detection baseline is correct from the moment the entry opens.
5. The `Saved HH:MM` indicator reflects the existing entry's last save, not a new write.

If there is no entry for the given date (e.g. navigating to a future date or a past day with no entry), the editor opens blank and the first keystroke creates the entry via autosave.

### Autosave

Autosave fires 1 500 ms after the last keystroke (`AUTOSAVE_DEBOUNCE_MS`). It sends the current plain-text content of the Lexical editor together with the current mood and tags. The write goes through `useUpsertEntry` → `syncEngine.enqueueEntry()` → `journalService.upsertEntry()`.

The editor only starts listening for changes (`OnChangePlugin`) **after** the initial seed completes (gated by `isEditorReadyRef`), so opening an existing entry never triggers an autosave for empty content.

When mood or tags change without a simultaneous text edit, a separate 300 ms debounce re-saves the entry using `lastSavedContentRef.current` as the content (not `existingEntry.content`, which could be stale after in-session edits).

### Editor initialisation — implementation notes

The `LexicalComposer` is not mounted until `editorSeedReady = true`, which is set only after `useEntryByDate` resolves (`isLoading = false`). This eliminates a previous bug where:

1. `LexicalComposer` mounted immediately with `initialContent = ''`.
2. `InitPlugin` (Lexical's init hook) ran synchronously, seeding the editor with `''` and marking `isEditorReadyRef = true`.
3. The fetch resolved later, but the seeding guard `!isEditorReadyRef.current` was already tripped → the editor stayed blank.
4. The first autosave (triggered by `OnChangePlugin` on the empty doc) silently overwrote the DB entry with empty content.

The fix gates the `LexicalComposer` on `editorSeedReady`, so `InitPlugin` always receives the correct content on its first (and only) run.

## AI Insights

### The reflection hierarchy

UnSaid is designed around a single architectural principle: **each level of reflection builds on the level below it, preferring existing work over reprocessing raw entries**.

```
Journal Entry
      ↓
Per-entry Reflection   (M1) — type='reflection', entry_id=UUID
      ↓
Weekly Reflection      (M2) — type='summary',    entry_id=NULL, period_start/end
      ↓
Monthly Reflection     (M3) — type='pattern',    entry_id=NULL, period_start/end
      ↓
Year in Reflection     (M4) — type='pattern',    entry_id=NULL, period_start/end
```

**Why this matters:**

- A Weekly Reflection reads the week's per-entry reflections, not the raw journal entries. It synthesises work that has already been done.
- A Monthly Reflection, when it arrives, will read the month's weekly reflections — not the individual days.
- This keeps inference costs proportional to what is new, not proportional to the entire journal.
- It also produces better results: a weekly narrative built from "this entry was about work and felt heavy" is richer than one built from raw text.

**Graceful degradation:**

Each level falls back gracefully when lower-level work is absent:
- A weekly reflection for a day without a per-entry reflection uses the raw entry excerpt as a substitute.
- A monthly reflection for a week without a weekly reflection would use per-entry summaries as a substitute.
- The fallback is transparent to the user and documented inline in each Edge Function.

This keeps the system useful from day one while rewarding consistent reflection habits over time.

---

### Milestone 2 — Patterns Over Time

Weekly reflection builds on per-entry reflections to answer "What has my recent emotional journey looked like?" using narrative prose rather than statistics.

**Weekly reflection flow:**
1. User navigates to `/insights`. If ≥ `WEEKLY_REFLECTION_MIN_ENTRIES` entries exist for the current week and no weekly reflection exists, an invitation card appears.
2. User clicks "Reflect on this week" — calls `generate-weekly-summary` Edge Function.
3. Edge Function uses existing per-entry reflection summaries where available; falls back to raw entry excerpts for unreflected entries (best-effort).
4. Groq produces a narrative synthesis (not statistics): `narrative`, `dominantEmotions`, `recurringThemes`, `emotionalArc`.
5. Result cached in `insights` table with `entry_id=NULL`, `period_start`, `period_end`, and `source_hash`.
6. Once generated, the invitation is replaced by the narrative. A subtle "may be outdated" notice + Regenerate appears only if staleness is detected.

**Staleness detection:**
- Mirror of the per-entry staleness model.
- If any per-entry reflection was created _after_ the weekly reflection's `createdAt`, the reflection is considered stale.
- A secondary async SHA-256 check compares the stored `source_hash` against a recomputed hash from current reflection source hashes.
- Only the staleness notice + Regenerate appear when stale — never a Regenerate button on a fresh reflection.

**Independent versioning:**
- Per-entry reflection: `promptVersion = '3.0.0'` (M3 bump — context injection added).
- Weekly reflection: `weeklyPromptVersion = '1.0.0'` (independent; stored in `_meta`).
- Bumping either version invalidates only the relevant insight type's caches.
- **Prompt version bumps are architectural events** — only bump when the reflection output is structurally different (e.g., context injection added). Do not bump for wording adjustments.

**Insights dashboard — section order:**
1. **This week** — weekly narrative (or invitation, or subtle hint when not enough entries)
2. **Recurring themes** — pill cloud from all reflection `themes[]` arrays, with lightweight emotion context derived from stored emotion scores (no new AI calls)
3. **Emotional balance over time** — CSS-only stacked bars for last 10 reflected entries
4. **Mood overview** — all-time distribution bar
5. **Recent reflections** — per-entry reflection cards

**`WeeklyPayload` schema:**
```json
{
  "narrative": "This week began with uncertainty but gradually shifted toward a quieter focus.",
  "dominantEmotions": [
    { "label": "Joy",     "score": 0.38 },
    { "label": "Neutral", "score": 0.32 }
  ],
  "recurringThemes": ["Work", "Rest"],
  "emotionalArc": "from uncertainty toward quiet focus",
  "_meta": {
    "version": "1.0.0",
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "generatedAt": "2026-07-14T09:00:00.000Z",
    "generationMs": 2800
  }
}
```

`_meta.version` holds the prompt version that generated this insight — `"1.0.0"` for weekly reflections, `"2.1.0"` for per-entry reflections. The two version spaces are independent; bumping one never invalidates the other.

**`generate-weekly-summary` call flow:**
1. Validate JWT → resolve `user_id`.
2. Parse and validate `weekStart` ("YYYY-MM-DD" Monday); compute `weekEnd` = weekStart + 6 days.
3. Fetch all entries for the user in `[weekStart, weekEnd]`.
4. Guard: 0 entries → `INSUFFICIENT_ENTRIES` (422).
5. Fetch `user_settings` for `groq_token_encrypted`, `groq_model`.
6. Guard: `groq_token_encrypted IS NULL` → `WEEKLY_NOT_CONFIGURED` (422).
7. Fetch existing `reflection` insights for entries in the week.
8. Build `entryHashes[]`: use `reflection.source_hash` for reflected entries; compute `sha256Hex(sourceEnvelope(content, 'entry', id))` for unreflected entries.
9. Compute `weeklySourceHash = sha256Hex(JSON.stringify({ weekStart, weekEnd, weeklyPromptVersion, model, entryHashes }))`.
10. Cache check: if stored `summary` insight matches hash and passes `isWeeklyResult()` → return cached.
11. Decrypt Groq token; call Groq LLM with synthesis prompt + weekly context block.
12. Parse + validate Groq JSON response.
13. Build `WeeklyPayload` with `_meta.version = WEEKLY_CONFIG.version`.
14. SELECT existing row → UPDATE if found, INSERT if not (resilient to index absence).
15. Return `{ result, meta: { cached, generationMs } }`.

---

### Milestone 1 — Foundation of Reflection

Two-provider architecture: HuggingFace for emotion classification, Groq for reflection generation.

| Edge Function | Provider | Purpose |
|---|---|---|
| `analyze-sentiment` | HuggingFace | 7-emotion classification → `SentimentPayload` (fallback path) |
| `generate-reflection` | HuggingFace + Groq | Emotion scores + LLM → `ReflectionPayload` (primary path) |

**Reflect flow:**
1. Client calls `generate-reflection` Edge Function.
2. If `groq_token_encrypted IS NULL` → returns `REFLECTION_NOT_CONFIGURED` (422).
3. Client silently falls back to `analyze-sentiment` (HF only). No error shown.
4. If both tokens configured → full reflection path: HF emotion scores + Groq LLM.

**Token setup (Settings → AI Configuration):**
- **Emotion Analysis (HuggingFace):** go to [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens), paste a read token.
- **Reflection Generation (Groq):** go to [console.groq.com/keys](https://console.groq.com/keys), paste an API key.
- Both tokens are AES-256-GCM encrypted by `encrypt-token` using `APP_ENCRYPTION_KEY`. The plaintext is never stored or returned.
- The `encrypt-token` Edge Function accepts `provider: 'hf' | 'groq'` (defaults to `'hf'` for backward compatibility) and writes to the corresponding `user_settings` column.

**`AI_CONFIG.promptVersion`:** bumped from `'1.0.0'` → `'2.0.0'` (M1) → `'2.1.0'` (M2, voice fix). Each bump stales all per-entry cached rows — users see "Re-reflect" on their next visit. This is intentional. Stored in `_meta.version` on each row.

**Naming reference:** see [`foundation-of-reflection-plan.md`](foundation-of-reflection-plan.md) for the full naming reference table.

### `ReflectionPayload` schema

Stored in `insights.payload` for `type = 'reflection'` rows:

```json
{
  "summary": "2–3 sentence reflection generated by Groq.",
  "emotions": [
    { "label": "Joy",     "score": 0.42 },
    { "label": "Neutral", "score": 0.30 },
    { "label": "Sadness", "score": 0.11 },
    { "label": "Fear",    "score": 0.06 }
  ],
  "themes": ["Work", "Family"],
  "question": "One open-ended follow-up question?",
  "_meta": {
    "version": "2.1.0",
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "generatedAt": "2026-07-10T12:00:00.000Z",
    "generationMs": 3200
  }
}
```

### `generate-reflection` call flow

1. Validate JWT → resolve `user_id`.
2. Parse and validate `entryId`.
3. Fetch entry (service role); assert `entry.user_id === user_id`.
4. Fetch `user_settings` for `hf_token_encrypted`, `hf_model`, `groq_token_encrypted`, `groq_model`.
5. Guard: if `groq_token_encrypted IS NULL` → return HTTP 422 `REFLECTION_NOT_CONFIGURED`.
6. Compute `source_hash = SHA-256({ content, promptVersion: '2.0.0', model: groq_model })`.
7. Cache check: if stored row matches hash **and** passes `isReflectionResult()` → return cached.
8. Decrypt HF token; call HF emotion model → 7 emotion scores.
9. Decrypt Groq token; call `https://api.groq.com/openai/v1/chat/completions` with emotion context + entry excerpt.
10. Parse + validate Groq JSON response with `isReflectionResult()`.
11. Build `ReflectionPayload` with `_meta.provider = 'groq'`.
12. Upsert to `insights` with `updated_at = now()`.
13. Return `{ result, meta: { cached: false, generationMs } }`.

The Groq endpoint is hardcoded — no configurable base URL in this milestone.

### How it works (legacy `analyze-sentiment` path)

The fallback path triggers when Groq is not configured. The Reflect button in the journal editor calls `analyze-sentiment` via `useGenerateReflection` → silent fallback:

1. Compute `source_hash = SHA-256(JSON.stringify({ content, promptVersion, model }))`.
2. If an existing `insights` row has the same hash **and** passes structural validation (`confidence > 0`, score in `[-1,1]`, valid label) → return the cached result immediately (no HF call).
3. Otherwise, decrypt the stored HF token and call the HuggingFace Inference router.
4. Map the 7-emotion probability scores to `{ score, label, confidence }`.
5. Write the validated result + `_meta` to the `insights` table and return to the client.

### HuggingFace endpoint (important)

```
Current:  https://router.huggingface.co/hf-inference/models/<model>
Retired:  https://api-inference.huggingface.co/models/<model>  ← DNS NXDOMAIN as of 2026
```

The `api-inference.huggingface.co` hostname no longer resolves. The Edge Function uses `router.huggingface.co/hf-inference/models/` exclusively. If you see `"dns error: failed to lookup address information"` in Edge Function logs, this is the cause.

### Token setup

Go to **Settings → AI Configuration** in the app. Two sub-sections:

**Emotion Analysis (HuggingFace):**
1. Paste a [HuggingFace read token](https://huggingface.co/settings/tokens).
2. Click **Save Token** — encrypted immediately; never displayed again.

**Reflection Generation (Groq):**
1. Paste a [Groq API key](https://console.groq.com/keys).
2. Click **Save Token** — encrypted immediately; never displayed again.
3. Optionally update the **Model** field (default: `llama-3.1-8b-instant`).

The **Replace** button uses `isReplacing` state (separate from `tokenSaved`) to show the form even when a token is already configured. This is required because `aiConfigured`/`reflectionConfigured` stays `true` from the DB until the new token is saved.

### Response shape

The HF Inference router returns `HFEmotionScore[][]` (nested) for single-string inputs. The Edge Function normalises both the nested form (router) and the legacy flat `HFEmotionScore[]` form for forward-compatibility.

### End-to-end verification (2026-07-03)

A full pipeline trace was performed confirming the following:

| Stage | Result |
|---|---|
| Token saved via `encrypt-token` | ✅ AES-256-GCM ciphertext stored in `user_settings.hf_token_encrypted` |
| `analyze-sentiment` invoked | ✅ POST `supabase.co/functions/v1/analyze-sentiment` → HTTP 200 |
| Edge Function JWT validation | ✅ Supabase anon client validates Bearer token |
| Entry ownership assert | ✅ `entry.user_id === user.id` check passes |
| Token decryption | ✅ `decryptToken()` recovers plaintext token from ciphertext |
| HF Inference call | ✅ `router.huggingface.co/hf-inference/models/j-hartmann/...` → HTTP 200 |
| `cached: false` confirmed | ✅ `meta.generationMs ≈ 6 400–6 700 ms` (real inference, not cache hit) |
| DB payload stored | ✅ `confidence > 0`, valid `label`, `_meta.provider = "huggingface"` |
| UI rendering | ✅ `Math.round(confidence * 100)` displayed correctly |
| Stale detection | ✅ "Journal updated since this insight." fires when saved content diverges |
| Replace token button | ✅ `isReplacing` state shows form correctly; `Cancel` dismisses without saving |

Sample stored payload from the verified run:

```json
{
  "score": 0.4567,
  "label": "positive",
  "confidence": 0.6420,
  "_meta": {
    "provider": "huggingface",
    "model": "j-hartmann/emotion-english-distilroberta-base",
    "promptVersion": "1.0.0",
    "generatedAt": "2026-07-03T13:36:24.967Z",
    "generationMs": 6422
  }
}
```

### Stored payload schema

```json
{
  "score": 0.48,
  "label": "positive",
  "confidence": 0.66,
  "_meta": {
    "provider": "huggingface",
    "model": "j-hartmann/emotion-english-distilroberta-base",
    "promptVersion": "1.0.0",
    "generatedAt": "2026-07-03T13:28:37.429Z",
    "generationMs": 4542
  }
}
```

`confidence` is the summed probability of the winning emotion category. It is always `> 0` for a real model output (HF softmax scores sum to 1). `confidence = 0` in a stored row is exclusively a bug artefact — see the migration below.

### Error codes surfaced to the UI

| Code | HTTP | Meaning |
|---|---|---|
| `MODEL_LOADING` | 503 | HF model cold-starting; retry in ~20 s |
| `PROVIDER_ERROR` | 502 | HF returned a non-200 status |
| `SHAPE_ERROR` | 502 | HF returned a 200 but an unrecognised payload shape |

### Root cause of the historical 0% confidence bug

The original `api-inference.huggingface.co` hostname became an NXDOMAIN (DNS resolution failure). The old code silently caught the network error and stored a fallback `{ confidence: 0, label: 'neutral' }` — which was then cached and served indefinitely. The fix:

1. Updated the HF endpoint to `router.huggingface.co/hf-inference/models/<model>`.
2. Removed all fallback/silent-failure paths from `generateSentiment()` — it only throws now.
3. Added `isSentimentResult()` guard: a row with `confidence = 0` is treated as `CACHE_INVALID` and regenerated.
4. Stale zero-confidence rows are cleaned up by migration `002_remove_invalid_cached_insights.sql`.

### Cache integrity

The cache-hit path validates the stored payload with `isSentimentResult()` before serving it. A row that fails validation (e.g. `confidence = 0` from a bug-era write) is treated as `CACHE_INVALID` — logged to Edge Function logs and regenerated. The database migration below cleans up any such rows.

### Error codes surfaced to the UI (Milestone 1)

| Code | HTTP | Source | Meaning |
|---|---|---|---|
| `MODEL_LOADING` | 503 | `analyze-sentiment` | HF model cold-starting; retry in ~20 s |
| `PROVIDER_ERROR` | 502 | `analyze-sentiment` | HF returned a non-200 status |
| `SHAPE_ERROR` | 502 | Both | Unrecognised response payload shape |
| `REFLECTION_NOT_CONFIGURED` | 422 | `generate-reflection` | Groq token not set — client falls back silently |
| `HF_PROVIDER_ERROR` | 502 | `generate-reflection` | HF returned a non-200 status |
| `GROQ_PROVIDER_ERROR` | 502 | `generate-reflection` | Groq returned a non-200 status |

### Database migrations

> ⚠️ **All migrations must be run before the Settings page will load correctly.**
> If you see **"Could not find the 'groq_model' column in the schema cache"** or the Settings page shows a migration error banner, migrations 003 and/or 004 have not been applied to the live database.

Run in order in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run):

| File | Purpose | Required for |
|---|---|---|
| `src/db/migrations/001_insights_source_hash.sql` | Add `source_hash` column + `UNIQUE(user_id, entry_id, type)` constraint | Stale detection |
| `src/db/migrations/002_remove_invalid_cached_insights.sql` | Delete all `sentiment` rows with `confidence = 0` (bug-era rows) | Clean cache |
| `src/db/migrations/003_reflection_type.sql` | Add `'reflection'` insight type; add `period_start`, `period_end`, `updated_at` columns | Reflection insights |
| `src/db/migrations/004_groq_provider_settings.sql` | Add `groq_token_encrypted`, `groq_model` columns to `user_settings` | **Settings page + Groq** |
| `src/db/migrations/005_security_hardening.sql` | Fix `search_path` on all DB functions; add ownership guards to `get_heatmap` + `get_memories`; revoke anon access to internal RPCs | **Security** |
| `src/db/migrations/006_weekly_summary_index.sql` | Create partial unique index `uq_insight_summary_period` on `(user_id, type, period_start, period_end) WHERE entry_id IS NULL` | **Weekly reflection (M2)** |
| `src/db/migrations/007_memory_tables.sql` | Add `life_chapters`, `chapter_entries`, `context_memory`, `memory_extractions` tables + RLS | **Memory (M3)** |

After running migration 004, if settings still fail to load, reload the PostgREST schema cache:
**Supabase Dashboard → Settings → API → Reload Schema**

Migration 005 has no schema changes (no new columns or tables) — no schema cache reload needed.

## Key Invariants

- **`entry_date` is always a user-local `"YYYY-MM-DD"` string** — never derived from `toISOString()` (UTC). Use `getTodayLocal()` from `src/shared/utils/dates.ts`.
- **One entry per user per calendar day** — enforced by `UNIQUE (user_id, entry_date)`. All writes use `UPSERT ON CONFLICT`.
- **Never call Supabase directly from `.tsx` components** — all data access goes through `src/services/` and then React Query hooks in feature `hooks.ts` files.
- **All writes go through `syncEngine.enqueueEntry()`** — not direct service calls.
- **`insights` has no client INSERT policy** — only Edge Functions (service role) can write insights.
- **`LexicalComposer` only mounts after `editorSeedReady = true`** — never with stale/empty `initialContent`.
- **Edge Functions must be redeployed after code changes** — `supabase functions deploy <name>`. The deployed version is independent of local source code; check with `supabase functions list`.

## Mobile

UnSaid is designed for equal first-class use on desktop and mobile. Journaling happens on the couch, during commutes, and just before bed — not only at a desk.

Every milestone should include a mobile pass before it is considered complete.

**Supported viewport range:** 390–1440px. Breakpoint: ≤ 680px activates the mobile layout.

**Mobile-specific behaviours:**
- Mood picker: 5-column CSS grid (all buttons in one row, no wrapping).
- Minimum touch target on mood buttons: 56 × 44 px.
- Reflect / Re-reflect button: full-width on mobile for easier tap.
- Reflection question hint (`↵ Add to entry`): hidden on mobile (redundant with `title` tooltip on tap).
- Insight cards: stack vertically on mobile (text above, "Open entry" button below).
- Journal textarea: shorter minimum height on mobile (240 px vs 360 px) to avoid excessive empty space.

## Security

### Database function hardening (migration 005)

All `SECURITY DEFINER` functions now include `SET search_path = ''`, which prevents a class of search-path injection attacks where a user-controlled schema could shadow built-in objects.

Two RPCs had a **data-access vulnerability** fixed in migration 005:

- **`get_heatmap`** — accepted any `p_user_id` UUID with no ownership check. An authenticated user could have called `/rest/v1/rpc/get_heatmap` with another user's UUID and read their full year of mood data.
- **`get_memories`** — same pattern. An authenticated user could have read another user's "On This Day" journal snippets.

Both functions now raise `Unauthorized` unless `p_user_id = auth.uid()`.

### Intentional security decisions

- **`waitlist` INSERT `WITH CHECK (true)`** — intentional. The waitlist is a pre-auth signup form. Anonymous users must be able to submit their email. The `UNIQUE` constraint on `waitlist.email` prevents spam duplicates. Row-level data is non-sensitive (email + optional reason text). No change needed.
- **`auth_leaked_password_protection` disabled** — not applicable. UnSaid uses magic-link / email OTP exclusively. There are no passwords to check against HaveIBeenPwned.

## Changelog

### Milestone 3 — Memory Before Intelligence (feature/memory-before-intelligence)

This milestone builds the memory foundation that every future intelligence feature depends on. It does not add visible AI features for users.

**Philosophy:** Memory should exist before intelligence. The AI first builds a reliable memory of a person's life. Only then should it draw conclusions. Memory is not a collection of facts — it is a collection of moments worth remembering.

**Two memory types:**
- **Context Memory** (`context_memory` table) — recurring entities (people, places, projects, topics) extracted from reflected entries. Used internally to enrich future reflections. Users may never interact with it directly.
- **Life Chapters** (`life_chapters` table) — meaningful collections of related journal entries representing distinct life episodes (e.g. "IBM Internship", "Thailand Trip"). Discovered automatically; never created by the user.

**Memory is conservative:**
- A chapter candidate requires ≥ 3 entries passing ≥ 2 of: entity co-occurrence, theme overlap (temporal proximity is a prerequisite filter, not a signal)
- Promotion from `forming` → `active` requires ALL three: sufficient evidence, stability over time (≥ 7 quiet days), no theme drift (≥ 50% overlap with original themes)
- A chapter becomes `dormant` after 60 days with no new linked entries

**Memory is quiet:**
- No new UI in this milestone — the memory layer is invisible to users
- `extract-memory` Edge Function runs asynchronously (fire-and-forget) after every reflection — the user never waits for it
- Errors in memory extraction have no user-facing effect

**Memory reduces AI cost:**
- `generate-reflection` now queries `context_memory` and `life_chapters` before calling Groq
- Relevant context (scored by overlap with current entry themes, not recency/frequency) is injected into the Groq system prompt as a compact block (≤ 500 tokens)
- Context injection triggers a `source_hash` change, inviting re-reflection when memory changes significantly

**Architecture changes:**
- New Edge Function: `supabase/functions/extract-memory/` — multi-signal chapter detection, entity extraction, dormancy sweep
- New DB migration: `src/db/migrations/007_memory_tables.sql` — four new tables
- New entities: `src/entities/memory.ts` — all domain types, mappers, constants
- New service: `src/services/memoryService.ts` — read-only queries + ContextBlock builder
- New feature hooks: `src/features/memory/hooks.ts` — `useLifeChapters`, `useContextMemory`, `useActiveChapterCount`
- `AI_CONFIG.promptVersion` bumped from `'2.1.0'` → `'3.0.0'` — existing per-entry cached reflections will show "Re-reflect" (intentional; context-aware reflections are meaningfully better)

**Required deployment steps:**
1. Apply `src/db/migrations/007_memory_tables.sql` in Supabase SQL Editor.
2. Deploy: `supabase functions deploy extract-memory`.
3. Redeploy: `supabase functions deploy generate-reflection` (context injection + extract-memory fire-and-forget added).
4. No schema cache reload required.

**New invariants (see AGENTS.md):**
- Memory tables are service_role-only writes
- `memory_extractions` is the idempotency guard for `extract-memory`
- Prompt version bumps are architectural events, not routine edits
- Memory tables are append-only wherever possible

---

### Milestone 2.5 — Product Polish & Architectural Refinement (feature/patterns-over-time)

**Terminology:**
- All user-facing strings now consistently use "Weekly Reflection" — never "Weekly Summary" or "synthesis" in any UI surface.
- README reflects the same terminology throughout.

**Payload simplification:**
- `suggestedReflection?: string` removed from `WeeklyPayload` and `WeeklyResult`. The field was reserved for a hypothetical future feature; keeping it created a gap between what the product produces and what the schema expresses. If coaching prompts become a product feature, the field will be introduced then with a purpose.
- `generate-weekly-summary` cache return path simplified: no longer spreads an optional field that was never populated.

**Recurring themes — from data to observations:**
- Each theme pill now surfaces lightweight context derived from stored emotion scores (no new AI calls):
  - "Work · often uplifting" when joy is consistently dominant across entries mentioning that theme (>45% of accumulated emotion score)
  - "Family · often heavy" when sadness is dominant
  - "Friends · 4 entries" when no single emotion is dominant enough to be meaningful
- Context is suppressed for single-entry themes (one data point is not a pattern).
- Pills render as vertical groups (theme + context line) instead of flat weighted text.

**`InsightMeta` unified version field:**
- `promptVersion` and `weeklyPromptVersion` replaced by a single `version` field on `InsightMeta`. Per-entry reflections store `"2.1.0"`; weekly reflections store `"1.0.0"`. No special-case placeholder values. The hash envelope key `weeklyPromptVersion` inside `JSON.stringify` is preserved unchanged — renaming it would silently invalidate all existing weekly reflection caches.

**Architecture refactor:**
- `parseEdgeFunctionError()` extracted as a shared private helper in `insightsService.ts`. The three service methods (`generateInsight`, `generateReflection`, `generateWeeklySummary`) each contained an identical 12-line error-parsing block. Now replaced with a single call.
- `EdgeFunctionErrorResponse` interface removed (no longer needed after the refactor).

**README additions:**
- Reflection hierarchy section documents the long-term architecture philosophy (Journal Entry → Per-entry Reflection → Weekly → Monthly → Year) with graceful degradation notes.

### Milestone 2 — Patterns Over Time (feature/patterns-over-time)

**New features:**
- **Weekly reflection** — synthesises a week's entries into a narrative emotional arc using the `generate-weekly-summary` Edge Function. Best-effort: uses per-entry reflection summaries where available, falls back to raw entry excerpts. Cached with independent `weeklyPromptVersion = '1.0.0'` so per-entry caches are never disturbed.
- **Recurring themes section** — pill cloud aggregated from all reflection `themes[]` arrays. Top 8 themes shown; includes emotion context derived from stored data.
- **Emotional timeline** — CSS-only stacked bars showing positive/neutral/negative balance for the last 10 reflected entries, ordered by entry date.
- **Weekly staleness detection** — mirrors the per-entry staleness model. Shows "may be outdated" notice + Regenerate only when staleness is detected.
- **`WEEKLY_REFLECTION_MIN_ENTRIES`** constant in `src/shared/constants.ts` — controls the invitation threshold without touching business logic.

**Architecture changes:**
- New Edge Function: `supabase/functions/generate-weekly-summary/index.ts`.
- New DB migration: `src/db/migrations/006_weekly_summary_index.sql` — partial unique index for `entry_id IS NULL` period rows.
- `EntryInsight` extended with `periodStart: string | null` and `periodEnd: string | null`.
- `InsightMeta` extended with optional `weeklyPromptVersion?: string`.
- `insightsService.getInsights()` now fetches and maps `period_start`/`period_end`.
- `getEmotionValence()`, `POSITIVE_EMOTIONS`, `NEGATIVE_EMOTIONS` extracted to `src/shared/utils/emotions.ts` — was duplicated between `InsightsPage.tsx` and `JournalEditor.tsx`.
- Insights dashboard redesigned: Weekly Reflection → Recurring Themes → Emotional Timeline → Mood Overview → Recent Reflections.

**Required deployment steps:**
1. Apply `src/db/migrations/006_weekly_summary_index.sql` in Supabase SQL Editor.
2. Deploy: `supabase functions deploy generate-weekly-summary`.
3. No schema cache reload required (no new columns or tables in this migration).

### Security hardening (migration 005, 2026-07-03)

- Fixed mutable `search_path` on all five DB functions (`set_updated_at`, `handle_new_user`, `ensure_profile`, `get_heatmap`, `get_memories`).
- Added ownership guards (`p_user_id = auth.uid()`) to `get_heatmap` and `get_memories` — previously any authenticated user could query another user's data by UUID.
- Revoked `EXECUTE` on internal-only RPCs (`auth_role`, `auth_status`, `handle_new_user`, `ensure_profile`) from the `anon` role.

### Milestone 1 release candidate polish (2026-07-03)

**Bug fixes:**
- **InsightsPage:** deduplicate insight cards by entry — when both a reflection and a legacy sentiment row exist for the same entry, only the reflection card is shown. Previously both appeared simultaneously.
- **HistoryPage:** the `entryId → insight` map now correctly prefers reflection over sentiment. Previously an older sentiment row could overwrite a newer reflection due to last-write-wins iteration.

**UX improvements:**
- Emotion pills normalised to Title-Case (`Joy`, `Sadness`) in both the reflection card and the Insights dashboard. Previously all-caps from the model were rendered as-is.
- Reflection question now shows an `↵ Add to entry` affordance hint on desktop so users know it is tappable.
- Reflection question has a `:focus-visible` outline ring for keyboard navigation.
- HistoryPage cards now show a `✦ [top emotion]` accent badge for reflected entries instead of nothing (previously only sentiment entries showed a pill; reflection entries showed no indicator).
- InsightsPage subtitle now has breathing room above the Mood Overview section heading.
- Insight cards use `align-items: flex-start` so the "Open entry →" button stays top-aligned with multi-line content.

**Mobile (≤ 680 px):**
- Mood picker fixed to a 5-column CSS grid — the "GREAT" button no longer wraps to a second row.
- Mood buttons have a minimum touch target height (56 px on mobile).
- Reflect / Re-reflect button is full-width on mobile.
- Insight cards stack vertically on mobile for readability.
- Journal textarea minimum height reduced from 420 px to 240 px on mobile.
