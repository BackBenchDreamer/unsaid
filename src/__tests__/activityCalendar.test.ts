/**
 * Activity calendar engine — unit tests.
 *
 * Pure structural tests: no DOM, no Supabase, no React.
 * Validates calendar alignment, month anchors, grid coverage,
 * edge cases (leap year, year starts on different weekdays), and overlay model.
 */

import { describe, it, expect } from 'vitest';
import {
  buildActivityCalendarModel,
} from '../entities/activityCalendar';
import type { ActivityCalendarDayInput } from '../entities/activityCalendar';

import {
  addDaysToDateOnly,
  endOfWeekDateOnly,
  startOfWeekDateOnly,
} from '../shared/utils/dateOnly';


// ─── Helper ────────────────────────────────────────────────────────────────

function countCells(model: ReturnType<typeof buildActivityCalendarModel>): number {
  return model.weeks.reduce((sum, w) => sum + w.days.length, 0);
}

function inRangeDays(model: ReturnType<typeof buildActivityCalendarModel>) {
  return model.weeks.flatMap((w) => w.days).filter((d) => d.isInRange);
}

// ─── Week-column structure ─────────────────────────────────────────────────

describe('buildActivityCalendarModel — week column structure', () => {
  it('all weeks have exactly 7 days', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    for (const week of model.weeks) {
      expect(week.days).toHaveLength(7);
    }
  });

  it('total grid cells cover the full grid span', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    expect(countCells(model)).toBe(model.bounds.totalWeeks * 7);
  });

  it('first cell is the correct grid start (Monday-aligned, Jan 2025)', () => {
    // Jan 1 2025 is a Wednesday → grid should start Mon Dec 30 2024
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      weekStartsOn: 1,
    });
    expect(model.bounds.gridStart).toBe('2024-12-30');
    expect(model.weeks[0].startDate).toBe('2024-12-30');
  });

  it('last cell is the correct grid end (Monday-aligned, Jan 2025)', () => {
    // Jan 31 2025 is a Friday → grid should end Sun Feb 2 2025
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      weekStartsOn: 1,
    });
    expect(model.bounds.gridEnd).toBe('2025-02-02');
  });

  it('week index 0 is correct for Sunday week start', () => {
    // Jan 1 2025 is a Wednesday → grid should start Sun Dec 29 2024 when weekStartsOn=0
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      weekStartsOn: 0,
    });
    expect(model.bounds.gridStart).toBe('2024-12-29');
  });

  it('dayOfWeek 0 for first day of grid, 6 for last day of grid', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      weekStartsOn: 1,
    });
    const firstWeek = model.weeks[0];
    expect(firstWeek.days[0].dayOfWeek).toBe(0);
    expect(firstWeek.days[6].dayOfWeek).toBe(6);
  });
});

// ─── Range correctness ─────────────────────────────────────────────────────

describe('buildActivityCalendarModel — range coverage', () => {
  it('marks exactly the correct days as isInRange for a full year', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    const rangeDays = inRangeDays(model);
    expect(rangeDays).toHaveLength(365);
    expect(rangeDays[0].date).toBe('2025-01-01');
    expect(rangeDays[rangeDays.length - 1].date).toBe('2025-12-31');
  });

  it('leap year 2024 has 366 in-range days', () => {
    const model = buildActivityCalendarModel({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      weekStartsOn: 1,
    });
    expect(inRangeDays(model)).toHaveLength(366);
  });

  it('days outside the range are not marked isInRange', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      weekStartsOn: 1,
    });
    const allDays = model.weeks.flatMap((w) => w.days);
    const outOfRange = allDays.filter((d) => !d.isInRange);
    for (const d of outOfRange) {
      expect(d.date < '2025-01-01' || d.date > '2025-01-31').toBe(true);
    }
  });
});

// ─── Month anchors ─────────────────────────────────────────────────────────

describe('buildActivityCalendarModel — month anchors', () => {
  it('generates exactly 12 month anchors for a full year', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    expect(model.monthAnchors).toHaveLength(12);
  });

  it('month anchor weekIndex matches the actual column the 1st of the month falls in', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    for (const anchor of model.monthAnchors) {
      const week = model.weeks[anchor.weekIndex];
      expect(week).toBeDefined();
      const hasFist = week.days.some((d) => d.date === anchor.date);
      expect(hasFist).toBe(true);
    }
  });

  it('month anchor labels are short month names', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    const labels = model.monthAnchors.map((a) => a.label);
    expect(labels).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ]);
  });

  it('month anchor dates are always the 1st of each month', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    for (const anchor of model.monthAnchors) {
      expect(anchor.date.endsWith('-01')).toBe(true);
    }
  });

  it('first month anchor week index is 0 when year starts on the grid start day', () => {
    // Jan 1 2024 is a Monday with weekStartsOn=1 → grid start = Jan 1 2024 → Jan anchor = week 0
    const model = buildActivityCalendarModel({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      weekStartsOn: 1,
    });
    expect(model.bounds.gridStart).toBe('2024-01-01');
    expect(model.monthAnchors[0].weekIndex).toBe(0);
  });
});

// ─── Visual state / overlay model ─────────────────────────────────────────

describe('buildActivityCalendarModel — visual state', () => {
  it('tone is none for a day with no input', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-01',
      weekStartsOn: 1,
    });
    const cell = inRangeDays(model)[0];
    expect(cell.visual.tone).toBe('none');
  });

  it('tone is active for a day with hasEntry=true', () => {
    const days: ActivityCalendarDayInput[] = [
      { date: '2025-06-01', hasEntry: true, mood: 'great' },
    ];
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-01',
      weekStartsOn: 1,
      days,
    });
    const cell = inRangeDays(model)[0];
    expect(cell.visual.tone).toBe('active');
    expect(cell.visual.overlays.mood).toBe('great');
  });

  it('all overlays default to false/null for an input with only hasEntry', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-01',
      weekStartsOn: 1,
      days: [{ date: '2025-06-01', hasEntry: true }],
    });
    const cell = inRangeDays(model)[0];
    expect(cell.visual.overlays.reflection).toBe(false);
    expect(cell.visual.overlays.memorable).toBe(false);
    expect(cell.visual.overlays.chapterMilestone).toBe(false);
    expect(cell.visual.overlays.streak).toBe(false);
    expect(cell.visual.overlays.favorite).toBe(false);
    expect(cell.visual.overlays.mood).toBeNull();
  });

  it('overlays are independently controlled', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-01',
      weekStartsOn: 1,
      days: [{
        date: '2025-06-01',
        hasEntry: true,
        mood: 'good',
        reflection: true,
        memorable: false,
        chapterMilestone: false,
        streak: true,
        favorite: false,
      }],
    });
    const cell = inRangeDays(model)[0];
    expect(cell.visual.overlays.reflection).toBe(true);
    expect(cell.visual.overlays.streak).toBe(true);
    expect(cell.visual.overlays.memorable).toBe(false);
    expect(cell.visual.overlays.mood).toBe('good');
  });
});

// ─── isToday flag ──────────────────────────────────────────────────────────

describe('buildActivityCalendarModel — isToday', () => {
  it('marks the todayDate cell as isToday=true', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-30',
      todayDate: '2025-06-15',
      weekStartsOn: 1,
    });
    const today = inRangeDays(model).find((d) => d.date === '2025-06-15');
    expect(today?.isToday).toBe(true);
  });

  it('only one cell is isToday', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-30',
      todayDate: '2025-06-15',
      weekStartsOn: 1,
    });
    const todayCells = inRangeDays(model).filter((d) => d.isToday);
    expect(todayCells).toHaveLength(1);
  });

  it('no cell is isToday when todayDate is not provided', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-06-01',
      endDate: '2025-06-30',
      weekStartsOn: 1,
    });
    const todayCells = inRangeDays(model).filter((d) => d.isToday);
    expect(todayCells).toHaveLength(0);
  });
});

// ─── Bounds metadata ───────────────────────────────────────────────────────

describe('buildActivityCalendarModel — bounds metadata', () => {
  it('exposes weekStartsOn in bounds', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 0,
    });
    expect(model.bounds.weekStartsOn).toBe(0);
  });

  it('totalDays matches the range span', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    expect(model.bounds.totalDays).toBe(365);
  });

  it('totalWeeks equals the number of week arrays', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      weekStartsOn: 1,
    });
    expect(model.bounds.totalWeeks).toBe(model.weeks.length);
  });
});

describe('buildActivityCalendarModel — timezone-safe date-only behavior', () => {
  it('never requires UTC timestamps or created_at to place entries', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-03-01',
      endDate: '2025-03-31',
      weekStartsOn: 1,
      days: [
        { date: '2025-03-09', hasEntry: true },
        { date: '2025-03-10', hasEntry: true },
      ],
    });

    const dates = inRangeDays(model)
      .filter((day) => day.stats.hasEntry)
      .map((day) => day.date);

    expect(dates).toEqual(['2025-03-09', '2025-03-10']);
  });

  it('uses deterministic date-only week bounds across DST-forward periods', () => {
    expect(startOfWeekDateOnly('2025-03-09', 1)).toBe('2025-03-03');
    expect(endOfWeekDateOnly('2025-03-09', 1)).toBe('2025-03-09');
    expect(addDaysToDateOnly('2025-03-09', 1)).toBe('2025-03-10');
  });

  it('uses deterministic date-only week bounds across DST-back periods', () => {
    expect(startOfWeekDateOnly('2025-11-02', 1)).toBe('2025-10-27');
    expect(endOfWeekDateOnly('2025-11-02', 1)).toBe('2025-11-02');
    expect(addDaysToDateOnly('2025-11-02', 1)).toBe('2025-11-03');
  });

  it('keeps travelled-user journal dates on their explicit entry_date', () => {
    const model = buildActivityCalendarModel({
      startDate: '2025-04-01',
      endDate: '2025-04-30',
      weekStartsOn: 1,
      days: [
        { date: '2025-04-04', hasEntry: true },
        { date: '2025-04-05', hasEntry: true },
      ],
    });

    const active = model.weeks
      .flatMap((week) => week.days)
      .filter((day) => day.stats.hasEntry)
      .map((day) => day.date);

    expect(active).toEqual(['2025-04-04', '2025-04-05']);
  });
});
