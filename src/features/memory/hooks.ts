/**
 * Memory Feature Hooks — Milestone 3: Memory Before Intelligence.
 *
 * Provides React Query hooks for querying life chapters and context memory.
 * These hooks are the foundation for M4's life chapter discovery UI.
 * In M3 they have no UI consumer — they establish the pattern and verify
 * the service/DB layer works correctly.
 *
 * All writes to memory tables happen exclusively via service_role in the
 * extract-memory Edge Function. No mutation hooks exist here.
 *
 * Cache strategy:
 *   - staleTime: 5 minutes (memory changes asynchronously via background Edge Function)
 *   - invalidation: timer-based only; memory hooks are NOT invalidated on entry saves
 *     (memory is updated by Edge Functions, not by journal mutations)
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { memoryService } from '../../services/memoryService';
import type { ChapterStatus, ContextEntityType } from '../../entities/memory';
import { useAuth } from '../../app/providers/AuthProvider';

// ─── Query Key Factory ────────────────────────────────────────
//
// Follows the journalKeys pattern from src/features/journal/hooks.ts.

export const memoryKeys = {
  all: ['memory'] as const,
  chapters: (status?: ChapterStatus) =>
    status ? ([...memoryKeys.all, 'chapters', status] as const) : ([...memoryKeys.all, 'chapters'] as const),
  chapter: (id: string) => [...memoryKeys.all, 'chapter', id] as const,
  context: (entityType?: ContextEntityType) =>
    entityType ? ([...memoryKeys.all, 'context', entityType] as const) : ([...memoryKeys.all, 'context'] as const),
  contextBlock: (themes: string[]) => [...memoryKeys.all, 'contextBlock', themes] as const,
  extractions: () => [...memoryKeys.all, 'extractions'] as const,
};

// ─── Hooks ───────────────────────────────────────────────────

/**
 * Fetch life chapters for the current user, optionally filtered by status.
 * Ordered by chapter_start DESC (most recent episode first).
 *
 * Returns only structurally mapped LifeChapter objects — never raw DB rows.
 * name and summary are null while status = 'forming'.
 */
export function useLifeChapters(status?: ChapterStatus) {
  const { user } = useAuth();
  const userId = user?.id;

  return useQuery({
    queryKey: memoryKeys.chapters(status),
    queryFn: () => memoryService.getLifeChapters(userId!, status),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,   // 5 minutes — memory updates are async/background
    gcTime: 15 * 60 * 1000,     // keep in cache for 15 minutes
  });
}

/**
 * Derived hook: count of active life chapters.
 * Useful for future badge indicators or empty-state detection in M4 UX.
 */
export function useActiveChapterCount(): number {
  const { data: chapters } = useLifeChapters('active');
  return chapters?.length ?? 0;
}

/**
 * Fetch context memory for the current user, optionally filtered by entity type.
 * Only returns entities that have met the minimum mention threshold (CONTEXT_MEMORY_MIN_MENTIONS).
 * importance_score is null for all M3-generated rows (reserved for M4+ ranking).
 */
export function useContextMemory(entityType?: ContextEntityType) {
  const { user } = useAuth();
  const userId = user?.id;

  return useQuery({
    queryKey: memoryKeys.context(entityType),
    queryFn: () => memoryService.getContextMemory(userId!, entityType),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });
}

/**
 * Fetch memory extraction records for the current user.
 * Used for debugging and backfill detection.
 * Not exposed in production UI — developer/admin use only.
 */
export function useMemoryExtractions() {
  const { user } = useAuth();
  const userId = user?.id;

  return useQuery({
    queryKey: memoryKeys.extractions(),
    queryFn: () => memoryService.getMemoryExtractions(userId!),
    enabled: !!userId,
    staleTime: 2 * 60 * 1000,   // 2 minutes — useful for real-time debugging
  });
}

/**
 * Fetch the active context block for the current user.
 * Used to preview what context would be injected into a reflection prompt.
 * The currentThemes parameter should come from the latest ReflectionPayload.themes.
 *
 * Not used in M3 production UI — exists for testing and future debug tooling.
 */
export function useContextBlock(currentThemes: string[] = []) {
  const { user } = useAuth();
  const userId = user?.id;

  // Memoize themes array identity for stable query key
  const stableThemes = useCallback(() => currentThemes, [currentThemes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return useQuery({
    queryKey: memoryKeys.contextBlock(currentThemes),
    queryFn: () => memoryService.getActiveChapterSummaries(userId!, stableThemes()),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });
}
