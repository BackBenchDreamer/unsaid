# Deployment Guide

> Complete instructions for deploying UnSaid to Supabase + Vercel from scratch.

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Supabase Project Setup](#1-supabase-project-setup)
- [2. Clone and Configure](#2-clone-and-configure)
- [3. Apply Database Schema](#3-apply-database-schema)
- [4. Configure Auth](#4-configure-auth)
- [5. Set Supabase Secrets](#5-set-supabase-secrets)
- [6. Deploy Edge Functions](#6-deploy-edge-functions)
- [7. Seed First Admin](#7-seed-first-admin)
- [8. Deploy Frontend to Vercel](#8-deploy-frontend-to-vercel)
- [9. Verify the Deployment](#9-verify-the-deployment)
- [Redeployment Checklist](#redeployment-checklist)
- [Environment Variables Reference](#environment-variables-reference)

---

## Prerequisites

- Node.js 20+
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase` or `npm install -g supabase`)
- A [Supabase](https://supabase.com) account and project
- A [Vercel](https://vercel.com) account (for frontend hosting)

---

## 1. Supabase Project Setup

1. Create a new Supabase project at [app.supabase.com](https://app.supabase.com)
2. Note your **Project URL** and **anon key** from **Project Settings → API**
3. Note your **project ref** from the URL (`app.supabase.com/project/<ref>`)

---

## 2. Clone and Configure

```bash
git clone <repo-url>
cd unsaid
npm install
cp .env.example .env
```

Edit `.env`:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

---

## 3. Apply Database Schema

In your Supabase project, navigate to **SQL Editor** and run the following files **in order**. Paste each file's contents and click **Run**.

### Base schema (run once on a fresh project)

1. `src/db/schema.sql` — all tables, indexes, triggers, RPCs
2. `src/db/rls.sql` — row-level security policies
3. `src/db/user_settings.sql` — user_settings table
4. `src/db/user_settings_rls.sql` — RLS for user_settings

### Migrations (run in order, all idempotent)

| File | Required for |
|---|---|
| `src/db/migrations/001_insights_source_hash.sql` | Stale detection |
| `src/db/migrations/002_remove_invalid_cached_insights.sql` | Cache cleanup |
| `src/db/migrations/003_reflection_type.sql` | AI reflection |
| `src/db/migrations/004_groq_provider_settings.sql` | **Settings page + Groq** |
| `src/db/migrations/005_security_hardening.sql` | **Security** |
| `src/db/migrations/006_weekly_summary_index.sql` | Weekly reflection |
| `src/db/migrations/007_memory_tables.sql` | Memory system |
| `src/db/migrations/008_memory_extraction_version.sql` | Memory versioning |

> ⚠️ **If Settings fails to load** with a schema cache error after migration 004, go to **Project Settings → API → Reload Schema** in the Supabase dashboard.

---

## 4. Configure Auth

In your Supabase project → **Authentication → Settings**:

1. Enable the **Email** provider (magic link / OTP — no passwords)
2. Set **Site URL** to your production domain (e.g. `https://unsaid.vercel.app`)
3. Add to **Redirect URLs** allowlist:
   - `https://your-production-domain.com`
   - `http://localhost:5173`

---

## 5. Set Supabase Secrets

Link your CLI to the project and set the required secrets:

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

The following secrets are required by Edge Functions:

| Secret | Description | How to get it |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set when linking | Dashboard → Project Settings → API |
| `SUPABASE_URL` | Auto-set when linking | Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | Auto-set when linking | Dashboard → Project Settings → API |
| `APP_ENCRYPTION_KEY` | 32-byte hex string for AES-GCM | Generate: `openssl rand -hex 32` |

Set `APP_ENCRYPTION_KEY` manually:

```bash
supabase secrets set APP_ENCRYPTION_KEY=<your-32-byte-hex-key>
```

> ⚠️ Keep `APP_ENCRYPTION_KEY` secret and consistent. Changing it will make all existing encrypted tokens unreadable — users will need to re-save their API keys.

---

## 6. Deploy Edge Functions

```bash
supabase functions deploy analyze-sentiment
supabase functions deploy generate-reflection
supabase functions deploy generate-weekly-summary
supabase functions deploy extract-memory
supabase functions deploy encrypt-token
supabase functions deploy approve-waitlist
```

Verify deployments:

```bash
supabase functions list
```

---

## 7. Seed First Admin

After your first sign-in to the app, run this in the Supabase SQL Editor:

```sql
UPDATE public.profiles
SET role = 'admin', status = 'approved'
WHERE email = 'you@example.com';
```

This is the only way to create an admin user — by design. The `AdminRoute` component in the frontend is a UI-only guard; admin access is enforced by RLS.

---

## 8. Deploy Frontend to Vercel

1. Push the repository to GitHub
2. Import the project at [vercel.com/new](https://vercel.com/new) — Vercel detects Vite automatically
3. Add environment variables in the Vercel project settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy

Vercel serves `dist/` as a static site. The `vercel.json` in the repository ensures all routes serve `index.html` for client-side routing.

---

## 9. Verify the Deployment

After deployment, verify the following:

- [ ] App loads at your production URL
- [ ] Magic link sign-in works (check Supabase Auth logs)
- [ ] New signup lands on `/waitlist`
- [ ] Admin can approve users from `/admin`
- [ ] Journal autosave works (check Supabase table editor → `entries`)
- [ ] AI reflection works (Settings → configure HF + Groq tokens → Reflect)
- [ ] Edge Function logs show no errors (Supabase dashboard → Edge Functions → Logs)

---

## Redeployment Checklist

When merging new code, check which components need redeployment:

| Changed | Action required |
|---|---|
| `src/` (frontend) | Vercel deploys automatically on push to `main` |
| `supabase/functions/<name>/` | `supabase functions deploy <name>` |
| `src/db/migrations/` | Apply new migration(s) in Supabase SQL Editor |
| `AI_CONFIG.promptVersion` bump | Redeploy `generate-reflection` |
| `EXTRACTION_VERSION` bump | Redeploy `extract-memory`; optionally delete stale `memory_extractions` rows |

---

## Environment Variables Reference

### Frontend (`.env`)

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon (public) key |

### Supabase Edge Function Secrets

| Secret | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL (auto-set) |
| `SUPABASE_ANON_KEY` | Supabase anon key (auto-set) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasses RLS (auto-set) |
| `APP_ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM token encryption |

### Local development

```bash
npm run dev          # Vite dev server (http://localhost:5173)
npm run build        # tsc -b && vite build
npm run lint         # eslint .
npm run test         # vitest run (single pass)
npm run test:watch   # vitest watch mode
```
