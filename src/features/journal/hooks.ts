/**
 * Journal hooks — data fetching and mutations via React Query.
 *
 * These hooks are the bridge between the UI layer and the service layer.
 * No direct Supabase calls. No business logic. Just data orchestration.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { journalService } from '../../services/journalService';
import { syncEngine } from '../../sync';
import { useAuth } from '../../app/providers/AuthProvider';
import { Entry, EntryUpsertPayload } from '../../entities/entry';

// ─── Query Keys ────────────────────────────────────────────

export const journalKeys = {
  all: ['journal'] as const,
  entries: () => [...journalKeys.all, 'entries'] as const,
  entry: (date: string) => [...journalKeys.all, 'entry', date] as const,
  dates: () => [...journalKeys.all, 'dates'] as const,
  heatmap: (start: string, end: string) => [...journalKeys.all, 'heatmap', start, end] as const,
  memories: (today: string) => [...journalKeys.all, 'memories', today] as const,
};

// ─── Queries ───────────────────────────────────────────────

/**
 * Fetch all entries (paginated).
 */
export function useEntries(limit = 50, offset = 0) {
  return useQuery({
    queryKey: [...journalKeys.entries(), limit, offset],
    queryFn: () => journalService.getEntries(limit, offset),
  });
}

/**
 * Fetch a single entry by date.
 */
export function useEntryByDate(date: string) {
  return useQuery({
    queryKey: journalKeys.entry(date),
    queryFn: () => journalService.getEntryByDate(date),
    enabled: !!date,
  });
}

/**
 * Fetch all entry dates (for streaks).
 */
export function useEntryDates() {
  return useQuery({
    queryKey: journalKeys.dates(),
    queryFn: () => journalService.getEntryDates(),
  });
}

/**
 * Fetch heatmap data.
 */
export function useHeatmap(userId: string, startDate: string, endDate: string) {
  return useQuery({
    queryKey: journalKeys.heatmap(startDate, endDate),
    queryFn: () => journalService.getHeatmap(userId, startDate, endDate),
    enabled: !!userId,
  });
}

/**
 * Fetch memories ("on this day").
 */
export function useMemories(userId: string, todayDate: string) {
  return useQuery({
    queryKey: journalKeys.memories(todayDate),
    queryFn: () => journalService.getMemories(userId, todayDate),
    enabled: !!userId,
  });
}

// ─── Mutations ─────────────────────────────────────────────

/**
 * Upsert an entry — goes through the sync queue for offline support.
 *
 * Optimistic update: immediately updates the query cache, then enqueues
 * the mutation for server sync.
 */
export function useUpsertEntry() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (payload: EntryUpsertPayload) => {
      if (!user) throw new Error('Not authenticated');

      // If online, try direct write first for responsiveness.
      if (navigator.onLine) {
        try {
          return await journalService.upsertEntry(user.id, payload);
        } catch {
          // Fall through to offline queue.
        }
      }

      // Enqueue for sync (offline or failed direct write).
      await syncEngine.enqueueEntry(user.id, payload);
      return null;
    },
    onMutate: async (payload) => {
      // Cancel any in-flight queries for this entry.
      await queryClient.cancelQueries({ queryKey: journalKeys.entry(payload.entryDate) });

      // Snapshot previous value.
      const previous = queryClient.getQueryData<Entry | null>(journalKeys.entry(payload.entryDate));

      // Optimistically update the cache.
      const optimistic: Entry = {
        id: previous?.id ?? `temp-${payload.entryDate}`,
        userId: user?.id ?? '',
        entryDate: payload.entryDate,
        content: payload.content,
        mood: payload.mood,
        tags: payload.tags,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData(journalKeys.entry(payload.entryDate), optimistic);

      return { previous, entryDate: payload.entryDate };
    },
    onError: (_err, _payload, context) => {
      // Rollback on error.
      if (context) {
        queryClient.setQueryData(
          journalKeys.entry(context.entryDate),
          context.previous,
        );
      }
    },
    onSettled: (_data, _error, payload) => {
      // Refetch to get server truth.
      queryClient.invalidateQueries({ queryKey: journalKeys.entry(payload.entryDate) });
      queryClient.invalidateQueries({ queryKey: journalKeys.entries() });
      queryClient.invalidateQueries({ queryKey: journalKeys.dates() });
    },
  });
}

/**
 * Delete an entry.
 */
export function useDeleteEntry() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ entryId, entryDate }: { entryId: string; entryDate: string }) => {
      if (!user) throw new Error('Not authenticated');

      if (navigator.onLine) {
        await journalService.deleteEntry(entryId);
      } else {
        await syncEngine.enqueueDelete(user.id, entryDate, entryId);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: journalKeys.all });
    },
  });
}
