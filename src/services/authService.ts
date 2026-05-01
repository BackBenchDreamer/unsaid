/**
 * Auth Service — wraps Supabase Auth.
 *
 * Intent-based methods, no raw Supabase calls in components.
 */

import { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { AppUser, userFromRow, ProfileRow } from '../entities/user';
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
   * This is the source of truth for role and status.
   */
  async getProfile(): Promise<AppUser | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const result = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (result.error && result.error.code === 'PGRST116') {
      // Profile doesn't exist yet (race with trigger).
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
