/**
 * Settings Service — reads and writes user_settings rows.
 *
 * Token handling:
 *  - saveHFToken() / saveGroqToken() call the encrypt-token Edge Function;
 *    the raw token never persists in the client after this call returns.
 *  - hasHFToken() checks if hf_token_encrypted is non-null; it does NOT
 *    return the ciphertext or the plaintext.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { ServiceError } from './errors';

export interface UserSettings {
  userId: string;
  theme: 'dark' | 'light';
  /**
   * The AI model identifier from user_settings.hf_model.
   * Provider-agnostic name — the column name is HF-specific but the value
   * is treated as an opaque model identifier throughout the client.
   */
  aiModel: string;
  /**
   * True when the user has a HF token configured (hf_token_encrypted IS NOT NULL).
   * Named aiConfigured rather than hasHFToken so the UI remains provider-agnostic.
   */
  aiConfigured: boolean;
  /**
   * True when the user has a Groq token configured (groq_token_encrypted IS NOT NULL).
   * Enables the full reflection generation path.
   */
  reflectionConfigured: boolean;
  /**
   * The Groq model identifier from user_settings.groq_model.
   * Used by generate-reflection Edge Function and by useEntryInsight for stale detection.
   */
  reflectionModel: string;
  updatedAt: string;
}

interface SettingsRow {
  user_id: string;
  theme: string;
  hf_model: string;
  hf_token_encrypted: string | null;
  groq_token_encrypted: string | null;
  groq_model: string;
  updated_at: string;
}

function settingsFromRow(row: SettingsRow): UserSettings {
  return {
    userId: row.user_id,
    theme: row.theme as 'dark' | 'light',
    aiModel: row.hf_model,
    aiConfigured: row.hf_token_encrypted !== null,
    reflectionConfigured: row.groq_token_encrypted !== null,
    reflectionModel: row.groq_model,
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
      .select('user_id, theme, hf_model, hf_token_encrypted, groq_token_encrypted, groq_model, updated_at')
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
   *
   * supabase.functions.invoke() wraps non-2xx responses in a FunctionsHttpError
   * whose generic .message is always "Edge Function returned a non-2xx status code".
   * The real error body lives in error.context (a Response object) — we extract it
   * so the UI can show the actual server-side message to the developer.
   */
  async saveHFToken(plainToken: string): Promise<void> {
    const { error } = await supabase.functions.invoke('encrypt-token', {
      body: { token: plainToken },
    });

    if (!error) return;

    // Extract the real JSON body from the raw Response object so we can
    // surface a meaningful error message instead of the Supabase wrapper's
    // generic "Edge Function returned a non-2xx status code".
    if (error instanceof FunctionsHttpError) {
      try {
        const body = await (error.context as Response).json() as { error?: string };
        const message = body?.error ?? error.message;
        throw new ServiceError(message, 'EDGE_FUNCTION_ERROR');
      } catch (jsonErr) {
        // json() itself threw (e.g. body already consumed) — fall through
        if (jsonErr instanceof ServiceError) throw jsonErr;
      }
    }

    throw new ServiceError(error.message, 'EDGE_FUNCTION_ERROR');
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

  /**
   * Send the plaintext Groq API key to the encrypt-token Edge Function.
   * The raw token is never stored on the client after this call.
   * Error handling is identical to saveHFToken().
   */
  async saveGroqToken(plainToken: string): Promise<void> {
    const { error } = await supabase.functions.invoke('encrypt-token', {
      body: { token: plainToken, provider: 'groq' },
    });

    if (!error) return;

    if (error instanceof FunctionsHttpError) {
      try {
        const body = await (error.context as Response).json() as { error?: string };
        const message = body?.error ?? error.message;
        throw new ServiceError(message, 'EDGE_FUNCTION_ERROR');
      } catch (jsonErr) {
        if (jsonErr instanceof ServiceError) throw jsonErr;
      }
    }

    throw new ServiceError(error.message, 'EDGE_FUNCTION_ERROR');
  },

  /**
   * Update the Groq model preference.
   */
  async updateGroqModel(userId: string, model: string): Promise<void> {
    const { error } = await supabase
      .from('user_settings')
      .update({ groq_model: model })
      .eq('user_id', userId);

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
  },
};
