// ============================================================
// generate-reflection — Supabase Edge Function (Deno)
//
// POST { entryId: string }
// Authorization: Bearer <access_token>
//
// Flow:
//   1.  Validate JWT
//   2.  Parse + validate body
//   3.  Fetch entry (service role — bypasses RLS)
//   4.  Assert ownership
//   5.  Fetch user_settings (hf_token_encrypted, hf_model, groq_token_encrypted, groq_model)
//   6.  Guard: groq_token_encrypted IS NULL → return REFLECTION_NOT_CONFIGURED (422)
//   7.  Compute source_hash = sha256Hex(sourceEnvelope(content, promptVersion, groq_model))
//   8.  Cache check: if existing reflection insight has matching source_hash AND
//       passes isReflectionResult() → return cached result immediately.
//   9.  Decrypt HF token
//  10.  Call HF emotion model — returns 7 emotion scores
//  11.  Decrypt Groq token
//  12.  Call Groq LLM with emotion context + entry excerpt
//  13.  Parse + validate JSON response with isReflectionResult()
//  14.  Build full payload with _meta (provider: 'groq')
//  15.  Upsert { payload, source_hash, updated_at } ON CONFLICT (user_id, entry_id, type)
//  16.  Return { result, meta: { cached, generationMs } }
//
// Error codes returned to the client:
//   REFLECTION_NOT_CONFIGURED — Groq token not set (expected; client falls back silently)
//   HF_PROVIDER_ERROR         — HF model returned non-200
//   HF_SHAPE_ERROR            — HF returned 200 but unrecognised response shape
//   GROQ_PROVIDER_ERROR       — Groq API returned non-200
//   SHAPE_ERROR               — Groq returned unparseable or structurally invalid JSON
//
// Provider error bodies are NEVER forwarded to the client — logged server-side only.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Local AI_CONFIG mirror ───────────────────────────────────
//
// Mirrors src/entities/insight.ts AI_CONFIG.
// Keep all three in sync (client + analyze-sentiment + generate-reflection)
// when bumping promptVersion and redeploying.
//
const AI_CONFIG = {
  // M3 bump: context injection added — all reflections now include relevant memory when available.
  // This is an architectural event: reflections with context are meaningfully different from those without.
  // Existing cached reflections will be marked stale (isStale = true) and users invited to re-reflect.
  promptVersion: '3.0.0',
  defaultHFModel: 'j-hartmann/emotion-english-distilroberta-base',
  defaultGroqModel: 'llama-3.1-8b-instant',
} as const;

// Maximum tokens for context memory injection into Groq prompts.
// 1 token ≈ 4 chars. Keep in sync with src/entities/memory.ts CONTEXT_MEMORY_MAX_TOKENS.
const CONTEXT_MEMORY_MAX_TOKENS = 500;
const CONTEXT_MEMORY_MIN_MENTIONS = 3;

// ─── Types ───────────────────────────────────────────────────

interface HFEmotionScore {
  label: string;
  score: number;
}

interface ReflectionEmotion {
  label: string;
  score: number;
}

interface ReflectionResult {
  summary: string;
  emotions: ReflectionEmotion[];
  themes: string[];
  question: string;
}

interface InsightMeta {
  version: string;
  provider: string;
  model: string;
  generatedAt: string;
  generationMs: number;
}

// ─── SHA-256 + source envelope ───────────────────────────────
// Inlined — Deno cannot import from src/.
// Implementations must stay in sync with src/shared/utils/hash.ts.

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sourceEnvelope(
  content: string,
  promptVersion: string,
  model: string,
  contextHash?: string,
): string {
  // Field order is fixed — do not reorder or existing hashes become invalid.
  // contextHash is included when context memory is injected.
  // A changed context will cause source_hash mismatch → reflection marked stale → user invited to re-reflect.
  if (contextHash) {
    return JSON.stringify({ content, promptVersion, model, contextHash });
  }
  return JSON.stringify({ content, promptVersion, model });
}

// ─── AES-GCM token decryption ────────────────────────────────
// Inlined — identical to analyze-sentiment/index.ts. Keep in sync.

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function decryptToken(ciphertext: string, keyHex: string): Promise<string> {
  // Format: base64(iv[12 bytes] + encrypted)
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

// ─── HF response mapping ─────────────────────────────────────
// Inlined — identical logic to analyze-sentiment/index.ts.
// Returns raw 7-score map for use in the Groq prompt.

function mapHFToEmotionScores(emotions: HFEmotionScore[]): Record<string, number> {
  const byLabel: Record<string, number> = {};
  for (const e of emotions) {
    if (typeof e.label !== 'string' || typeof e.score !== 'number') {
      throw new Error(`Unexpected HF emotion item shape: ${JSON.stringify(e).slice(0, 100)}`);
    }
    byLabel[e.label.toLowerCase()] = e.score;
  }
  return byLabel;
}

// ─── Reflection result type guard ────────────────────────────

function isReflectionResult(v: unknown): v is ReflectionResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.summary === 'string' && r.summary.trim().length > 0 &&
    Array.isArray(r.emotions) &&
    r.emotions.length > 0 &&
    (r.emotions as unknown[]).every(
      (e) =>
        typeof (e as Record<string, unknown>).label === 'string' &&
        typeof (e as Record<string, unknown>).score === 'number',
    ) &&
    Array.isArray(r.themes) &&
    typeof r.question === 'string' && r.question.trim().length > 0
  );
}

// ─── Context memory retrieval ─────────────────────────────────
//
// Queries context_memory and life_chapters for the user, scores each by
// relevance to the current entry's themes, and builds a compact context block.
//
// This is the retrieval extension point: the scoring logic here can be upgraded
// in future milestones without changing the prompt construction or DB schema.
//
// Returns { contextText, contextHash } where contextHash is a SHA-256 of the
// context text — used in sourceEnvelope so the source_hash changes when memory changes.

interface ContextResult {
  contextText: string;
  contextHash: string | undefined;
  isEmpty: boolean;
}

async function getRelevantContext(
  svc: ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>,
  userId: string,
  currentThemes: string[],
): Promise<ContextResult> {
  const themesLower = currentThemes.map((t) => t.toLowerCase());
  const charBudget = CONTEXT_MEMORY_MAX_TOKENS * 4; // 1 token ≈ 4 chars

  // Fetch all qualifying context memory (above minimum mentions threshold)
  const { data: allMemory } = await svc
    .from('context_memory')
    .select('entity_type, entity_value, mention_count, emotional_tags')
    .eq('user_id', userId)
    .gte('mention_count', CONTEXT_MEMORY_MIN_MENTIONS) as {
      data: Array<{ entity_type: string; entity_value: string; mention_count: number; emotional_tags: string[] }> | null;
    };

  // Score each entity by relevance to current themes (not recency or frequency)
  // +2 if entity_value semantically overlaps with themes
  // +1 if emotional_tags overlap with themes
  const scoredMemory = (allMemory ?? [])
    .map((entity) => {
      let score = 0;
      if (themesLower.some(
        (t) => entity.entity_value.includes(t) || t.includes(entity.entity_value),
      )) {
        score += 2;
      }
      if ((entity.emotional_tags ?? []).some((tag) => themesLower.includes(tag.toLowerCase()))) {
        score += 1;
      }
      return { entity, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entity.mention_count - a.entity.mention_count);

  // Fetch active chapters, score by theme tag overlap
  const { data: activeChapters } = await svc
    .from('life_chapters')
    .select('name, summary, theme_tags, last_change_at')
    .eq('user_id', userId)
    .eq('status', 'active') as {
      data: Array<{ name: string | null; summary: string | null; theme_tags: string[]; last_change_at: string }> | null;
    };

  const scoredChapters = (activeChapters ?? [])
    .filter((c) => c.name) // only named chapters
    .map((chapter) => {
      const overlap = (chapter.theme_tags ?? []).filter(
        (t) => themesLower.includes(t.toLowerCase()),
      ).length;
      return { chapter, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap);

  // Build context text within token budget
  const parts: string[] = [];
  let charCount = 0;

  // Group entities by type for readability
  const entityGroups = new Map<string, string[]>();
  for (const { entity } of scoredMemory) {
    if (entity.entity_type === 'topic') continue; // topics are already in the prompt via themes
    const group = entityGroups.get(entity.entity_type) ?? [];
    group.push(entity.entity_value);
    entityGroups.set(entity.entity_type, group);
  }

  // Include topic entities separately for completeness
  const topicEntities = scoredMemory
    .filter(({ entity }) => entity.entity_type === 'topic')
    .map(({ entity }) => entity.entity_value);

  if (entityGroups.size > 0 || topicEntities.length > 0) {
    const entityParts: string[] = [];
    for (const [type, values] of entityGroups) {
      entityParts.push(`${type}s: ${values.slice(0, 5).join(', ')}`);
    }
    if (topicEntities.length > 0) {
      entityParts.push(`recurring topics: ${topicEntities.slice(0, 5).join(', ')}`);
    }
    const entityText = `Relevant context about this person: ${entityParts.join('; ')}.`;
    if (charCount + entityText.length <= charBudget) {
      parts.push(entityText);
      charCount += entityText.length;
    }
  }

  // Add top active chapter if it has theme overlap
  const topChapter = scoredChapters[0];
  if (topChapter && topChapter.overlap > 0 && topChapter.chapter.name) {
    const chapterText = topChapter.chapter.summary
      ? `They are currently in a life chapter called "${topChapter.chapter.name}": ${topChapter.chapter.summary}`
      : `They are currently in a life chapter called "${topChapter.chapter.name}".`;
    if (charCount + chapterText.length <= charBudget) {
      parts.push(chapterText);
      charCount += chapterText.length;
    }
  }

  const contextText = parts.join(' ');
  if (!contextText) {
    return { contextText: '', contextHash: undefined, isEmpty: true };
  }

  // Compute a hash of the context for source_hash inclusion
  const contextHash = await sha256Hex(contextText);
  return { contextText, contextHash, isEmpty: false };
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
  try {
    const body = await req.json();
    entryId = body.entryId;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!entryId || typeof entryId !== 'string') {
    return json({ error: 'entryId is required' }, 400);
  }

  // Service-role client for all DB operations
  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 3. Fetch entry ───────────────────────────────────────
  const { data: entry, error: entryError } = await svc
    .from('entries')
    .select('id, user_id, content')
    .eq('id', entryId)
    .single();

  if (entryError || !entry) {
    return json({ error: 'Entry not found' }, 404);
  }

  // ── 4. Assert ownership ──────────────────────────────────
  if (entry.user_id !== user.id) {
    return json({ error: 'Access denied' }, 403);
  }

  // ── 5. Fetch user_settings ───────────────────────────────
  const { data: settings, error: settingsError } = await svc
    .from('user_settings')
    .select('hf_token_encrypted, hf_model, groq_token_encrypted, groq_model')
    .eq('user_id', user.id)
    .single();

  if (settingsError || !settings) {
    return json({ error: 'User settings not found. Please visit Settings.' }, 422);
  }

  if (!settings.hf_token_encrypted) {
    return json(
      { error: 'No emotion analysis token configured. Add it in Settings.', code: 'HF_NOT_CONFIGURED' },
      422,
    );
  }

  // ── 6. Guard: Groq not configured ───────────────────────
  // This is an expected condition — the client silently falls back to
  // analyze-sentiment when it receives this code. Not an error.
  if (!settings.groq_token_encrypted) {
    return json(
      { error: 'Reflection not configured. Add a Groq API key in Settings.', code: 'REFLECTION_NOT_CONFIGURED' },
      422,
    );
  }

  const hfModel = settings.hf_model ?? AI_CONFIG.defaultHFModel;
  const groqModel = settings.groq_model ?? AI_CONFIG.defaultGroqModel;

  // ── 7. Fetch relevant context memory (M3: context injection) ──
  // Retrieve relevant context before computing source_hash so the hash
  // reflects the context that will be injected into the prompt.
  // Gracefully returns isEmpty=true if no memory exists yet (zero regression).
  let contextResult: ContextResult = { contextText: '', contextHash: undefined, isEmpty: true };
  try {
    // We don't have themes yet (HF runs later), so we pass empty themes here.
    // The context injection uses entity-level relevance scoring, which works
    // with an empty theme array by relying solely on entity mention counts.
    // After HF runs and themes are known, the context is scored more precisely
    // in future milestones. For M3, this is a best-effort retrieval.
    contextResult = await getRelevantContext(svc, user.id, []);
  } catch (ctxErr) {
    // Context retrieval failure is non-fatal — proceed without context injection.
    console.warn('[generate-reflection] Context retrieval failed (non-fatal):', ctxErr instanceof Error ? ctxErr.message : String(ctxErr));
  }

  // ── 8. Compute source_hash ───────────────────────────────
  // Uses groq_model (not hf_model) — the reflection output depends on the LLM.
  // contextHash is included when context was retrieved — a changed memory
  // will invalidate the cache and invite the user to re-reflect.
  const sourceHash = await sha256Hex(
    sourceEnvelope(entry.content, AI_CONFIG.promptVersion, groqModel, contextResult.contextHash),
  );

  // ── 9. Cache check ───────────────────────────────────────
  const { data: existing } = await svc
    .from('insights')
    .select('payload, source_hash')
    .eq('entry_id', entryId)
    .eq('type', 'reflection')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing && existing.source_hash === sourceHash) {
    const payload = existing.payload as unknown;
    if (isReflectionResult(payload)) {
      const cached: ReflectionResult = {
        summary: (payload as ReflectionResult).summary,
        emotions: (payload as ReflectionResult).emotions,
        themes: (payload as ReflectionResult).themes,
        question: (payload as ReflectionResult).question,
      };
      return json({ result: cached, meta: { cached: true, generationMs: 0 } });
    }
    console.warn(
      `[generate-reflection] CACHE_INVALID entry=${entryId} — stored payload failed isReflectionResult(); regenerating`,
    );
  }

  // ── 9. Decrypt HF token ──────────────────────────────────
  let hfToken: string;
  try {
    hfToken = await decryptToken(settings.hf_token_encrypted, encryptionKey);
  } catch (err) {
    console.error('[generate-reflection] HF token decryption failed:', err);
    return json({ error: 'Failed to decrypt emotion analysis token. Please re-save it in Settings.' }, 500);
  }

  // ── 10. Call HF emotion model ────────────────────────────
  const hfStartMs = Date.now();

  const hfRes = await fetch(
    `https://router.huggingface.co/hf-inference/models/${hfModel}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: entry.content.slice(0, 512) }),
    },
  );

  if (!hfRes.ok) {
    const errBody = await hfRes.text().catch(() => '');
    // Log full error server-side — never forward provider bodies to the client.
    console.error(`[generate-reflection] HF error ${hfRes.status} for entry=${entryId}: ${errBody.slice(0, 300)}`);

    if (hfRes.status === 503) {
      return json(
        { error: 'Emotion model is loading, try again in a moment.', code: 'HF_MODEL_LOADING' },
        503,
      );
    }
    return json(
      { error: 'Emotion analysis failed. Please try again.', code: 'HF_PROVIDER_ERROR' },
      502,
    );
  }

  let hfRawData: unknown;
  try {
    hfRawData = await hfRes.json();
  } catch {
    return json({ error: 'Unexpected emotion model response.', code: 'HF_SHAPE_ERROR' }, 502);
  }

  let emotions: HFEmotionScore[];
  if (!Array.isArray(hfRawData) || hfRawData.length === 0) {
    console.error(`[generate-reflection] HF SHAPE_ERROR — expected non-empty array for entry=${entryId}`);
    return json({ error: 'Unexpected emotion model response shape.', code: 'HF_SHAPE_ERROR' }, 502);
  }

  if (Array.isArray(hfRawData[0])) {
    // Nested HFEmotionScore[][] — take first element
    emotions = hfRawData[0] as HFEmotionScore[];
  } else {
    // Flat HFEmotionScore[]
    emotions = hfRawData as HFEmotionScore[];
  }

  let emotionScores: Record<string, number>;
  try {
    emotionScores = mapHFToEmotionScores(emotions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-reflection] HF item validation failed for entry=${entryId}: ${msg}`);
    return json({ error: 'Unexpected emotion model response.', code: 'HF_SHAPE_ERROR' }, 502);
  }

  // ── 12. Decrypt Groq token ───────────────────────────────
  let groqToken: string;
  try {
    groqToken = await decryptToken(settings.groq_token_encrypted, encryptionKey);
  } catch (err) {
    console.error('[generate-reflection] Groq token decryption failed:', err);
    return json({ error: 'Failed to decrypt reflection token. Please re-save it in Settings.' }, 500);
  }

  // ── 13. Call Groq LLM ────────────────────────────────────
  //
  // Groq endpoint is hardcoded — no configurable base URL.
  // response_format: { type: "json_object" } enforces structured JSON output.
  const groqStartMs = Date.now();

  const emotionLine = Object.entries(emotionScores)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(', ');

  // Build system prompt — inject context block if available.
  // Context section uses "Context about this person:" as the named section header.
  // If no context exists, the prompt is identical to the pre-M3 version (zero regression).
  const contextSection = contextResult.isEmpty
    ? ''
    : `\n\nContext about this person:\n${contextResult.contextText}`;

  const systemPrompt = `You are a thoughtful journaling companion speaking directly to the person who wrote this entry. Use "you" and "your" — never refer to them as "the writer" or in third person. Be honest, warm, and specific to what they wrote. Never be prescriptive or preachy.${contextSection}`;

  const userPrompt = `Given the journal entry excerpt and its emotional composition, write a short reflection (2–3 sentences) addressed directly to the person — use "you", not "the writer". Reveal something they may not have explicitly noticed. End with exactly one open-ended follow-up question, also addressed to them directly.

Emotional composition:
${emotionLine}

Journal excerpt (first 600 characters):
"${entry.content.slice(0, 600)}"

Respond ONLY with valid JSON in exactly this shape:
{
  "summary": "2–3 sentence reflection addressed to the person as 'you'.",
  "emotions": [
    { "label": "Joy", "score": 0.42 },
    { "label": "Neutral", "score": 0.30 },
    { "label": "Sadness", "score": 0.11 },
    { "label": "Fear", "score": 0.06 }
  ],
  "themes": ["Work", "Family"],
  "question": "One open-ended question addressed directly to the person?"
}

Rules:
- summary: address the person as "you". Never say "the writer" or "they".
- question: address the person as "you". Never say "the writer" or "they".
- emotions: list the top 4 by score, human-readable capitalised labels.
- themes: 1–3 one-word or short-phrase topics.
- summary and question must be non-empty strings.
- Do not include any text outside the JSON object.`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: groqModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });

  const generationMs = Date.now() - hfStartMs;

  if (!groqRes.ok) {
    const errBody = await groqRes.text().catch(() => '');
    // Log full error server-side — never forward Groq error bodies to the client.
    console.error(`[generate-reflection] Groq error ${groqRes.status} for entry=${entryId}: ${errBody.slice(0, 300)}`);
    return json(
      { error: 'Reflection generation failed. Please try again.', code: 'GROQ_PROVIDER_ERROR' },
      502,
    );
  }

  // ── 13. Parse + validate Groq response ──────────────────
  let groqBody: unknown;
  try {
    groqBody = await groqRes.json();
  } catch {
    return json({ error: 'Failed to parse reflection response.', code: 'SHAPE_ERROR' }, 502);
  }

  const groqContent = (groqBody as Record<string, unknown>)?.choices;
  if (!Array.isArray(groqContent) || groqContent.length === 0) {
    console.error(`[generate-reflection] Groq SHAPE_ERROR — no choices for entry=${entryId}`);
    return json({ error: 'Unexpected reflection response shape.', code: 'SHAPE_ERROR' }, 502);
  }

  const messageContent = (groqContent[0] as Record<string, unknown>)?.message;
  const rawContent = (messageContent as Record<string, unknown>)?.content;

  if (typeof rawContent !== 'string') {
    console.error(`[generate-reflection] Groq SHAPE_ERROR — no content string for entry=${entryId}`);
    return json({ error: 'Unexpected reflection response shape.', code: 'SHAPE_ERROR' }, 502);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error(`[generate-reflection] JSON parse failed for entry=${entryId}: ${rawContent.slice(0, 200)}`);
    return json({ error: 'Failed to parse reflection JSON.', code: 'SHAPE_ERROR' }, 502);
  }

  if (!isReflectionResult(parsed)) {
    console.error(`[generate-reflection] Validation failed for entry=${entryId}: ${JSON.stringify(parsed).slice(0, 300)}`);
    return json({ error: 'Reflection result failed validation. Please try again.', code: 'SHAPE_ERROR' }, 502);
  }

  const reflectionResult = parsed;

  // ── 14. Build full payload with _meta ────────────────────
  const meta: InsightMeta = {
    version: AI_CONFIG.promptVersion,
    provider: 'groq',
    model: groqModel,
    generatedAt: new Date().toISOString(),
    generationMs,
  };

  const fullPayload = { ...reflectionResult, _meta: meta };

  // ── 16. Upsert insight ───────────────────────────────────
  //
  // updated_at is explicitly set to now() on both insert and conflict-update
  // so it always reflects when the row was last written.
  const { error: upsertError } = await svc.from('insights').upsert(
    {
      user_id: user.id,
      entry_id: entryId,
      type: 'reflection',
      payload: fullPayload,
      source_hash: sourceHash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,entry_id,type' },
  );

  if (upsertError) {
    console.error('[generate-reflection] Failed to upsert insight:', upsertError.message);
    return json({ error: 'Failed to save reflection' }, 500);
  }

  // ── 17. Fire extract-memory asynchronously (non-blocking) ──
  // Do NOT await. Do NOT let failure affect the reflection response.
  // The extract-memory function has its own idempotency guard and error handling.
  try {
    const extractMemoryUrl = `${supabaseUrl}/functions/v1/extract-memory`;
    const authHeader = req.headers.get('Authorization') ?? '';
    // Fire-and-forget: no await, errors silently ignored
    fetch(extractMemoryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ entryId }),
    }).catch((err: unknown) => {
      console.warn('[generate-reflection] extract-memory fire-and-forget failed (non-fatal):', err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    // Synchronous errors in the setup (not the fetch itself) — also non-fatal
    console.warn('[generate-reflection] extract-memory dispatch failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // ── 18. Return result + observability metadata ───────────
  const groqMs = Date.now() - groqStartMs;
  return json({
    result: reflectionResult,
    meta: { cached: false, generationMs: groqMs },
  });
});
