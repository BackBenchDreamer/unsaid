/**
 * Insights Page — Patterns over time dashboard.
 *
 * Answers: "What has my recent emotional journey looked like?"
 *
 * Four progressive states based on user journey:
 *   A. No journal entries yet
 *   B. Entries exist but AI not configured
 *   C. AI configured but nothing reflected yet
 *   D. Full dashboard — four sections in storytelling order:
 *      1. Weekly Reflection  — the week's emotional arc in narrative prose
 *      2. Recurring Themes   — topics that keep surfacing across entries
 *      3. Emotional Timeline — CSS-only stacked bars for last 10 entries
 *      4. Recent Reflections — per-entry reflection cards
 *
 * Design principle: story first, visuals second. The weekly narrative is
 * the primary artifact. Charts support reflection — they do not replace it.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useInsights,
  useCurrentWeekInsight,
  useGenerateWeeklySummary,
  formatReflectedAt,
} from './hooks';
import { useSettings } from '../settings/hooks';
import { useEntries, useEntryDates } from '../journal/hooks';
import {
  isSentimentPayload,
  isReflectionPayload,
  isWeeklyPayload,
} from '../../entities/insight';
import type { EntryInsight, ReflectionPayload, WeeklyPayload } from '../../entities/insight';
import { formatDisplayDate, formatShortDate } from '../../shared/utils/dates';
import { getEmotionValence, POSITIVE_EMOTIONS, NEGATIVE_EMOTIONS } from '../../shared/utils/emotions';
import { WEEKLY_REFLECTION_MIN_ENTRIES } from '../../shared/constants';

// ─── Sentiment helpers ─────────────────────────────────────

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '😊',
  neutral: '😐',
  negative: '😔',
};

const SENTIMENT_DOT_COLOR: Record<string, string> = {
  positive: 'var(--success)',
  negative: 'var(--danger)',
  neutral: 'var(--text-muted)',
};

// ─── Section heading style ─────────────────────────────────

const SECTION_HEADING_STYLE: React.CSSProperties = {
  fontSize: '0.82rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-sm)',
  fontWeight: 600,
};

// ─── WeeklySummaryCard ─────────────────────────────────────

interface WeeklySummaryCardProps {
  weekStart: string;
  weekEnd: string;
  entryCount: number;
  summary: EntryInsight | undefined;
  hasEnough: boolean;
  isWeeklyStale: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
}

function WeeklySummaryCard({
  weekStart,
  weekEnd,
  entryCount,
  summary,
  hasEnough,
  isWeeklyStale,
  isGenerating,
  onGenerate,
}: WeeklySummaryCardProps) {
  // State: no summary, not enough entries — show a very subtle hint
  if (!summary && !hasEnough) {
    if (entryCount === 0) return null;
    return (
      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
        Write on at least {WEEKLY_REFLECTION_MIN_ENTRIES} days this week to unlock a weekly reflection.
      </p>
    );
  }

  // State: no summary, enough entries — show the invitation
  if (!summary && hasEnough) {
    return (
      <div className="weekly-invitation-card">
        <p className="weekly-invitation-lead">
          You've written on {entryCount} day{entryCount === 1 ? '' : 's'} this week.
        </p>
        <p className="weekly-invitation-sub">Your week is ready for reflection.</p>
        <button
          type="button"
          className="btn-primary"
          onClick={onGenerate}
          disabled={isGenerating}
          style={{ marginTop: 'var(--space-sm)' }}
        >
          {isGenerating ? 'Reflecting…' : 'Reflect on this week'}
        </button>
      </div>
    );
  }

  // State: summary exists — render narrative (fresh or stale)
  if (summary && isWeeklyPayload(summary.payload)) {
    const w = summary.payload as WeeklyPayload;

    return (
      <div className="weekly-summary-card">
        <p className="weekly-narrative">{w.narrative}</p>
        {w.emotionalArc && (
          <p className="weekly-arc">{w.emotionalArc}</p>
        )}
        {w.recurringThemes.length > 0 && (
          <div className="weekly-themes" style={{ marginTop: 'var(--space-xs)' }}>
            {w.recurringThemes.map((theme) => (
              <span key={theme} className="theme-pill">
                {theme}
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: 'var(--space-sm)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
            {formatShortDate(weekStart)} – {formatShortDate(weekEnd)}
          </span>
          {isWeeklyStale && (
            <>
              <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
                · Weekly reflection may be outdated
              </span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={onGenerate}
                disabled={isGenerating}
              >
                {isGenerating ? 'Reflecting…' : 'Regenerate'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ─── RecurringThemesSection ────────────────────────────────

interface RecurringThemesSectionProps {
  insights: EntryInsight[];
}

function RecurringThemesSection({ insights }: RecurringThemesSectionProps) {
  const themeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of insights) {
      if (i.type !== 'reflection' || !isReflectionPayload(i.payload)) continue;
      const r = i.payload as ReflectionPayload;
      for (const theme of r.themes) {
        const normalised = theme.trim();
        if (normalised) {
          counts.set(normalised, (counts.get(normalised) ?? 0) + 1);
        }
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [insights]);

  if (themeCounts.length === 0) return null;

  const maxCount = themeCounts[0]?.[1] ?? 1;

  return (
    <section style={{ marginTop: 'var(--space-xl)', marginBottom: 'var(--space-2xl)' }}>
      <h2 style={SECTION_HEADING_STYLE}>Recurring themes</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', alignItems: 'baseline' }}>
        {themeCounts.map(([theme, count]) => {
          const weight = count / maxCount; // 0..1
          // Scale font-size between 0.78rem (rare) and 1rem (most frequent)
          const fontSize = 0.78 + weight * 0.22;
          const opacity = 0.55 + weight * 0.45;
          return (
            <span
              key={theme}
              className="theme-pill theme-pill-weighted"
              style={{ fontSize: `${fontSize.toFixed(2)}rem`, opacity }}
              title={`${count} reflection${count === 1 ? '' : 's'}`}
            >
              {theme}
            </span>
          );
        })}
      </div>
    </section>
  );
}

// ─── EmotionalTimelineSection ──────────────────────────────

interface EmotionalTimelineSectionProps {
  insights: EntryInsight[];
  entriesById: Map<string, string>; // entryId → entryDate
}

function EmotionalTimelineSection({ insights, entriesById }: EmotionalTimelineSectionProps) {
  // Build timeline from last 10 reflection insights (by entry date, ascending)
  const timelineItems = useMemo(() => {
    const reflections = insights
      .filter((i) => i.type === 'reflection' && isReflectionPayload(i.payload) && i.entryId)
      .map((i) => ({
        insight: i,
        entryDate: i.entryId ? (entriesById.get(i.entryId) ?? '') : '',
      }))
      .filter((x) => x.entryDate !== '')
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
      .slice(-10);

    return reflections;
  }, [insights, entriesById]);

  if (timelineItems.length < 2) return null;

  return (
    <section style={{ marginBottom: 'var(--space-2xl)' }}>
      <h2 style={SECTION_HEADING_STYLE}>Emotional balance over time</h2>
      <div className="emotional-timeline">
        {timelineItems.map(({ insight, entryDate }) => {
          if (!isReflectionPayload(insight.payload)) return null;
          const r = insight.payload as ReflectionPayload;

          // Compute valence totals from emotion scores
          let pos = 0, neg = 0, neu = 0;
          for (const e of r.emotions) {
            const v = getEmotionValence(e.label);
            if (v === 'positive') pos += e.score;
            else if (v === 'negative') neg += e.score;
            else neu += e.score;
          }
          const total = pos + neg + neu || 1;
          const posPct = pos / total;
          const negPct = neg / total;
          const neuPct = neu / total;

          // Dominant emotion label for tooltip
          const dominant = [...r.emotions].sort((a, b) => b.score - a.score)[0];
          const dominantLabel = dominant
            ? dominant.label.charAt(0).toUpperCase() + dominant.label.slice(1).toLowerCase()
            : '';

          return (
            <div
              key={insight.id}
              className="timeline-bar-wrapper"
              title={`${formatDisplayDate(entryDate)} · ${dominantLabel}`}
            >
              <div className="timeline-bar">
                {posPct > 0 && (
                  <div
                    className="timeline-segment positive"
                    style={{ flex: posPct }}
                  />
                )}
                {neuPct > 0 && (
                  <div
                    className="timeline-segment neutral"
                    style={{ flex: neuPct }}
                  />
                )}
                {negPct > 0 && (
                  <div
                    className="timeline-segment negative"
                    style={{ flex: negPct }}
                  />
                )}
              </div>
              <div className="timeline-date-label">
                {formatShortDate(entryDate)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
        {(['positive', 'neutral', 'negative'] as const).map((label) => (
          <span key={label} style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: SENTIMENT_DOT_COLOR[label],
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            {label.charAt(0).toUpperCase() + label.slice(1)}
          </span>
        ))}
      </div>
    </section>
  );
}

// ─── InsightCard ———————————————————————————————————————────

interface InsightCardProps {
  insight: EntryInsight;
  entryDate: string | undefined;
}

function InsightCard({ insight, entryDate }: InsightCardProps) {
  const navigate = useNavigate();

  // ── Reflection insight ──────────────────────────────────
  if (isReflectionPayload(insight.payload)) {
    const r = insight.payload as ReflectionPayload;
    const truncated =
      r.summary.length > 120 ? r.summary.slice(0, 120) + '…' : r.summary;
    const topTwo = [...r.emotions].sort((a, b) => b.score - a.score).slice(0, 2);

    return (
      <div className="insight-card">
        <div style={{ flex: 1 }}>
          {entryDate && (
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.4rem',
                fontWeight: 500,
              }}
            >
              {formatDisplayDate(entryDate)}
            </div>
          )}
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              margin: '0 0 0.4rem',
              lineHeight: 1.55,
            }}
          >
            {truncated}
          </p>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-xs)',
              flexWrap: 'wrap',
              marginBottom: '0.3rem',
            }}
          >
            {topTwo.map((e) => {
              const label =
                e.label.charAt(0).toUpperCase() +
                e.label.slice(1).toLowerCase();
              return (
                <span
                  key={e.label}
                  className={`reflection-emotion-pill ${getEmotionValence(e.label)}`}
                >
                  {label}
                </span>
              );
            })}
          </div>
          <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
            {formatReflectedAt(insight.createdAt)}
          </span>
        </div>
        {entryDate && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => navigate(`/journal/${entryDate}`)}
          >
            Open entry →
          </button>
        )}
      </div>
    );
  }

  // ── Legacy sentiment insight ────────────────────────────
  if (isSentimentPayload(insight.payload)) {
    const s = insight.payload;
    const pct = Math.round(s.confidence * 100);

    return (
      <div className="insight-card">
        <div style={{ flex: 1 }}>
          {entryDate && (
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.4rem',
                fontWeight: 500,
              }}
            >
              {formatDisplayDate(entryDate)}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              flexWrap: 'wrap',
            }}
          >
            <span className={`sentiment-pill sentiment-${s.label}`}>
              {SENTIMENT_EMOJI[s.label]}{' '}
              {s.label.charAt(0).toUpperCase() + s.label.slice(1)}
            </span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {pct}% confidence
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {formatReflectedAt(insight.createdAt)}
            </span>
          </div>
        </div>
        {entryDate && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => navigate(`/journal/${entryDate}`)}
          >
            Open entry →
          </button>
        )}
      </div>
    );
  }

  return null;
}

// ─── Page ──────────────────────────────────────────────────

export default function InsightsPage() {
  const navigate = useNavigate();
  const { data: insights, isLoading: insightsLoading } = useInsights();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: entries, isLoading: entriesLoading } = useEntries(1);
  const { data: entryDates } = useEntryDates();

  // Build entryId → entryDate map for card links and timeline
  const { data: allEntries } = useEntries(500);
  const entriesById = useMemo(() => {
    const m = new Map<string, string>();
    (allEntries ?? []).forEach((e) => m.set(e.id, e.entryDate));
    return m;
  }, [allEntries]);

  // Weekly reflection state — pass entriesById so staleness detection is scoped
  // to only entries within the current week (prevents false positives when
  // re-reflecting entries from other weeks).
  const { weekStart, weekEnd, entryCount, summary, hasEnough, isWeeklyStale } =
    useCurrentWeekInsight(entryDates ?? [], entriesById);
  const generateWeeklyMutation = useGenerateWeeklySummary();

  const isLoading = insightsLoading || settingsLoading || entriesLoading;

  if (isLoading) {
    return (
      <div className="page insights-page">
        <h1>Insights</h1>
        <div className="loading-spinner" />
      </div>
    );
  }

  // ── State A: no entries at all ──────────────────────────
  if (!entries || entries.length === 0) {
    return (
      <div className="page insights-page">
        <h1>Insights</h1>
        <div className="empty-state">
          <p className="empty-icon">✦</p>
          <p className="empty-title">Start writing to unlock insights</p>
          <p className="empty-subtitle">
            Write your first journal entry to begin discovering patterns.
          </p>
          <button
            className="btn-primary"
            onClick={() => navigate('/journal')}
            style={{ marginTop: '1rem' }}
          >
            Go to Journal
          </button>
        </div>
      </div>
    );
  }

  // ── State B: entries exist, AI not configured ───────────
  if (!settings?.aiConfigured) {
    return (
      <div className="page insights-page">
        <h1>Insights</h1>
        <div className="empty-state">
          <p className="empty-icon">✦</p>
          <p className="empty-title">AI Insights not enabled</p>
          <p className="empty-subtitle">
            Configure your AI token to unlock emotional analysis of your writing.
          </p>
          <button
            className="btn-primary"
            onClick={() => navigate('/settings')}
            style={{ marginTop: '1rem' }}
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  // Collect all displayable per-entry insights, deduplicating by entryId.
  // When both a reflection and a sentiment row exist for the same entry,
  // prefer the reflection insight so only one card renders per entry.
  const allPerEntryInsights = (() => {
    const byEntry = new Map<string | null, EntryInsight>();
    for (const i of (insights ?? [])) {
      const isReflection = i.type === 'reflection' && isReflectionPayload(i.payload);
      const isSentiment = i.type === 'sentiment' && isSentimentPayload(i.payload);
      if (!isReflection && !isSentiment) continue;

      const key = i.entryId;
      const existing = byEntry.get(key);
      if (!existing) {
        byEntry.set(key, i);
      } else if (existing.type !== 'reflection' && isReflection) {
        byEntry.set(key, i);
      }
    }
    return Array.from(byEntry.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  })();

  // ── State C: AI configured, nothing reflected yet ───────
  if (allPerEntryInsights.length === 0) {
    return (
      <div className="page insights-page">
        <h1>Insights</h1>
        <div className="empty-state">
          <p className="empty-icon">✦</p>
          <p className="empty-title">Nothing reflected yet</p>
          <p className="empty-subtitle">
            Open any journal entry and press{' '}
            <strong>Reflect</strong> to see your emotional patterns here.
          </p>
          <button
            className="btn-primary"
            onClick={() => navigate('/journal')}
            style={{ marginTop: '1rem' }}
          >
            Go to Journal
          </button>
        </div>
      </div>
    );
  }

  // ── State D: full dashboard ─────────────────────────────

  // Mood distribution computed from the deduplicated insight list.
  // Uses allPerEntryInsights (reflection preferred over sentiment per entry)
  // to prevent double-counting entries that have both a sentiment and
  // a reflection row. Each entry contributes exactly one count.
  const counts = { positive: 0, neutral: 0, negative: 0 };

  for (const i of allPerEntryInsights) {
    if (isReflectionPayload(i.payload)) {
      const payload = i.payload as unknown as ReflectionPayload;
      const pos = payload.emotions
        .filter((e) => POSITIVE_EMOTIONS.has(e.label.toLowerCase()))
        .reduce((s, e) => s + e.score, 0);
      const neg = payload.emotions
        .filter((e) => NEGATIVE_EMOTIONS.has(e.label.toLowerCase()))
        .reduce((s, e) => s + e.score, 0);
      const neu = payload.emotions
        .filter((e) => e.label.toLowerCase() === 'neutral')
        .reduce((s, e) => s + e.score, 0);
      if (pos >= neg && pos >= neu) counts.positive++;
      else if (neg >= pos && neg >= neu) counts.negative++;
      else counts.neutral++;
    } else if (isSentimentPayload(i.payload)) {
      counts[i.payload.label]++;
    }
  }

  const total = counts.positive + counts.neutral + counts.negative;

  return (
    <div className="page insights-page">
      <h1>Insights</h1>
      <p className="page-subtitle">Your recent emotional journey.</p>

      {/* ── 1. Weekly Reflection ─────────────────────────── */}
      {/* Only render the section when there is something worth showing:
          a summary already exists, or at least one entry exists this week.
          If the user hasn't written anything this week, the section is hidden
          entirely — no orphaned heading. */}
      {(summary !== undefined || entryCount > 0) && (
        <section style={{ marginTop: 'var(--space-xl)', marginBottom: 'var(--space-2xl)' }}>
          <h2 style={SECTION_HEADING_STYLE}>This week</h2>
          <WeeklySummaryCard
            weekStart={weekStart}
            weekEnd={weekEnd}
            entryCount={entryCount}
            summary={summary}
            hasEnough={hasEnough}
            isWeeklyStale={isWeeklyStale}
            isGenerating={generateWeeklyMutation.isPending}
            onGenerate={() => generateWeeklyMutation.mutate(weekStart)}
          />
          {generateWeeklyMutation.isError && (
            <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 'var(--space-xs)' }}>
              Could not generate weekly reflection. Please try again.
            </p>
          )}
        </section>
      )}

      {/* ── 2. Recurring Themes ──────────────────────────── */}
      <RecurringThemesSection insights={insights ?? []} />

      {/* ── 3. Emotional Timeline ────────────────────────── */}
      <EmotionalTimelineSection insights={insights ?? []} entriesById={entriesById} />

      {/* ── 4. Mood overview (all-time distribution bar) ─── */}
      {total > 0 && (
        <section style={{ marginBottom: 'var(--space-2xl)' }}>
          <h2 style={SECTION_HEADING_STYLE}>Mood overview</h2>
          <div className="insight-distribution-bar">
            {(['positive', 'neutral', 'negative'] as const).map((label) => {
              const flex = total > 0 ? counts[label] / total : 0;
              if (flex === 0) return null;
              return (
                <div
                  key={label}
                  className={`insight-distribution-segment ${label}`}
                  style={{ flex }}
                  title={`${counts[label]} ${label}`}
                />
              );
            })}
          </div>
          <div className="insight-distribution-labels">
            {(['positive', 'neutral', 'negative'] as const).map((label) => (
              <span key={label} className="insight-distribution-label">
                <span
                  className="insight-distribution-dot"
                  style={{ background: SENTIMENT_DOT_COLOR[label] }}
                />
                {counts[label]} {label}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── 5. Recent Reflections ────────────────────────── */}
      <section>
        <h2 style={SECTION_HEADING_STYLE}>Recent reflections</h2>
        <div className="insights-grid">
          {allPerEntryInsights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              entryDate={insight.entryId ? entriesById.get(insight.entryId) : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
