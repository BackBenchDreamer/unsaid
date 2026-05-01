/**
 * Insights Service — calls Edge Functions for sentiment analysis
 * and retrieves cached insights.
 *
 * All computation happens server-side.
 * Client only triggers and reads results.
 */

import { supabase } from './supabaseClient';
import { SentimentResult } from '../entities/insight';
import { ServiceError } from './errors';

export const insightsService = {
  /**
   * Analyze sentiment for a journal entry via Edge Function.
   */
  async analyzeEntrySentiment(entryId: string): Promise<SentimentResult> {
    const { data, error } = await supabase.functions.invoke('analyze-sentiment', {
      body: { entryId },
    });

    if (error) throw new ServiceError(error.message, 'EDGE_FUNCTION_ERROR');
    return data as SentimentResult;
  },

  /**
   * Get cached insights for the current user.
   */
  async getInsights(userId: string, type?: string): Promise<Array<{ id: string; type: string; payload: Record<string, unknown>; createdAt: string }>> {
    let query = supabase
      .from('insights')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: { id: string; type: string; payload: Record<string, unknown>; created_at: string }) => ({
      id: r.id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at,
    }));
  },
};
