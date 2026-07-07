// ============================================================
// extract-memory — Supabase Edge Function (Deno)
//
// POST { entryId: string; userId: string; backfill?: boolean }
// Authorization: Bearer <access_token>  (user JWT for ownership check)
//
// This function runs asynchronously after generate-reflection completes.
// The client does NOT await it. Errors are logged server-side only —
// no error ever propagates to affect the reflection response.
//
// Pipeline (single-entry mode):
//   1.  Validate JWT + assert ownership
//   2.  Idempotency check — skip if memory_extractions row exists
//   3.  Fetch saved ReflectionPayload from insights table
//   4.  Step 1: Entity extraction → upsert context_memory
//       - Always: themes from ReflectionPayload.themes (entity_type='topic')
//       - If Groq configured: lightweight Groq call for people/places/orgs/projects
//       - If Groq NOT configured: topics only; no regex fallback
//   5.  Step 2: Chapter candidate scoring (multi-signal)
//       - Signal (a): entity co-occurrence (person/place/project/org only)
//       - Signal (b): temporal proximity (prerequisite filter, 90 days)
//       - Signal (c): theme overlap
//       - Candidate passes if ≥2 of signals (a) and (c)
//       - Cluster ≥ CHAPTER_MIN_ENTRIES → create/update life_chapter
//   6.  Step 3: Structural stability check (forming → active promotion)
//       - entry_count ≥ CHAPTER_MIN_ENTRIES
//       - (now - last_change_at) ≥ CHAPTER_STABILITY_DAYS
//       - theme drift ≤ 50%
//       - If all pass AND Groq configured: generate name + summary, promote to active
//   7.  Step 4: Dormancy sweep — mark active chapters dormant if stale
//   8.  Final: INSERT memory_extractions (commit point)
//
// Backfill mode (backfill: true):
//   Processes all entries for the user that have a 'reflection' insight
//   but no memory_extractions row. Calls the single-entry pipeline for each.
//
// Constants (mirrored from src/entities/memory.ts — cannot import from src/):
//   CHAPTER_MIN_ENTRIES = 3
//   CHAPTER_DORMANCY_DAYS = 60
//   CHAPTER_CANDIDATE_WINDOW_DAYS = 90
//   CHAPTER_STABILITY_DAYS = 7
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Constants (mirrored from src/entities/memory.ts) ───────

const CHAPTER_MIN_ENTRIES = 3;
const CHAPTER_DORMANCY_DAYS = 60;
const CHAPTER_CANDIDATE_WINDOW_DAYS = 90;
const CHAPTER_STABILITY_DAYS = 7;

// ─── Types ───────────────────────────────────────────────────

interface ReflectionPayload {
  summary: string;
  emotions: Array<{ label: string; score: number }>;
  themes: string[];
  question: string;
  _meta: {
    version: string;
    provider: string;
    model: string;
    generatedAt: string;
    generationMs: number;
  };
}

interface EntryRecord {
  id: string;
  user_id: string;
  entry_date: string;
  content: string;
}

interface ChapterRecord {
  id: string;
  user_id: string;
  status: string;
  theme_tags: string[];
  entry_count: number;
  last_change_at: string;
  chapter_start: string;
  signals: Record<string, unknown> | null;
  name: string | null;
}

interface InsightRecord {
  id: string;
  entry_id: string;
  payload: Record<string, unknown>;
}

// ─── AES-GCM token decryption ────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function decryptToken(ciphertext: string, keyHex: string): Promise<string> {
  const raw = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const data = raw.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
  return new TextDecoder().decode(decrypted);
}

// ─── Type guard for ReflectionPayload ────────────────────────

function isReflectionPayload(v: unknown): v is ReflectionPayload {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.summary === 'string' &&
    Array.isArray(r.themes) &&
    typeof r._meta === 'object' && r._meta !== null &&
    typeof (r._meta as Record<string, unknown>).version === 'string'
  );
}

// ─── Date helpers ─────────────────────────────────────────────

function daysAgo(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Theme drift check ────────────────────────────────────────
// Returns the overlap ratio between two theme arrays.
// Used to detect if a forming chapter's identity has shifted (> 50% new themes).

function themeOverlapRatio(setA: string[], setB: string[]): number {
  if (setA.length === 0 && setB.length === 0) return 1;
  if (setA.length === 0 || setB.length === 0) return 0;
  const lower = (arr: string[]) => arr.map((t) => t.toLowerCase());
  const a = new Set(lower(setA));
  const b = new Set(lower(setB));
  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : overlap / union;
}

// ─── CORS helper ─────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Core extraction pipeline (single entry) ─────────────────

async function extractForEntry(
  svc: ReturnType<typeof createClient>,
  userId: string,
  entryId: string,
  groqToken: string | null,
): Promise<void> {
  // ── Fetch ReflectionPayload ───────────────────────────────
  const { data: insightData } = await svc
    .from('insights')
    .select('id, entry_id, payload')
    .eq('entry_id', entryId)
    .eq('user_id', userId)
    .eq('type', 'reflection')
    .maybeSingle() as { data: InsightRecord | null };

  if (!insightData || !isReflectionPayload(insightData.payload)) {
    console.info(`[extract-memory] No valid reflection for entry=${entryId} — skipping`);
    return;
  }

  const reflection = insightData.payload as ReflectionPayload;
  const promptVersion = reflection._meta.version;

  // ── Fetch entry record ────────────────────────────────────
  const { data: entryData } = await svc
    .from('entries')
    .select('id, user_id, entry_date, content')
    .eq('id', entryId)
    .single() as { data: EntryRecord | null };

  if (!entryData) {
    console.warn(`[extract-memory] Entry not found: entry=${entryId}`);
    return;
  }

  const entryDate = entryData.entry_date;
  const currentThemes = reflection.themes.map((t) => t.toLowerCase());

  // ── Step 1: Entity extraction ─────────────────────────────
  //
  // Always extract themes from ReflectionPayload (entity_type='topic').
  // If Groq is configured, also extract people/places/orgs/projects.
  // If Groq is NOT configured, topics only — no regex fallback.

  const topicEntities: Array<{ type: string; value: string }> = currentThemes.map((t) => ({
    type: 'topic',
    value: t,
  }));

  let namedEntities: Array<{ type: string; value: string }> = [];

  if (groqToken) {
    try {
      namedEntities = await extractNamedEntities(groqToken, entryData.content);
    } catch (err) {
      // Named entity extraction failure is non-fatal — proceed with topics only
      console.warn(`[extract-memory] Named entity extraction failed for entry=${entryId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  const allEntities = [...topicEntities, ...namedEntities];
  const dominantEmotions = reflection.emotions.slice(0, 3).map((e) => e.label.toLowerCase());

  // Upsert each entity into context_memory.
  // Read-then-write: SELECT existing row, then UPDATE (increment) or INSERT (new).
  // Append-only invariant: mention_count only increases, emotional_tags only grow.
  for (const entity of allEntities) {
    if (!entity.value || entity.value.trim().length === 0) continue;
    const normalizedValue = entity.value.toLowerCase().trim();

    const { data: existing } = await svc
      .from('context_memory')
      .select('id, mention_count, emotional_tags, last_seen_date')
      .eq('user_id', userId)
      .eq('entity_type', entity.type)
      .eq('entity_value', normalizedValue)
      .maybeSingle() as {
        data: { id: string; mention_count: number; emotional_tags: string[]; last_seen_date: string } | null;
      };

    if (existing) {
      // Merge emotional tags (deduplicate, preserve history)
      const mergedTags = Array.from(new Set([...(existing.emotional_tags ?? []), ...dominantEmotions]));
      // Keep the most recent date
      const mostRecentDate = entryDate > existing.last_seen_date ? entryDate : existing.last_seen_date;
      await svc
        .from('context_memory')
        .update({
          mention_count: existing.mention_count + 1,
          last_seen_date: mostRecentDate,
          emotional_tags: mergedTags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await svc.from('context_memory').insert({
        user_id: userId,
        entity_type: entity.type,
        entity_value: normalizedValue,
        mention_count: 1,
        last_seen_date: entryDate,
        emotional_tags: dominantEmotions,
        importance_score: null,  // reserved for M4+
      });
    }
  }

  // ── Step 2: Chapter candidate scoring (multi-signal) ─────
  //
  // Fetch recent reflections within CHAPTER_CANDIDATE_WINDOW_DAYS.
  // For each, compute signal overlap with current entry.
  // Signal (a): entity co-occurrence (non-topic entities only)
  // Signal (c): theme overlap
  // Candidate passes if ≥2 of signals (a) and (c) — temporal is prerequisite.

  const windowStart = addDays(entryDate, -CHAPTER_CANDIDATE_WINDOW_DAYS);

  // Fetch recent insights with their entry metadata
  const { data: recentInsights } = await svc
    .from('insights')
    .select('entry_id, payload')
    .eq('user_id', userId)
    .eq('type', 'reflection')
    .neq('entry_id', entryId)  // exclude current entry
    .gte('created_at', windowStart + 'T00:00:00Z') as { data: InsightRecord[] | null };

  // Fetch entry_dates for the recent insights
  const recentEntryIds = (recentInsights ?? [])
    .map((i) => i.entry_id)
    .filter(Boolean);

  const recentEntryDates: Record<string, string> = {};
  if (recentEntryIds.length > 0) {
    const { data: recentEntries } = await svc
      .from('entries')
      .select('id, entry_date')
      .in('id', recentEntryIds) as { data: Array<{ id: string; entry_date: string }> | null };
    for (const e of (recentEntries ?? [])) {
      recentEntryDates[e.id] = e.entry_date;
    }
  }

  // Fetch current entry's context_memory entities (non-topic, for signal a)
  const { data: currentEntryContextMemory } = await svc
    .from('context_memory')
    .select('entity_value, entity_type')
    .eq('user_id', userId)
    .in('entity_type', ['person', 'place', 'project', 'organization'])
    .gte('last_seen_date', windowStart) as { data: Array<{ entity_value: string; entity_type: string }> | null };

  const currentNonTopicEntities = new Set(
    (currentEntryContextMemory ?? []).map((e) => e.entity_value),
  );

  // Score each recent entry
  const candidateEntryIds: string[] = [];

  for (const insight of (recentInsights ?? [])) {
    if (!insight.entry_id || !isReflectionPayload(insight.payload)) continue;
    const otherEntryDate = recentEntryDates[insight.entry_id];
    if (!otherEntryDate) continue;

    // Temporal prerequisite: within window
    if (otherEntryDate < windowStart) continue;

    const otherThemes = (insight.payload.themes ?? []).map((t: string) => t.toLowerCase());

    // Signal (c): theme overlap
    const themeOverlap = otherThemes.some((t: string) => currentThemes.includes(t));

    // Signal (a): entity co-occurrence — check if other entry has shared non-topic entities
    // We approximate this by checking if any of the other entry's themes appear in current
    // non-topic context memory entities (entities extracted from current entry content)
    // A more precise implementation would cross-reference context_memory by entry.
    // For M3 this approximation is sufficient — M4 can add explicit entry→entity tracking.
    const entityOverlap = currentNonTopicEntities.size > 0 &&
      otherThemes.some((t: string) =>
        Array.from(currentNonTopicEntities).some((e) => e.includes(t) || t.includes(e)),
      );

    // Pass if ≥2 of the two signals (a) and (c)
    const signalCount = (themeOverlap ? 1 : 0) + (entityOverlap ? 1 : 0);
    if (signalCount >= 2) {
      candidateEntryIds.push(insight.entry_id);
    }
  }

  // Build candidate cluster: current entry + candidates
  const clusterEntryIds = [entryId, ...candidateEntryIds];

  if (clusterEntryIds.length >= CHAPTER_MIN_ENTRIES) {
    // Build signals audit object
    const signalsAudit = {
      entity_overlap: Array.from(currentNonTopicEntities),
      theme_overlap: currentThemes,
      entry_count: clusterEntryIds.length,
      candidate_entry_ids: candidateEntryIds,
    };

    // Check if any existing forming/active chapter covers >50% of these entries
    const { data: existingLinks } = await svc
      .from('chapter_entries')
      .select('chapter_id, entry_id')
      .in('entry_id', clusterEntryIds) as { data: Array<{ chapter_id: string; entry_id: string }> | null };

    // Count how many cluster entries each chapter already claims
    const chapterCoverage = new Map<string, number>();
    for (const link of (existingLinks ?? [])) {
      chapterCoverage.set(link.chapter_id, (chapterCoverage.get(link.chapter_id) ?? 0) + 1);
    }

    // Find the chapter with best coverage (>50% of cluster)
    let bestChapterId: string | null = null;
    let bestCoverage = 0;
    for (const [chapId, count] of chapterCoverage) {
      if (count > clusterEntryIds.length * 0.5 && count > bestCoverage) {
        bestChapterId = chapId;
        bestCoverage = count;
      }
    }

    if (!bestChapterId) {
      // No existing chapter covers this cluster — create a forming chapter
      const dedupedThemes = Array.from(new Set(currentThemes));

      const { data: newChapter } = await svc
        .from('life_chapters')
        .insert({
          user_id: userId,
          chapter_start: clusterEntryIds.length > 0
            ? (Object.values(recentEntryDates)[0] ?? entryDate)
            : entryDate,
          status: 'forming',
          theme_tags: dedupedThemes,
          entry_count: clusterEntryIds.length,
          last_change_at: new Date().toISOString(),
          signals: signalsAudit,
        })
        .select('id')
        .single() as { data: { id: string } | null };

      if (newChapter) {
        // Link all cluster entries to the new chapter
        const linkRows = clusterEntryIds.map((eid) => ({
          chapter_id: newChapter.id,
          entry_id: eid,
        }));
        await svc.from('chapter_entries').upsert(linkRows, { onConflict: 'chapter_id,entry_id', ignoreDuplicates: true });
      }
    } else {
      // Existing chapter — check its current status
      const { data: existingChapter } = await svc
        .from('life_chapters')
        .select('id, status, theme_tags, entry_count, last_change_at, signals, name')
        .eq('id', bestChapterId)
        .single() as { data: ChapterRecord | null };

      if (existingChapter) {
        // Link current entry if not already linked
        await svc
          .from('chapter_entries')
          .upsert(
            { chapter_id: bestChapterId, entry_id: entryId },
            { onConflict: 'chapter_id,entry_id', ignoreDuplicates: true },
          );

        const newEntryCount = (existingChapter.entry_count ?? 0) + 1;
        const mergedThemes = Array.from(
          new Set([...(existingChapter.theme_tags ?? []), ...currentThemes]),
        );
        const now = new Date().toISOString();

        if (existingChapter.status === 'forming') {
          // Update chapter metrics
          await svc
            .from('life_chapters')
            .update({
              entry_count: newEntryCount,
              theme_tags: mergedThemes,
              last_change_at: now,
              signals: signalsAudit,
              updated_at: now,
            })
            .eq('id', bestChapterId);

          // ── Step 3: Structural stability check ─────────────────
          // All three must pass to promote to active:
          //   1. entry_count ≥ CHAPTER_MIN_ENTRIES (already true)
          //   2. (now - last_change_at) ≥ CHAPTER_STABILITY_DAYS
          //   3. theme drift ≤ 50%
          const daysSinceChange = daysAgo(existingChapter.last_change_at);
          const originalThemes = (existingChapter.signals as Record<string, unknown>)?.theme_overlap as string[] ?? existingChapter.theme_tags;
          const driftRatio = themeOverlapRatio(originalThemes, mergedThemes);

          const isStable = daysSinceChange >= CHAPTER_STABILITY_DAYS;
          const isDriftOk = driftRatio >= 0.5;  // ≥50% theme overlap = acceptable drift

          if (isStable && isDriftOk && groqToken) {
            // All conditions met + Groq available → generate name + summary, promote
            try {
              const { name, summary } = await generateChapterNameAndSummary(
                groqToken,
                mergedThemes,
                newEntryCount,
                existingChapter.chapter_start,
              );
              await svc
                .from('life_chapters')
                .update({
                  status: 'active',
                  name,
                  summary,
                  updated_at: now,
                })
                .eq('id', bestChapterId);
              console.info(`[extract-memory] Chapter promoted to active: id=${bestChapterId} name="${name}"`);
            } catch (err) {
              console.warn(`[extract-memory] Chapter naming failed for id=${bestChapterId}:`, err instanceof Error ? err.message : String(err));
              // Promotion deferred — chapter stays forming until next extraction
            }
          } else if (isStable && isDriftOk && !groqToken) {
            // Structurally stable but Groq not available — promote with null name/summary
            // Name will be generated when Groq becomes available
            await svc
              .from('life_chapters')
              .update({
                status: 'active',
                name: null,
                summary: null,
                updated_at: now,
              })
              .eq('id', bestChapterId);
            console.info(`[extract-memory] Chapter promoted to active (unnamed, Groq unavailable): id=${bestChapterId}`);
          }
        } else if (existingChapter.status === 'active') {
          // Active chapter — just update entry count and theme tags
          await svc
            .from('life_chapters')
            .update({
              entry_count: newEntryCount,
              theme_tags: mergedThemes,
              last_change_at: now,
              updated_at: now,
            })
            .eq('id', bestChapterId);
        }
      }
    }
  }

  // ── Step 4: Dormancy sweep ────────────────────────────────
  // Mark active chapters dormant if last_change_at is older than CHAPTER_DORMANCY_DAYS.

  const { data: activeChapters } = await svc
    .from('life_chapters')
    .select('id, last_change_at')
    .eq('user_id', userId)
    .eq('status', 'active') as { data: Array<{ id: string; last_change_at: string }> | null };

  for (const chapter of (activeChapters ?? [])) {
    if (daysAgo(chapter.last_change_at) > CHAPTER_DORMANCY_DAYS) {
      const chapterEndDate = new Date(chapter.last_change_at).toISOString().slice(0, 10);
      await svc
        .from('life_chapters')
        .update({
          status: 'dormant',
          chapter_end: chapterEndDate,
          updated_at: new Date().toISOString(),
        })
        .eq('id', chapter.id);
      console.info(`[extract-memory] Chapter marked dormant: id=${chapter.id}`);
    }
  }

  // ── Final: Write extraction record (commit point) ─────────
  // This insert is the last operation. If anything above failed, no record
  // exists, and the next call will retry from scratch.
  await svc.from('memory_extractions').insert({
    user_id: userId,
    entry_id: entryId,
    extracted_at: new Date().toISOString(),
    prompt_version: promptVersion,
  });
}

// ─── Groq: Named entity extraction ───────────────────────────

interface NamedEntityResult {
  people?: string[];
  places?: string[];
  organizations?: string[];
  projects?: string[];
}

async function extractNamedEntities(
  groqToken: string,
  content: string,
): Promise<Array<{ type: string; value: string }>> {
  const systemPrompt = `You are an entity extractor. Extract named entities from journal text. Be conservative — only include entities that are clearly and explicitly mentioned. Do not infer or guess.`;

  const userPrompt = `Extract named entities from this journal entry excerpt. Return ONLY valid JSON in exactly this shape:
{
  "people": ["name1", "name2"],
  "places": ["place1"],
  "organizations": ["org1"],
  "projects": ["project1"]
}

Rules:
- Only include entities that are explicitly named (not pronouns, not vague references)
- Names should be normalized (lowercase, no punctuation)
- Empty arrays for categories with no entities
- Maximum 5 entities per category

Journal excerpt (first 800 characters):
"${content.slice(0, 800)}"`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,  // low temperature for factual extraction
      max_tokens: 300,
    }),
  });

  if (!groqRes.ok) {
    throw new Error(`Groq entity extraction failed: ${groqRes.status}`);
  }

  const groqBody = await groqRes.json() as Record<string, unknown>;
  const choices = groqBody?.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Groq entity extraction returned no choices');
  }

  const rawContent = ((choices[0]?.message as Record<string, unknown>)?.content) as string;
  if (typeof rawContent !== 'string') throw new Error('No content in Groq response');

  const parsed = JSON.parse(rawContent) as NamedEntityResult;

  const entities: Array<{ type: string; value: string }> = [];
  for (const name of (parsed.people ?? [])) {
    if (name?.trim()) entities.push({ type: 'person', value: name.trim().toLowerCase() });
  }
  for (const place of (parsed.places ?? [])) {
    if (place?.trim()) entities.push({ type: 'place', value: place.trim().toLowerCase() });
  }
  for (const org of (parsed.organizations ?? [])) {
    if (org?.trim()) entities.push({ type: 'organization', value: org.trim().toLowerCase() });
  }
  for (const project of (parsed.projects ?? [])) {
    if (project?.trim()) entities.push({ type: 'project', value: project.trim().toLowerCase() });
  }

  return entities;
}

// ─── Groq: Chapter name + summary generation ─────────────────

async function generateChapterNameAndSummary(
  groqToken: string,
  themes: string[],
  entryCount: number,
  chapterStart: string,
): Promise<{ name: string; summary: string }> {
  const systemPrompt = `You are a thoughtful assistant that names life chapters from a journal. Names should be evocative, personal, and specific — like chapter titles in a memoir. Avoid generic names.`;

  const userPrompt = `Name a life chapter in someone's journal based on these signals:
- Themes: ${themes.join(', ')}
- Number of journal entries: ${entryCount}
- Started around: ${chapterStart}

Return ONLY valid JSON in exactly this shape:
{
  "name": "Short evocative chapter name (2-5 words)",
  "summary": "One sentence describing what this period was about."
}

Rules:
- name: 2-5 words, evocative and personal, like a memoir chapter title
- summary: one sentence, present-tense description of the period
- Do not use the word "journey" or "chapter" in the name
- Do not include any text outside the JSON object`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 150,
    }),
  });

  if (!groqRes.ok) {
    throw new Error(`Groq chapter naming failed: ${groqRes.status}`);
  }

  const groqBody = await groqRes.json() as Record<string, unknown>;
  const choices = groqBody?.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Groq chapter naming returned no choices');
  }

  const rawContent = ((choices[0]?.message as Record<string, unknown>)?.content) as string;
  if (typeof rawContent !== 'string') throw new Error('No content in Groq chapter naming response');

  const parsed = JSON.parse(rawContent) as { name?: string; summary?: string };
  if (!parsed.name || !parsed.summary) {
    throw new Error('Groq chapter naming returned invalid shape');
  }

  return { name: parsed.name, summary: parsed.summary };
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const encryptionKey = Deno.env.get('APP_ENCRYPTION_KEY')!;

  // ── 1. Validate JWT ──────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401);
  }
  const token = authHeader.slice(7);

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  // ── 2. Parse body ────────────────────────────────────────
  let entryId: string;
  let backfill: boolean;
  try {
    const body = await req.json();
    entryId = body.entryId;
    backfill = body.backfill === true;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!entryId || typeof entryId !== 'string') {
    return json({ error: 'entryId is required' }, 400);
  }

  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 3. Assert ownership ──────────────────────────────────
  const { data: entryCheck } = await svc
    .from('entries')
    .select('user_id')
    .eq('id', entryId)
    .single() as { data: { user_id: string } | null };

  if (!entryCheck || entryCheck.user_id !== user.id) {
    return json({ error: 'Access denied' }, 403);
  }

  // ── 4. Fetch Groq token (if configured) ──────────────────
  let groqToken: string | null = null;
  try {
    const { data: settings } = await svc
      .from('user_settings')
      .select('groq_token_encrypted')
      .eq('user_id', user.id)
      .single() as { data: { groq_token_encrypted: string | null } | null };

    if (settings?.groq_token_encrypted && encryptionKey) {
      groqToken = await decryptToken(settings.groq_token_encrypted, encryptionKey);
    }
  } catch (err) {
    console.warn('[extract-memory] Could not load Groq token — proceeding without named entity extraction:', err instanceof Error ? err.message : String(err));
  }

  // ── 5. Backfill mode ─────────────────────────────────────
  if (backfill) {
    try {
      // Find all entries with a reflection but no extraction record
      const { data: allReflections } = await svc
        .from('insights')
        .select('entry_id')
        .eq('user_id', user.id)
        .eq('type', 'reflection')
        .not('entry_id', 'is', null) as { data: Array<{ entry_id: string }> | null };

      const { data: extractedEntries } = await svc
        .from('memory_extractions')
        .select('entry_id')
        .eq('user_id', user.id) as { data: Array<{ entry_id: string }> | null };

      const extractedSet = new Set((extractedEntries ?? []).map((e) => e.entry_id));
      const toProcess = (allReflections ?? [])
        .map((r) => r.entry_id)
        .filter((id) => id && !extractedSet.has(id));

      console.info(`[extract-memory] Backfill: ${toProcess.length} entries to process for user=${user.id}`);

      let processed = 0;
      let skipped = 0;
      for (const eid of toProcess) {
        try {
          await extractForEntry(svc, user.id, eid, groqToken);
          processed++;
        } catch (err) {
          console.error(`[extract-memory] Backfill failed for entry=${eid}:`, err instanceof Error ? err.message : String(err));
          skipped++;
        }
      }

      return json({ ok: true, backfill: true, processed, skipped });
    } catch (err) {
      console.error('[extract-memory] Backfill error:', err instanceof Error ? err.message : String(err));
      return json({ ok: false, error: 'Backfill failed', backfill: true }, 500);
    }
  }

  // ── 6. Idempotency check ─────────────────────────────────
  const { data: existing } = await svc
    .from('memory_extractions')
    .select('id')
    .eq('user_id', user.id)
    .eq('entry_id', entryId)
    .maybeSingle() as { data: { id: string } | null };

  if (existing) {
    return json({ ok: true, skipped: true });
  }

  // ── 7. Run extraction pipeline ───────────────────────────
  try {
    await extractForEntry(svc, user.id, entryId, groqToken);
    return json({ ok: true, skipped: false });
  } catch (err) {
    // Errors are logged server-side but never propagated to affect the caller.
    // The missing memory_extractions row means the next call will retry.
    console.error(`[extract-memory] Pipeline failed for entry=${entryId}:`, err instanceof Error ? err.message : String(err));
    return json({ ok: false, error: 'Extraction failed — will retry on next reflection' });
  }
});
