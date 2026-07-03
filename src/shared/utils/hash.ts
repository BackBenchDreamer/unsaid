/**
 * SHA-256 hashing utilities for AI source-hash computation.
 *
 * Uses Web Crypto API — available natively in browsers and Deno.
 * No external dependencies.
 *
 * Both exports are inlined verbatim inside the Edge Function
 * (supabase/functions/analyze-sentiment/index.ts) because Deno cannot
 * import from src/. The implementations must stay in sync.
 */

/**
 * Async SHA-256 hex digest of the given string.
 * Returns a deterministic 64-character lowercase hex string.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the deterministic JSON envelope that is hashed to produce source_hash.
 *
 * Every input that influences AI output must appear here.
 * Changing any field automatically invalidates all cached hashes computed
 * with different values — no new DB columns required.
 *
 * Field order is fixed by JSON.stringify on a literal object; do not
 * reorder the keys or the hash will change for existing records.
 */
export function sourceEnvelope(
  content: string,
  promptVersion: string,
  model: string,
): string {
  return JSON.stringify({ content, promptVersion, model });
}
