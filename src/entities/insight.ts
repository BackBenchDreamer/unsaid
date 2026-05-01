/**
 * Insight / Memory — derived entities.
 *
 * These are always computed server-side (Edge Function or SQL function).
 * Client never produces or trusts these values.
 */

export interface SentimentResult {
  /** -1 to 1 scale. */
  score: number;
  /** "negative" | "neutral" | "positive" */
  label: 'negative' | 'neutral' | 'positive';
  /** Confidence 0-1. */
  confidence: number;
}

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
