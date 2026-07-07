/**
 * Memory Service — read-only queries for life chapters and context memory.
 *
 * All writes to memory tables happen exclusively via service_role in the
 * extract-memory Edge Function. This service only reads results for the
 * client-side React Query layer.
 *
 * The `getActiveChapterSummaries` method builds a ContextBlock for use by
 * the generate-reflection Edge Function's context injection step. In M3 it
 * is exposed here for testability; the Edge Function mirrors the query logic
 * directly in Deno (cannot import from src/).
 */

import { supabase } from './supabaseClient';
import { ServiceError } from './errors';
import type {
  LifeChapter,
  ChapterEntry,
  ContextMemory,
  MemoryExtraction,
  ChapterStatus,
  ContextEntityType,
  ContextBlock,
} from '../entities/memory';
import {
  lifeChapterFromRow,
  chapterEntryFromRow,
  contextMemoryFromRow,
  memoryExtractionFromRow,
  CONTEXT_MEMORY_MIN_MENTIONS,
  CONTEXT_MEMORY_MAX_TOKENS,
} from '../entities/memory';
import type {
  LifeChapterRow,
  ChapterEntryRow,
  ContextMemoryRow,
  MemoryExtractionRow,
} from '../entities/memory';

export const memoryService = {
  /**
   * Fetch all life chapters for a user, optionally filtered by status.
   * Ordered by chapter_start DESC (most recent episode first).
   * Returns fully-mapped LifeChapter objects — never raw DB rows.
   */
  async getLifeChapters(userId: string, status?: ChapterStatus): Promise<LifeChapter[]> {
    let query = supabase
      .from('life_chapters')
      .select(
        'id, user_id, name, summary, chapter_start, chapter_end, status, theme_tags, entry_count, last_change_at, signals, created_at, updated_at',
      )
      .eq('user_id', userId)
      .order('chapter_start', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: LifeChapterRow) => lifeChapterFromRow(r));
  },

  /**
   * Fetch all entries linked to a specific life chapter.
   * Ordered by joined_at ASC (chronological order of discovery).
   */
  async getChapterEntries(chapterId: string): Promise<ChapterEntry[]> {
    const { data, error } = await supabase
      .from('chapter_entries')
      .select('id, chapter_id, entry_id, joined_at')
      .eq('chapter_id', chapterId)
      .order('joined_at', { ascending: true });

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: ChapterEntryRow) => chapterEntryFromRow(r));
  },

  /**
   * Fetch context memory for a user, optionally filtered by entity type.
   * Only returns entities that have met the minimum mention threshold.
   * Ordered by last_seen_date DESC (most recently encountered first).
   *
   * In M3, importance_score is always null. Future milestones may populate
   * it for retrieval ranking — the query returns it as-is.
   */
  async getContextMemory(userId: string, entityType?: ContextEntityType): Promise<ContextMemory[]> {
    let query = supabase
      .from('context_memory')
      .select(
        'id, user_id, entity_type, entity_value, mention_count, last_seen_date, emotional_tags, importance_score, created_at, updated_at',
      )
      .eq('user_id', userId)
      .gte('mention_count', CONTEXT_MEMORY_MIN_MENTIONS)
      .order('last_seen_date', { ascending: false });

    if (entityType) {
      query = query.eq('entity_type', entityType);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: ContextMemoryRow) => contextMemoryFromRow(r));
  },

  /**
   * Fetch memory extraction records for a user.
   * Primarily used for debugging and backfill detection.
   */
  async getMemoryExtractions(userId: string): Promise<MemoryExtraction[]> {
    const { data, error } = await supabase
      .from('memory_extractions')
      .select('id, user_id, entry_id, extracted_at, prompt_version, extraction_version')
      .eq('user_id', userId)
      .order('extracted_at', { ascending: false });

    if (error) throw new ServiceError(error.message, error.code ?? 'DB_ERROR');

    return (data ?? []).map((r: MemoryExtractionRow) => memoryExtractionFromRow(r));
  },

  /**
   * Build a compact ContextBlock from active chapters and relevant context memory.
   *
   * This is the client-side mirror of the context injection logic in the
   * generate-reflection Edge Function. It is exposed here for:
   *   1. Testing the token estimation and relevance logic independently
   *   2. Future use in a "preview context" debug UI (M4+)
   *
   * The actual prompt injection happens in the Edge Function (Deno), which
   * mirrors this logic. Changes here should be kept in sync.
   *
   * Relevance scoring (M3 implementation — extension point for M4+):
   *   - Entities: relevance = presence in provided currentThemes array
   *   - Chapters: relevance = count of theme_tags overlapping with currentThemes
   *   - Token budget: CONTEXT_MEMORY_MAX_TOKENS (500 tokens ≈ 2000 chars)
   *
   * @param userId        The user whose memory to retrieve.
   * @param currentThemes Themes from the current entry's ReflectionPayload.themes.
   */
  async getActiveChapterSummaries(userId: string, currentThemes: string[] = []): Promise<ContextBlock> {
    const themesLower = currentThemes.map((t) => t.toLowerCase());

    // Fetch all qualifying context memory
    const allMemory = await memoryService.getContextMemory(userId);

    // Score each entity by relevance to current themes
    // +2 if entity_value appears in current themes, +1 if emotional_tags overlap
    const scoredMemory = allMemory
      .map((entity) => {
        let score = 0;
        if (themesLower.some((t) => entity.entityValue.toLowerCase().includes(t) || t.includes(entity.entityValue.toLowerCase()))) {
          score += 2;
        }
        if (entity.emotionalTags.some((tag) => themesLower.includes(tag.toLowerCase()))) {
          score += 1;
        }
        return { entity, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entity.mentionCount - a.entity.mentionCount);

    // Fetch active chapters, score by theme overlap
    const activeChapters = await memoryService.getLifeChapters(userId, 'active');
    const scoredChapters = activeChapters
      .map((chapter) => {
        const overlap = chapter.themeTags.filter((t) =>
          themesLower.includes(t.toLowerCase()),
        ).length;
        return { chapter, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap || new Date(b.chapter.lastChangeAt).getTime() - new Date(a.chapter.lastChangeAt).getTime());

    // Build context text within token budget (1 token ≈ 4 chars)
    const charBudget = CONTEXT_MEMORY_MAX_TOKENS * 4;
    const parts: string[] = [];
    let charCount = 0;

    // Group entities by type for readability
    const entityGroups = new Map<string, string[]>();
    for (const { entity } of scoredMemory) {
      const group = entityGroups.get(entity.entityType) ?? [];
      group.push(entity.entityValue);
      entityGroups.set(entity.entityType, group);
    }

    if (entityGroups.size > 0) {
      const entityParts: string[] = [];
      for (const [type, values] of entityGroups) {
        entityParts.push(`${type}s: ${values.join(', ')}`);
      }
      const entityText = `Relevant context: ${entityParts.join('; ')}.`;
      if (charCount + entityText.length <= charBudget) {
        parts.push(entityText);
        charCount += entityText.length;
      }
    }

    // Add top active chapter if it has enough theme overlap
    const topChapter = scoredChapters[0];
    if (topChapter && topChapter.chapter.name && topChapter.overlap > 0) {
      const chapterText = topChapter.chapter.summary
        ? `Active life chapter: "${topChapter.chapter.name}" — ${topChapter.chapter.summary}`
        : `Active life chapter: "${topChapter.chapter.name}"`;
      if (charCount + chapterText.length <= charBudget) {
        parts.push(chapterText);
        charCount += chapterText.length;
      }
    }

    const contextText = parts.join(' ');
    const tokenEstimate = Math.ceil(charCount / 4);

    return {
      contextText,
      chapterCount: scoredChapters.filter(({ overlap }) => overlap > 0).length,
      entityCount: scoredMemory.length,
      tokenEstimate,
      isEmpty: contextText.length === 0,
    };
  },
};
