/**
 * History Page — journal entries grouped by month, newspaper-column style.
 *
 * Read-only sentiment pills appear on entries that have been analysed.
 * No Reflect button here — analysis is intentional and done from the editor.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { useEntries } from './hooks';
import { useInsights } from '../insights/hooks';
import { formatShortDate } from '../../shared/utils/dates';
import { MOOD_EMOJIS } from '../../shared/constants';
import { isSentimentPayload, isReflectionPayload } from '../../entities/insight';
import type { EntryInsight } from '../../entities/insight';

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '😊',
  neutral: '😐',
  negative: '😔',
};

function groupByMonth(entries: Array<{ id: string; entryDate: string; content: string; mood: string | null; tags: string[] }>) {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = format(parseISO(entry.entryDate), 'MMMM yyyy');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  return Array.from(groups.entries());
}

export default function HistoryPage() {
  const { data: entries, isLoading, error } = useEntries(200);
  const { data: insights } = useInsights();
  const navigate = useNavigate();

  const grouped = useMemo(() => {
    if (!entries) return [];
    return groupByMonth(entries);
  }, [entries]);

  // Build a map from entryId → best EntryInsight for O(1) lookup per card.
  // insights is sorted createdAt DESC. We prefer reflection over sentiment:
  // if a reflection row exists for an entry, never replace it with sentiment.
  const insightByEntryId = useMemo(() => {
    const m = new Map<string, EntryInsight>();
    for (const i of (insights ?? [])) {
      if (!i.entryId) continue;
      const existing = m.get(i.entryId);
      if (!existing) {
        m.set(i.entryId, i);
      } else if (existing.type !== 'reflection' && i.type === 'reflection') {
        // Upgrade: a newer reflection supersedes the stored sentiment
        m.set(i.entryId, i);
      }
      // A stored reflection is never downgraded to sentiment
    }
    return m;
  }, [insights]);

  if (isLoading) {
    return (
      <div className="page history-page">
        <h1>Journal</h1>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page history-page">
        <h1>Journal</h1>
        <p className="error-message">Failed to load entries.</p>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="page history-page">
        <h1>Journal</h1>
        <div className="empty-state">
          <p className="empty-icon">📖</p>
          <p className="empty-title">Nothing written yet</p>
          <p className="empty-subtitle">Every great story starts with a single sentence.</p>
          <button className="btn-primary" onClick={() => navigate('/journal')} style={{ marginTop: '1rem' }}>
            Write your first entry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page history-page">
      <h1>Journal</h1>

      {grouped.map(([monthLabel, monthEntries]) => (
        <div key={monthLabel}>
          <div className="month-group-header">{monthLabel}</div>
          <div className="entries-list">
            {monthEntries.map((entry) => {
              const parsed = parseISO(entry.entryDate);
              const dayNum = format(parsed, 'd');
              const dayOfWeek = format(parsed, 'EEE');
              const shortDate = formatShortDate(entry.entryDate);

              // Read-only AI indicator for analysed entries.
              // Prefer reflection (rich) over legacy sentiment (label-only).
              const insight = insightByEntryId.get(entry.id);
              const sentiment =
                insight && isSentimentPayload(insight.payload)
                  ? insight.payload
                  : null;
              const reflection =
                insight && isReflectionPayload(insight.payload)
                  ? insight.payload
                  : null;
              // Top emotion from reflection for display (highest score)
              const topEmotion = reflection
                ? [...reflection.emotions].sort((a, b) => b.score - a.score)[0]
                : null;

              return (
                <button
                  key={entry.id}
                  className="entry-card"
                  onClick={() => navigate(`/journal/${entry.entryDate}`)}
                  aria-label={`Open entry for ${shortDate}`}
                >
                  <div className="entry-card-date-col">
                    <span className="entry-card-date">{dayOfWeek}</span>
                    <span className="entry-card-day">{dayNum}</span>
                    {entry.mood && (
                      <span className="entry-card-mood">{MOOD_EMOJIS[entry.mood]}</span>
                    )}
                  </div>
                  <div className="entry-card-body">
                    <p className="entry-card-preview">
                      {entry.content.slice(0, 160) || <em style={{ opacity: 0.5 }}>Empty entry</em>}
                      {entry.content.length > 160 && '…'}
                    </p>
                    {entry.tags.length > 0 && (
                      <div className="entry-card-tags">
                        {entry.tags.slice(0, 5).map((tag) => (
                          <span key={tag} className="tag tag-sm">{tag}</span>
                        ))}
                      </div>
                    )}
                    {/* Reflection insight: show top emotion pill */}
                    {topEmotion && (
                      <div style={{ marginTop: '0.4rem' }}>
                        <span className="history-reflection-badge">
                          ✦{' '}
                          {topEmotion.label.charAt(0).toUpperCase() +
                            topEmotion.label.slice(1).toLowerCase()}
                        </span>
                      </div>
                    )}
                    {/* Legacy sentiment pill (HF-only users) */}
                    {!topEmotion && sentiment && (
                      <div style={{ marginTop: '0.4rem' }}>
                        <span className={`sentiment-pill sentiment-${sentiment.label}`} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>
                          {SENTIMENT_EMOJI[sentiment.label]}{' '}
                          {sentiment.label.charAt(0).toUpperCase() + sentiment.label.slice(1)}
                        </span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
