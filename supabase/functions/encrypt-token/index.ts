// ============================================================
// encrypt-token — Supabase Edge Function (Deno)
//
// POST { token: string }
// Authorization: Bearer <access_token>
//
// Encrypts the plaintext AI provider token using AES-GCM and stores
// the ciphertext in user_settings.hf_token_encrypted.
//
// The raw token is NEVER returned to the client and is NOT logged.
//
// Requires the APP_ENCRYPTION_KEY secret to be set:
//   supabase secrets set APP_ENCRYPTION_KEY=<64-hex-char-key>
//   (32 bytes = 256 bits for AES-256-GCM)
//   Generate with: openssl rand -hex 32
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── CORS + JSON helpers ──────────────────────────────────────

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

// ─── AES-GCM encryption helper ───────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function encryptToken(plaintext: string, keyHex: string): Promise<string> {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      `APP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Got length: ${keyHex?.length ?? 0}`,
    );
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );

  // Concat iv + ciphertext → base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const encryptionKey = Deno.env.get('APP_ENCRYPTION_KEY') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Fail fast with a clear message if the secret is missing
  if (!encryptionKey || encryptionKey.length !== 64) {
    console.error(
      `APP_ENCRYPTION_KEY misconfigured. Expected 64 hex chars, got: ${encryptionKey?.length ?? 0}`,
    );
    return json(
      {
        error:
          'Server configuration error: APP_ENCRYPTION_KEY is missing or has the wrong length. ' +
          'Run: supabase secrets set APP_ENCRYPTION_KEY=$(openssl rand -hex 32)',
      },
      500,
    );
  }

  // ── 1. Verify caller JWT ─────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401);
  }
  const jwtToken = authHeader.slice(7);

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwtToken}` } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(jwtToken);
  if (authError || !user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  // ── 2. Parse body ────────────────────────────────────────
  let plainToken: string;
  try {
    const body = await req.json();
    plainToken = body.token;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!plainToken || typeof plainToken !== 'string' || plainToken.trim().length === 0) {
    return json({ error: 'token must be a non-empty string' }, 400);
  }

  // ── 3. Encrypt ───────────────────────────────────────────
  let ciphertext: string;
  try {
    ciphertext = await encryptToken(plainToken.trim(), encryptionKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Encryption failed:', msg);
    return json({ error: `Encryption failed: ${msg}` }, 500);
  }

  // ── 4. Store ciphertext ──────────────────────────────────
  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { error: updateError } = await svc
    .from('user_settings')
    .update({ hf_token_encrypted: ciphertext })
    .eq('user_id', user.id);

  if (updateError) {
    console.error('Failed to update user_settings:', updateError);
    return json({ error: 'Failed to save token', detail: updateError.message }, 500);
  }

  // ── 5. Return success (never echo the token) ─────────────
  return json({ success: true });
});
