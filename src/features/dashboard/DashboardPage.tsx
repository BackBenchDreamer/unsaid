/**
 * Dashboard Page — greeting, streak stats, year heatmap, On This Day memories.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, getMonth } from 'date-fns';
import { useAuth } from '../../app/providers/AuthProvider';
import { useEntryDates, useHeatmap, useMemories } from '../journal/hooks';
import { computeStreak } from '../../entities/streak';
import { getTodayLocal, getCurrentYearRange, formatDisplayDate } from '../../shared/utils/dates';
import { MOOD_COLORS, MOOD_EMOJIS } from '../../shared/constants';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function getDayOfWeekMonday(dateStr: string): number {
  // 0 = Mon, 6 = Sun
  const d = parseISO(dateStr).getDay();
  return d === 0 ? 6 : d - 1;
}

interface HeatmapWeek {
  cells: Array<{ date: string; count: number; mood: string | null } | null>;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const todayLocal = getTodayLocal();
  const { start, end } = getCurrentYearRange();

  const { data: entryDates } = useEntryDates();
  const { data: heatmapData } = useHeatmap(user?.id ?? '', start, end);
  const { data: memories } = useMemories(user?.id ?? '', todayLocal);

  const streak = entryDates ? computeStreak(entryDates, todayLocal) : null;

  // Build week-column grid (GitHub style, Monday-first)
  const { weeks, monthPositions } = useMemo(() => {
    if (!heatmapData || heatmapData.length === 0) return { weeks: [], monthPositions: [] };

    const firstDayOfWeek = getDayOfWeekMonday(start); // offset for first week padding

    // Build all weeks
    const allWeeks: HeatmapWeek[] = [];
    let currentWeek: HeatmapWeek = { cells: Array(7).fill(null) };
    let dayIndex = firstDayOfWeek;

    for (const cell of heatmapData) {
      currentWeek.cells[dayIndex] = cell;
      dayIndex++;
      if (dayIndex === 7) {
        allWeeks.push(currentWeek);
        currentWeek = { cells: Array(7).fill(null) };
        dayIndex = 0;
      }
    }
    if (dayIndex > 0) allWeeks.push(currentWeek);

    // Month label positions (week index of first occurrence of each month)
    const seenMonths = new Set<number>();
    const monthPos: Array<{ month: number; weekIdx: number }> = [];
    heatmapData.forEach((cell, i) => {
      const d = parseISO(cell.date);
      const m = getMonth(d);
      const weekIdx = Math.floor((firstDayOfWeek + i) / 7);
      if (!seenMonths.has(m)) {
        seenMonths.add(m);
        monthPos.push({ month: m, weekIdx });
      }
    });

    return { weeks: allWeeks, monthPositions: monthPos };
  }, [heatmapData, start]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const dayOfWeek = format(new Date(), 'EEEE');
  const displayDate = formatDisplayDate(todayLocal);

  return (
    <div className="page dashboard-page">
      {/* Greeting */}
      <div className="dashboard-greeting">
        <h1>
          {greeting}{user?.displayName ? `, ${user.displayName}` : ''}
        </h1>
        <p className="greeting-date">
          {dayOfWeek} · {displayDate}
        </p>
      </div>

      {/* CTA */}
      <div className="dashboard-cta">
        <button
          className="btn-primary"
          onClick={() => navigate('/journal')}
        >
          Write today's entry
        </button>
      </div>

      {/* Streak stats */}
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

      {/* Heatmap — GitHub-style week grid */}
      {weeks.length > 0 && (
        <div className="heatmap-section">
          <h2>This year</h2>
          <div className="heatmap-container">
            <div className="heatmap-graph">
              {/* Month labels */}
              <div className="heatmap-months">
                {monthPositions.map(({ month, weekIdx }) => (
                  <span
                    key={month}
                    className="heatmap-month-label"
                    style={{ marginLeft: weekIdx === 0 ? 0 : undefined }}
                  >
                    {MONTH_LABELS[month]}
                  </span>
                ))}
              </div>

              <div className="heatmap-body">
                {/* Day-of-week labels */}
                <div className="heatmap-day-labels">
                  {DAY_LABELS.map((label, i) => (
                    <span key={i} className="heatmap-day-label">{label}</span>
                  ))}
                </div>

                {/* Week columns */}
                <div className="heatmap-weeks">
                  {weeks.map((week, wi) => (
                    <div key={wi} className="heatmap-week">
                      {week.cells.map((cell, di) => {
                        if (!cell) {
                          return <div key={di} className="heatmap-cell" style={{ visibility: 'hidden' }} />;
                        }
                        const hasEntry = cell.count > 0;
                        const moodColor = hasEntry && cell.mood ? MOOD_COLORS[cell.mood] : undefined;
                        return (
                          <div
                            key={di}
                            className={`heatmap-cell ${hasEntry ? 'heatmap-filled' : 'heatmap-empty'}`}
                            style={moodColor ? { backgroundColor: moodColor, opacity: 0.7 } : undefined}
                            title={`${cell.date}${cell.mood ? ` · ${cell.mood}` : ''}${hasEntry ? ' ✓' : ''}`}
                            onClick={() => hasEntry && navigate(`/journal/${cell.date}`)}
                            role={hasEntry ? 'button' : undefined}
                            aria-label={hasEntry ? `View entry for ${cell.date}` : undefined}
                            tabIndex={hasEntry ? 0 : undefined}
                            onKeyDown={(e) => {
                              if (hasEntry && (e.key === 'Enter' || e.key === ' ')) {
                                navigate(`/journal/${cell.date}`);
                              }
                            }}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* On This Day */}
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
