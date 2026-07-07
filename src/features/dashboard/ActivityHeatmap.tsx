/**
 * Activity heatmap — reusable yearly contribution-style calendar view.
 *
 * Renders a pure ActivityCalendarModel from the domain layer. The component is
 * intentionally visual only and does not own calendar math.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { format, parseISO } from 'date-fns';
import type { ActivityCalendarDay, ActivityCalendarModel } from '../../entities/activityCalendar';
import { formatDisplayDate } from '../../shared/utils/dates';
import { MOOD_COLORS, MOOD_EMOJIS } from '../../shared/constants';

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

interface ActivityHeatmapProps {
  model: ActivityCalendarModel;
  onSelectDate?: (date: string) => void;
}

interface HeatmapDetailState {
  day: ActivityCalendarDay;
}

function getDayDescription(day: ActivityCalendarDay): string {
  const parts = [formatDisplayDate(day.date)];
  parts.push(day.stats.hasEntry ? 'Journal written' : 'No journal entry');

  if (day.visual.overlays.mood) {
    parts.push(`Mood: ${day.visual.overlays.mood}`);
  }

  if (day.visual.overlays.reflection) {
    parts.push('Reflection generated');
  } else {
    parts.push('Reflection not generated');
  }

  return parts.join(' · ');
}

function getCellStyle(day: ActivityCalendarDay): CSSProperties | undefined {
  if (!day.stats.hasEntry) return undefined;
  const mood = day.visual.overlays.mood;
  if (!mood) return undefined;
  const color = MOOD_COLORS[mood];
  return color ? { '--heatmap-cell-color': color } as CSSProperties : undefined;
}

export function ActivityHeatmap({ model, onSelectDate }: ActivityHeatmapProps) {
  const [detail, setDetail] = useState<HeatmapDetailState | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const daysWithEntries = useMemo(
    () => model.weeks.flatMap((week) => week.days).filter((day) => day.isInRange && day.stats.hasEntry).length,
    [model],
  );

  const monthGridColumns = useMemo(
    () => `repeat(${model.bounds.totalWeeks}, minmax(var(--heatmap-cell-size), 1fr))`,
    [model.bounds.totalWeeks],
  );

  useEffect(() => {
    if (!detail) return undefined;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      setDetail(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetail(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [detail]);

  return (
    <section className="activity-heatmap-card" aria-labelledby="activity-heatmap-heading">
      <div className="activity-heatmap-header">
        <div>
          <h2 id="activity-heatmap-heading">This year</h2>
          <p className="activity-heatmap-subtitle">
            {daysWithEntries} {daysWithEntries === 1 ? 'day captured' : 'days captured'} across {model.bounds.totalDays} days
          </p>
        </div>
        <div className="activity-heatmap-legend" aria-hidden="true">
          <span>Less</span>
          <div className="activity-heatmap-legend-scale">
            <span className="heatmap-cell heatmap-cell-empty" />
            <span className="heatmap-cell heatmap-cell-filled" />
          </div>
          <span>More</span>
        </div>
      </div>

      <div className="activity-heatmap-scroll" role="region" aria-label="Yearly journal activity calendar" tabIndex={0}>
        <div className="activity-heatmap-grid-shell">
          <div className="activity-heatmap-months" style={{ gridTemplateColumns: monthGridColumns }}>
            {model.monthAnchors.map((anchor) => (
              <span
                key={anchor.date}
                className="activity-heatmap-month-label"
                style={{ gridColumn: `${anchor.weekIndex + 1} / span 4` }}
              >
                {anchor.label}
              </span>
            ))}
          </div>

          <div className="activity-heatmap-layout">
            <div className="activity-heatmap-day-labels" aria-hidden="true">
              {DAY_LABELS.map((label, index) => (
                <span key={`${label}-${index}`} className="activity-heatmap-day-label">{label}</span>
              ))}
            </div>

            <div className="activity-heatmap-weeks" style={{ gridTemplateColumns: monthGridColumns }} role="grid" aria-readonly="true">
              {model.weeks.map((week) => (
                <div key={week.startDate} className="activity-heatmap-week" role="row">
                  {week.days.map((day) => {
                    const isInteractive = day.isInRange;
                    const isSelected = selectedDate === day.date;
                    const detailId = `activity-heatmap-detail-${day.date}`;
                    const summary = getDayDescription(day);

                    return (
                      <button
                        key={day.date}
                        type="button"
                        className={[
                          'heatmap-cell-button',
                          day.stats.hasEntry ? 'is-active' : 'is-empty',
                          !day.isInRange ? 'is-outside-range' : '',
                          day.isToday ? 'is-today' : '',
                          isSelected ? 'is-selected' : '',
                        ].filter(Boolean).join(' ')}
                        style={getCellStyle(day)}
                        onMouseEnter={() => {
                          setSelectedDate(day.date);
                          setDetail({ day });
                        }}
                        onFocus={() => {
                          setSelectedDate(day.date);
                          setDetail({ day });
                        }}
                        onMouseLeave={() => setDetail((current) => (current?.day.date === day.date ? null : current))}
                        onBlur={() => setDetail((current) => (current?.day.date === day.date ? null : current))}
                        onClick={() => {
                          setSelectedDate(day.date);
                          setDetail({ day });
                          if (!day.stats.hasEntry) {
                            return;
                          }

                          if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
                            onSelectDate?.(day.date);
                          }
                        }}
                        disabled={!isInteractive}
                        role="gridcell"
                        aria-label={summary}
                        aria-describedby={detail?.day.date === day.date ? detailId : undefined}
                      >
                        <span className="heatmap-cell-surface" />
                        {day.visual.overlays.reflection && <span className="heatmap-cell-overlay heatmap-cell-overlay-reflection" aria-hidden="true" />}
                        {day.visual.overlays.favorite && <span className="heatmap-cell-overlay heatmap-cell-overlay-favorite" aria-hidden="true" />}
                        <span className="sr-only">{summary}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {detail && (
        <div
          ref={popoverRef}
          id={`activity-heatmap-detail-${detail.day.date}`}
          className="activity-heatmap-popover"
          role="status"
        >
          <div className="activity-heatmap-popover-date">
            {format(parseISO(detail.day.date), 'EEEE')} · {formatDisplayDate(detail.day.date)}
          </div>
          <div className="activity-heatmap-popover-status">
            <span>{detail.day.stats.hasEntry ? 'Journal written' : 'No journal entry'}</span>
            {detail.day.visual.overlays.mood && (
              <span>
                {MOOD_EMOJIS[detail.day.visual.overlays.mood] ?? '•'} {detail.day.visual.overlays.mood}
              </span>
            )}
            <span>{detail.day.visual.overlays.reflection ? 'Reflection generated' : 'Reflection pending'}</span>
          </div>
        </div>
      )}
    </section>
  );
}
