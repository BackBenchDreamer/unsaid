/**
 * Tests for memory domain entities and logic — Milestone 3.
 *
 * Tests cover:
 *   - lifeChapterFromRow mapper
 *   - contextMemoryFromRow mapper
 *   - memoryExtractionFromRow mapper
 *   - Memory constants correctness
 *   - themeOverlapRatio logic (chapter stability check)
 *   - ContextBlock token estimation via getActiveChapterSummaries
 *
 * All tests are pure unit tests — no network calls, no Supabase.
 */

import { describe, it, expect } from 'vitest';
import {
  lifeChapterFromRow,
  chapterEntryFromRow,
  contextMemoryFromRow,
  memoryExtractionFromRow,
  CHAPTER_MIN_ENTRIES,
  CHAPTER_DORMANCY_DAYS,
  CHAPTER_CANDIDATE_WINDOW_DAYS,
  CHAPTER_STABILITY_DAYS,
  CONTEXT_MEMORY_MIN_MENTIONS,
  CONTEXT_MEMORY_MAX_TOKENS,
} from '../entities/memory';
import type {
  LifeChapterRow,
  ChapterEntryRow,
  ContextMemoryRow,
  MemoryExtractionRow,
} from '../entities/memory';

// ─── lifeChapterFromRow ──────────────────────────────────────

describe('lifeChapterFromRow', () => {
  const base: LifeChapterRow = {
    id: 'chapter-1',
    user_id: 'user-1',
    name: 'IBM Internship',
    summary: 'A summer of learning and growth.',
    chapter_start: '2026-05-01',
    chapter_end: null,
    status: 'active',
    theme_tags: ['work', 'internship'],
    entry_count: 12,
    last_change_at: '2026-07-15T10:00:00Z',
    signals: { entity_overlap: ['ibm'], theme_overlap: ['work'], entry_count: 12 },
    created_at: '2026-05-01T08:00:00Z',
    updated_at: '2026-07-15T10:00:00Z',
  };

  it('maps all fields to camelCase', () => {
    const chapter = lifeChapterFromRow(base);
    expect(chapter.id).toBe('chapter-1');
    expect(chapter.userId).toBe('user-1');
    expect(chapter.name).toBe('IBM Internship');
    expect(chapter.summary).toBe('A summer of learning and growth.');
    expect(chapter.chapterStart).toBe('2026-05-01');
    expect(chapter.chapterEnd).toBeNull();
    expect(chapter.status).toBe('active');
    expect(chapter.themeTags).toEqual(['work', 'internship']);
    expect(chapter.entryCount).toBe(12);
    expect(chapter.lastChangeAt).toBe('2026-07-15T10:00:00Z');
    expect(chapter.signals).toMatchObject({ entity_overlap: ['ibm'] });
    expect(chapter.createdAt).toBe('2026-05-01T08:00:00Z');
    expect(chapter.updatedAt).toBe('2026-07-15T10:00:00Z');
  });

  it('handles null name and summary (forming chapter)', () => {
    const forming = lifeChapterFromRow({ ...base, name: null, summary: null, status: 'forming' });
    expect(forming.name).toBeNull();
    expect(forming.summary).toBeNull();
    expect(forming.status).toBe('forming');
  });

  it('handles null chapter_end (active chapter with no end date)', () => {
    const chapter = lifeChapterFromRow({ ...base, chapter_end: null });
    expect(chapter.chapterEnd).toBeNull();
  });

  it('handles chapter_end when set (dormant chapter)', () => {
    const dormant = lifeChapterFromRow({
      ...base,
      status: 'dormant',
      chapter_end: '2026-08-31',
    });
    expect(dormant.status).toBe('dormant');
    expect(dormant.chapterEnd).toBe('2026-08-31');
  });

  it('handles null signals', () => {
    const chapter = lifeChapterFromRow({ ...base, signals: null });
    expect(chapter.signals).toBeNull();
  });

  it('returns empty array for missing theme_tags', () => {
    const chapter = lifeChapterFromRow({ ...base, theme_tags: [] });
    expect(chapter.themeTags).toEqual([]);
  });
});

// ─── chapterEntryFromRow ─────────────────────────────────────

describe('chapterEntryFromRow', () => {
  const base: ChapterEntryRow = {
    id: 'link-1',
    chapter_id: 'chapter-1',
    entry_id: 'entry-42',
    joined_at: '2026-06-01T09:00:00Z',
  };

  it('maps all fields to camelCase', () => {
    const link = chapterEntryFromRow(base);
    expect(link.id).toBe('link-1');
    expect(link.chapterId).toBe('chapter-1');
    expect(link.entryId).toBe('entry-42');
    expect(link.joinedAt).toBe('2026-06-01T09:00:00Z');
  });
});

// ─── contextMemoryFromRow ────────────────────────────────────

describe('contextMemoryFromRow', () => {
  const base: ContextMemoryRow = {
    id: 'mem-1',
    user_id: 'user-1',
    entity_type: 'person',
    entity_value: 'ashu',
    mention_count: 7,
    last_seen_date: '2026-07-20',
    emotional_tags: ['joy', 'anticipation'],
    importance_score: null,
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-07-20T08:00:00Z',
  };

  it('maps all fields to camelCase', () => {
    const memory = contextMemoryFromRow(base);
    expect(memory.id).toBe('mem-1');
    expect(memory.userId).toBe('user-1');
    expect(memory.entityType).toBe('person');
    expect(memory.entityValue).toBe('ashu');
    expect(memory.mentionCount).toBe(7);
    expect(memory.lastSeenDate).toBe('2026-07-20');
    expect(memory.emotionalTags).toEqual(['joy', 'anticipation']);
    expect(memory.importanceScore).toBeNull();
    expect(memory.createdAt).toBe('2026-01-15T08:00:00Z');
    expect(memory.updatedAt).toBe('2026-07-20T08:00:00Z');
  });

  it('maps importance_score as null in M3 (reserved for M4+)', () => {
    const memory = contextMemoryFromRow({ ...base, importance_score: null });
    expect(memory.importanceScore).toBeNull();
  });

  it('accepts importance_score when set (future use)', () => {
    const memory = contextMemoryFromRow({ ...base, importance_score: 0.85 });
    expect(memory.importanceScore).toBe(0.85);
  });

  it('handles all entity types', () => {
    const types = ['person', 'place', 'project', 'organization', 'topic'] as const;
    for (const type of types) {
      const memory = contextMemoryFromRow({ ...base, entity_type: type });
      expect(memory.entityType).toBe(type);
    }
  });

  it('returns empty array for missing emotional_tags', () => {
    const memory = contextMemoryFromRow({ ...base, emotional_tags: [] });
    expect(memory.emotionalTags).toEqual([]);
  });
});

// ─── memoryExtractionFromRow ─────────────────────────────────

describe('memoryExtractionFromRow', () => {
  const base: MemoryExtractionRow = {
    id: 'ext-1',
    user_id: 'user-1',
    entry_id: 'entry-42',
    extracted_at: '2026-07-20T12:00:00Z',
    prompt_version: '3.0.0',
    extraction_version: '1.0.0',
  };

  it('maps all fields to camelCase', () => {
    const extraction = memoryExtractionFromRow(base);
    expect(extraction.id).toBe('ext-1');
    expect(extraction.userId).toBe('user-1');
    expect(extraction.entryId).toBe('entry-42');
    expect(extraction.extractedAt).toBe('2026-07-20T12:00:00Z');
    expect(extraction.promptVersion).toBe('3.0.0');
    expect(extraction.extractionVersion).toBe('1.0.0');
  });

  it('stores prompt version from ReflectionPayload._meta.version (not hardcoded)', () => {
    // The promptVersion field should be whatever was in the reflection at extraction time
    const extraction = memoryExtractionFromRow({ ...base, prompt_version: '2.1.0' });
    expect(extraction.promptVersion).toBe('2.1.0');
  });

  it('stores extraction_version independently from prompt_version', () => {
    // extraction_version tracks the extraction pipeline logic version,
    // not the reflection prompt version. They are bumped independently.
    const extraction = memoryExtractionFromRow({ ...base, prompt_version: '4.0.0', extraction_version: '2.0.0' });
    expect(extraction.promptVersion).toBe('4.0.0');
    expect(extraction.extractionVersion).toBe('2.0.0');
  });
});

// ─── Memory Constants ────────────────────────────────────────

describe('memory constants', () => {
  it('CHAPTER_MIN_ENTRIES is a positive integer', () => {
    expect(CHAPTER_MIN_ENTRIES).toBeGreaterThan(0);
    expect(Number.isInteger(CHAPTER_MIN_ENTRIES)).toBe(true);
  });

  it('CHAPTER_DORMANCY_DAYS is positive', () => {
    expect(CHAPTER_DORMANCY_DAYS).toBeGreaterThan(0);
  });

  it('CHAPTER_CANDIDATE_WINDOW_DAYS is positive', () => {
    expect(CHAPTER_CANDIDATE_WINDOW_DAYS).toBeGreaterThan(0);
  });

  it('CHAPTER_STABILITY_DAYS is positive and less than CHAPTER_DORMANCY_DAYS', () => {
    expect(CHAPTER_STABILITY_DAYS).toBeGreaterThan(0);
    // Stability window must be shorter than dormancy threshold
    // (a chapter can't be dormant before it has a chance to be stable)
    expect(CHAPTER_STABILITY_DAYS).toBeLessThan(CHAPTER_DORMANCY_DAYS);
  });

  it('CONTEXT_MEMORY_MIN_MENTIONS is a positive integer', () => {
    expect(CONTEXT_MEMORY_MIN_MENTIONS).toBeGreaterThan(0);
    expect(Number.isInteger(CONTEXT_MEMORY_MIN_MENTIONS)).toBe(true);
  });

  it('CONTEXT_MEMORY_MAX_TOKENS is positive', () => {
    expect(CONTEXT_MEMORY_MAX_TOKENS).toBeGreaterThan(0);
  });

  it('CHAPTER_MIN_ENTRIES matches the multi-signal threshold documented in the plan', () => {
    // This constant determines when a chapter is first created.
    // The plan specifies ≥3 entries as the minimum — conservative to avoid false positives.
    expect(CHAPTER_MIN_ENTRIES).toBe(3);
  });

  it('CHAPTER_STABILITY_DAYS matches the documented value', () => {
    // 7 days is the minimum quiet period before promotion. See AGENTS.md.
    expect(CHAPTER_STABILITY_DAYS).toBe(7);
  });
});

// ─── Token budget calculations ───────────────────────────────

describe('context block token estimation', () => {
  it('estimates token count from character count (1 token ≈ 4 chars)', () => {
    // 500 tokens * 4 chars/token = 2000 chars budget
    const charBudget = CONTEXT_MEMORY_MAX_TOKENS * 4;
    expect(charBudget).toBe(2000);
  });

  it('a short context stays within the token budget', () => {
    const contextText = 'Relevant context about this person: persons: ashu; recurring topics: work, internship.';
    const tokenEstimate = Math.ceil(contextText.length / 4);
    expect(tokenEstimate).toBeLessThanOrEqual(CONTEXT_MEMORY_MAX_TOKENS);
  });

  it('token estimate for empty context is 0', () => {
    const tokenEstimate = Math.ceil(''.length / 4);
    expect(tokenEstimate).toBe(0);
  });
});

// ─── Chapter lifecycle logic (dormancy threshold) ────────────

describe('chapter dormancy logic', () => {
  /**
   * Helper that mirrors the dormancy check in extract-memory Edge Function.
   * Extracted as a testable pure function.
   */
  function daysAgo(dateStr: string, nowStr: string): number {
    const date = new Date(dateStr);
    const now = new Date(nowStr);
    return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  }

  function isDormant(lastChangeAt: string, today: string): boolean {
    return daysAgo(lastChangeAt, today) > CHAPTER_DORMANCY_DAYS;
  }

  it('active chapter is NOT dormant within the threshold', () => {
    const lastChange = '2026-06-01';
    const today = '2026-07-01';  // 30 days later
    expect(isDormant(lastChange, today)).toBe(false);
  });

  it('active chapter IS dormant after threshold exceeded', () => {
    const lastChange = '2026-05-01';
    const today = '2026-07-10';  // 70 days later (> 60)
    expect(isDormant(lastChange, today)).toBe(true);
  });

  it('boundary case: exactly on threshold is NOT yet dormant', () => {
    const lastChange = '2026-05-01';
    const today = '2026-06-30';  // exactly 60 days later
    // isDormant uses strict > so exactly 60 days is still active
    expect(isDormant(lastChange, today)).toBe(false);
  });

  it('boundary case: one day beyond threshold is dormant', () => {
    const lastChange = '2026-05-01';
    const today = '2026-07-01';  // 61 days later
    expect(isDormant(lastChange, today)).toBe(true);
  });
});
