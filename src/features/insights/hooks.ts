/**
 * Insights hooks — data fetching and mutation for AI reflection features.
 *
 * Follows the journalKeys / useUpsertEntry pattern from journal/hooks.ts.
 * Components import from this file only — never from insightsService directly.
 */

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  differenceInCalendarDays,
  differenceInCalendarWeeks,
  isToday as dateFnsIsToday,
  isYesterday,
  parseISO,
  startOfWeek,
  endOfWeek,
  format,
  isWithinInterval,
} from 'date-fns';
import { useAuth } from '../../app/providers/AuthProvider';
import { useSettings } from '../settings/hooks';
import { insightsService } from '../../services/insightsService';
import { sha256Hex, sourceEnvelope } from '../../shared/utils/hash';
import { AI_CONFIG, isWeeklyPayload, isReflectionPayload } from '../../entities/insight';
import type { EntryInsight } from '../../entities/insight';
import { WEEKLY_REFLECTION_MIN_ENTRIES } from '../../shared/constants';

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

// ─── Weekly Summary Hooks ──────────────────────────────────

/**
 * Weekly prompt version — independent from AI_CONFIG.promptVersion.
 * Used when computing the client-side weekly staleness hash.
 * Must stay in sync with WEEKLY_CONFIG.weeklyPromptVersion in the
 * generate-weekly-summary Edge Function.
 */
export const WEEKLY_PROMPT_VERSION = '1.0.0';

/**
 * Derive all weekly summary insights from the useInsights() cache.
 * No extra network call — filters and sorts the already-fetched array.
 * Returns insights sorted by periodStart descending (most recent first).
 */
export function useWeeklyInsights() {
  const { data: insights } = useInsights();

  return useMemo(() => {
    return (insights ?? [])
      .filter((i) => i.type === 'summary' && isWeeklyPayload(i.payload))
      .sort((a, b) => (b.periodStart ?? '').localeCompare(a.periodStart ?? ''));
  }, [insights]);
}

/**
 * Derive the state of the current week's reflection from cached data.
 *
 * Staleness model mirrors useEntryInsight:
 *   - For each entry in the current week that has a reflection, compare
 *     the reflection's createdAt against the weekly summary's createdAt.
 *   - If any per-entry reflection was created/updated AFTER the weekly
 *     summary, the weekly summary is considered stale.
 *   - This correctly detects the primary invalidation trigger: new or
 *     updated per-entry reflections that weren't included in the summary.
 *
 * Note: For entries without reflections, we use entry hash staleness via
 * a separate async SHA-256 computation (same pattern as useEntryInsight).
 * The async hash state resolves after the first render.
 *
 * @param entryDates  All entry dates ("YYYY-MM-DD") for the current user.
 *                    Typically from useEntryDates().data ?? [].
 */
export function useCurrentWeekInsight(entryDates: string[]): {
  weekStart: string;
  weekEnd: string;
  entryCount: number;
  summary: EntryInsight | undefined;
  hasEnough: boolean;
  isWeeklyStale: boolean;
} {
  const { data: insights } = useInsights();
  const { data: settings } = useSettings();

  // Compute current week range (Mon–Sun) in user-local calendar
  const today = new Date();
  const weekStartDate = startOfWeek(today, { weekStartsOn: 1 });
  const weekEndDate = endOfWeek(today, { weekStartsOn: 1 });
  const weekStart = format(weekStartDate, 'yyyy-MM-dd');
  const weekEnd = format(weekEndDate, 'yyyy-MM-dd');

  // Count entries that fall within this week
  const entryCount = useMemo(() => {
    return entryDates.filter((d) => {
      try {
        return isWithinInterval(parseISO(d), { start: weekStartDate, end: weekEndDate });
      } catch {
        return false;
      }
    }).length;
    // weekStartDate / weekEndDate are derived from `today` — recompute when entryDates changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryDates, weekStart]);

  // Find the existing weekly summary for this week
  const summary = useMemo(() => {
    return (insights ?? []).find(
      (i) =>
        i.type === 'summary' &&
        i.periodStart === weekStart &&
        i.periodEnd === weekEnd &&
        isWeeklyPayload(i.payload),
    );
  }, [insights, weekStart, weekEnd]);

  // For each entry in this week that has a per-entry reflection,
  // collect the most recent reflection createdAt.
  // If any reflection's createdAt is AFTER the summary's createdAt → stale.
  const isStaleByReflectionDate = useMemo(() => {
    if (!summary) return false;

    const weeklyCreatedAt = summary.createdAt;
    const weekReflections = (insights ?? []).filter(
      (i) =>
        i.type === 'reflection' &&
        isReflectionPayload(i.payload) &&
        i.entryId !== null,
    );

    // We don't have entry_date on insight rows directly, but we can check
    // if the reflection was created after the weekly summary. Any newer
    // per-entry reflection means the weekly summary is out of date.
    return weekReflections.some((r) => r.createdAt > weeklyCreatedAt);
  }, [insights, summary]);

  // Async staleness: compute a fresh weekly source_hash and compare against stored.
  // This catches the case where entry content changed but no new reflection was generated.
  // Uses the same pattern as useEntryInsight's savedHash state.
  const [freshHash, setFreshHash] = useState('');

  useEffect(() => {
    if (!summary || !settings) {
      const t = setTimeout(() => setFreshHash(''), 0);
      return () => clearTimeout(t);
    }

    // Build the same entryHashes array as the Edge Function would.
    // For entries with reflections: use reflection.source_hash.
    // For entries without: we can't compute content hash client-side without fetching
    // all entry content, so we skip them — the reflection-date check above handles those.
    // This means freshHash comparison is only meaningful when all contributing entries
    // have reflections; otherwise rely on isStaleByReflectionDate.
    const reflectionInsights = (insights ?? []).filter(
      (i) => i.type === 'reflection' && i.entryId !== null,
    );

    // Collect source_hashes for entries that have reflections (sorted by entryId for determinism;
    // actual sort is by entry_date at the Edge Function — we approximate with a stable sort here)
    const entryHashInputs = reflectionInsights
      .filter((i) => i.sourceHash !== null)
      .map((i) => i.sourceHash as string)
      .sort(); // deterministic sort

    if (entryHashInputs.length === 0) {
      const t = setTimeout(() => setFreshHash(''), 0);
      return () => clearTimeout(t);
    }

    const groqModel = settings.reflectionModel;
    let cancelled = false;
    sha256Hex(
      JSON.stringify({
        weekStart,
        weekEnd,
        weeklyPromptVersion: WEEKLY_PROMPT_VERSION,
        model: groqModel,
        entryHashes: entryHashInputs,
      }),
    ).then((h) => {
      if (!cancelled) setFreshHash(h);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekEnd, settings, summary?.sourceHash, insights?.length]);

  const isHashStale =
    !!summary &&
    freshHash !== '' &&
    (summary.sourceHash === null || freshHash !== summary.sourceHash);

  const isWeeklyStale = isStaleByReflectionDate || isHashStale;

  return {
    weekStart,
    weekEnd,
    entryCount,
    summary,
    hasEnough: entryCount >= WEEKLY_REFLECTION_MIN_ENTRIES,
    isWeeklyStale,
  };
}

/**
 * Trigger weekly summary generation for a given week start date.
 *
 * Expected non-error conditions are handled silently (no error state shown):
 *   WEEKLY_NOT_CONFIGURED — Groq not set up
 *   INSUFFICIENT_ENTRIES  — not enough entries in the week
 *
 * Other errors surface via mutation.isError / mutation.error.
 */
export function useGenerateWeeklySummary() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (weekStart: string) => {
      const result = await insightsService.generateWeeklySummary(weekStart);
      // Both graceful non-error conditions are silently ignored.
      // The UI decides what to show based on the presence/absence of a summary.
      if (!result.ok) return;
    },
    onSuccess: () => {
      if (user) {
        queryClient.invalidateQueries({ queryKey: insightKeys.user(user.id) });
      }
    },
  });
}
