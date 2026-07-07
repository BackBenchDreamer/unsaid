# Architecture

> How UnSaid is structured, how its modules relate, and the invariants that hold the system together.

## Table of Contents

- [Overview](#overview)
- [Module Boundaries](#module-boundaries)
- [Data Flow](#data-flow)
- [Offline-First Sync](#offline-first-sync)
- [Auth and Access Control](#auth-and-access-control)
- [Key Invariants](#key-invariants)
- [Mobile Design](#mobile-design)

---

## Overview

<!-- TODO: System architecture diagram showing frontend, Supabase, Edge Functions, HF, Groq -->
<!-- docs/images/system-architecture.png -->

UnSaid is a React SPA backed by Supabase. All data mutations flow through a client-side sync queue before reaching the database. AI inference runs inside Supabase Edge Functions (Deno) — the client never calls AI providers directly.

```
Browser
  └── React SPA (Vite)
        ├── Supabase JS client (auth, realtime-less DB queries)
        ├── IndexedDB sync queue (offline writes)
        └── Edge Function calls (AI + admin actions)

Supabase
  ├── Postgres (all persistent state, RLS enforced)
  ├── Auth (magic-link / email OTP)
  └── Edge Functions (Deno)
        ├── analyze-sentiment      → HuggingFace
        ├── generate-reflection    → HuggingFace + Groq
        ├── generate-weekly-summary→ Groq
        ├── extract-memory         → Groq (optional) + Postgres
        ├── encrypt-token          → AES-GCM (no external call)
        └── approve-waitlist       → Postgres (admin only)
```

---

## Module Boundaries

### `src/entities/`

Domain types, raw DB row types, mappers, and constants. Every entity module contains:

- `XxxRow` — raw snake_case DB shape (never returned to UI)
- `Xxx` — camelCase domain type (returned by services)
- `xxxFromRow()` — mapper function
- Validators and constants

**Rule:** no Supabase imports. Pure TypeScript.

### `src/services/`

All Supabase query logic lives here. Services always:
- Accept strongly-typed arguments
- Return mapped domain types (never `XxxRow`)
- Throw `ServiceError` (extends `Error` with a `code: string` field) on failure
- Use `unwrap()` from `errors.ts` rather than manual `.error` checks

**Rule:** no React imports. Called only from feature hooks.

### `src/features/`

Feature directories each contain:
- Page component(s) (`.tsx`)
- `hooks.ts` — React Query hooks that call services; the only place services are called from

**Rule:** `.tsx` files never call services directly. All data access goes through hooks.

### `supabase/functions/`

Edge Functions run in Deno. They cannot import from `src/`. Any shared logic (type guards, constants, crypto helpers) is inlined per function with a "keep in sync" comment.

Each function:
- Validates JWT and asserts ownership before any DB write
- Uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS for server-side writes)
- Never forwards provider error bodies to the client
- Returns a typed error code string in every non-200 response

---

## Data Flow

### Journal write

```
User types
  → Lexical OnChangePlugin (1500ms debounce)
  → useUpsertEntry (React Query mutation)
  → syncEngine.enqueueEntry()
  → journalService.upsertEntry()  (tries immediate write)
  → on failure: syncQueue.enqueue() (IndexedDB)
  → drains on: online event | 30s poll | explicit flush()
  → Supabase UPSERT ON CONFLICT (user_id, entry_date)
```

### Reflection

```
User clicks Reflect
  → useGenerateReflection hook
  → insightsService.generateReflection(entryId)
  → POST /functions/v1/generate-reflection
      → HF emotion model (7 scores)
      → context_memory + life_chapters query (≤500 token block)
      → Groq LLM (reflection + themes + question)
      → UPSERT insights ON CONFLICT (user_id, entry_id, type)
      → fire-and-forget POST /functions/v1/extract-memory
  → client receives ReflectionPayload
```

### Memory extraction (background)

```
POST /functions/v1/extract-memory  (fire-and-forget, no client await)
  → idempotency check: SELECT memory_extractions WHERE (user_id, entry_id)
  → Step 1: entity extraction → UPSERT context_memory
  → Step 2: chapter candidate scoring (multi-signal, entry_date window)
  → Step 3: stability check → promote forming → active
  → Step 4: dormancy sweep → mark stale active chapters dormant
  → INSERT memory_extractions  ← commit point
```

---

## Offline-First Sync

IndexedDB database: `unsaid-sync`, version 1.

**Mutation ID:** `${userId}:${entryDate}:${action}` — deterministic. A new write for the same entry+day replaces the pending mutation (last-write-wins). The server uses `UPSERT ON CONFLICT (user_id, entry_date)` so replayed mutations are idempotent.

**Drain triggers:**
1. `online` browser event
2. 30-second polling interval (while online)
3. After every successful direct write

**Testing:** Use `fake-indexeddb` (`import 'fake-indexeddb/auto'`) for full IndexedDB unit tests without a browser.

---

## Auth and Access Control

Two gates for all data access:

1. **Authentication** — magic-link (OTP) via Supabase Auth. No passwords.
2. **Approval** — `profiles.status` must be `'approved'`. New signups start as `'pending'` and are redirected to `/waitlist`.

Admin users (`profiles.role = 'admin'`) can approve/reject waitlist applicants from `/admin`. Admin role is checked server-side via RLS. The `AdminRoute` component in the frontend is a UI-only guard — it is not a security boundary.

RLS is enabled on every table. Unauthenticated or pending users receive no data even if they bypass the client-side guards.

**Preventing infinite recursion in RLS:** Policies on `profiles` must not query `profiles` directly (causes Postgres error 42P17). Two `SECURITY DEFINER` helper functions — `auth_role()` and `auth_status()` — bypass RLS safely and are used in all policies that need to read the calling user's role or status.

---

## Key Invariants

These invariants are enforced at multiple levels (DB constraints, service layer, Edge Function guards). Violating them produces silent data corruption.

| Invariant | Where enforced |
|---|---|
| `entry_date` is always a local `"YYYY-MM-DD"` string — never from `toISOString()` | `getTodayLocal()` utility; DB `DATE` type |
| One entry per user per calendar day | `UNIQUE (user_id, entry_date)` DB constraint |
| Services never return raw DB rows | All service methods call `xFromRow()` mappers |
| `.tsx` files never call services directly | Convention; hooks are the only consumers |
| All writes go through `syncEngine.enqueueEntry()` | Enforced by `useUpsertEntry` hook |
| Memory tables are service_role-only writes | No client INSERT/UPDATE/DELETE RLS policies |
| `memory_extractions` is the extraction commit point | Absent row = extraction incomplete = retry |
| `LexicalComposer` only mounts after `editorSeedReady = true` | Editor seed guard in `JournalPage` |
| Streaks and heatmaps derive from `entry_date` only | Never from `created_at` |

---

## Mobile Design

UnSaid is designed for equal first-class use on desktop and mobile. Journaling happens on the couch, during commutes, and just before bed.

**Supported viewport range:** 390–1440px. Breakpoint: ≤ 680px activates the mobile layout.

Every milestone should include a mobile pass before it is considered complete. Mobile-specific behaviours are documented per feature in the relevant component files.
