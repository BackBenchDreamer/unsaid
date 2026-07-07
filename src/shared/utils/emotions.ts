/**
 * Emotion valence utilities shared across InsightsPage and JournalEditor.
 *
 * The 7-emotion model (j-hartmann/emotion-english-distilroberta-base) maps
 * to three valence categories. These sets and the helper function are used
 * in multiple callsites, so they live here rather than being duplicated.
 */

export const POSITIVE_EMOTIONS = new Set(['joy', 'surprise']);
export const NEGATIVE_EMOTIONS = new Set(['anger', 'disgust', 'fear', 'sadness']);

/**
 * Map a raw emotion label (from the HF model or Groq response) to a
 * positive / negative / neutral valence category.
 *
 * Comparison is case-insensitive — labels from different sources may
 * arrive capitalised ("Joy") or lowercase ("joy").
 */
export function getEmotionValence(label: string): 'positive' | 'negative' | 'neutral' {
  const l = label.toLowerCase();
  if (POSITIVE_EMOTIONS.has(l)) return 'positive';
  if (NEGATIVE_EMOTIONS.has(l)) return 'negative';
  return 'neutral';
}
