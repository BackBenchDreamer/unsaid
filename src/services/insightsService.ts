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
import type { EntryInsight, SentimentResult, ReflectionResult, WeeklyResult } from '../entities/insight';
import { ServiceError } from './errors';

/**
 * Parse a structured error body from a Supabase Edge Function HTTP error.
 *
 * supabase-js wraps non-2xx Edge Function responses in FunctionsHttpError.
 * error.message is always the generic wrapper string.
 * The actual JSON body lives in error.context (a Response object) — must be
 * read with .json() (async). Falls back gracefully if parsing fails.
 *
 * Returns { code, message } extracted from the body, or the generic defaults.
 */
async function parseEdgeFunctionError(
  error: unknown,
): Promise<{ code: string; message: string }> {
  let code = 'EDGE_FUNCTION_ERROR';
  let message = error instanceof Error ? error.message : 'Unknown error';

  if (error instanceof FunctionsHttpError) {
    try {
      const body = await (error.context as Response).json() as { error?: string; code?: string };
      if (body?.code) code = body.code;
      if (body?.error) message = body.error;
    } catch {
      // context body already consumed or not JSON — use generic message
    }
  }

  return { code, message };
}

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

/** Raw DB row shape from the insights table. */
interface InsightRow {
  id: string;
  entry_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  source_hash: string | null;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
}

/**
 * Result type for generateReflection().
 * Returns a typed value (not a thrown error) for REFLECTION_NOT_CONFIGURED so the
 * hook can silently fall back to the HF-only path without showing an error state.
 */
export type GenerateReflectionResult =
  | { ok: true; data: ReflectionResult }
  | { ok: false; code: 'REFLECTION_NOT_CONFIGURED' };

/**
 * Result type for generateWeeklySummary().
 * Returns a typed value (not a thrown error) for expected non-error conditions
 * so the hook can handle them without showing an error state.
 */
export type GenerateWeeklySummaryResult =
  | { ok: true; data: WeeklyResult }
  | { ok: false; code: 'WEEKLY_NOT_CONFIGURED' | 'INSUFFICIENT_ENTRIES' };

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
      .select('id, entry_id, type, payload, source_hash, created_at, period_start, period_end')
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
      periodStart: r.period_start,
      periodEnd: r.period_end,
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

    if (error) {
      const { code, message } = await parseEdgeFunctionError(error);
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

    if (error) {
      const { code, message } = await parseEdgeFunctionError(error);
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

  /**
   * Trigger weekly reflection generation for the given week start date.
   *
   * Builds on existing per-entry reflections where available (best-effort):
   *   - For entries that have been reflected on: uses the stored reflection summary.
   *   - For entries without a reflection: uses the first 300 chars of raw content.
   *
   * Returns a typed result rather than throwing for expected conditions:
   *   { ok: false, code: 'WEEKLY_NOT_CONFIGURED' }  — Groq not configured
   *   { ok: false, code: 'INSUFFICIENT_ENTRIES' }   — fewer entries than required
   *
   * All other errors are thrown as ServiceErrors.
   *
   * @param weekStart  Monday of the target week in "YYYY-MM-DD" format.
   */
  async generateWeeklySummary(weekStart: string): Promise<GenerateWeeklySummaryResult> {
    const { data, error } = await supabase.functions.invoke('generate-weekly-summary', {
      body: { weekStart },
    });

    if (error) {
      const { code, message } = await parseEdgeFunctionError(error);
      // Expected non-error conditions — caller handles without showing error UI.
      if (code === 'WEEKLY_NOT_CONFIGURED') {
        return { ok: false, code: 'WEEKLY_NOT_CONFIGURED' };
      }
      if (code === 'INSUFFICIENT_ENTRIES') {
        return { ok: false, code: 'INSUFFICIENT_ENTRIES' };
      }
      throw new ServiceError(message, code);
    }

    const response = data as { result: WeeklyResult; meta: { cached: boolean; generationMs: number } };

    if (import.meta.env.DEV) {
      console.debug(
        `[weekly] weekStart=${weekStart} cached=${response.meta?.cached} generationMs=${response.meta?.generationMs}`,
      );
    }

    return { ok: true, data: response.result };
  },
};
