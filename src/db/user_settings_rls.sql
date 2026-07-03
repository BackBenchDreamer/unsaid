-- ============================================================
-- UnSaid — user_settings RLS policies
-- Run AFTER rls.sql in the Supabase SQL Editor.
-- ============================================================

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Users can read only their own settings row.
CREATE POLICY "Users can read own settings"
  ON public.user_settings FOR SELECT
  USING (auth.uid() = user_id);

-- Users can update only their own settings row.
-- They cannot change user_id (WITH CHECK enforces this).
CREATE POLICY "Users can update own settings"
  ON public.user_settings FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Note: No INSERT policy — rows are created by the handle_new_user
-- trigger (SECURITY DEFINER). Users never need to INSERT directly.
-- Note: No DELETE policy — settings are deleted via CASCADE from profiles.
