/**
 * Settings Service — reads and writes user_settings rows.
 *
 * HF token handling:
 *  - saveHFToken() calls the encrypt-token Edge Function; the raw token
 *    never persists in the client after this call returns.
 *  - hasHFToken() checks if hf_token_encrypted is non-null; it does NOT
 *    return the ciphertext or the plaintext.
 */

import { supabase } from './supabaseClient';
import { ServiceError } from './errors';

export interface UserSettings {
  userId: string;
  theme: 'dark' | 'light';
  hfModel: string;
  hasHFToken: boolean;
  updatedAt: string;
}

interface SettingsRow {
  user_id: string;
  theme: string;
  hf_model: string;
  hf_token_encrypted: string | null;
  updated_at: string;
}

function settingsFromRow(row: SettingsRow): UserSettings {
  return {
    userId: row.user_id,
    theme: row.theme as 'dark' | 'light',
    hfModel: row.hf_model,
    hasHFToken: row.hf_token_encrypted !== null,
    updatedAt: row.updated_at,
  };
}

export const settingsService = {
  /**
   * Fetch the settings row for the given user.
   */
  async getSettings(userId: string): Promise<UserSettings> {
    const { data, error } = await supabase
      .from('user_settings')
      .select('user_id, theme, hf_model, hf_token_encrypted, updated_at')
      .eq('user_id', userId)
      .single();

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
    if (!data) throw new ServiceError('Settings not found', 'NOT_FOUND', 404);

    return settingsFromRow(data as SettingsRow);
  },

  /**
   * Update the theme preference.
   */
  async updateTheme(userId: string, theme: 'dark' | 'light'): Promise<void> {
    const { error } = await supabase
      .from('user_settings')
      .update({ theme })
      .eq('user_id', userId);

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
  },

  /**
   * Send the plaintext HF token to the encrypt-token Edge Function.
   * The raw token is never stored on the client after this call.
   */
  async saveHFToken(plainToken: string): Promise<void> {
    const { error } = await supabase.functions.invoke('encrypt-token', {
      body: { token: plainToken },
    });

    if (error) throw new ServiceError(error.message, 'EDGE_FUNCTION_ERROR');
  },

  /**
   * Check whether a HF token has been saved (without revealing the ciphertext).
   */
  async hasHFToken(userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('user_settings')
      .select('hf_token_encrypted')
      .eq('user_id', userId)
      .single();

    if (error) return false;
    return (data as { hf_token_encrypted: string | null } | null)?.hf_token_encrypted !== null;
  },
};
