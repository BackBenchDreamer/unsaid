-- ============================================================
-- Migration 006 — Weekly summary partial unique index
--
-- Run in Supabase SQL Editor AFTER migrations 001–005.
-- Safe to run multiple times (idempotent).
--
-- Context: Migration 003 (003_reflection_type.sql) added the
-- period_start and period_end columns to the insights table and
-- documented this index, explicitly deferring its creation to
-- Milestone 2 when summary rows would first be written.
--
-- This migration activates that deferred index.
-- ============================================================

-- ── Create partial unique index for period-based insight rows ──
--
-- The existing uq_insight_entry_type UNIQUE constraint covers
-- (user_id, entry_id, type) but only when entry_id IS NOT NULL.
-- Postgres treats NULLs as distinct in UNIQUE constraints, so
-- entry_id IS NULL rows (weekly/monthly summaries) are not
-- covered by that constraint.
--
-- This partial index enforces: one summary per user per
-- (type, period_start, period_end) window when entry_id IS NULL.
-- This prevents duplicate weekly summaries from being inserted
-- concurrently (e.g. two Regenerate clicks within the same second).
--
-- The onConflict key used by the Edge Function upsert must match
-- the columns in this index: (user_id, type, period_start, period_end).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'insights'
      AND indexname  = 'uq_insight_summary_period'
  ) THEN
    CREATE UNIQUE INDEX uq_insight_summary_period
      ON public.insights (user_id, type, period_start, period_end)
      WHERE entry_id IS NULL;
  END IF;
END;
$$;
