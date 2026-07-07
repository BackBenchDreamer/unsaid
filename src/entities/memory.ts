/**
 * Memory Domain Entities — Milestone 3: Memory Before Intelligence.
 *
 * Two memory types:
 *
 *  LifeChapter     — a meaningful collection of related journal entries
 *                    representing a distinct life episode (e.g. "IBM Internship").
 *                    Discovered automatically by the extract-memory Edge Function.
 *                    Never created or mutated directly by the client.
 *
 *  ContextMemory   — a recurring entity (person, place, project, topic, etc.)
 *                    extracted from reflected entries. Used internally to enrich
 *                    future reflection prompts. Users may eventually see these
 *                    in M4 but the data layer is built here.
 *
 * Supporting types:
 *  ChapterEntry    — join table row linking an entry to a chapter.
 *  MemoryExtraction — idempotency guard: one row per processed entry.
 *
 * Invariants:
 *  - All writes to these tables happen via service_role in Edge Functions only.
 *  - No client mutation is permitted.
 *  - importanceScore is NULL for all M3-generated context_memory rows.
 *  - chapter name/summary are NULL while status = 'forming'.
 *  - entry_count and last_change_at on life_chapters are maintained by extract-memory.
 */

// ─── Chapter Status ────────────────────────────────────────

/**
 * Status lifecycle for a life chapter:
 *   forming  → candidate detected; not yet structurally stable
 *   active   → promoted; LLM-named; stable evidence
 *   dormant  → no new entries for CHAPTER_DORMANCY_DAYS days
 */
export type ChapterStatus = 'forming' | 'active' | 'dormant';

// ─── Context Entity Type ───────────────────────────────────

/**
 * Type of entity stored in context_memory.
 *   topic        — from ReflectionPayload.themes (always extracted)
 *   person       — from Groq entity extraction (requires Groq)
 *   place        — from Groq entity extraction (requires Groq)
 *   project      — from Groq entity extraction (requires Groq)
 *   organization — from Groq entity extraction (requires Groq)
 */
export type ContextEntityType = 'person' | 'place' | 'project' | 'organization' | 'topic';

// ─── Constants ────────────────────────────────────────────

/** Minimum number of entries in a candidate cluster before a chapter is created. */
export const CHAPTER_MIN_ENTRIES = 3;

/**
 * Number of days without a new entry after which a chapter becomes dormant.
 * Measured from last_change_at on the life_chapters row.
 */
export const CHAPTER_DORMANCY_DAYS = 60;

/**
 * Maximum age (in days) of entries considered for chapter candidate clustering.
 * Prevents ancient entries from conflating with present-day episodes.
 */
export const CHAPTER_CANDIDATE_WINDOW_DAYS = 90;

/**
 * Minimum number of days a forming chapter must be stable (no new entries)
 * before promotion to active is considered. This is ONE of three conditions
 * in the structural stability check; time alone does not promote.
 */
export const CHAPTER_STABILITY_DAYS = 7;

/**
 * Minimum mention_count for a context_memory entity to be considered
 * for injection into a reflection prompt. Entities below this are noise.
 */
export const CONTEXT_MEMORY_MIN_MENTIONS = 3;

/**
 * Maximum token budget for the context block injected into Groq prompts.
 * Estimated at 1 token ≈ 4 chars. Keeps reflection costs bounded.
 */
export const CONTEXT_MEMORY_MAX_TOKENS = 500;

// ─── DB Row Types (snake_case — never exposed to UI) ──────

/** Raw DB row for life_chapters — never returned to UI, always mapped. */
export interface LifeChapterRow {
  id: string;
  user_id: string;
  name: string | null;
  summary: string | null;
  chapter_start: string;     // "YYYY-MM-DD"
  chapter_end: string | null; // "YYYY-MM-DD"
  status: string;
  theme_tags: string[];
  entry_count: number;
  last_change_at: string;    // ISO 8601
  signals: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Raw DB row for chapter_entries join table. */
export interface ChapterEntryRow {
  id: string;
  chapter_id: string;
  entry_id: string;
  joined_at: string;
}

/** Raw DB row for context_memory. */
export interface ContextMemoryRow {
  id: string;
  user_id: string;
  entity_type: string;
  entity_value: string;
  mention_count: number;
  last_seen_date: string;    // "YYYY-MM-DD"
  emotional_tags: string[];
  importance_score: number | null;
  created_at: string;
  updated_at: string;
}

/** Raw DB row for memory_extractions. */
export interface MemoryExtractionRow {
  id: string;
  user_id: string;
  entry_id: string;
  extracted_at: string;
  prompt_version: string;
  extraction_version: string;
}

// ─── Domain Types (camelCase — returned by service layer) ─

/**
 * A life chapter — a meaningful, LLM-named collection of journal entries
 * representing a distinct episode of a person's life.
 *
 * name and summary are null while status = 'forming' (not yet promoted).
 * entryCount and lastChangeAt are maintained by extract-memory.
 * signals is an audit record of which candidate signals fired; unused by UI.
 */
export interface LifeChapter {
  readonly id: string;
  readonly userId: string;
  name: string | null;
  summary: string | null;
  readonly chapterStart: string;  // "YYYY-MM-DD"
  chapterEnd: string | null;      // "YYYY-MM-DD"
  status: ChapterStatus;
  themeTags: string[];
  entryCount: number;
  lastChangeAt: string;           // ISO 8601
  signals: Record<string, unknown> | null;
  readonly createdAt: string;
  updatedAt: string;
}

/**
 * A single entry linked to a life chapter.
 */
export interface ChapterEntry {
  readonly id: string;
  readonly chapterId: string;
  readonly entryId: string;
  readonly joinedAt: string;
}

/**
 * A recurring entity tracked in context memory.
 *
 * importanceScore is null for all M3-generated rows.
 * It is reserved for future retrieval ranking (M4+) and will allow
 * the system to prefer meaningful memories over merely frequent ones
 * without requiring a schema migration.
 */
export interface ContextMemory {
  readonly id: string;
  readonly userId: string;
  entityType: ContextEntityType;
  entityValue: string;
  mentionCount: number;
  lastSeenDate: string;    // "YYYY-MM-DD"
  emotionalTags: string[];
  importanceScore: number | null;  // null in M3; reserved for M4+ ranking
  readonly createdAt: string;
  updatedAt: string;
}

/**
 * Record that a given entry has been fully processed by extract-memory.
 * If absent for an entry_id, extraction has not completed (will be retried).
 * Delete this row to force re-extraction.
 *
 * Two independent version fields:
 *
 *   promptVersion    — mirrors AI_CONFIG.promptVersion from ReflectionPayload._meta.version
 *                      (the reflection prompt version at extraction time). Answers:
 *                      "which reflection generated this extraction?"
 *
 *   extractionVersion — the EXTRACTION_VERSION constant from the extract-memory Edge Function.
 *                      Bump this when the extraction pipeline itself changes (new entity types,
 *                      changed candidate signals, different chapter thresholds). Answers:
 *                      "which extraction logic version was used?"
 *                      Delete rows with an old extractionVersion to force re-extraction.
 */
export interface MemoryExtraction {
  readonly id: string;
  readonly userId: string;
  readonly entryId: string;
  readonly extractedAt: string;
  readonly promptVersion: string;
  readonly extractionVersion: string;
}

/**
 * Compact context block built from active chapters + relevant context memory.
 * Passed to the Groq prompt injection step in generate-reflection.
 * tokenEstimate uses the 1 token ≈ 4 chars heuristic.
 */
export interface ContextBlock {
  contextText: string;
  chapterCount: number;
  entityCount: number;
  tokenEstimate: number;
  isEmpty: boolean;
}

// ─── Mappers ───────────────────────────────────────────────

export function lifeChapterFromRow(row: LifeChapterRow): LifeChapter {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    summary: row.summary,
    chapterStart: row.chapter_start,
    chapterEnd: row.chapter_end,
    status: row.status as ChapterStatus,
    themeTags: row.theme_tags ?? [],
    entryCount: row.entry_count,
    lastChangeAt: row.last_change_at,
    signals: row.signals,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function chapterEntryFromRow(row: ChapterEntryRow): ChapterEntry {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    entryId: row.entry_id,
    joinedAt: row.joined_at,
  };
}

export function contextMemoryFromRow(row: ContextMemoryRow): ContextMemory {
  return {
    id: row.id,
    userId: row.user_id,
    entityType: row.entity_type as ContextEntityType,
    entityValue: row.entity_value,
    mentionCount: row.mention_count,
    lastSeenDate: row.last_seen_date,
    emotionalTags: row.emotional_tags ?? [],
    importanceScore: row.importance_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function memoryExtractionFromRow(row: MemoryExtractionRow): MemoryExtraction {
  return {
    id: row.id,
    userId: row.user_id,
    entryId: row.entry_id,
    extractedAt: row.extracted_at,
    promptVersion: row.prompt_version,
    extractionVersion: row.extraction_version,
  };
}
