-- ============================================================
-- Migration 004 — Add Groq provider columns to user_settings
--
-- groq_token_encrypted: AES-256-GCM ciphertext of the user's Groq API key.
--   Never returned to the client. Read only by Edge Functions via service role.
-- groq_model: the Groq model to use for reflection generation.
--   Default is 'llama-3.1-8b-instant' (fast, low-cost Groq model).
--
-- Run in Supabase SQL Editor AFTER migration 003.
-- Safe to run multiple times (idempotent).
-- ============================================================

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS groq_token_encrypted TEXT;
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS groq_model TEXT DEFAULT 'llama-3.1-8b-instant';
