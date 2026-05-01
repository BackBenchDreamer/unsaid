/**
 * Date utilities — timezone-safe operations for journal dates.
 *
 * The golden rule: entry_date is always a user-local calendar date "YYYY-MM-DD".
 * We never derive it from created_at or from toISOString().
 */

import { format, subDays, startOfYear, endOfYear, parseISO } from 'date-fns';

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
  return format(parseISO(dateStr), 'MMMM d, yyyy');
}

/**
 * Format a date for compact display (e.g. "May 1").
 */
export function formatShortDate(dateStr: string): string {
  return format(parseISO(dateStr), 'MMM d');
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
 * Check if a date string is today.
 */
export function isToday(dateStr: string): boolean {
  return dateStr === getTodayLocal();
}

/**
 * Get day of week (0 = Sun, 6 = Sat).
 */
export function getDayOfWeek(dateStr: string): number {
  return parseISO(dateStr).getDay();
}
