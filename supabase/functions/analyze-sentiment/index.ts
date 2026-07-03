// ============================================================
// analyze-sentiment — Supabase Edge Function (Deno)
//
// POST { entryId: string }
// Authorization: Bearer <access_token>
//
// Flow:
//   1.  Validate JWT
//   2.  Parse + validate body
//   3.  Fetch entry (service role — bypasses RLS)
//   4.  Assert ownership
//   5.  Fetch user_settings (hf_model is part of the source_hash envelope)
//   6.  Compute source_hash = sha256Hex(sourceEnvelope(content, promptVersion, model))
//   7.  Cache check: if existing insight has matching source_hash → validate with
//       isSentimentResult() (full invariant check) before serving.  A row that
//       fails validation is treated as CACHE_INVALID and regenerated.
//   8.  Decrypt HF token
//   9.  Call generateSentiment() — provider-isolated; THROWS on any error.
//       HF 503 (model loading) throws HFModelLoadingError — distinct HTTP 503 response.
//       All other errors throw HFProviderError — HTTP 502 response.
//       Neither error path stores anything to the DB.
//  10.  Validate the SentimentResult produced by mapHFToSentiment().
//  11.  Upsert { payload: { ...result, _meta }, source_hash } — only on success.
//       _meta includes provider: "huggingface" for future backend portability.
//  12.  Return { result, meta: { cached, generationMs } }
//
// Response shape normalisation (generateSentiment):
//   HF Inference API returns HFEmotionScore[] for a single input string
//   and HFEmotionScore[][] for a batch array.  We always send a single string,
//   so we handle both but prefer the flat form.  Anything else is logged and thrown.
//
// Error codes returned to the client:
//   MODEL_LOADING  — HF returned 503; user should retry in ~20s
//   PROVIDER_ERROR — HF returned another non-200 status
//   SHAPE_ERROR    — HF returned 200 but an unrecognised payload shape or bad items
//
// Internal diagnostics emitted to Edge Function logs (not sent to client):
//   CACHE_INVALID  — cached row exists but fails isSentimentResult(); regenerating
//
// Modular structure:
//   generateSentiment()   — HF provider call + response mapping
//   mapHFToSentiment()    — 7-emotion → SentimentResult mapping
//   isSentimentResult()   — runtime type-guard with full invariant checks
//   sha256Hex()           — Web Crypto SHA-256 (mirrors src/shared/utils/hash.ts)
//   sourceEnvelope()      — deterministic hash input (mirrors src/shared/utils/hash.ts)
//   decryptToken()        — AES-GCM token decryption
//
// Adding future capabilities (summarise, reflection prompt, patterns):
//   Create supabase/functions/<capability>/index.ts following the same structure.
//   Do not add new capability logic to this file.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Local AI_CONFIG mirror ───────────────────────────────────
//
// Mirrors src/entities/insight.ts AI_CONFIG.
// Keep the two in sync when bumping promptVersion or defaultModel
// and redeploying the function.
//
const AI_CONFIG = {
  promptVersion: '1.0.0',
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;

// ─── Types ───────────────────────────────────────────────────

interface SentimentResult {
  score: number;         // -1 to 1
  label: 'negative' | 'neutral' | 'positive';
  confidence: number;    // 0 to 1 — reflects actual model output, never a synthetic fallback
}

interface InsightMeta {
  promptVersion: string;
  /** Identifier of the AI inference backend, e.g. "huggingface". */
  provider: string;
  model: string;
  generatedAt: string;
  generationMs: number;
}

interface HFEmotionScore {
  label: string;
  score: number;
}

// ─── Typed provider error classes ────────────────────────────
//
// Separate types let the handler route to the right HTTP status and
// error code without string-matching on error messages.

class HFModelLoadingError extends Error {
  constructor(public readonly estimatedSecs?: number) {
    super('HuggingFace model is loading. Please try again in a moment.');
    this.name = 'HFModelLoadingError';
  }
}

class HFProviderError extends Error {
  constructor(public readonly httpStatus: number, detail: string) {
    super(`HuggingFace API error ${httpStatus}: ${detail}`);
    this.name = 'HFProviderError';
  }
}

class HFShapeError extends Error {
  constructor(detail: string) {
    super(`Unexpected HuggingFace response shape: ${detail}`);
    this.name = 'HFShapeError';
  }
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
): string {
  // Field order is fixed — do not reorder or existing hashes become invalid.
  return JSON.stringify({ content, promptVersion, model });
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

// ─── Runtime type guard ───────────────────────────────────────
//
// Treats both live provider results and cached DB payloads as untrusted input.
// A row that fails any check is treated as a cache miss (CACHE_INVALID) and
// the provider is called again regardless of source_hash.
//
// Full invariant checks:
//   score      must be a finite number in [-1, 1]
//   label      must be exactly one of the three valid string literals
//   confidence must be a finite number in (0, 1]
//              — zero is never valid (winner category is always > 0 for a
//                properly normalised softmax distribution)
//              — values > 1 indicate a summation overflow bug

function isSentimentResult(v: unknown): v is SentimentResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.score === 'number' &&
    isFinite(r.score) &&
    r.score >= -1 && r.score <= 1 &&
    (r.label === 'negative' || r.label === 'neutral' || r.label === 'positive') &&
    typeof r.confidence === 'number' &&
    isFinite(r.confidence) &&
    r.confidence > 0 &&    // zero is never a valid model output
    r.confidence <= 1      // softmax winner cannot exceed 1
  );
}

// ─── HF response mapping ─────────────────────────────────────
//
// All seven emotion labels are mapped to three sentiment categories.
// Called only after the caller has validated that every item has the
// expected shape — throws HFShapeError if an individual item is malformed.

function mapHFToSentiment(emotions: HFEmotionScore[]): SentimentResult {
  // Validate each item explicitly: an unexpected API change should fail loudly.
  for (const e of emotions) {
    if (typeof e.label !== 'string' || typeof e.score !== 'number') {
      throw new HFShapeError(
        `emotion item has unexpected shape: ${JSON.stringify(e).slice(0, 100)}`,
      );
    }
  }

  const byLabel: Record<string, number> = {};
  for (const e of emotions) {
    byLabel[e.label.toLowerCase()] = e.score;
  }

  const positiveScore = (byLabel['joy'] ?? 0) + (byLabel['surprise'] ?? 0);
  const negativeScore =
    (byLabel['anger'] ?? 0) +
    (byLabel['disgust'] ?? 0) +
    (byLabel['fear'] ?? 0) +
    (byLabel['sadness'] ?? 0);
  const neutralScore = byLabel['neutral'] ?? 0;

  let label: SentimentResult['label'];
  let confidence: number;

  if (positiveScore >= negativeScore && positiveScore >= neutralScore) {
    label = 'positive';
    confidence = positiveScore;
  } else if (negativeScore >= positiveScore && negativeScore >= neutralScore) {
    label = 'negative';
    confidence = negativeScore;
  } else {
    label = 'neutral';
    confidence = neutralScore;
  }

  return {
    score: Math.max(-1, Math.min(1, positiveScore - negativeScore)),
    label,
    confidence: Math.min(1, confidence),
  };
}

// ─── Provider-isolated sentiment generation ──────────────────
//
// All HuggingFace-specific logic lives here.
// This function ONLY throws — it never returns a fallback / synthetic result.
// Callers must not catch and swallow; they must propagate or map to HTTP errors.
//
// Throws:
//   HFModelLoadingError  — 503 response (cold start; user should retry)
//   HFProviderError      — any other non-200 response
//   HFShapeError         — 200 response with unrecognised payload shape or bad items

async function generateSentiment(
  content: string,
  hfToken: string,
  model: string,
): Promise<{ result: SentimentResult; generationMs: number }> {
  const startMs = Date.now();

  const hfRes = await fetch(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: content.slice(0, 512) }),
    },
  );

  const generationMs = Date.now() - startMs;

  // ── Non-200 path ──────────────────────────────────────────
  if (!hfRes.ok) {
    const errBody = await hfRes.text().catch(() => '');

    // 503: model is warming up — surface a user-actionable retry message.
    if (hfRes.status === 503) {
      // HF sometimes includes { "estimated_time": <seconds> } in the body.
      let estimatedSecs: number | undefined;
      try {
        const parsed = JSON.parse(errBody) as Record<string, unknown>;
        if (typeof parsed.estimated_time === 'number') {
          estimatedSecs = Math.ceil(parsed.estimated_time);
        }
      } catch {
        // body is not JSON — ignore
      }
      throw new HFModelLoadingError(estimatedSecs);
    }

    throw new HFProviderError(hfRes.status, errBody.slice(0, 300));
  }

  // ── 200 path — validate and normalise response shape ─────
  //
  // The HF Inference API returns:
  //   HFEmotionScore[]   — single input string (our case: inputs is a string)
  //   HFEmotionScore[][] — batch input array  (inputs is string[])
  //
  // We always send a single string, so the flat form is the expected shape.
  // We also handle the nested form defensively in case the API behaviour
  // changes or a future caller sends batch input.
  // Any other shape is a hard error — do not fall back silently.

  let rawData: unknown;
  try {
    rawData = await hfRes.json();
  } catch (e) {
    throw new HFShapeError(`response body is not valid JSON: ${String(e).slice(0, 100)}`);
  }

  let emotions: HFEmotionScore[];

  // Truncated snapshot of the raw payload for shape-error diagnostics.
  // Logged before any throw so unexpected API changes are immediately visible
  // in Edge Function logs without needing to reproduce the request.
  const rawSnippet = JSON.stringify(rawData).slice(0, 300);

  if (!Array.isArray(rawData) || rawData.length === 0) {
    console.error(
      `[analyze-sentiment] SHAPE_ERROR — expected non-empty array. raw=${rawSnippet}`,
    );
    throw new HFShapeError(
      `expected non-empty array, got: ${rawSnippet}`,
    );
  }

  if (Array.isArray(rawData[0])) {
    // Nested: HFEmotionScore[][] — take the first element (first input's scores)
    const nested = rawData[0] as unknown[];
    if (!Array.isArray(nested) || nested.length === 0) {
      console.error(
        `[analyze-sentiment] SHAPE_ERROR — nested[0] is not a non-empty array. raw=${rawSnippet}`,
      );
      throw new HFShapeError(
        `nested response first element is not a non-empty array: ${JSON.stringify(rawData[0]).slice(0, 200)}`,
      );
    }
    emotions = nested as HFEmotionScore[];
  } else {
    // Flat: HFEmotionScore[] — use directly
    emotions = rawData as HFEmotionScore[];
  }

  // mapHFToSentiment validates individual items and throws HFShapeError on bad ones.
  // If it throws, log the raw payload here so diagnostics include the full context.
  let result: SentimentResult;
  try {
    result = mapHFToSentiment(emotions);
  } catch (e) {
    console.error(
      `[analyze-sentiment] SHAPE_ERROR — item validation failed. raw=${rawSnippet}`,
    );
    throw e;
  }

  return { result, generationMs };
} // end generateSentiment

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
  // Must happen before computing source_hash — hf_model is part of the envelope.
  const { data: settings, error: settingsError } = await svc
    .from('user_settings')
    .select('hf_token_encrypted, hf_model')
    .eq('user_id', user.id)
    .single();

  if (settingsError || !settings) {
    return json({ error: 'User settings not found. Please visit Settings.' }, 422);
  }

  if (!settings.hf_token_encrypted) {
    return json(
      { error: 'No AI token configured. Add it in Settings to use AI features.' },
      422,
    );
  }

  const model = settings.hf_model ?? AI_CONFIG.defaultModel;

  // ── 6. Compute source_hash ───────────────────────────────
  const sourceHash = await sha256Hex(
    sourceEnvelope(entry.content, AI_CONFIG.promptVersion, model),
  );

  // ── 7. Cache check ───────────────────────────────────────
  //
  // A cache hit requires BOTH:
  //   a) source_hash matches  (content + prompt + model are unchanged)
  //   b) the stored payload passes isSentimentResult() — structural validity
  //      AND confidence > 0 (confidence=0 is never a real model output)
  //
  // A row that fails (b) is treated as a miss regardless of hash equality.
  // This prevents stale bug-era rows from being served forever.
  const { data: existing } = await svc
    .from('insights')
    .select('payload, source_hash')
    .eq('entry_id', entryId)
    .eq('type', 'sentiment')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing && existing.source_hash === sourceHash) {
    const payload = existing.payload as unknown;
    if (isSentimentResult(payload)) {
      // Valid cache hit — return without calling the provider.
      const cachedResult: SentimentResult = {
        score: payload.score,
        label: payload.label,
        confidence: payload.confidence,
      };
      return json({ result: cachedResult, meta: { cached: true, generationMs: 0 } });
    }
    // CACHE_INVALID: the row exists and the hash matches, but the stored payload
    // fails isSentimentResult() — either a pre-fix bug row or a future migration
    // that changed the schema without purging old rows.  Log with enough context
    // to diagnose the failure, then fall through to re-generate.
    const stored = existing.payload as Record<string, unknown>;
    console.warn(
      `[analyze-sentiment] CACHE_INVALID entry=${entryId}` +
      ` score=${stored.score} label=${stored.label} confidence=${stored.confidence}` +
      ` — falling through to re-generate`,
    );
  }

  // ── 8. Decrypt token ─────────────────────────────────────
  let hfToken: string;
  try {
    hfToken = await decryptToken(settings.hf_token_encrypted, encryptionKey);
  } catch (err) {
    console.error('Token decryption failed:', err);
    return json(
      { error: 'Failed to decrypt AI token. Please re-save it in Settings.' },
      500,
    );
  }

  // ── 9. Generate sentiment (provider-isolated) ────────────
  //
  // generateSentiment() only throws — never returns a synthetic fallback.
  // Each error subclass maps to a distinct HTTP response:
  //
  //   HFModelLoadingError → 503 + code MODEL_LOADING (user: "retry in ~Ns")
  //   HFProviderError     → 502 + code PROVIDER_ERROR
  //   HFShapeError        → 502 + code SHAPE_ERROR (unexpected API change)
  //
  // None of these paths persist anything to the DB.
  let sentimentResult: SentimentResult;
  let generationMs: number;

  try {
    ({ result: sentimentResult, generationMs } = await generateSentiment(
      entry.content,
      hfToken,
      model,
    ));
  } catch (err) {
    if (err instanceof HFModelLoadingError) {
      const detail = err.estimatedSecs
        ? `Model is loading, try again in about ${err.estimatedSecs} seconds.`
        : 'Model is loading, try again in a moment.';
      console.info(`[analyze-sentiment] model loading for entry=${entryId}: ${detail}`);
      return json({ error: detail, code: 'MODEL_LOADING' }, 503);
    }
    if (err instanceof HFShapeError) {
      console.error(`[analyze-sentiment] shape error for entry=${entryId}:`, err.message);
      return json({ error: err.message, code: 'SHAPE_ERROR' }, 502);
    }
    if (err instanceof HFProviderError) {
      console.error(`[analyze-sentiment] provider error for entry=${entryId}:`, err.message);
      return json({ error: err.message, code: 'PROVIDER_ERROR' }, 502);
    }
    // Unknown error — should never reach here but log it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[analyze-sentiment] unexpected error for entry=${entryId}:`, msg);
    return json({ error: `Unexpected error: ${msg}` }, 500);
  }

  // ── 10. Final result validation ──────────────────────────
  //
  // mapHFToSentiment() should always produce a valid result after passing item
  // validation, but this guard is a belt-and-suspenders check before we write
  // to the DB.  A zero-confidence result here would mean the model returned all
  // zero scores, which indicates a provider-side problem — don't cache it.
  if (!isSentimentResult(sentimentResult)) {
    console.error(
      `[analyze-sentiment] generated result failed validation for entry=${entryId}:`,
      JSON.stringify(sentimentResult),
    );
    return json(
      { error: 'AI result failed validation. Please try again.', code: 'SHAPE_ERROR' },
      502,
    );
  }

  // ── 11. Build full payload with _meta ────────────────────
  //
  // provider is recorded so stored rows remain self-describing if additional
  // inference backends (e.g. OpenAI, Anthropic) are added in future.
  // Keep in sync with the InsightMeta interface in src/entities/insight.ts.
  const meta: InsightMeta = {
    promptVersion: AI_CONFIG.promptVersion,
    provider: 'huggingface',
    model,
    generatedAt: new Date().toISOString(),
    generationMs,
  };

  const fullPayload = { ...sentimentResult, _meta: meta };

  // ── 12. Upsert insight ───────────────────────────────────
  //
  // Only reached on a validated, successful generation.
  // Error and fallback paths all returned early above.
  const { error: upsertError } = await svc.from('insights').upsert(
    {
      user_id: user.id,
      entry_id: entryId,
      type: 'sentiment',
      payload: fullPayload,
      source_hash: sourceHash,
    },
    { onConflict: 'user_id,entry_id,type' },
  );

  if (upsertError) {
    console.error('Failed to upsert insight:', upsertError);
    return json({ error: 'Failed to save insight', detail: upsertError.message }, 500);
  }

  // ── 13. Return result + observability metadata ───────────
  return json({ result: sentimentResult, meta: { cached: false, generationMs } });
});
