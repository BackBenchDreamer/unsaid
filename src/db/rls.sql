-- ============================================================
-- UnSaid — Row Level Security Policies
-- ============================================================
-- All user data access is governed by RLS.
-- Admin operations check role from the profiles table, not the client.
--
-- IMPORTANT: Policies on `profiles` must NEVER query `profiles` directly
-- (e.g. with EXISTS or a subselect) — that causes infinite recursion
-- (Postgres error 42P17).  Instead we use two SECURITY DEFINER helper
-- functions that bypass RLS and are safe to call from within policies.
-- ============================================================

ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insights          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.life_chapters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_extractions ENABLE ROW LEVEL SECURITY;

-- ─── RLS helper functions ───────────────────────────────────
-- These are SECURITY DEFINER so they run as the function owner (postgres),
-- bypassing RLS entirely.  They are the ONLY safe way to read profiles
-- from within a profiles RLS policy without triggering infinite recursion.

CREATE OR REPLACE FUNCTION public.auth_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.auth_status()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT status FROM public.profiles WHERE id = auth.uid();
$$;

-- ─── Profiles ──────────────────────────────────────────────

-- Users can read their own profile row.
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Users can update their own display_name; role and status are immutable
-- from the client (only admins can change those via the admin policy).
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role   = public.auth_role()    -- role unchanged
    AND status = public.auth_status()  -- status unchanged
  );

-- Admins can read ALL profiles (uses helper to avoid recursion).
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT
  USING (public.auth_role() = 'admin');

-- Admins can update any profile (for approval/rejection).
DROP POLICY IF EXISTS "Admins can update profiles" ON public.profiles;
CREATE POLICY "Admins can update profiles"
  ON public.profiles FOR UPDATE
  USING (public.auth_role() = 'admin');

-- ─── Entries ───────────────────────────────────────────────
-- Entries policies query `profiles` but from a *different* table's policy,
-- so there is no recursion here — these are safe as-is.

DROP POLICY IF EXISTS "Approved users can read own entries" ON public.entries;
CREATE POLICY "Approved users can read own entries"
  ON public.entries FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can insert own entries" ON public.entries;
CREATE POLICY "Approved users can insert own entries"
  ON public.entries FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can update own entries" ON public.entries;
CREATE POLICY "Approved users can update own entries"
  ON public.entries FOR UPDATE
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can delete own entries" ON public.entries;
CREATE POLICY "Approved users can delete own entries"
  ON public.entries FOR DELETE
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

-- ─── Waitlist ──────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can add themselves to waitlist" ON public.waitlist;
CREATE POLICY "Users can add themselves to waitlist"
  ON public.waitlist FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can read waitlist" ON public.waitlist;
CREATE POLICY "Admins can read waitlist"
  ON public.waitlist FOR SELECT
  USING (public.auth_role() = 'admin');

DROP POLICY IF EXISTS "Admins can update waitlist" ON public.waitlist;
CREATE POLICY "Admins can update waitlist"
  ON public.waitlist FOR UPDATE
  USING (public.auth_role() = 'admin');

-- ─── Insights ──────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can read own insights" ON public.insights;
CREATE POLICY "Users can read own insights"
  ON public.insights FOR SELECT
  USING (auth.uid() = user_id);

-- Only service_role (Edge Functions) can insert insights.
-- No INSERT policy = only service_role can write.

-- ─── Memory Tables (Milestone 3) ───────────────────────────
-- All four memory tables follow the same pattern as insights:
--   - Approved users can SELECT their own rows
--   - No INSERT/UPDATE/DELETE policy = only service_role (Edge Functions) can write
-- This is intentional: memory is built entirely by the extract-memory Edge Function,
-- never mutated directly by the client.

DROP POLICY IF EXISTS "Approved users can read own life chapters" ON public.life_chapters;
CREATE POLICY "Approved users can read own life chapters"
  ON public.life_chapters FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can read own chapter entries" ON public.chapter_entries;
CREATE POLICY "Approved users can read own chapter entries"
  ON public.chapter_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.life_chapters lc
      WHERE lc.id = chapter_entries.chapter_id
        AND lc.user_id = auth.uid()
        AND public.auth_status() = 'approved'
    )
  );

DROP POLICY IF EXISTS "Approved users can read own context memory" ON public.context_memory;
CREATE POLICY "Approved users can read own context memory"
  ON public.context_memory FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );

DROP POLICY IF EXISTS "Approved users can read own memory extractions" ON public.memory_extractions;
CREATE POLICY "Approved users can read own memory extractions"
  ON public.memory_extractions FOR SELECT
  USING (
    auth.uid() = user_id
    AND public.auth_status() = 'approved'
  );
