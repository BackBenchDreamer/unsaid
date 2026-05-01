/**
 * Dashboard Page — streak, heatmap, and memories.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/providers/AuthProvider';
import { useEntryDates, useHeatmap, useMemories } from '../journal/hooks';
import { computeStreak } from '../../entities/streak';
import { getTodayLocal, getCurrentYearRange, formatDisplayDate } from '../../shared/utils/dates';
import { MOOD_COLORS, MOOD_EMOJIS } from '../../shared/constants';

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const todayLocal = getTodayLocal();
  const { start, end } = getCurrentYearRange();

  const { data: entryDates } = useEntryDates();
  const { data: heatmapData } = useHeatmap(user?.id ?? '', start, end);
  const { data: memories } = useMemories(user?.id ?? '', todayLocal);

  const streak = entryDates ? computeStreak(entryDates, todayLocal) : null;

  return (
    <div className="page dashboard-page">
      <div className="dashboard-greeting">
        <h1>Welcome back{user?.displayName ? `, ${user.displayName}` : ''}</h1>
        <p className="greeting-date">{formatDisplayDate(todayLocal)}</p>
      </div>

      {/* Quick actions */}
      <div className="dashboard-actions">
        <button
          className="btn-primary btn-lg"
          onClick={() => navigate('/journal')}
        >
          ✍️ Write Today's Entry
        </button>
      </div>

      {/* Streak cards */}
      {streak && (
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-value">{streak.current}</span>
            <span className="stat-label">Day Streak</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{streak.longest}</span>
            <span className="stat-label">Best Streak</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{streak.totalEntries}</span>
            <span className="stat-label">Total Entries</span>
          </div>
        </div>
      )}

      {/* Heatmap */}
      {heatmapData && heatmapData.length > 0 && (
        <div className="heatmap-section">
          <h2>Your Year</h2>
          <div className="heatmap-grid">
            {heatmapData.map((cell) => (
              <div
                key={cell.date}
                className={`heatmap-cell ${cell.count > 0 ? 'heatmap-filled' : 'heatmap-empty'}`}
                style={
                  cell.count > 0 && cell.mood
                    ? { backgroundColor: MOOD_COLORS[cell.mood] + '80' }
                    : undefined
                }
                title={`${cell.date}${cell.mood ? ` — ${cell.mood}` : ''}${cell.count > 0 ? ' ✓' : ''}`}
                onClick={() => cell.count > 0 && navigate(`/journal/${cell.date}`)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Memories */}
      {memories && memories.length > 0 && (
        <div className="memories-section">
          <h2>On This Day</h2>
          <div className="memories-list">
            {memories.map((memory) => (
              <button
                key={memory.id}
                className="memory-card"
                onClick={() => navigate(`/journal/${memory.entryDate}`)}
              >
                <div className="memory-header">
                  <span className="memory-date">
                    {memory.daysAgo === 365
                      ? '1 year ago'
                      : `${Math.floor(memory.daysAgo / 365)} years ago`}
                  </span>
                  {memory.mood && <span>{MOOD_EMOJIS[memory.mood]}</span>}
                </div>
                <p className="memory-snippet">{memory.snippet}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
