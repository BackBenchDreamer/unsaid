// ============================================================
// encrypt-token — Supabase Edge Function (Deno)
//
// POST { token: string }
// Authorization: Bearer <access_token>
//
// Encrypts the plaintext HuggingFace API token using AES-GCM
// and stores the ciphertext in user_settings.hf_token_encrypted.
//
// The raw token is NEVER returned to the client and is NOT logged.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── AES-GCM encryption helper ───────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function encryptToken(plaintext: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoded,
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
  const jwtToken = authHeader.slice(7);

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwtToken}` } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(jwtToken);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 2. Parse body ────────────────────────────────────────
  let plainToken: string;
  try {
    const body = await req.json();
    plainToken = body.token;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!plainToken || typeof plainToken !== 'string' || plainToken.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'token must be a non-empty string' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 3. Encrypt ───────────────────────────────────────────
  let ciphertext: string;
  try {
    ciphertext = await encryptToken(plainToken.trim(), encryptionKey);
  } catch (err) {
    console.error('Encryption failed:', err);
    return new Response(JSON.stringify({ error: 'Encryption failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
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
    return new Response(JSON.stringify({ error: 'Failed to save token' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 5. Return success (never echo the token) ─────────────
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
