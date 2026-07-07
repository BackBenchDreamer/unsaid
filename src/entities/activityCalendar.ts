/**
 * Activity calendar domain model and pure calendar layout engine.
 *
 * This module is UI-agnostic. It computes real calendar structure that can be
 * rendered by dashboard heatmaps, yearly reviews, timelines, and exported views.
 */

import {
  addDays,
  eachDayOfInterval,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfWeek,
} from 'date-fns';
import type { WeekStart } from '../shared/utils/dates';
import { getDayOfWeekIndex } from '../shared/utils/dates';

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
  const startDate = parseISO(args.startDate);
  const endDate = parseISO(args.endDate);
  const todayDate = args.todayDate;

  const gridStart = startOfWeek(startDate, { weekStartsOn });
  const gridEnd = endOfWeek(endDate, { weekStartsOn });
  const rangeDays = eachDayOfInterval({ start: startDate, end: endDate });
  const gridDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const inputByDate = new Map((args.days ?? []).map((day) => [day.date, day]));

  const weeks: ActivityCalendarWeek[] = [];
  const monthAnchors: ActivityCalendarMonthAnchor[] = [];

  let currentWeek: ActivityCalendarDay[] = [];
  let currentWeekStart = format(gridStart, 'yyyy-MM-dd');

  for (let index = 0; index < gridDays.length; index += 1) {
    const day = gridDays[index];
    const date = format(day, 'yyyy-MM-dd');
    const input = inputByDate.get(date);
    const isInRange = date >= args.startDate && date <= args.endDate;
    const visual = toVisualState(input);

    currentWeek.push({
      date,
      dayOfWeek: getDayOfWeekIndex(date, weekStartsOn),
      isCurrentMonth: isSameMonth(day, startDate),
      isInRange,
      isToday: todayDate === date,
      visual,
      stats: {
        hasEntry: input?.hasEntry ?? false,
      },
    });

    if (date >= args.startDate && date <= args.endDate && day.getDate() === 1) {
      monthAnchors.push({
        month: day.getMonth(),
        label: format(day, 'MMM'),
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
      const nextDay = addDays(day, 1);
      currentWeekStart = format(nextDay, 'yyyy-MM-dd');
    }
  }

  return {
    bounds: {
      rangeStart: args.startDate,
      rangeEnd: args.endDate,
      gridStart: format(gridStart, 'yyyy-MM-dd'),
      gridEnd: format(gridEnd, 'yyyy-MM-dd'),
      totalDays: rangeDays.length,
      totalWeeks: weeks.length,
      weekStartsOn,
    },
    weeks,
    monthAnchors,
  };
}
