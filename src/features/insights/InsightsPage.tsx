/**
 * Insights Page — AI reflection dashboard.
 *
 * Four progressive states based on user journey:
 *   A. No journal entries yet
 *   B. Entries exist but AI not configured
 *   C. AI configured but nothing reflected yet
 *   D. Insights exist — full dashboard with distribution bar + cards
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInsights, formatReflectedAt } from './hooks';
import { useSettings } from '../settings/hooks';
import { useEntries } from '../journal/hooks';
import { isSentimentPayload, isReflectionPayload } from '../../entities/insight';
import type { EntryInsight, ReflectionPayload } from '../../entities/insight';
import { formatDisplayDate } from '../../shared/utils/dates';

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

// ─── Emotion valence helper ────────────────────────────────
// Note: duplicated from JournalEditor.tsx intentionally —
// deduplication deferred until a third callsite warrants a shared util.

const POSITIVE_EMOTIONS = new Set(['joy', 'surprise']);
const NEGATIVE_EMOTIONS = new Set(['anger', 'disgust', 'fear', 'sadness']);

function getEmotionValence(label: string): 'positive' | 'negative' | 'neutral' {
  const l = label.toLowerCase();
  if (POSITIVE_EMOTIONS.has(l)) return 'positive';
  if (NEGATIVE_EMOTIONS.has(l)) return 'negative';
  return 'neutral';
}

// ─── InsightCard — handles both reflection and sentiment types ──

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
            {topTwo.map((e) => (
              <span
                key={e.label}
                className={`reflection-emotion-pill ${getEmotionValence(e.label)}`}
              >
                {e.label}
              </span>
            ))}
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

  // ── Legacy sentiment insight (unchanged rendering) ──────
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

  // Build entryId → entryDate map for card links
  const { data: allEntries } = useEntries(500);
  const entriesById = useMemo(() => {
    const m = new Map<string, string>();
    (allEntries ?? []).forEach((e) => m.set(e.id, e.entryDate));
    return m;
  }, [allEntries]);

  const isLoading = insightsLoading || settingsLoading || entriesLoading;

  if (isLoading) {
    return (
      <div className="page insights-page">
        <h1>Insights</h1>
        <div className="loading-spinner" />
      </div>
    );
  }

  // Collect all displayable insights (reflection + sentiment), sorted by createdAt desc
  const allInsights = (insights ?? []).filter(
    (i) =>
      (i.type === 'reflection' && isReflectionPayload(i.payload)) ||
      (i.type === 'sentiment' && isSentimentPayload(i.payload)),
  );

  // Legacy sentinel insights only — for the empty state check
  const sentimentInsights = (insights ?? []).filter(
    (i) => i.type === 'sentiment' && isSentimentPayload(i.payload),
  );

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

  // ── State C: AI configured, nothing reflected yet ───────
  if (allInsights.length === 0) {
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

  // ── State D: dashboard ──────────────────────────────────

  // Mood distribution counts — aggregates both reflection and sentiment insights.
  const counts = { positive: 0, neutral: 0, negative: 0 };

  // Sentiment insights: use stored label directly
  sentimentInsights.forEach((i) => {
    const s = isSentimentPayload(i.payload) ? i.payload : null;
    if (s) counts[s.label]++;
  });

  // Reflection insights: derive dominant valence from emotion scores
  const reflectionInsightsAll = (insights ?? []).filter(
    (i) => i.type === 'reflection' && isReflectionPayload(i.payload),
  );
  for (const i of reflectionInsightsAll) {
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
  }

  const total = counts.positive + counts.neutral + counts.negative;

  return (
    <div className="page insights-page">
      <h1>Insights</h1>
      <p className="page-subtitle">Emotional patterns from your writing.</p>

      {/* ── Mood distribution bar ─────────────────────── */}
      <section style={{ marginBottom: 'var(--space-2xl)' }}>
        <h2
          style={{
            fontSize: '0.82rem',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--text-muted)',
            marginBottom: 'var(--space-sm)',
            fontWeight: 600,
          }}
        >
          Mood overview
        </h2>

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

      {/* ── Recent reflections ────────────────────────── */}
      <section>
        <h2
          style={{
            fontSize: '0.82rem',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--text-muted)',
            marginBottom: 'var(--space-md)',
            fontWeight: 600,
          }}
        >
          Recent reflections
        </h2>
        <div className="insights-grid">
          {allInsights.map((insight) => (
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
