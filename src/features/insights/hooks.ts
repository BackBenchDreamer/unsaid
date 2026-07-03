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
 * Derive a single entry's insights from the useInsights cache.
 * No extra network call — just lookups on the already-fetched array.
 *
 * Returns both reflectionInsight and sentimentInsight separately so the
 * AI panel can apply the priority rule: reflection takes precedence over sentiment.
 *
 * Also computes isStale using the correct model for the active insight type:
 *   - reflectionInsight present → hash against settings.reflectionModel (groq_model)
 *   - only sentimentInsight    → hash against settings.aiModel (hf_model)
 *
 * Staleness is tied to last *saved* content, not live keystrokes,
 * so the notice only appears after the next successful autosave.
 *
 * @param entryId  The entry's DB id, or undefined if the entry hasn't been saved yet.
 * @param savedContent  The last successfully saved content string (from JournalEditor's
 *   lastSavedContentRef). Pass '' if the entry hasn't been saved.
 */
export function useEntryInsight(
  entryId: string | undefined,
  savedContent: string,
): {
  insight: EntryInsight | undefined;
  reflectionInsight: EntryInsight | undefined;
  sentimentInsight: EntryInsight | undefined;
  isStale: boolean;
} {
  const { data: insights } = useInsights();
  const { data: settings } = useSettings();

  // Async SHA-256 of the saved content + prompt envelope.
  // Stored in state so the component re-renders once the hash resolves.
  const [savedHash, setSavedHash] = useState('');

  // Derive the individual insight rows from the full cache.
  const reflectionInsight = entryId
    ? (insights ?? []).find((i) => i.entryId === entryId && i.type === 'reflection')
    : undefined;

  const sentimentInsight = entryId
    ? (insights ?? []).find((i) => i.entryId === entryId && i.type === 'sentiment')
    : undefined;

  // Priority: reflection > sentiment
  const activeInsight = reflectionInsight ?? sentimentInsight;

  useEffect(() => {
    if (!savedContent || !settings || !activeInsight) {
      const t = setTimeout(() => setSavedHash(''), 0);
      return () => clearTimeout(t);
    }
    // Use reflectionModel for 'reflection' insights, aiModel for 'sentiment' insights.
    // This ensures the stale-detection hash matches what the Edge Function computes.
    const model =
      activeInsight.type === 'reflection'
        ? settings.reflectionModel
        : settings.aiModel;

    let cancelled = false;
    sha256Hex(sourceEnvelope(savedContent, AI_CONFIG.promptVersion, model)).then((h) => {
      if (!cancelled) setSavedHash(h);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedContent, settings, activeInsight?.type, activeInsight?.sourceHash]);

  // Stale when: activeInsight exists, savedHash computed, and they differ.
  // Null source_hash (legacy row) is treated as always-stale.
  const isStale =
    !!activeInsight &&
    savedHash !== '' &&
    (activeInsight.sourceHash === null || savedHash !== activeInsight.sourceHash);

  return { insight: activeInsight, reflectionInsight, sentimentInsight, isStale };
}

// ─── Mutations ─────────────────────────────────────────────

/**
 * Trigger full reflection generation for a journal entry.
 *
 * Primary path: calls generate-reflection Edge Function (HF + Groq).
 * Fallback path: if Groq is not configured (REFLECTION_NOT_CONFIGURED),
 *   silently falls back to the legacy analyze-sentiment Edge Function (HF only).
 *
 * The fallback is transparent to the user — no error is shown.
 * On error (other than REFLECTION_NOT_CONFIGURED), the error is surfaced
 * via mutation.isError / mutation.error in the same way as useGenerateInsight.
 */
export function useGenerateReflection() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (entryId: string) => {
      const result = await insightsService.generateReflection(entryId);
      if (!result.ok) {
        // REFLECTION_NOT_CONFIGURED — Groq not set up yet.
        // Silently fall back to legacy HF sentiment path.
        await insightsService.generateInsight(entryId);
      }
      // result.ok === true: reflection generated successfully.
    },
    onSuccess: () => {
      if (user) {
        queryClient.invalidateQueries({ queryKey: insightKeys.user(user.id) });
      }
    },
    // onError fires if generateInsight() (fallback) throws, or if
    // generateReflection() throws on a non-REFLECTION_NOT_CONFIGURED error.
    // Error is surfaced to the component via mutation.isError / mutation.error.
  });
}

/**
 * Trigger AI sentiment for a journal entry (legacy HF-only path).
 * Kept unchanged — called as fallback inside useGenerateReflection.
 * Also used directly in tests and any component that only needs sentiment.
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
