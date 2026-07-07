/**
 * Activity calendar domain model and pure calendar layout engine.
 *
 * This module is UI-agnostic. It computes real calendar structure that can be
 * rendered by dashboard heatmaps, yearly reviews, timelines, and exported views.
 */

import type { WeekStart } from '../shared/utils/dates';
import {
  addDaysToDateOnly,
  eachDateOnlyInRange,
  endOfWeekDateOnly,
  getDayOfMonthFromDateOnly,
  getMonthFromDateOnly,
  getWeekdayIndexFromDateOnly,
  isDateOnlyInRange,
  startOfWeekDateOnly,
} from '../shared/utils/dateOnly';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type ActivityDayTone = 'none' | 'active';

export interface ActivityCalendarOverlayState {
  mood?: string | null;
  reflection?: boolean;
  memorable?: boolean;
  chapterMilestone?: boolean;
  streak?: boolean;
  favorite?: boolean;
}

export interface ActivityCalendarDayVisualState {
  tone: ActivityDayTone;
  overlays: ActivityCalendarOverlayState;
}

export interface ActivityCalendarDayInput {
  date: string;
  hasEntry: boolean;
  mood?: string | null;
  reflection?: boolean;
  memorable?: boolean;
  chapterMilestone?: boolean;
  streak?: boolean;
  favorite?: boolean;
}

export interface ActivityCalendarDay {
  date: string;
  dayOfWeek: number;
  isCurrentMonth: boolean;
  isInRange: boolean;
  isToday: boolean;
  visual: ActivityCalendarDayVisualState;
  stats: {
    hasEntry: boolean;
  };
}

export interface ActivityCalendarWeek {
  index: number;
  startDate: string;
  endDate: string;
  days: ActivityCalendarDay[];
}

export interface ActivityCalendarMonthAnchor {
  month: number;
  label: string;
  weekIndex: number;
  date: string;
}

export interface ActivityCalendarBounds {
  rangeStart: string;
  rangeEnd: string;
  gridStart: string;
  gridEnd: string;
  totalDays: number;
  totalWeeks: number;
  weekStartsOn: WeekStart;
}

export interface ActivityCalendarModel {
  bounds: ActivityCalendarBounds;
  weeks: ActivityCalendarWeek[];
  monthAnchors: ActivityCalendarMonthAnchor[];
}

function toVisualState(input?: ActivityCalendarDayInput): ActivityCalendarDayVisualState {
  return {
    tone: input?.hasEntry ? 'active' : 'none',
    overlays: {
      mood: input?.mood ?? null,
      reflection: input?.reflection ?? false,
      memorable: input?.memorable ?? false,
      chapterMilestone: input?.chapterMilestone ?? false,
      streak: input?.streak ?? false,
      favorite: input?.favorite ?? false,
    },
  };
}

export function buildActivityCalendarModel(args: {
  startDate: string;
  endDate: string;
  todayDate?: string;
  weekStartsOn?: WeekStart;
  days?: ActivityCalendarDayInput[];
}): ActivityCalendarModel {
  const weekStartsOn = args.weekStartsOn ?? 1;
  const todayDate = args.todayDate;

  const gridStart = startOfWeekDateOnly(args.startDate, weekStartsOn);
  const gridEnd = endOfWeekDateOnly(args.endDate, weekStartsOn);
  const rangeDays = eachDateOnlyInRange(args.startDate, args.endDate);
  const gridDays = eachDateOnlyInRange(gridStart, gridEnd);
  const inputByDate = new Map((args.days ?? []).map((day) => [day.date, day]));

  const weeks: ActivityCalendarWeek[] = [];
  const monthAnchors: ActivityCalendarMonthAnchor[] = [];

  let currentWeek: ActivityCalendarDay[] = [];
  let currentWeekStart = gridStart;

  for (let index = 0; index < gridDays.length; index += 1) {
    const date = gridDays[index];
    const input = inputByDate.get(date);
    const isInRange = isDateOnlyInRange(date, args.startDate, args.endDate);
    const visual = toVisualState(input);
    const month = getMonthFromDateOnly(date);

    currentWeek.push({
      date,
      dayOfWeek: getWeekdayIndexFromDateOnly(date, weekStartsOn),
      isCurrentMonth: isInRange,
      isInRange,
      isToday: todayDate === date,
      visual,
      stats: {
        hasEntry: input?.hasEntry ?? false,
      },
    });

    if (isInRange && getDayOfMonthFromDateOnly(date) === 1) {
      monthAnchors.push({
        month,
        label: MONTH_LABELS[month],
        weekIndex: Math.floor(index / 7),
        date,
      });
    }

    if (currentWeek.length === 7) {
      weeks.push({
        index: weeks.length,
        startDate: currentWeekStart,
        endDate: date,
        days: currentWeek,
      });
      currentWeek = [];
      currentWeekStart = addDaysToDateOnly(date, 1);
    }
  }

  return {
    bounds: {
      rangeStart: args.startDate,
      rangeEnd: args.endDate,
      gridStart,
      gridEnd,
      totalDays: rangeDays.length,
      totalWeeks: weeks.length,
      weekStartsOn,
    },
    weeks,
    monthAnchors,
  };
}
