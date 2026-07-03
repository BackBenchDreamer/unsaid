/**
 * Insights Page — sentiment analysis results, readable not raw JSON.
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../app/providers/AuthProvider';
import { insightsService } from '../../services/insightsService';
import type { SentimentResult } from '../../entities/insight';

interface InsightRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function sentimentPayload(payload: Record<string, unknown>): SentimentResult | null {
  if (
    typeof payload.score === 'number' &&
    typeof payload.label === 'string' &&
    typeof payload.confidence === 'number'
  ) {
    return payload as unknown as SentimentResult;
  }
  return null;
}

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '😊',
  neutral: '😐',
  negative: '😔',
};

function SentimentCard({ insight }: { insight: InsightRow }) {
  const s = sentimentPayload(insight.payload);
  if (!s) return null;

  const pct = Math.round(s.confidence * 100);
  const cls = `sentiment-pill sentiment-${s.label}`;

  return (
    <div className="insight-card">
      <div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
          Sentiment
        </div>
        <span className={cls}>
          {SENTIMENT_EMOJI[s.label]} {s.label.charAt(0).toUpperCase() + s.label.slice(1)}
        </span>
        <span style={{ marginLeft: '0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          {pct}% confidence
        </span>
      </div>
      <div className="insight-meta">
        {new Date(insight.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
    </div>
  );
}

export default function InsightsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [analyseEntryId, setAnalyseEntryId] = useState('');
  const [analyseError, setAnalyseError] = useState('');

  const { data: insights, isLoading } = useQuery({
    queryKey: ['insights', user?.id],
    queryFn: () => insightsService.getInsights(user!.id),
    enabled: !!user,
  });

  const analyseMutation = useMutation({
    mutationFn: (entryId: string) => insightsService.analyzeEntrySentiment(entryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights', user?.id] });
      setAnalyseEntryId('');
      setAnalyseError('');
    },
    onError: (err) => {
      setAnalyseError(err instanceof Error ? err.message : 'Analysis failed');
    },
  });

  const handleAnalyse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!analyseEntryId.trim()) return;
    setAnalyseError('');
    analyseMutation.mutate(analyseEntryId.trim());
  };

  const sentimentInsights = (insights ?? []).filter((i) => i.type === 'sentiment');

  return (
    <div className="page insights-page">
      <h1>Insights</h1>
      <p className="page-subtitle">Emotional patterns from your writing.</p>

      {/* Analyse by entry ID */}
      <section style={{ marginBottom: 'var(--space-2xl)' }}>
        <form onSubmit={handleAnalyse} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1', minWidth: '200px' }}>
            <label htmlFor="entry-id" className="form-label">Analyse an entry</label>
            <input
              id="entry-id"
              type="text"
              className="form-input"
              value={analyseEntryId}
              onChange={(e) => setAnalyseEntryId(e.target.value)}
              placeholder="Paste an entry UUID…"
              style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
          </div>
          <button
            type="submit"
            className="analyze-btn"
            disabled={analyseMutation.isPending || !analyseEntryId.trim()}
            style={{ marginBottom: '0' }}
          >
            {analyseMutation.isPending ? '…' : '✦ Analyse'}
          </button>
        </form>
        {analyseError && (
          <p className="form-error" style={{ marginTop: 'var(--space-xs)' }}>{analyseError}</p>
        )}
      </section>

      {/* Results */}
      {isLoading ? (
        <div className="loading-spinner" />
      ) : sentimentInsights.length === 0 ? (
        <div className="empty-state">
          <p className="empty-icon">✦</p>
          <p className="empty-title">No insights yet</p>
          <p className="empty-subtitle">
            Paste an entry ID above to analyse its emotional tone.
          </p>
        </div>
      ) : (
        <div className="insights-grid">
          {sentimentInsights.map((insight) => (
            <SentimentCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
}
