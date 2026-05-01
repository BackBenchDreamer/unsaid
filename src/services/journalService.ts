/**
 * Journal Service — all entry CRUD, heatmap, and memory queries.
 *
 * Encapsulates Supabase interactions; returns typed domain objects.
 * Never exposes raw DB rows to the UI layer.
 */

import { supabase } from './supabaseClient';
import {
  Entry,
  EntryRow,
  EntryUpsertPayload,
  entryFromRow,
  entryToRowPayload,
  validateEntryPayload,
} from '../entities/entry';
import { HeatmapCell, Memory } from '../entities/insight';
import { unwrap, ValidationError, ServiceError } from './errors';

export const journalService = {
  /**
   * Get all entries for the current user, ordered by entry_date DESC.
   */
  async getEntries(limit = 50, offset = 0): Promise<Entry[]> {
    const result = await supabase
      .from('entries')
      .select('*')
      .order('entry_date', { ascending: false })
      .range(offset, offset + limit - 1);

    const rows = unwrap(result) as EntryRow[];
    return rows.map(entryFromRow);
  },

  /**
   * Get a single entry by date for the current user.
   */
  async getEntryByDate(entryDate: string): Promise<Entry | null> {
    const { data, error } = await supabase
      .from('entries')
      .select('*')
      .eq('entry_date', entryDate)
      .maybeSingle();

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
    if (!data) return null;
    return entryFromRow(data as EntryRow);
  },

  /**
   * Upsert an entry (create or update).
   *
   * Uses ON CONFLICT (user_id, entry_date) to enforce one-per-day.
   * This is the primary write path, used by both direct writes and sync queue.
   */
  async upsertEntry(userId: string, payload: EntryUpsertPayload): Promise<Entry> {
    const errors = validateEntryPayload(payload);
    if (errors.length > 0) throw new ValidationError(errors);

    const rowPayload = entryToRowPayload(userId, payload);

    const result = await supabase
      .from('entries')
      .upsert(rowPayload, {
        onConflict: 'user_id,entry_date',
      })
      .select()
      .single();

    const row = unwrap(result) as EntryRow;
    return entryFromRow(row);
  },

  /**
   * Delete an entry by ID.
   */
  async deleteEntry(entryId: string): Promise<void> {
    const { error } = await supabase
      .from('entries')
      .delete()
      .eq('id', entryId);

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
  },

  /**
   * Get all entry_dates for streak computation.
   */
  async getEntryDates(): Promise<string[]> {
    const { data, error } = await supabase
      .from('entries')
      .select('entry_date')
      .order('entry_date', { ascending: true });

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
    return (data ?? []).map((r: { entry_date: string }) => r.entry_date);
  },

  /**
   * Get heatmap data for a date range.
   */
  async getHeatmap(userId: string, startDate: string, endDate: string): Promise<HeatmapCell[]> {
    const { data, error } = await supabase.rpc('get_heatmap', {
      p_user_id: userId,
      p_start_date: startDate,
      p_end_date: endDate,
    });

    if (error) throw new ServiceError(error.message, error.code ?? 'RPC_ERROR');
    return (data ?? []).map((r: { date: string; has_entry: boolean; mood: string | null }) => ({
      date: r.date,
      count: r.has_entry ? 1 : 0,
      mood: r.mood,
    }));
  },

  /**
   * Get "on this day" memories.
   */
  async getMemories(userId: string, todayDate: string): Promise<Memory[]> {
    const { data, error } = await supabase.rpc('get_memories', {
      p_user_id: userId,
      p_today: todayDate,
    });

    if (error) throw new ServiceError(error.message, error.code ?? 'RPC_ERROR');
    return (data ?? []).map((r: { id: string; entry_date: string; snippet: string; mood: string | null; days_ago: number }) => ({
      id: r.id,
      entryDate: r.entry_date,
      snippet: r.snippet,
      mood: r.mood,
      daysAgo: r.days_ago,
    }));
  },

  /**
   * Search entries by content.
   */
  async searchEntries(query: string, limit = 20): Promise<Entry[]> {
    const { data, error } = await supabase
      .from('entries')
      .select('*')
      .ilike('content', `%${query}%`)
      .order('entry_date', { ascending: false })
      .limit(limit);

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
    return (data ?? []).map((r: EntryRow) => entryFromRow(r));
  },
};
