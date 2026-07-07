/**
 * Deterministic date-only utilities for local journal dates.
 *
 * These helpers operate on `YYYY-MM-DD` values as pure calendar data rather than
 * instants in time. They intentionally avoid `Date.parse()` / `parseISO()` for
 * layout and indexing logic so DST and timezone offsets cannot shift a journal
 * day into the wrong week or month.
 */

import { format } from 'date-fns';
import type { WeekStart } from './dates';

export interface DateOnlyParts {
  year: number;
  month: number;
  day: number;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateOnly(date: string): DateOnlyParts {
  const match = DATE_ONLY_RE.exec(date);
  if (!match) {
    throw new Error(`Invalid date-only value: ${date}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function formatDateOnly(parts: DateOnlyParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function toLocalDate(date: string): Date {
  const { year, month, day } = parseDateOnly(date);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function addDaysToDateOnly(date: string, amount: number): string {
  const next = toLocalDate(date);
  next.setDate(next.getDate() + amount);
  return format(next, 'yyyy-MM-dd');
}

export function compareDateOnly(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isDateOnlyInRange(date: string, start: string, end: string): boolean {
  return compareDateOnly(date, start) >= 0 && compareDateOnly(date, end) <= 0;
}

export function getDayOfWeekFromDateOnly(date: string): number {
  const { year, month, day } = parseDateOnly(date);
  let y = year;
  let m = month;

  if (m < 3) {
    m += 12;
    y -= 1;
  }

  const k = y % 100;
  const j = Math.floor(y / 100);
  const h = (day + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;

  return (h + 6) % 7;
}

export function getWeekdayIndexFromDateOnly(date: string, weekStartsOn: WeekStart = 1): number {
  const day = getDayOfWeekFromDateOnly(date);
  return (day - weekStartsOn + 7) % 7;
}

export function startOfWeekDateOnly(date: string, weekStartsOn: WeekStart = 1): string {
  const offset = getWeekdayIndexFromDateOnly(date, weekStartsOn);
  return addDaysToDateOnly(date, -offset);
}

export function endOfWeekDateOnly(date: string, weekStartsOn: WeekStart = 1): string {
  const offset = 6 - getWeekdayIndexFromDateOnly(date, weekStartsOn);
  return addDaysToDateOnly(date, offset);
}

export function eachDateOnlyInRange(start: string, end: string): string[] {
  const result: string[] = [];
  let current = start;

  while (compareDateOnly(current, end) <= 0) {
    result.push(current);
    current = addDaysToDateOnly(current, 1);
  }

  return result;
}

export function getMonthFromDateOnly(date: string): number {
  return parseDateOnly(date).month - 1;
}

export function getDayOfMonthFromDateOnly(date: string): number {
  return parseDateOnly(date).day;
}
