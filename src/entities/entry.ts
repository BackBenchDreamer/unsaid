/**
 * Journal Entry — core domain entity.
 *
 * Invariants:
 *  - One entry per user per entry_date (enforced DB-side via UNIQUE constraint).
 *  - entry_date is a user-local calendar date string "YYYY-MM-DD", never UTC-derived.
 *  - Streaks and heatmaps derive from entry_date, never from created_at.
 *  - content may be empty (draft), but entry_date + user_id pair is canonical.
 */

/** Mood values — exhaustive, ordered from negative to positive. */
export const MOODS = ['terrible', 'bad', 'meh', 'good', 'great'] as const;
export type Mood = (typeof MOODS)[number];

/** Tags are free-form lowercase strings, max 20 per entry. */
export type Tag = string;
export const MAX_TAGS_PER_ENTRY = 20;
export const MAX_TAG_LENGTH = 40;

/**
 * Canonical Entry domain object.
 * This is what the service layer returns — never a raw DB row.
 */
export interface Entry {
  readonly id: string;
  readonly userId: string;
  /** "YYYY-MM-DD" — user-local calendar date, the canonical day key. */
  readonly entryDate: string;
  content: string;
  mood: Mood | null;
  tags: Tag[];
  readonly createdAt: string;
  updatedAt: string;
}

/** Shape for creating / upserting an entry (client → service). */
export interface EntryUpsertPayload {
  entryDate: string; // "YYYY-MM-DD"
  content: string;
  mood: Mood | null;
  tags: Tag[];
}

/** DB row shape — maps 1:1 to Supabase table columns. */
export interface EntryRow {
  id: string;
  user_id: string;
  entry_date: string;
  content: string;
  mood: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

// ─── Mappers ───────────────────────────────────────────────

export function entryFromRow(row: EntryRow): Entry {
  return {
    id: row.id,
    userId: row.user_id,
    entryDate: row.entry_date,
    content: row.content,
    mood: (row.mood as Mood) ?? null,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function entryToRowPayload(
  userId: string,
  payload: EntryUpsertPayload,
): Omit<EntryRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    user_id: userId,
    entry_date: payload.entryDate,
    content: payload.content,
    mood: payload.mood,
    tags: payload.tags,
  };
}

// ─── Validation ────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEntryDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const parsed = new Date(d + 'T00:00:00');
  return !isNaN(parsed.getTime());
}

export function validateEntryPayload(p: EntryUpsertPayload): string[] {
  const errors: string[] = [];
  if (!isValidEntryDate(p.entryDate)) errors.push('Invalid entry_date format.');
  if (p.tags.length > MAX_TAGS_PER_ENTRY) errors.push(`Max ${MAX_TAGS_PER_ENTRY} tags.`);
  if (p.tags.some((t) => t.length > MAX_TAG_LENGTH)) errors.push(`Tag too long (max ${MAX_TAG_LENGTH}).`);
  if (p.mood !== null && !MOODS.includes(p.mood)) errors.push('Invalid mood value.');
  return errors;
}
