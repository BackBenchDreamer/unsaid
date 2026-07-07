-- ============================================================
-- Migration 008 — Memory Extraction Version (Milestone 3 follow-up)
-- ============================================================
-- Adds an `extraction_version` column to memory_extractions.
--
-- Rationale:
--   `prompt_version` on memory_extractions records the AI reflection
--   prompt version (ReflectionPayload._meta.version) at extraction time.
--   It answers "which reflection generated this extraction?" but does NOT
--   identify which extraction logic version was used.
--
--   `extraction_version` is a separate, independently-versioned constant
--   (e.g. '1.0.0') defined in the extract-memory Edge Function. It must be
--   bumped whenever the extraction pipeline changes in a way that would
--   produce meaningfully different context_memory or life_chapter results
--   (e.g. new entity types, changed candidate scoring signals, different
--   chapter promotion thresholds). It is independent of the reflection
--   prompt version.
--
--   When the extraction_version changes:
--     DELETE FROM memory_extractions WHERE extraction_version != '<new>';
--   This forces re-extraction for all entries under the new pipeline logic
--   without requiring a full schema migration.
--
-- Initial value: '1.0.0' for all existing rows (backfill via DEFAULT).
-- Run after: 007_memory_tables.sql
-- Run before: any Milestone 4 migrations
-- ============================================================

ALTER TABLE public.memory_extractions
  ADD COLUMN IF NOT EXISTS extraction_version TEXT NOT NULL DEFAULT '1.0.0';

-- Backfill: existing rows (written before this migration) are tagged '1.0.0'
-- because they were all produced by the initial extraction pipeline.
-- The DEFAULT above handles this automatically for existing rows.

-- Update the AGENTS.md invariant note is documented in the changelog.
