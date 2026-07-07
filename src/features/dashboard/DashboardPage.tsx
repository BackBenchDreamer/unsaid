/**
 * Dashboard Page — greeting, streak stats, year heatmap, On This Day memories.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { useAuth } from '../../app/providers/AuthProvider';
import { useEntryDates, useHeatmap, useMemories } from '../journal/hooks';
import { buildActivityCalendarModel } from '../../entities/activityCalendar';
import { computeStreak } from '../../entities/streak';
import { getTodayLocal, getCurrentYearRange } from '../../shared/utils/dates';
import { MOOD_EMOJIS } from '../../shared/constants';
import { ActivityHeatmap } from './ActivityHeatmap';

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const todayLocal = getTodayLocal();
  const { start, end } = getCurrentYearRange();

  const { data: entryDates } = useEntryDates();
  const { data: heatmapData } = useHeatmap(user?.id ?? '', start, end);
  const { data: memories } = useMemories(user?.id ?? '', todayLocal);

  const streak = entryDates ? computeStreak(entryDates, todayLocal) : null;

  const calendarModel = useMemo(() => {
    return buildActivityCalendarModel({
      startDate: start,
      endDate: end,
      todayDate: todayLocal,
      weekStartsOn: 1,
      days: (heatmapData ?? []).map((cell) => ({
        date: cell.date,
        hasEntry: cell.count > 0,
        mood: cell.mood,
      })),
    });
  }, [end, heatmapData, start, todayLocal]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const dayOfWeek = format(new Date(), 'EEEE');
  const displayDate = format(new Date(), 'MMMM d, yyyy');

  return (
    <div className="page dashboard-page">
      <div className="dashboard-greeting">
        <h1>
          {greeting}{user?.displayName ? `, ${user.displayName}` : ''}
        </h1>
        <p className="greeting-date">
          {dayOfWeek} · {displayDate}
        </p>
      </div>

      <div className="dashboard-cta">
        <button
          className="btn-primary"
          onClick={() => navigate('/journal')}
        >
          Write today's entry
        </button>
      </div>

      {streak && (
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-value">{streak.current > 0 ? `🔥 ${streak.current}` : streak.current}</span>
            <span className="stat-label">Day streak</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{streak.longest}</span>
            <span className="stat-label">Best streak</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{streak.totalEntries}</span>
            <span className="stat-label">Total entries</span>
          </div>
        </div>
      )}

      {calendarModel.weeks.length > 0 && (
        <div className="heatmap-section">
          <ActivityHeatmap
            model={calendarModel}
            onSelectDate={(date) => navigate(`/journal/${date}`)}
          />
        </div>
      )}

      {memories && memories.length > 0 && (
        <div className="memories-section">
          <h2>On this day</h2>
          <div className="memories-list">
            {memories.map((memory) => {
              const yearsAgo = Math.round(memory.daysAgo / 365);
              const label = yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`;
              return (
                <button
                  key={memory.id}
                  className="memory-card"
                  onClick={() => navigate(`/journal/${memory.entryDate}`)}
                >
                  <div className="memory-header">
                    <span className="memory-date">{label}</span>
                    {memory.mood && <span>{MOOD_EMOJIS[memory.mood]}</span>}
                  </div>
                  <p className="memory-snippet">
                    <span className="memory-quote" aria-hidden="true">"</span>
                    {memory.snippet}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
