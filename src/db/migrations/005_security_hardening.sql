-- ============================================================
-- Migration 005 — Security hardening
-- Addresses Supabase Security Advisor warnings:
--   • function_search_path_mutable (5 functions)
--   • anon/authenticated can call SECURITY DEFINER RPCs
--   • get_heatmap / get_memories have no ownership check
--
-- Run in Supabase SQL Editor after migrations 001–004.
-- Safe to run multiple times (all statements are idempotent).
-- ============================================================

-- ─── 1. Fix search_path on set_updated_at ──────────────────
--
-- Trigger function used by entries and user_settings.
-- Adding SET search_path = '' means all table/function references
-- must be schema-qualified (they already are: public.entries, etc.)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = '';

-- ─── 2. Fix search_path + ownership guard on get_heatmap ───
--
-- SECURITY FIX: added p_user_id = auth.uid() guard.
-- Without this, any authenticated user could call
-- /rest/v1/rpc/get_heatmap with another user's UUID
-- and read their mood history.
CREATE OR REPLACE FUNCTION public.get_heatmap(
  p_user_id   UUID,
  p_start_date DATE,
  p_end_date   DATE
)
RETURNS TABLE(date DATE, has_entry BOOLEAN, mood TEXT) AS $$
BEGIN
  -- Ownership guard: the requesting user must own the data.
  IF auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    d::DATE AS date,
    EXISTS(
      SELECT 1 FROM public.entries e
      WHERE e.user_id = p_user_id
        AND e.entry_date = d::DATE
    ) AS has_entry,
    (
      SELECT e.mood FROM public.entries e
      WHERE e.user_id = p_user_id
        AND e.entry_date = d::DATE
      LIMIT 1
    ) AS mood
  FROM generate_series(p_start_date, p_end_date, '1 day'::INTERVAL) d;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = '';

-- ─── 3. Fix search_path + ownership guard on get_memories ──
--
-- SECURITY FIX: added p_user_id = auth.uid() guard.
-- Without this, any authenticated user could call
-- /rest/v1/rpc/get_memories with another user's UUID
-- and read their journal snippets.
CREATE OR REPLACE FUNCTION public.get_memories(
  p_user_id UUID,
  p_today   DATE
)
RETURNS TABLE(id UUID, entry_date DATE, snippet TEXT, mood TEXT, days_ago INT) AS $$
BEGIN
  -- Ownership guard: the requesting user must own the data.
  IF auth.uid() IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.entry_date,
    LEFT(e.content, 200) AS snippet,
    e.mood,
    (p_today - e.entry_date)::INT AS days_ago
  FROM public.entries e
  WHERE e.user_id = p_user_id
    AND EXTRACT(MONTH FROM e.entry_date) = EXTRACT(MONTH FROM p_today)
    AND EXTRACT(DAY FROM e.entry_date) = EXTRACT(DAY FROM p_today)
    AND e.entry_date < p_today
  ORDER BY e.entry_date DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = '';

-- ─── 4. Fix search_path on handle_new_user ─────────────────
--
-- This replaces the version in user_settings.sql with the
-- schema-qualified version. Logic is identical.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Guard: only run when email_confirmed_at transitions NULL → set.
  IF (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL) THEN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_settings (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = '';

-- ─── 5. Fix search_path on ensure_profile ──────────────────
--
-- Resilience fallback called by the client after sign-in.
-- The auth.uid() guard inside makes anonymous calls a no-op.
CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS void AS $$
DECLARE
  v_user_id UUID;
  v_email   TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO v_email
  FROM auth.users
  WHERE id = v_user_id;

  INSERT INTO public.profiles (id, email)
  VALUES (v_user_id, v_email)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = '';

-- ─── 6. Revoke anon EXECUTE on internal-only functions ─────
--
-- These functions are used exclusively by RLS policies or the
-- auth trigger — they should never be callable via the REST API
-- by anonymous users. REVOKE makes the intent explicit and
-- silences the security advisor warning.
--
-- Note: auth_role and auth_status already have SET search_path
-- in rls.sql — this only adds the REVOKE.
REVOKE EXECUTE ON FUNCTION public.auth_role()       FROM anon;
REVOKE EXECUTE ON FUNCTION public.auth_status()     FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_profile()  FROM anon;

-- ─── Notes on remaining warnings ───────────────────────────
--
-- waitlist INSERT WITH CHECK (true):
--   Intentional. The waitlist is a pre-auth signup form; anonymous
--   users must be able to insert their own email. The UNIQUE constraint
--   on waitlist.email prevents duplicate submissions. No change needed.
--
-- auth_leaked_password_protection:
--   Not applicable. UnSaid uses magic-link / email OTP only.
--   There are no passwords to check against HaveIBeenPwned. Ignore.
--
-- rls_auto_enable:
--   Supabase internal function — not created by this project. Ignore.
