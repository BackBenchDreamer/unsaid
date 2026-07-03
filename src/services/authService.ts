/**
 * Auth Service — wraps Supabase Auth.
 *
 * Intent-based methods, no raw Supabase calls in components.
 */

import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { userFromRow } from '../entities/user';
import type { AppUser, ProfileRow } from '../entities/user';
import { unwrap, AuthError } from './errors';

export interface AuthState {
  session: Session | null;
  user: User | null;
}

export const authService = {
  /**
   * Sign in with magic link (OTP via email).
   */
  async signInWithOtp(email: string): Promise<void> {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) throw new AuthError(error.message, error);
  },

  /**
   * Verify OTP token from magic link.
   */
  async verifyOtp(email: string, token: string): Promise<Session> {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error) throw new AuthError(error.message, error);
    if (!data.session) throw new AuthError('No session returned');
    return data.session;
  },

  /**
   * Get current session (from local storage / refresh).
   */
  async getSession(): Promise<AuthState> {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw new AuthError(error.message, error);
    return {
      session: data.session,
      user: data.session?.user ?? null,
    };
  },

  /**
   * Get the app-level profile for the current user.
   *
   * Calls the ensure_profile RPC first so that the profile and user_settings
   * rows are guaranteed to exist even if the UPDATE trigger was missed (e.g.
   * Supabase maintenance, pre-migration sign-ups).  The RPC is a no-op when
   * both rows already exist, so this is always safe to call on sign-in.
   */
  async getProfile(): Promise<AppUser | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    // Best-effort ensure: provision profile+settings rows if missing.
    // Failure is non-fatal — profile fetch below will still reflect reality.
    await supabase.rpc('ensure_profile').then(
      () => {},
      () => {}, // silently ignore — fallback, not critical path
    );

    const result = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (result.error && result.error.code === 'PGRST116') {
      // Profile still doesn't exist (e.g. unverified user with no confirmed email).
      return null;
    }

    const row = unwrap(result) as ProfileRow;
    return userFromRow(row);
  },

  /**
   * Sign out.
   */
  async signOut(): Promise<void> {
    const { error } = await supabase.auth.signOut();
    if (error) throw new AuthError(error.message, error);
  },

  /**
   * Listen to auth state changes.
   */
  onAuthStateChange(callback: (event: string, session: Session | null) => void) {
    return supabase.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
  },
};
