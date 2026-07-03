// ============================================================
// analyze-sentiment — Supabase Edge Function (Deno)
//
// POST { entryId: string }
// Authorization: Bearer <access_token>
//
// Flow:
//   1. Verify caller JWT
//   2. Fetch entry (service role — bypasses RLS)
//   3. Assert ownership
//   4. Fetch user_settings — get encrypted HF token
//   5. Decrypt token (AES-GCM)
//   6. Call HuggingFace j-hartmann model
//   7. Map 7-emotion output → SentimentResult
//   8. Upsert into insights (service role)
//   9. Return SentimentResult JSON
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Types ──────────────────────────────────────────────────

interface SentimentResult {
  score: number;        // -1 to 1
  label: 'negative' | 'neutral' | 'positive';
  confidence: number;   // 0 to 1
}

interface HFEmotionScore {
  label: string;
  score: number;
}

// ─── AES-GCM helpers ─────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function decryptToken(ciphertext: string, keyHex: string): Promise<string> {
  // Format: base64(iv + encrypted)
  const raw = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const data = raw.slice(12);

  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

// ─── HF response mapping ─────────────────────────────────────

function mapHFToSentiment(emotions: HFEmotionScore[]): SentimentResult {
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

  let label: 'positive' | 'negative' | 'neutral';
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

  const score = Math.max(-1, Math.min(1, positiveScore - negativeScore));

  return { score, label, confidence: Math.min(1, confidence) };
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const encryptionKey = Deno.env.get('APP_ENCRYPTION_KEY')!;

  // ── 1. Verify caller JWT ─────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = authHeader.slice(7);

  // User-scoped client only used for JWT verification
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 2. Parse body ────────────────────────────────────────
  let entryId: string;
  try {
    const body = await req.json();
    entryId = body.entryId;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!entryId || typeof entryId !== 'string') {
    return new Response(JSON.stringify({ error: 'entryId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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
    return new Response(JSON.stringify({ error: 'Entry not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 4. Assert ownership ──────────────────────────────────
  if (entry.user_id !== user.id) {
    return new Response(JSON.stringify({ error: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 5. Fetch encrypted HF token ──────────────────────────
  const { data: settings, error: settingsError } = await svc
    .from('user_settings')
    .select('hf_token_encrypted, hf_model')
    .eq('user_id', user.id)
    .single();

  if (settingsError || !settings) {
    return new Response(
      JSON.stringify({ error: 'User settings not found. Please visit Settings.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!settings.hf_token_encrypted) {
    return new Response(
      JSON.stringify({
        error: 'No HuggingFace token configured. Add it in Settings to use AI features.',
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 6. Decrypt token ─────────────────────────────────────
  let hfToken: string;
  try {
    hfToken = await decryptToken(settings.hf_token_encrypted, encryptionKey);
  } catch (err) {
    console.error('Token decryption failed:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to decrypt HuggingFace token. Please re-save it in Settings.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 7. Call HuggingFace ──────────────────────────────────
  const model = settings.hf_model ?? 'j-hartmann/emotion-english-distilroberta-base';
  let sentimentResult: SentimentResult = { score: 0, label: 'neutral', confidence: 0 };

  try {
    const hfRes = await fetch(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: entry.content.slice(0, 512) }),
      },
    );

    if (hfRes.ok) {
      const hfData = await hfRes.json() as HFEmotionScore[][];
      if (Array.isArray(hfData) && Array.isArray(hfData[0])) {
        sentimentResult = mapHFToSentiment(hfData[0]);
      }
    } else {
      console.warn(`HuggingFace API returned ${hfRes.status} — using neutral fallback`);
    }
  } catch (err) {
    console.warn('HuggingFace API call failed — using neutral fallback:', err);
  }

  // ── 8. Upsert into insights ──────────────────────────────
  const { error: insertError } = await svc.from('insights').upsert(
    {
      user_id: user.id,
      entry_id: entryId,
      type: 'sentiment',
      payload: sentimentResult,
    },
    { onConflict: 'user_id,entry_id,type' },
  );

  if (insertError) {
    console.error('Failed to insert insight:', insertError);
    return new Response(
      JSON.stringify({ error: 'Failed to save insight', detail: insertError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 9. Return result ─────────────────────────────────────
  return new Response(JSON.stringify(sentimentResult), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
