# UnSaid

> *Your private journal. Unspoken thoughts given form.*

UnSaid is an invite-only personal journaling app with offline-first sync, mood tracking, streaks, year-in-review heatmaps, and optional AI sentiment analysis via Hugging Face. Built with React 19, TypeScript, and Supabase.

> **AI pipeline status (as of 2026-07-03):** fully operational and end-to-end verified. See [AI Insights](#ai-insights) for operational notes.

## Features

- **Daily journal** — one entry per calendar day; distraction-free writing (Lexical editor) with autosave (1.5 s debounce) and offline queuing
- **Mood tracking** — tag each entry: terrible / bad / meh / good / great
- **Tagging** — free-form lowercase tags per entry (max 20)
- **Streaks** — current and longest consecutive-day streak, computed from local calendar dates
- **Year heatmap** — mood-coloured GitHub-style activity grid via a Postgres RPC
- **"On This Day" memories** — entries from the same day in past years
- **AI Insights** — opt-in sentiment analysis via a Hugging Face model (stored in `insights` table); explicit user action, never automatic
- **Offline-first sync** — writes queue to IndexedDB and drain on reconnect; last-write-wins per day
- **Invite-only access** — new signups land in a waitlist; an admin approves/rejects from the admin panel
- **Settings** — per-user theme (dark/light) and HF token stored encrypted server-side

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
│   ├── insights/     # AI sentiment insights
│   ├── settings/     # Theme + HF token settings
│   └── admin/        # Admin waitlist panel
├── services/         # Supabase calls — always return domain types, never raw rows
├── shared/           # Constants, date utilities
├── sync/             # Offline queue (IndexedDB) + sync engine
└── db/               # SQL files — apply manually in Supabase SQL editor

supabase/
└── functions/
    ├── analyze-sentiment/  # POST {entryId} → runs HF model, writes to insights
    ├── encrypt-token/      # POST {token} → AES-GCM encrypt, writes to user_settings
    └── approve-waitlist/   # POST {waitlistId, action} → admin-only approval
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

**`AI_CONFIG.promptVersion`:** bumped from `'1.0.0'` to `'2.0.0'` in Milestone 1. All cached `'sentiment'` source hashes become stale — users see "Re-reflect" on their next visit. This is intentional.

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
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "promptVersion": "2.0.0",
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

After running migration 004, if settings still fail to load, reload the PostgREST schema cache:
**Supabase Dashboard → Settings → API → Reload Schema**

## Key Invariants

- **`entry_date` is always a user-local `"YYYY-MM-DD"` string** — never derived from `toISOString()` (UTC). Use `getTodayLocal()` from `src/shared/utils/dates.ts`.
- **One entry per user per calendar day** — enforced by `UNIQUE (user_id, entry_date)`. All writes use `UPSERT ON CONFLICT`.
- **Never call Supabase directly from `.tsx` components** — all data access goes through `src/services/` and then React Query hooks in feature `hooks.ts` files.
- **All writes go through `syncEngine.enqueueEntry()`** — not direct service calls.
- **`insights` has no client INSERT policy** — only Edge Functions (service role) can write insights.
- **`LexicalComposer` only mounts after `editorSeedReady = true`** — never with stale/empty `initialContent`.
- **Edge Functions must be redeployed after code changes** — `supabase functions deploy <name>`. The deployed version is independent of local source code; check with `supabase functions list`.
