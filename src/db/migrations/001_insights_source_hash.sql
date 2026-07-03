-- ============================================================
-- Migration 001 — Add source_hash + uq_insight_entry_type to insights
--
-- Run in Supabase SQL Editor.
-- Safe to run multiple times (idempotent).
-- ============================================================

-- Add source_hash column for AI reflection cache invalidation.
-- source_hash = SHA-256 of sourceEnvelope(content, promptVersion, model)
-- NULL on existing rows (treated as always-stale until re-reflected).
ALTER TABLE public.insights
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- Unique constraint enables ON CONFLICT upsert in the Edge Function.
-- One reflection row per (user_id, entry_id, type).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_insight_entry_type'
  ) THEN
    ALTER TABLE public.insights
      ADD CONSTRAINT uq_insight_entry_type UNIQUE (user_id, entry_id, type);
  END IF;
END;
$$;
