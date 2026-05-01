/**
 * Application-wide constants.
 */

export const APP_NAME = 'UnSaid';
export const APP_TAGLINE = 'Your private journal, unspoken thoughts given form.';

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const SYNC_POLL_INTERVAL_MS = 30_000;
export const MAX_CONTENT_LENGTH = 50_000;
export const MAX_RETRIES = 5;

/** Mood colors for heatmap and UI. */
export const MOOD_COLORS: Record<string, string> = {
  terrible: '#ef4444',
  bad: '#f97316',
  meh: '#eab308',
  good: '#22c55e',
  great: '#3b82f6',
};

export const MOOD_EMOJIS: Record<string, string> = {
  terrible: '😢',
  bad: '😕',
  meh: '😐',
  good: '😊',
  great: '🥳',
};
