/**
 * History Page — list of past journal entries.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useEntries } from './hooks';
import { formatDisplayDate } from '../../shared/utils/dates';
import { MOOD_EMOJIS } from '../../shared/constants';

export default function HistoryPage() {
  const { data: entries, isLoading, error } = useEntries(100);
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="page history-page">
        <h1>Your Journal</h1>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page history-page">
        <h1>Your Journal</h1>
        <p className="error-message">Failed to load entries.</p>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="page history-page">
        <h1>Your Journal</h1>
        <div className="empty-state">
          <p className="empty-icon">📝</p>
          <p className="empty-title">No entries yet</p>
          <p className="empty-subtitle">Start writing to see your journal history here.</p>
          <button className="btn-primary" onClick={() => navigate('/journal')}>
            Write your first entry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page history-page">
      <h1>Your Journal</h1>
      <div className="entries-list">
        {entries.map((entry) => (
          <button
            key={entry.id}
            className="entry-card"
            onClick={() => navigate(`/journal/${entry.entryDate}`)}
          >
            <div className="entry-card-header">
              <span className="entry-card-date">{formatDisplayDate(entry.entryDate)}</span>
              {entry.mood && (
                <span className="entry-card-mood">{MOOD_EMOJIS[entry.mood]}</span>
              )}
            </div>
            <p className="entry-card-preview">
              {entry.content.slice(0, 150) || 'Empty entry'}
              {entry.content.length > 150 && '...'}
            </p>
            {entry.tags.length > 0 && (
              <div className="entry-card-tags">
                {entry.tags.slice(0, 5).map((tag) => (
                  <span key={tag} className="tag tag-sm">{tag}</span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
