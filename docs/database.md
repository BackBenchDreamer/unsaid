# Database

> Schema design, migration history, RLS policies, and critical data invariants.

## Table of Contents

- [Overview](#overview)
- [Schema](#schema)
- [Migrations](#migrations)
- [Row Level Security](#row-level-security)
- [Critical Invariants](#critical-invariants)
- [Useful Queries](#useful-queries)

---

## Overview

UnSaid uses Supabase Postgres. All tables have RLS enabled. The client uses the anon key; Edge Functions use the service_role key (bypasses RLS).

```
profiles              — one row per verified user
entries               — one row per (user, calendar day)
waitlist              — pre-auth invite requests
insights              — AI output cache (reflections, summaries)
user_settings         — per-user AI tokens + theme preference
life_chapters         — meaningful journal episodes (M3+)
chapter_entries       — join: entries ↔ life_chapters
context_memory        — recurring entities extracted from reflections (M3+)
memory_extractions    — extraction idempotency guard (M3+)
```

---

## Schema

### `profiles`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | References `auth.users(id) ON DELETE CASCADE` |
| `email` | TEXT NOT NULL | |
| `display_name` | TEXT | |
| `role` | TEXT | `'user'` \| `'admin'` — enforced by RLS, not client |
| `status` | TEXT | `'pending'` \| `'approved'` \| `'rejected'` |
| `created_at` | TIMESTAMPTZ | |

Provisioned on first verified sign-in (email_confirmed_at trigger), not on OTP request.

### `entries`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL | References `profiles(id) ON DELETE CASCADE` |
| `entry_date` | DATE NOT NULL | Local `"YYYY-MM-DD"` — never UTC |
| `content` | TEXT | |
| `mood` | TEXT | `'terrible'`\|`'bad'`\|`'meh'`\|`'good'`\|`'great'` |
| `tags` | TEXT[] | Lowercase, max 20 |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE (user_id, entry_date)` — one entry per user per calendar day. All writes use `UPSERT ON CONFLICT (user_id, entry_date)`.

### `insights`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL | |
| `entry_id` | UUID | NULL for period insights (weekly/monthly) |
| `type` | TEXT | `'sentiment'`\|`'reflection'`\|`'summary'`\|`'pattern'` |
| `payload` | JSONB | Full AI output including `_meta` |
| `source_hash` | TEXT | SHA-256 of source envelope — used for staleness detection |
| `period_start` / `period_end` | DATE | For period insights; NULL for per-entry |
| `updated_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE (user_id, entry_id, type)` — one insight per (user, entry, type). NULL `entry_id` rows (period insights) use a separate partial unique index.

No client INSERT policy — only Edge Functions (service_role) can write.

### `user_settings`

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID PK | References `profiles(id) ON DELETE CASCADE` |
| `theme` | TEXT | `'dark'` \| `'light'` |
| `hf_token_encrypted` | TEXT | AES-GCM ciphertext |
| `hf_model` | TEXT | HF model path override |
| `groq_token_encrypted` | TEXT | AES-GCM ciphertext |
| `groq_model` | TEXT | Groq model override |

### `life_chapters`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL | |
| `name` | TEXT | NULL while `status = 'forming'`; LLM-generated on promotion |
| `summary` | TEXT | NULL while `status = 'forming'`; LLM-generated on promotion |
| `chapter_start` | DATE NOT NULL | Earliest `entry_date` in the chapter cluster |
| `chapter_end` | DATE | Set when status becomes `'dormant'` |
| `status` | TEXT | `'forming'` \| `'active'` \| `'dormant'` |
| `theme_tags` | TEXT[] | Accumulated topics across linked entries |
| `entry_count` | INT | Maintained by `extract-memory`; avoids expensive COUNT(*) |
| `last_change_at` | TIMESTAMPTZ | Updated on every new entry join |
| `signals` | JSONB | Audit record of candidate scoring signals |

### `context_memory`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL | |
| `entity_type` | TEXT | `'person'`\|`'place'`\|`'project'`\|`'organization'`\|`'topic'` |
| `entity_value` | TEXT | Lowercase normalized |
| `mention_count` | INT | Append-only; never reset |
| `last_seen_date` | DATE | `entry_date` of most recent mention |
| `emotional_tags` | TEXT[] | Emotions co-occurring with this entity; grows over time |
| `importance_score` | NUMERIC | NULL in M3; reserved for future retrieval ranking |

**Constraint:** `UNIQUE (user_id, entity_type, entity_value)` — one row per entity per user.

### `memory_extractions`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL | |
| `entry_id` | UUID NOT NULL | References `entries(id) ON DELETE CASCADE` |
| `extracted_at` | TIMESTAMPTZ | |
| `prompt_version` | TEXT | `ReflectionPayload._meta.version` at extraction time |
| `extraction_version` | TEXT | `EXTRACTION_VERSION` constant in `extract-memory` function |

**Constraint:** `UNIQUE (user_id, entry_id)` — one extraction record per entry.

Rows are immutable. Delete a row to force re-extraction for that entry (e.g. after bumping `EXTRACTION_VERSION`).

---

## Migrations

Run in order in Supabase SQL Editor. Each migration is idempotent.

| File | Purpose |
|---|---|
| `001_insights_source_hash.sql` | Add `source_hash` + `UNIQUE(user_id, entry_id, type)` |
| `002_remove_invalid_cached_insights.sql` | Delete legacy `confidence = 0` sentinel rows |
| `003_reflection_type.sql` | Add `'reflection'` insight type; `period_start/end`, `updated_at` |
| `004_groq_provider_settings.sql` | Add `groq_token_encrypted`, `groq_model` to `user_settings` |
| `005_security_hardening.sql` | `SET search_path = ''` on all functions; ownership guards on RPCs |
| `006_weekly_summary_index.sql` | Partial unique index for period insights (`entry_id IS NULL`) |
| `007_memory_tables.sql` | Four memory tables + RLS (M3) |
| `008_memory_extraction_version.sql` | Add `extraction_version` to `memory_extractions` (M3 follow-up) |

---

## Row Level Security

All tables have RLS enabled. The pattern for data tables:

- Users can SELECT their own rows (`auth.uid() = user_id`)
- Approved users only (`public.auth_status() = 'approved'`)
- No INSERT/UPDATE/DELETE client policies on AI-managed tables (`insights`, `life_chapters`, `chapter_entries`, `context_memory`, `memory_extractions`) — only service_role (Edge Functions) can write

**RLS helper functions** (`SECURITY DEFINER`, bypass RLS safely):
- `public.auth_role()` — returns `profiles.role` for the calling user
- `public.auth_status()` — returns `profiles.status` for the calling user

These exist to prevent infinite recursion (a policy on `profiles` cannot query `profiles` directly).

---

## Critical Invariants

| Invariant | Enforcement |
|---|---|
| `entry_date` is local `"YYYY-MM-DD"` | DB `DATE` type + `getTodayLocal()` utility; never `toISOString()` |
| One entry per user per day | `UNIQUE (user_id, entry_date)` + UPSERT |
| Streaks and heatmaps from `entry_date` only | Never from `created_at` |
| Memory tables append-only | `mention_count` only increases; `memory_extractions` rows never updated |
| `memory_extractions` is the extraction commit point | Written last; absent = incomplete = retry |
| `prompt_version` ≠ `extraction_version` | Independent versioning; bump only the one that changed |

---

## Useful Queries

**Force re-extraction for a user's entries (e.g. after bumping EXTRACTION_VERSION):**
```sql
DELETE FROM public.memory_extractions
WHERE user_id = '<user-id>'
  AND extraction_version != '1.0.0';
```

**Check which entries have not been extracted yet:**
```sql
SELECT e.id, e.entry_date
FROM public.entries e
JOIN public.insights i ON i.entry_id = e.id AND i.type = 'reflection'
LEFT JOIN public.memory_extractions me ON me.entry_id = e.id
WHERE e.user_id = '<user-id>'
  AND me.id IS NULL;
```

**Seed the first admin user:**
```sql
UPDATE public.profiles
SET role = 'admin', status = 'approved'
WHERE email = 'you@example.com';
```
