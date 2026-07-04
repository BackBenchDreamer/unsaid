-- ============================================================
-- Migration 003 — Add 'reflection' insight type + future-proof columns
--
-- Run in Supabase SQL Editor AFTER migrations 001 and 002.
-- Safe to run multiple times (idempotent).
-- ============================================================

-- ── 1. Expand type CHECK to include 'reflection' ────────────
-- The inline CHECK on the type column is unnamed (Postgres auto-generates the
-- name). LIKE '%''sentiment''%' quotes the literal so it matches only the type
-- check definition and not any future constraint that incidentally contains the
-- word "sentiment" in a different position.
-- The ADD CONSTRAINT block is also guarded with an existence check so the
-- migration is safe to re-run (idempotent as stated in the header comment).
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.insights'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%''sentiment''%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.insights DROP CONSTRAINT %I', v_conname);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insights_type_check'
      AND conrelid = 'public.insights'::regclass
  ) THEN
    ALTER TABLE public.insights
      ADD CONSTRAINT insights_type_check
        CHECK (type IN ('sentiment', 'summary', 'pattern', 'reflection'));
  END IF;
END;
$$;

-- ── 2. Future-proof columns (nullable, unused in Milestone 1) ──
-- period_start / period_end: weekly and monthly summary windows (Milestone 2+)
-- updated_at: tracks last regeneration time when an upsert overwrites a row.
--   Added as nullable first, backfilled from created_at so existing rows carry
--   a meaningful timestamp (not the migration run date), then DEFAULT set.
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS period_end   DATE;
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE public.insights SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE public.insights ALTER COLUMN updated_at SET DEFAULT now();

-- ── Future summary rows note ──────────────────────────────────
-- The uq_insight_entry_type UNIQUE constraint (user_id, entry_id, type) does NOT
-- enforce uniqueness when entry_id IS NULL (Postgres treats NULLs as distinct).
-- Weekly and monthly summary insights (entry_id IS NULL) require a separate
-- partial unique index. Add this when implementing summary insights:
--
-- CREATE UNIQUE INDEX uq_insight_summary_period
--   ON public.insights (user_id, type, period_start, period_end)
--   WHERE entry_id IS NULL;
--
-- Do NOT add this index in Migration 003 — period_start/period_end are not
-- yet used and the index would be vacuous until summary rows are written.
