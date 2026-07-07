/**
 * Date utilities — timezone-safe operations for journal dates.
 *
 * The golden rule: entry_date is always a user-local calendar date "YYYY-MM-DD".
 * We never derive it from created_at or from toISOString().
 */

import { format, subDays, startOfYear, endOfYear } from 'date-fns';
import {
  getDayOfWeekFromDateOnly,
  getWeekdayIndexFromDateOnly,
  toLocalDate,
} from './dateOnly';

/**
 * Get today's date as "YYYY-MM-DD" in the user's local timezone.
 * This is the ONLY correct way to get today's journal date.
 */
export function getTodayLocal(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/**
 * Format a date for display (e.g. "May 1, 2026").
 */
export function formatDisplayDate(dateStr: string): string {
  return format(toLocalDate(dateStr), 'MMMM d, yyyy');
}

/**
 * Format a date for compact display (e.g. "May 1").
 */
export function formatShortDate(dateStr: string): string {
  return format(toLocalDate(dateStr), 'MMM d');
}

/**
 * Get yesterday's date as "YYYY-MM-DD".
 */
export function getYesterdayLocal(): string {
  return format(subDays(new Date(), 1), 'yyyy-MM-dd');
}

/**
 * Get the start and end of the current year for heatmap range.
 */
export function getCurrentYearRange(): { start: string; end: string } {
  const now = new Date();
  return {
    start: format(startOfYear(now), 'yyyy-MM-dd'),
    end: format(endOfYear(now), 'yyyy-MM-dd'),
  };
}

/**
 * Calendar week start options.
 */
export type WeekStart = 0 | 1 | 6;

/**
 * Get local day of week aligned to a configurable week start.
 * Returns 0 for the first day of the configured week.
 */
export function getDayOfWeekIndex(dateStr: string, weekStartsOn: WeekStart = 1): number {
  return getWeekdayIndexFromDateOnly(dateStr, weekStartsOn);
}


/**
 * Check if a date string is today.
 */
export function isToday(dateStr: string): boolean {
  return dateStr === getTodayLocal();
}

/**
 * Get day of week (0 = Sun, 6 = Sat).
 */
export function getDayOfWeek(dateStr: string): number {
  return getDayOfWeekFromDateOnly(dateStr);
}
