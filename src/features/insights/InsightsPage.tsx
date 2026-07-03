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
import { isSentimentPayload } from '../../entities/insight';
import type { EntryInsight } from '../../entities/insight';
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

// ─── SentimentCard ─────────────────────────────────────────

interface SentimentCardProps {
  insight: EntryInsight;
  entryDate: string | undefined;
}

function SentimentCard({ insight, entryDate }: SentimentCardProps) {
  const navigate = useNavigate();
  const s = isSentimentPayload(insight.payload) ? insight.payload : null;
  if (!s) return null;

  const pct = Math.round(s.confidence * 100);

  return (
    <div className="insight-card">
      <div style={{ flex: 1 }}>
        {entryDate && (
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.4rem', fontWeight: 500 }}>
            {formatDisplayDate(entryDate)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
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

  // Filter to sentiment insights with valid payloads
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
  if (sentimentInsights.length === 0) {
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

  // Mood distribution counts
  const counts = { positive: 0, neutral: 0, negative: 0 };
  sentimentInsights.forEach((i) => {
    const s = isSentimentPayload(i.payload) ? i.payload : null;
    if (s) counts[s.label]++;
  });
  const total = sentimentInsights.length;

  return (
    <div className="page insights-page">
      <h1>Insights</h1>
      <p className="page-subtitle">Emotional patterns from your writing.</p>

      {/* ── Mood distribution bar ─────────────────────── */}
      <section style={{ marginBottom: 'var(--space-2xl)' }}>
        <h2 style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)', fontWeight: 600 }}>
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
        <h2 style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 'var(--space-md)', fontWeight: 600 }}>
          Recent reflections
        </h2>
        <div className="insights-grid">
          {sentimentInsights.map((insight) => (
            <SentimentCard
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
