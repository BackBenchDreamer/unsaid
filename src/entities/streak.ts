/**
 * Streak — always derived from entry_date, never from created_at.
 *
 * The streak is the number of consecutive calendar days (entry_date)
 * with at least one entry, ending today or yesterday.
 *
 * All computation uses the sorted list of unique entry_dates.
 * This function is timezone-safe because entry_date is already
 * a user-local "YYYY-MM-DD" string set at write time.
 */

import { differenceInCalendarDays, parseISO, subDays, format } from 'date-fns';

export interface StreakInfo {
  /** Current consecutive-day streak count. */
  current: number;
  /** Longest consecutive-day streak count ever. */
  longest: number;
  /** Total entries written. */
  totalEntries: number;
}

/**
 * Compute streak info from a list of entry_date strings.
 * @param entryDates Array of "YYYY-MM-DD" strings (need not be sorted/unique).
 * @param todayLocal Today's date as "YYYY-MM-DD" in user's local timezone.
 */
export function computeStreak(entryDates: string[], todayLocal: string): StreakInfo {
  if (entryDates.length === 0) {
    return { current: 0, longest: 0, totalEntries: 0 };
  }

  // Deduplicate and sort ascending.
  const unique = [...new Set(entryDates)].sort();
  const dates = unique.map((d) => parseISO(d));

  // Compute all streaks.
  let longest = 1;
  let currentRun = 1;
  const streaks: { end: Date; length: number }[] = [];

  for (let i = 1; i < dates.length; i++) {
    const diff = differenceInCalendarDays(dates[i], dates[i - 1]);
    if (diff === 1) {
      currentRun++;
    } else {
      streaks.push({ end: dates[i - 1], length: currentRun });
      longest = Math.max(longest, currentRun);
      currentRun = 1;
    }
  }
  // Push the final run.
  streaks.push({ end: dates[dates.length - 1], length: currentRun });
  longest = Math.max(longest, currentRun);

  // Current streak: last run that ends today or yesterday.
  const today = parseISO(todayLocal);
  const yesterday = subDays(today, 1);
  const lastRun = streaks[streaks.length - 1];
  const lastEndStr = format(lastRun.end, 'yyyy-MM-dd');
  const todayStr = format(today, 'yyyy-MM-dd');
  const yesterdayStr = format(yesterday, 'yyyy-MM-dd');

  const current =
    lastEndStr === todayStr || lastEndStr === yesterdayStr ? lastRun.length : 0;

  return {
    current,
    longest,
    totalEntries: entryDates.length,
  };
}
