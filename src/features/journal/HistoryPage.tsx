/**
 * History Page — journal entries grouped by month, newspaper-column style.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { useEntries } from './hooks';
import { formatShortDate } from '../../shared/utils/dates';
import { MOOD_EMOJIS } from '../../shared/constants';

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
  const navigate = useNavigate();

  const grouped = useMemo(() => {
    if (!entries) return [];
    return groupByMonth(entries);
  }, [entries]);

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
