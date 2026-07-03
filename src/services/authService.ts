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
    // emailRedirectTo must point to /auth/callback so the PKCE code= param
    // is handled by AuthCallbackPage.exchangeCodeForSession() instead of
    // being silently dropped on the root route.
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: redirectTo,
      },
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
   * Fetches the profile first (critical path), then calls ensure_profile as
   * a best-effort fallback only when the profile is missing.  The RPC is
   * never allowed to block or interfere with the primary SELECT.
   */
  async getProfile(): Promise<AppUser | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const result = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // Happy path — profile exists and RLS allowed the read.
    if (!result.error && result.data) {
      return userFromRow(result.data as ProfileRow);
    }

    // No error but no data = RLS filtered the row (shouldn't happen for own
    // profile, but treat it the same as missing).
    const isMissing =
      result.data === null ||
      (result.error !== null && result.error.code === 'PGRST116');

    if (isMissing) {
      // Call ensure_profile to provision the row if it doesn't exist yet.
      // This is the resilience fallback for the verified-trigger migration.
      const { error: rpcError } = await supabase.rpc('ensure_profile');
      if (rpcError) {
        // RPC not deployed yet — nothing we can do, treat as not signed in.
        return null;
      }

      // Retry once after provisioning.
      const retry = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (retry.error || !retry.data) return null;
      return userFromRow(retry.data as ProfileRow);
    }

    // Any other unexpected DB error.
    throw unwrap(result);
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
