/**
 * Insights Service — triggers Edge Functions for AI reflection
 * and retrieves cached insights from the DB.
 *
 * All inference happens server-side (Edge Functions).
 * This service only triggers and reads results — no business logic.
 *
 * Cache-check logic lives inside the Edge Function.
 * Stale-detection logic lives in src/features/insights/hooks.ts.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import type { EntryInsight, SentimentResult, ReflectionResult } from '../entities/insight';
import { ServiceError } from './errors';

/**
 * Response envelope returned by the analyze-sentiment Edge Function on success.
 */
interface GenerateInsightResponse {
  result: SentimentResult;
  meta: {
    /** True when the Edge Function returned a cached result (no inference call). */
    cached: boolean;
    /** Wall-clock ms of the inference call. 0 when cached. */
    generationMs: number;
  };
}

/**
 * Response envelope returned by the generate-reflection Edge Function on success.
 */
interface GenerateReflectionResponse {
  result: ReflectionResult;
  meta: {
    cached: boolean;
    generationMs: number;
  };
}

/**
 * Error envelope returned by the Edge Function on failure.
 * `code` is one of: MODEL_LOADING | PROVIDER_ERROR | SHAPE_ERROR | REFLECTION_NOT_CONFIGURED |
 * (absent for auth/server errors)
 */
interface EdgeFunctionErrorResponse {
  error: string;
  code?: string;
}

/** Raw DB row shape from the insights table. */
interface InsightRow {
  id: string;
  entry_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  source_hash: string | null;
  created_at: string;
}

/**
 * Result type for generateReflection().
 * Returns a typed value (not a thrown error) for REFLECTION_NOT_CONFIGURED so the
 * hook can silently fall back to the HF-only path without showing an error state.
 */
export type GenerateReflectionResult =
  | { ok: true; data: ReflectionResult }
  | { ok: false; code: 'REFLECTION_NOT_CONFIGURED' };

export const insightsService = {
  /**
   * Fetch all cached insights for a user, optionally filtered by type.
   * Returns fully-mapped EntryInsight objects (never raw DB rows).
   *
   * TODO: add LIMIT and pagination support when InsightsPage adds infinite scroll or
   * when the user base reaches 1+ year of daily usage. Current cap: unbounded.
   * After one year of daily journaling with two insight types, this can be 730+ rows.
   */
  async getInsights(userId: string, type?: string): Promise<EntryInsight[]> {
    let query = supabase
      .from('insights')
      .select('id, entry_id, type, payload, source_hash, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: InsightRow) => ({
      id: r.id,
      entryId: r.entry_id,
      type: r.type as EntryInsight['type'],
      payload: r.payload,
      sourceHash: r.source_hash,
      createdAt: r.created_at,
    }));
  },

  /**
   * Trigger AI reflection for the given journal entry via the Edge Function.
   *
   * The Edge Function:
   *   - Checks source_hash cache — returns immediately if content unchanged
   *     AND the cached row passes structural validation (confidence > 0).
   *   - Calls the AI provider only on cache miss.
   *   - Stores the result + _meta + source_hash ONLY on successful generation.
   *
   * Throws typed ServiceErrors so the UI can present appropriate messages:
   *   code='MODEL_LOADING'  — HF cold start; user should retry in ~20s
   *   code='PROVIDER_ERROR' — HF returned a non-200 error
   *   code='SHAPE_ERROR'    — HF returned an unrecognised response format
   *   code='EDGE_FUNCTION_ERROR' — transport / unknown error
   */
  async generateInsight(entryId: string): Promise<SentimentResult> {
    const { data, error } = await supabase.functions.invoke('analyze-sentiment', {
      body: { entryId },
    });

    // supabase-js wraps non-2xx Edge Function responses in a FunctionsHttpError.
    // error.message is always the generic "Edge Function returned a non-2xx status code".
    // The actual JSON body lives in error.context (a Response object) — must be
    // read with .json() (async). Falls back to error.message if parsing fails.
    if (error) {
      let code = 'EDGE_FUNCTION_ERROR';
      let message = error.message;

      if (error instanceof FunctionsHttpError) {
        try {
          const body = await (error.context as Response).json() as EdgeFunctionErrorResponse;
          if (body?.code) code = body.code;
          if (body?.error) message = body.error;
        } catch {
          // context body already consumed or not JSON — use generic message
        }
      }

      throw new ServiceError(message, code);
    }

    const response = data as GenerateInsightResponse;

    // Log cache metadata for observability — not surfaced in the UI.
    if (import.meta.env.DEV) {
      console.debug(
        `[insight] entry=${entryId} cached=${response.meta?.cached} generationMs=${response.meta?.generationMs}`,
      );
    }

    return response.result;
  },

  /**
   * Trigger reflection generation for the given journal entry via the Edge Function.
   *
   * Returns a typed result rather than throwing for REFLECTION_NOT_CONFIGURED —
   * this allows the hook to silently fall back to the legacy HF sentiment path.
   *
   * All other errors are thrown as ServiceErrors (same pattern as generateInsight).
   *
   * Throws typed ServiceErrors for:
   *   code='HF_PROVIDER_ERROR'   — HF returned a non-200 error
   *   code='GROQ_PROVIDER_ERROR' — Groq returned a non-200 error
   *   code='SHAPE_ERROR'         — Groq returned invalid JSON or bad structure
   *   code='EDGE_FUNCTION_ERROR' — transport / unknown error
   */
  async generateReflection(entryId: string): Promise<GenerateReflectionResult> {
    const { data, error } = await supabase.functions.invoke('generate-reflection', {
      body: { entryId },
    });

    // Same FunctionsHttpError pattern as generateInsight — error.message is the
    // generic wrapper; actual structured body is in error.context (Response).
    if (error) {
      let code = 'EDGE_FUNCTION_ERROR';
      let message = error.message;

      if (error instanceof FunctionsHttpError) {
        try {
          const body = await (error.context as Response).json() as EdgeFunctionErrorResponse;
          if (body?.code) code = body.code;
          if (body?.error) message = body.error;
        } catch {
          // context body already consumed or not JSON — use generic message
        }
      }

      // REFLECTION_NOT_CONFIGURED is an expected condition — not an error state.
      // Groq token not set yet; caller silently falls back to analyze-sentiment.
      if (code === 'REFLECTION_NOT_CONFIGURED') {
        return { ok: false, code: 'REFLECTION_NOT_CONFIGURED' };
      }

      throw new ServiceError(message, code);
    }

    const response = data as GenerateReflectionResponse;

    if (import.meta.env.DEV) {
      console.debug(
        `[reflection] entry=${entryId} cached=${response.meta?.cached} generationMs=${response.meta?.generationMs}`,
      );
    }

    return { ok: true, data: response.result };
  },
};
