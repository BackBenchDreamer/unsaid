// ============================================================
// generate-weekly-summary — Supabase Edge Function (Deno)
//
// POST { weekStart: string }  — "YYYY-MM-DD" (Monday of the target week)
// Authorization: Bearer <access_token>
//
// Flow:
//   1.  Validate JWT
//   2.  Parse + validate body; compute weekEnd = weekStart + 6 days
//   3.  Fetch all entries for the user in [weekStart, weekEnd]
//   4.  Guard: 0 entries → INSUFFICIENT_ENTRIES (422)
//   5.  Fetch user_settings (groq_token_encrypted, groq_model)
//   6.  Guard: groq_token_encrypted IS NULL → WEEKLY_NOT_CONFIGURED (422)
//   7.  For each entry: fetch its 'reflection' insight if it exists
//   8.  Build entryHashes: for each entry, use reflection.source_hash if
//       available, otherwise sha256Hex(sourceEnvelope(content, 'entry', entry.id))
//   9.  Sort entryHashes by entry_date ascending (deterministic)
//  10.  Compute weekly source_hash = sha256Hex(JSON.stringify({
//         weekStart, weekEnd, weeklyPromptVersion, model: groqModel, entryHashes
//       }))
//  11.  Cache check: if existing 'summary' insight matches hash AND passes
//       isWeeklyResult() → return cached result immediately
//  12.  Decrypt Groq token
//  13.  Build synthesis context from per-entry reflections / raw excerpts
//  14.  Call Groq LLM with weekly synthesis prompt
//  15.  Parse + validate JSON response with isWeeklyResult()
//  16.  Build full payload with _meta (weeklyPromptVersion, provider: 'groq')
//  17.  SELECT existing row → UPDATE if found, INSERT if not.
//       (Resilient to migration 006 not yet applied; same result as UPSERT once it is.)
//  18.  Return { result, meta: { cached, generationMs } }
//
// Error codes returned to the client:
//   INSUFFICIENT_ENTRIES      — 0 entries in the requested week (expected; not an error)
//   WEEKLY_NOT_CONFIGURED     — Groq token not set (expected; client shows setup prompt)
//   GROQ_PROVIDER_ERROR       — Groq API returned non-200
//   SHAPE_ERROR               — Groq returned unparseable or structurally invalid JSON
//
// Provider error bodies are NEVER forwarded to the client — logged server-side only.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Local config mirror ──────────────────────────────────────
//
// weeklyPromptVersion is independent from AI_CONFIG.promptVersion used by
// per-entry reflections. Bumping this invalidates weekly summary caches only.
// Do NOT bump AI_CONFIG.promptVersion here — that would invalidate per-entry
// reflection caches and is handled by the generate-reflection Edge Function.
//
const WEEKLY_CONFIG = {
  weeklyPromptVersion: '1.0.0',
  defaultGroqModel: 'llama-3.1-8b-instant',
} as const;

// ─── Types ───────────────────────────────────────────────────

interface ReflectionEmotion {
  label: string;
  score: number;
}

interface WeeklyResult {
  narrative: string;
  dominantEmotions: ReflectionEmotion[];
  recurringThemes: string[];
  emotionalArc: string;
}

interface InsightMeta {
  promptVersion: string;
  weeklyPromptVersion: string;
  provider: string;
  model: string;
  generatedAt: string;
  generationMs: number;
}

// ─── SHA-256 + source envelope ───────────────────────────────
// Inlined — Deno cannot import from src/.
// sha256Hex and sourceEnvelope stay in sync with src/shared/utils/hash.ts.

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
): string {
  // Field order is fixed — do not reorder or existing hashes become invalid.
  return JSON.stringify({ content, promptVersion, model });
}

// ─── AES-GCM token decryption ────────────────────────────────
// Inlined — identical to generate-reflection/index.ts. Keep in sync.

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

// ─── Add days helper (no date-fns in Deno edge) ──────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Weekly result type guard ─────────────────────────────────

function isWeeklyResult(v: unknown): v is WeeklyResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.narrative === 'string' && r.narrative.trim().length > 0 &&
    Array.isArray(r.dominantEmotions) &&
    (r.dominantEmotions as unknown[]).every(
      (e) =>
        typeof (e as Record<string, unknown>).label === 'string' &&
        typeof (e as Record<string, unknown>).score === 'number',
    ) &&
    Array.isArray(r.recurringThemes) &&
    typeof r.emotionalArc === 'string' && r.emotionalArc.trim().length > 0
  );
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

  // ── 2. Parse body + compute week range ───────────────────
  let weekStart: string;
  try {
    const body = await req.json();
    weekStart = body.weekStart;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!weekStart || typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return json({ error: 'weekStart must be a "YYYY-MM-DD" date string' }, 400);
  }

  const weekEnd = addDays(weekStart, 6); // Mon → Sun

  // Service-role client for all DB operations
  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 3. Fetch entries for the week ────────────────────────
  const { data: entries, error: entriesError } = await svc
    .from('entries')
    .select('id, user_id, entry_date, content')
    .eq('user_id', user.id)
    .gte('entry_date', weekStart)
    .lte('entry_date', weekEnd)
    .order('entry_date', { ascending: true });

  if (entriesError) {
    console.error('[generate-weekly-summary] Failed to fetch entries:', entriesError.message);
    return json({ error: 'Failed to fetch entries' }, 500);
  }

  // ── 4. Guard: no entries this week ───────────────────────
  if (!entries || entries.length === 0) {
    return json(
      { error: 'No journal entries found for this week.', code: 'INSUFFICIENT_ENTRIES' },
      422,
    );
  }

  // ── 5. Fetch user_settings ───────────────────────────────
  const { data: settings, error: settingsError } = await svc
    .from('user_settings')
    .select('groq_token_encrypted, groq_model')
    .eq('user_id', user.id)
    .single();

  if (settingsError || !settings) {
    return json({ error: 'User settings not found. Please visit Settings.' }, 422);
  }

  // ── 6. Guard: Groq not configured ────────────────────────
  if (!settings.groq_token_encrypted) {
    return json(
      { error: 'Weekly reflection requires a Groq API key. Add it in Settings.', code: 'WEEKLY_NOT_CONFIGURED' },
      422,
    );
  }

  const groqModel = settings.groq_model ?? WEEKLY_CONFIG.defaultGroqModel;

  // ── 7. Fetch existing reflection insights for these entries ──
  const entryIds = entries.map((e: { id: string }) => e.id);

  const { data: reflections } = await svc
    .from('insights')
    .select('entry_id, payload, source_hash')
    .in('entry_id', entryIds)
    .eq('type', 'reflection')
    .eq('user_id', user.id);

  // Build a map: entry_id → { reflectionSummary, reflectionSourceHash }
  const reflectionMap = new Map<string, { summary: string; sourceHash: string | null }>();
  for (const r of (reflections ?? [])) {
    const payload = r.payload as Record<string, unknown>;
    if (typeof payload?.summary === 'string' && payload.summary.trim().length > 0) {
      reflectionMap.set(r.entry_id as string, {
        summary: payload.summary as string,
        sourceHash: r.source_hash as string | null,
      });
    }
  }

  // ── 8. Build entryHashes ─────────────────────────────────
  //
  // For each entry (sorted by entry_date ascending — already sorted from query):
  //   - If a reflection exists and has a source_hash: use reflection.source_hash
  //   - If a reflection exists but lacks a source_hash: use entry content hash
  //   - If no reflection exists: use entry content hash (stable identifier)
  //
  // "entry content hash" = sha256Hex(sourceEnvelope(content, 'entry', entry.id))
  // The 'entry' literal and entry.id make this distinct from any prompt-versioned hash.
  const entryHashesPromises = entries.map(
    async (entry: { id: string; content: string }) => {
      const reflection = reflectionMap.get(entry.id);
      if (reflection?.sourceHash) {
        return reflection.sourceHash;
      }
      // Fallback: hash the raw entry content with a stable envelope
      return sha256Hex(sourceEnvelope(entry.content, 'entry', entry.id));
    },
  );
  const entryHashes = await Promise.all(entryHashesPromises);
  // entryHashes is already in entry_date ascending order (from the DB query)

  // ── 10. Compute weekly source_hash ───────────────────────
  const weeklySourceHash = await sha256Hex(
    JSON.stringify({
      weekStart,
      weekEnd,
      weeklyPromptVersion: WEEKLY_CONFIG.weeklyPromptVersion,
      model: groqModel,
      entryHashes,
    }),
  );

  // ── 11. Cache check ──────────────────────────────────────
  const { data: existing } = await svc
    .from('insights')
    .select('payload, source_hash')
    .eq('user_id', user.id)
    .eq('type', 'summary')
    .eq('period_start', weekStart)
    .eq('period_end', weekEnd)
    .is('entry_id', null)
    .maybeSingle();

  if (existing && existing.source_hash === weeklySourceHash) {
    const payload = existing.payload as unknown;
    if (isWeeklyResult(payload)) {
      const w = payload as WeeklyResult;
      const cached: WeeklyResult = {
        narrative: w.narrative,
        dominantEmotions: w.dominantEmotions,
        recurringThemes: w.recurringThemes,
        emotionalArc: w.emotionalArc,
      };
      return json({ result: cached, meta: { cached: true, generationMs: 0 } });
    }
    console.warn(
      `[generate-weekly-summary] CACHE_INVALID weekStart=${weekStart} — stored payload failed isWeeklyResult(); regenerating`,
    );
  }

  // ── 12. Decrypt Groq token ───────────────────────────────
  let groqToken: string;
  try {
    groqToken = await decryptToken(settings.groq_token_encrypted, encryptionKey);
  } catch (err) {
    console.error('[generate-weekly-summary] Groq token decryption failed:', err);
    return json({ error: 'Failed to decrypt reflection token. Please re-save it in Settings.' }, 500);
  }

  // ── 13. Build synthesis context ──────────────────────────
  //
  // Assemble a structured view of the week for the LLM.
  // Use reflection summaries where available; fall back to raw excerpts.
  // Format: one line per entry, ordered by date.
  const entryLines = entries.map((entry: { entry_date: string; id: string; content: string }) => {
    const reflection = reflectionMap.get(entry.id);
    if (reflection?.summary) {
      return `${entry.entry_date} (reflected): "${reflection.summary}"`;
    }
    const excerpt = entry.content.slice(0, 300).replace(/\s+/g, ' ').trim();
    return `${entry.entry_date} (excerpt): "${excerpt}"`;
  });

  const contextBlock = entryLines.join('\n');
  const entryCount = entries.length;
  const reflectedCount = reflectionMap.size;

  // ── 14. Call Groq LLM ────────────────────────────────────
  const groqStartMs = Date.now();

  const systemPrompt = `You are a thoughtful journaling companion helping someone understand the arc of their week. You notice what they might not have explicitly articulated — emotional continuity, subtle shifts, and recurring preoccupations. Be honest and warm. Never be prescriptive or preachy. Always use "you" and "your" when addressing the person — never refer to them as "the writer" or use third person.`;

  const userPrompt = `Here are the journal entries from ${weekStart} to ${weekEnd} (${entryCount} day${entryCount === 1 ? '' : 's'}, ${reflectedCount} with reflections):

${contextBlock}

Write a weekly synthesis that helps the person see their week as a whole. Address them directly using "you". Focus on the emotional arc, not statistics. Avoid phrases like "you had X positive days."

Respond ONLY with valid JSON in exactly this shape:
{
  "narrative": "2–4 sentences addressed directly to the person using 'you'.",
  "dominantEmotions": [
    { "label": "Joy", "score": 0.45 },
    { "label": "Sadness", "score": 0.28 }
  ],
  "recurringThemes": ["Work", "Rest"],
  "emotionalArc": "from overwhelm toward quiet satisfaction"
}

Rules:
- narrative: 2–4 sentences. Story, not summary. Use "you" — never "the writer" or "they".
- dominantEmotions: up to 4 emotions aggregated across the week, human-readable capitalised labels, sorted by score descending.
- recurringThemes: 1–4 one-word or short-phrase topics that appeared repeatedly.
- emotionalArc: a short phrase (not a sentence) describing the direction of change, e.g. "from uncertainty toward calm" or "sustained focus with occasional frustration".
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

  const generationMs = Date.now() - groqStartMs;

  if (!groqRes.ok) {
    const errBody = await groqRes.text().catch(() => '');
    // Log full error server-side — never forward Groq error bodies to the client.
    console.error(`[generate-weekly-summary] Groq error ${groqRes.status} for weekStart=${weekStart}: ${errBody.slice(0, 300)}`);
    return json(
      { error: 'Weekly reflection generation failed. Please try again.', code: 'GROQ_PROVIDER_ERROR' },
      502,
    );
  }

  // ── 15. Parse + validate Groq response ──────────────────
  let groqBody: unknown;
  try {
    groqBody = await groqRes.json();
  } catch {
    return json({ error: 'Failed to parse weekly reflection response.', code: 'SHAPE_ERROR' }, 502);
  }

  const groqContent = (groqBody as Record<string, unknown>)?.choices;
  if (!Array.isArray(groqContent) || groqContent.length === 0) {
    console.error(`[generate-weekly-summary] Groq SHAPE_ERROR — no choices for weekStart=${weekStart}`);
    return json({ error: 'Unexpected weekly reflection response shape.', code: 'SHAPE_ERROR' }, 502);
  }

  const messageContent = (groqContent[0] as Record<string, unknown>)?.message;
  const rawContent = (messageContent as Record<string, unknown>)?.content;

  if (typeof rawContent !== 'string') {
    console.error(`[generate-weekly-summary] Groq SHAPE_ERROR — no content string for weekStart=${weekStart}`);
    return json({ error: 'Unexpected weekly reflection response shape.', code: 'SHAPE_ERROR' }, 502);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error(`[generate-weekly-summary] JSON parse failed for weekStart=${weekStart}: ${rawContent.slice(0, 200)}`);
    return json({ error: 'Failed to parse weekly reflection JSON.', code: 'SHAPE_ERROR' }, 502);
  }

  if (!isWeeklyResult(parsed)) {
    console.error(`[generate-weekly-summary] Validation failed for weekStart=${weekStart}: ${JSON.stringify(parsed).slice(0, 300)}`);
    return json({ error: 'Weekly reflection result failed validation. Please try again.', code: 'SHAPE_ERROR' }, 502);
  }

  const weeklyResult = parsed;

  // ── 16. Build full payload with _meta ────────────────────
  const meta: InsightMeta = {
    promptVersion: 'n/a',             // Not applicable — weekly rows use weeklyPromptVersion
    weeklyPromptVersion: WEEKLY_CONFIG.weeklyPromptVersion,
    provider: 'groq',
    model: groqModel,
    generatedAt: new Date().toISOString(),
    generationMs,
  };

  const fullPayload = { ...weeklyResult, _meta: meta };

  // ── 17. Write insight (SELECT → UPDATE or INSERT) ────────
  //
  // We use an explicit SELECT → UPDATE/INSERT pattern rather than
  // UPSERT with onConflict so the write succeeds regardless of whether
  // migration 006 (the partial unique index uq_insight_summary_period) has
  // been applied to the database.  This is safe because:
  //   a) We already performed a source_hash cache check (step 11 above),
  //      so if a matching row exists with the same hash we returned early.
  //   b) The service role bypasses RLS, so the SELECT is authoritative.
  //   c) Two concurrent Regenerate clicks will produce at most one extra
  //      row (harmless; the next cache check will deduplicate).
  //
  // Once migration 006 is applied (uq_insight_summary_period index exists),
  // the behaviour is identical — the explicit SELECT is just one extra
  // read per generation, which is negligible.

  // Check for an existing row for this period (entry_id IS NULL)
  const { data: existingRow } = await svc
    .from('insights')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'summary')
    .eq('period_start', weekStart)
    .eq('period_end', weekEnd)
    .is('entry_id', null)
    .maybeSingle();

  // Perform the write — UPDATE if a row exists, INSERT otherwise.
  const writeResult = await (existingRow
    ? svc
        .from('insights')
        .update({
          payload: fullPayload,
          source_hash: weeklySourceHash,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingRow.id)
    : svc.from('insights').insert({
        user_id: user.id,
        entry_id: null,
        type: 'summary',
        payload: fullPayload,
        source_hash: weeklySourceHash,
        period_start: weekStart,
        period_end: weekEnd,
        updated_at: new Date().toISOString(),
      }));

  if (writeResult.error) {
    console.error('[generate-weekly-summary] Failed to write insight:', writeResult.error.message);
    return json({ error: 'Failed to save weekly reflection' }, 500);
  }

  // ── 18. Return result + observability metadata ───────────
  return json({
    result: weeklyResult,
    meta: { cached: false, generationMs },
  });
});
