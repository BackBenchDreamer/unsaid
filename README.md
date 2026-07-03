# UnSaid

> *Your private journal. Unspoken thoughts given form.*

UnSaid is an invite-only personal journaling app with offline-first sync, mood tracking, streaks, year-in-review heatmaps, and optional AI sentiment analysis via Hugging Face. Built with React 19, TypeScript, and Supabase.

## Features

- **Daily journal** — distraction-free writing (Lexical editor) with autosave (1.5 s debounce) and offline queuing
- **Mood tracking** — tag each entry: terrible / bad / meh / good / great
- **Tagging** — free-form lowercase tags per entry (max 20)
- **Streaks** — current and longest consecutive-day streak, computed from local calendar dates
- **Year heatmap** — mood-coloured GitHub-style activity grid via a Postgres RPC
- **"On This Day" memories** — entries from the same day in past years
- **AI Insights** — opt-in sentiment analysis via a Hugging Face model (stored in `insights` table)
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

## Key Invariants

- **`entry_date` is always a user-local `"YYYY-MM-DD"` string** — never derived from `toISOString()` (UTC). Use `getTodayLocal()` from `src/shared/utils/dates.ts`.
- **Never call Supabase directly from `.tsx` components** — all data access goes through `src/services/` and then React Query hooks in feature `hooks.ts` files.
- **All writes go through `syncEngine.enqueueEntry()`** — not direct service calls.
- **`insights` has no client INSERT policy** — only Edge Functions (service role) can write insights.
