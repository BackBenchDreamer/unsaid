/**
 * Insight entities — AI reflection types for UnSaid.
 *
 * This file is the canonical source of truth for all AI configuration
 * and type definitions on the client. Provider-specific logic is isolated
 * inside Edge Functions; nothing here references HuggingFace or any
 * other provider by name.
 */

// ─── AI Configuration ────────────────────────────────────────

/**
 * Canonical AI configuration for UnSaid.
 *
 * promptVersion: bump this string whenever prompt logic changes in the
 *   Edge Function. All existing source_hash values become stale automatically —
 *   users will see "Re-reflect" on their next visit.
 *
 * defaultModel: fallback display value if user has not set a model in settings.
 *   The actual model used at inference time comes from settings.aiModel
 *   (mapped from user_settings.hf_model in the DB).
 *
 * EDGE FUNCTION NOTE: supabase/functions/analyze-sentiment/index.ts contains
 *   a local AI_CONFIG mirror. Keep the two in sync when bumping promptVersion
 *   or defaultModel and redeploying the function.
 */
export const AI_CONFIG = {
  promptVersion: '1.0.0',
  defaultModel: 'j-hartmann/emotion-english-distilroberta-base',
} as const;

// ─── Insight types ────────────────────────────────────────────

/**
 * InsightType — extensible union, no schema change required to add new types.
 * The `type` column CHECK constraint already covers all three values.
 * Adding a new AI capability requires:
 *   1. A new Supabase Edge Function (supabase/functions/<capability>/index.ts)
 *   2. Adding the new type to this union
 *   3. Adding a new AiAction entry in JournalEditor with enabled: true
 */
export type InsightType = 'sentiment' | 'summary' | 'pattern';

/**
 * Stored inside every insight payload as payload._meta.
 * Makes each DB row self-describing — no joins required to understand
 * how or when an insight was generated, or with which provider/model/prompt.
 */
export interface InsightMeta {
  /** e.g. "1.0.0" — bump AI_CONFIG.promptVersion to invalidate all caches. */
  promptVersion: string;
  /**
   * Inference backend identifier, e.g. "huggingface".
   * Stored so rows remain interpretable if additional backends are added later.
   * Added in prompt version 1.0.0; absent on rows generated before this field
   * was introduced (treat missing as "huggingface" for backward compatibility).
   */
  provider: string;
  /** AI model identifier. Provider-specific value, opaque to the client. */
  model: string;
  /** ISO 8601 UTC timestamp of when the insight was generated. */
  generatedAt: string;
  /** Wall-clock milliseconds for the inference call. 0 = cache hit. */
  generationMs: number;
}

/**
 * Full typed payload for type='sentiment'.
 * Stored in the DB; includes _meta for self-description.
 */
export interface SentimentPayload {
  /** Normalised score from -1 (most negative) to 1 (most positive). */
  score: number;
  label: 'negative' | 'neutral' | 'positive';
  /** Confidence of the winning label, 0–1. */
  confidence: number;
  _meta: InsightMeta;
}

/**
 * Edge Function wire return type — what generateInsight() returns to the client.
 * Intentionally excludes _meta: the UI only needs the sentiment result.
 */
export interface SentimentResult {
  score: number;
  label: 'negative' | 'neutral' | 'positive';
  confidence: number;
}

/**
 * A typed insight row read from the DB via insightsService.getInsights().
 * The payload field is open-schema (Record<string, unknown>) to accommodate
 * future insight types without requiring code changes here.
 */
export interface EntryInsight {
  id: string;
  /** The journal entry this insight was generated from. Null for user-level insights. */
  entryId: string | null;
  type: InsightType;
  /** Open-schema — use isSentimentPayload() to narrow for type='sentiment'. */
  payload: Record<string, unknown>;
  /**
   * SHA-256 of sourceEnvelope(content, promptVersion, model) at generation time.
   * Null for legacy rows (pre-migration). Null rows are treated as always-stale.
   */
  sourceHash: string | null;
  createdAt: string;
}

/**
 * Type-narrowing guard: returns true if p contains SentimentPayload fields.
 * Parameter is `unknown` — widest safe type for a type guard — so it works
 * for both payload.score === 'number' checks and TypeScript's predicate constraint.
 * Checks only the core result fields; _meta may be absent on legacy rows.
 */
export function isSentimentPayload(p: unknown): p is SentimentPayload {
  if (typeof p !== 'object' || p === null) return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.score === 'number' &&
    typeof v.label === 'string' &&
    typeof v.confidence === 'number'
  );
}

/**
 * A single item in the "Reflect" AI menu (AiMenu component).
 *
 * v1 registered actions:
 *   { id: 'generate-insight',  label: 'Generate Insight',   enabled: true }
 *   { id: 'summarize-entry',   label: 'Summarize Entry',    enabled: false, disabledReason: 'Coming soon' }
 *   { id: 'reflection-prompt', label: 'Reflection Prompt',  enabled: false, disabledReason: 'Coming soon' }
 *   { id: 'find-patterns',     label: 'Find Patterns',      enabled: false, disabledReason: 'Coming soon' }
 *
 * To activate a new capability in a future version:
 *   1. Add its Edge Function to supabase/functions/
 *   2. Add the type to InsightType (if new)
 *   3. Flip enabled: true on the corresponding AiAction in JournalEditor
 *   No changes to AiMenu, JournalEditor layout, or the trigger button are needed.
 */
export interface AiAction {
  /** Stable identifier, e.g. 'generate-insight'. */
  id: string;
  /** Display label in the menu, e.g. 'Generate Insight'. */
  label: string;
  /** Optional one-line description shown below the label. */
  description?: string;
  /** Which insight type this action produces. */
  insightType: InsightType;
  /** Called when the user selects this action from the menu. */
  invoke: () => void;
  /** If false, the item is rendered disabled with disabledReason subtext. */
  enabled: boolean;
  /** Shown below the label when enabled is false, e.g. 'Coming soon'. */
  disabledReason?: string;
}

// ─── Memory + Heatmap (unchanged from original) ──────────────

export interface Memory {
  id: string;
  entryDate: string;
  snippet: string;
  mood: string | null;
  daysAgo: number;
}

export interface HeatmapCell {
  date: string; // "YYYY-MM-DD"
  count: number; // 0 or 1 for journaling (entry exists or not)
  mood: string | null;
}
