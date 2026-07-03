/**
 * Insights hooks — data fetching and mutation for AI reflection features.
 *
 * Follows the journalKeys / useUpsertEntry pattern from journal/hooks.ts.
 * Components import from this file only — never from insightsService directly.
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  differenceInCalendarDays,
  differenceInCalendarWeeks,
  isToday as dateFnsIsToday,
  isYesterday,
  parseISO,
} from 'date-fns';
import { useAuth } from '../../app/providers/AuthProvider';
import { useSettings } from '../settings/hooks';
import { insightsService } from '../../services/insightsService';
import { sha256Hex, sourceEnvelope } from '../../shared/utils/hash';
import { AI_CONFIG } from '../../entities/insight';
import type { EntryInsight } from '../../entities/insight';

// ─── Query Keys ────────────────────────────────────────────

export const insightKeys = {
  all: ['insights'] as const,
  user: (userId: string) => [...insightKeys.all, userId] as const,
};

// ─── Relative time helper ──────────────────────────────────

/**
 * Format an ISO timestamp as a human-friendly relative reflection label.
 *
 * Examples:
 *   "Reflected just now"     (< 1 minute ago)
 *   "Reflected today"        (same calendar day, ≥ 1 min ago)
 *   "Reflected yesterday"
 *   "Reflected 3 days ago"   (2–6 days)
 *   "Reflected 2 weeks ago"  (7+ days)
 */
export function formatReflectedAt(isoString: string): string {
  const date = parseISO(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = diffMs / 60_000;

  if (diffMins < 1) return 'Reflected just now';
  if (dateFnsIsToday(date)) return 'Reflected today';
  if (isYesterday(date)) return 'Reflected yesterday';

  const diffDays = differenceInCalendarDays(now, date);
  if (diffDays < 7) return `Reflected ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  const diffWeeks = differenceInCalendarWeeks(now, date);
  return `Reflected ${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
}

// ─── Queries ───────────────────────────────────────────────

/**
 * Fetch all insights for the current user.
 * Used by InsightsPage (dashboard), HistoryPage (pill map), and useEntryInsight.
 */
export function useInsights() {
  const { user } = useAuth();

  return useQuery({
    queryKey: insightKeys.user(user?.id ?? ''),
    queryFn: () => insightsService.getInsights(user!.id),
    enabled: !!user,
  });
}

/**
 * Derive a single entry's insight from the useInsights cache.
 * No extra network call — just a lookup on the already-fetched array.
 *
 * Also computes isStale: true when the saved content has changed since the
 * insight was generated. Staleness is tied to last *saved* content, not live
 * keystrokes, so the notice only appears after the next successful autosave.
 *
 * @param entryId  The entry's DB id, or undefined if the entry hasn't been saved yet.
 * @param savedContent  The last successfully saved content string (from JournalEditor's
 *   lastSavedContentRef). Pass '' if the entry hasn't been saved.
 */
export function useEntryInsight(
  entryId: string | undefined,
  savedContent: string,
): { insight: EntryInsight | undefined; isStale: boolean } {
  const { data: insights } = useInsights();
  const { data: settings } = useSettings();

  // Async SHA-256 of the saved content + prompt envelope.
  // Stored in state so the component re-renders once the hash resolves.
  const [savedHash, setSavedHash] = useState('');

  useEffect(() => {
    if (!savedContent || !settings) {
      // Reset asynchronously to avoid synchronous setState-in-effect warning
      const t = setTimeout(() => setSavedHash(''), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    sha256Hex(
      sourceEnvelope(savedContent, AI_CONFIG.promptVersion, settings.aiModel),
    ).then((h) => {
      if (!cancelled) setSavedHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [savedContent, settings]);

  const insight = entryId
    ? (insights ?? []).find((i) => i.entryId === entryId)
    : undefined;

  // Stale when: insight exists, has a stored hash, and the saved hash differs.
  // Null source_hash (legacy row) is treated as always-stale.
  const isStale =
    !!insight &&
    savedHash !== '' &&
    (insight.sourceHash === null || savedHash !== insight.sourceHash);

  return { insight, isStale };
}

// ─── Mutations ─────────────────────────────────────────────

/**
 * Trigger AI reflection for a journal entry.
 * On success, invalidates the user's insights query so all panels refresh.
 */
export function useGenerateInsight() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: (entryId: string) => insightsService.generateInsight(entryId),
    onSuccess: () => {
      if (user) {
        queryClient.invalidateQueries({
          queryKey: insightKeys.user(user.id),
        });
      }
    },
  });
}
