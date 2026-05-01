-- ============================================================
-- UnSaid — Supabase Schema
-- ============================================================
-- Run this against a fresh Supabase project (or as a migration).
-- ============================================================

-- ─── Enable required extensions ────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Profiles ──────────────────────────────────────────────
-- Mirrors auth.users, extended with app-specific fields.
-- Populated via trigger on auth.users insert.
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  display_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user'
              CHECK (role IN ('user', 'admin')),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_role   ON public.profiles(role);

-- ─── Journal Entries ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  mood        TEXT CHECK (mood IN ('terrible', 'bad', 'meh', 'good', 'great')),
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- INVARIANT: one entry per user per calendar day.
  CONSTRAINT uq_user_entry_date UNIQUE (user_id, entry_date)
);

-- Indexes for dashboard, heatmap, history views.
CREATE INDEX IF NOT EXISTS idx_entries_user_date  ON public.entries(user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_mood   ON public.entries(user_id, mood);
CREATE INDEX IF NOT EXISTS idx_entries_date        ON public.entries(entry_date);

-- ─── Waitlist ──────────────────────────────────────────────
-- Tracks invite requests before they become profiles.
CREATE TABLE IF NOT EXISTS public.waitlist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT NOT NULL UNIQUE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES public.profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_waitlist_status ON public.waitlist(status);

-- ─── Insights (optional materialized cache) ────────────────
CREATE TABLE IF NOT EXISTS public.insights (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_id    UUID REFERENCES public.entries(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('sentiment', 'summary', 'pattern')),
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_user ON public.insights(user_id, type);

-- ─── Auto-update updated_at trigger ────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entries_updated_at
  BEFORE UPDATE ON public.entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─── Auto-create profile on signup ─────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only create if it doesn't exist (idempotent-ish for migrations).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  END IF;
END;
$$;

-- ─── RPC: Heatmap data ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_heatmap(
  p_user_id UUID,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TABLE(date DATE, has_entry BOOLEAN, mood TEXT) AS $$
BEGIN
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── RPC: Memories ("on this day") ────────────────────────
CREATE OR REPLACE FUNCTION public.get_memories(
  p_user_id UUID,
  p_today DATE
)
RETURNS TABLE(id UUID, entry_date DATE, snippet TEXT, mood TEXT, days_ago INT) AS $$
BEGIN
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
