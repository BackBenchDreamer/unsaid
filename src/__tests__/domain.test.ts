/**
 * Tests for domain invariants: streak computation and entry validation.
 */

import { describe, it, expect } from 'vitest';
import { computeStreak } from '../entities/streak';
import { validateEntryPayload, isValidEntryDate, EntryUpsertPayload } from '../entities/entry';

describe('computeStreak', () => {
  it('returns zero for no entries', () => {
    const result = computeStreak([], '2026-05-01');
    expect(result.current).toBe(0);
    expect(result.longest).toBe(0);
    expect(result.totalEntries).toBe(0);
  });

  it('returns 1 for a single entry today', () => {
    const result = computeStreak(['2026-05-01'], '2026-05-01');
    expect(result.current).toBe(1);
    expect(result.longest).toBe(1);
  });

  it('returns current streak for consecutive days ending today', () => {
    const dates = ['2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01'];
    const result = computeStreak(dates, '2026-05-01');
    expect(result.current).toBe(4);
    expect(result.longest).toBe(4);
  });

  it('returns current streak for consecutive days ending yesterday', () => {
    const dates = ['2026-04-29', '2026-04-30'];
    const result = computeStreak(dates, '2026-05-01');
    expect(result.current).toBe(2);
  });

  it('returns 0 current streak if last entry was 2+ days ago', () => {
    const dates = ['2026-04-25', '2026-04-26'];
    const result = computeStreak(dates, '2026-05-01');
    expect(result.current).toBe(0);
    expect(result.longest).toBe(2);
  });

  it('computes longest streak across gaps', () => {
    const dates = [
      '2026-01-01', '2026-01-02', '2026-01-03', // 3-day streak
      '2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13', '2026-02-14', // 5-day streak
      '2026-03-01',
    ];
    const result = computeStreak(dates, '2026-05-01');
    expect(result.longest).toBe(5);
    expect(result.current).toBe(0);
    expect(result.totalEntries).toBe(9);
  });

  it('deduplicates dates', () => {
    const dates = ['2026-05-01', '2026-05-01', '2026-05-01'];
    const result = computeStreak(dates, '2026-05-01');
    expect(result.current).toBe(1);
    expect(result.totalEntries).toBe(3); // raw count, not deduplicated
  });
});

describe('isValidEntryDate', () => {
  it('accepts valid YYYY-MM-DD', () => {
    expect(isValidEntryDate('2026-05-01')).toBe(true);
    expect(isValidEntryDate('2026-12-31')).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(isValidEntryDate('05-01-2026')).toBe(false);
    expect(isValidEntryDate('2026/05/01')).toBe(false);
    expect(isValidEntryDate('not-a-date')).toBe(false);
    expect(isValidEntryDate('')).toBe(false);
  });
});

describe('validateEntryPayload', () => {
  const validPayload: EntryUpsertPayload = {
    entryDate: '2026-05-01',
    content: 'Hello world',
    mood: 'good',
    tags: ['test'],
  };

  it('returns no errors for valid payload', () => {
    expect(validateEntryPayload(validPayload)).toHaveLength(0);
  });

  it('rejects invalid date', () => {
    const errors = validateEntryPayload({ ...validPayload, entryDate: 'bad' });
    expect(errors).toContain('Invalid entry_date format.');
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const errors = validateEntryPayload({ ...validPayload, tags });
    expect(errors.some(e => e.includes('Max'))).toBe(true);
  });

  it('rejects invalid mood', () => {
    const errors = validateEntryPayload({ ...validPayload, mood: 'invalid' as any });
    expect(errors).toContain('Invalid mood value.');
  });
});
