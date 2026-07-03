-- ============================================================
-- UnSaid — user_settings table migration
-- Run AFTER schema.sql in the Supabase SQL Editor.
-- ============================================================

-- ─── User Settings ──────────────────────────────────────────
-- 1:1 with profiles. Stores per-user preferences and
-- the AES-GCM encrypted HuggingFace API token.
-- The hf_token_encrypted column is NEVER returned to the client;
-- it is only read inside Edge Functions using the service role key.

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id               UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  theme                 TEXT NOT NULL DEFAULT 'dark'
                        CHECK (theme IN ('dark', 'light')),
  hf_token_encrypted    TEXT,           -- AES-GCM ciphertext; null until user saves a token
  hf_model              TEXT NOT NULL DEFAULT 'j-hartmann/emotion-english-distilroberta-base',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── Extend handle_new_user to also create a settings row ───
-- Replace the existing function so new sign-ups get a settings
-- row automatically. The INSERT into user_settings uses the same
-- SECURITY DEFINER context so no RLS policy is needed for INSERT.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);

  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Backfill settings rows for any existing profiles ───────
-- Safe to run even if no profiles exist yet.
INSERT INTO public.user_settings (user_id)
SELECT id FROM public.profiles
WHERE id NOT IN (SELECT user_id FROM public.user_settings)
ON CONFLICT DO NOTHING;
