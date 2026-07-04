/**
 * Settings Page — user preferences and AI configuration.
 *
 * Sections:
 *   1. Appearance — dark/light theme toggle
 *   2. AI Configuration — two sub-sections:
 *      a. Emotion Analysis (HuggingFace) — HF token (write-only after save)
 *      b. Reflection Generation (Groq) — Groq token + model (write-only token after save)
 *
 * Error state design:
 *   All form sections use a stable vertical layout (label → input → error → button row).
 *   Error messages always appear below the input field, never beside the button.
 *   The button row is always the last element in the form — error messages never push it.
 */

import { useState, useEffect, useRef } from 'react';
import { useSettings, useUpdateTheme, useSaveHFToken, useSaveGroqToken, useUpdateGroqModel } from './hooks';

export default function SettingsPage() {
  const { data: settings, isLoading, isError: settingsError } = useSettings();
  const updateTheme = useUpdateTheme();
  const saveHFToken = useSaveHFToken();
  const saveGroqToken = useSaveGroqToken();
  const updateGroqModel = useUpdateGroqModel();

  // ── HF token state (unchanged from original) ──────────────
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [tokenError, setTokenError] = useState('');

  // ── Groq token state ───────────────────────────────────────
  const [groqTokenInput, setGroqTokenInput] = useState('');
  const [groqTokenSaved, setGroqTokenSaved] = useState(false);
  const [isReplacingGroq, setIsReplacingGroq] = useState(false);
  const [groqTokenError, setGroqTokenError] = useState('');

  // ── Groq model state ───────────────────────────────────────
  const [groqModelInput, setGroqModelInput] = useState('');
  const [groqModelSaved, setGroqModelSaved] = useState(false);
  const [groqModelError, setGroqModelError] = useState('');

  // Seed groqModelInput once from settings. Use a ref guard to prevent settings
  // refetch (triggered by token save → cache invalidation) from overwriting a
  // value the user has typed but not yet saved.
  const groqModelInitialized = useRef(false);
  useEffect(() => {
    if (!groqModelInitialized.current && settings?.reflectionModel) {
      setGroqModelInput(settings.reflectionModel);
      groqModelInitialized.current = true;
    }
  }, [settings?.reflectionModel]);

  // ── HF handlers (unchanged from original) ─────────────────

  const handleThemeToggle = (theme: 'dark' | 'light') => {
    updateTheme.mutate(theme);
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setTokenError('');
    if (!tokenInput.trim()) return;

    try {
      await saveHFToken.mutateAsync(tokenInput.trim());
      setTokenInput('');
      setTokenSaved(true);
      setIsReplacing(false);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to save token');
    }
  };

  const handleReplace = () => {
    setIsReplacing(true);
    setTokenSaved(false);
    setTokenError('');
    setTokenInput('');
  };

  const handleCancelReplace = () => {
    setIsReplacing(false);
    setTokenError('');
    setTokenInput('');
  };

  // ── Groq handlers ─────────────────────────────────────────

  const handleSaveGroqToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setGroqTokenError('');
    if (!groqTokenInput.trim()) return;

    try {
      await saveGroqToken.mutateAsync(groqTokenInput.trim());
      setGroqTokenInput('');
      setGroqTokenSaved(true);
      setIsReplacingGroq(false);
    } catch (err) {
      setGroqTokenError(err instanceof Error ? err.message : 'Failed to save Groq token');
    }
  };

  const handleReplaceGroq = () => {
    setIsReplacingGroq(true);
    setGroqTokenSaved(false);
    setGroqTokenError('');
    setGroqTokenInput('');
  };

  const handleCancelReplaceGroq = () => {
    setIsReplacingGroq(false);
    setGroqTokenError('');
    setGroqTokenInput('');
  };

  const handleSaveGroqModel = async (e: React.FormEvent) => {
    e.preventDefault();
    setGroqModelError('');
    if (!groqModelInput.trim()) return;

    try {
      await updateGroqModel.mutateAsync(groqModelInput.trim());
      setGroqModelSaved(true);
      setTimeout(() => setGroqModelSaved(false), 3000);
    } catch (err) {
      setGroqModelError(err instanceof Error ? err.message : 'Failed to save model');
    }
  };

  if (isLoading) {
    return (
      <div className="page settings-page">
        <div className="loading-spinner" />
      </div>
    );
  }

  // Settings failed to load — most likely cause is a missing database migration.
  // The groq_model / groq_token_encrypted columns were added in migration 004.
  // Show an actionable error rather than a silently broken page.
  if (settingsError) {
    return (
      <div className="page settings-page">
        <h1>Settings</h1>
        <div className="settings-error-banner">
          <strong>Settings could not be loaded.</strong>
          <p style={{ marginTop: '0.5rem', marginBottom: 0 }}>
            This usually means a database migration has not been applied. Run the
            following migrations in order in the Supabase SQL Editor:
          </p>
          <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem', marginBottom: 0 }}>
            <li><code>src/db/migrations/003_reflection_type.sql</code></li>
            <li><code>src/db/migrations/004_groq_provider_settings.sql</code></li>
          </ol>
          <p style={{ marginTop: '0.5rem', marginBottom: 0 }}>
            After running the migrations, refresh this page.
          </p>
        </div>
      </div>
    );
  }

  const currentTheme = settings?.theme ?? 'dark';

  return (
    <div className="page settings-page">
      <h1>Settings</h1>

      {/* ── Appearance ─────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Appearance</h2>
        <p className="settings-section-desc">Choose how UnSaid looks.</p>

        <div className="theme-toggle-group">
          <button
            className={`theme-option ${currentTheme === 'dark' ? 'theme-option-active' : ''}`}
            onClick={() => handleThemeToggle('dark')}
            type="button"
          >
            <span className="theme-option-icon">🌙</span>
            <span>Dark</span>
          </button>
          <button
            className={`theme-option ${currentTheme === 'light' ? 'theme-option-active' : ''}`}
            onClick={() => handleThemeToggle('light')}
            type="button"
          >
            <span className="theme-option-icon">☀️</span>
            <span>Light</span>
          </button>
        </div>

        {updateTheme.isError && (
          <p className="form-error" style={{ marginTop: '0.5rem' }}>
            Failed to save theme preference.
          </p>
        )}
      </section>

      {/* ── AI Configuration ───────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">AI Configuration</h2>

        {/* ── Emotion Analysis (HuggingFace) ─────────── */}
        <h3 className="settings-subsection-title">Emotion Analysis (HuggingFace)</h3>
        <p className="settings-section-desc">
          Used to detect the emotional tone of your journal entries.
          Your token is encrypted server-side and never returned to this device.
        </p>

        {tokenSaved ? (
          <div className="token-status token-configured">
            <span className="token-status-icon">✓</span>
            <span>Token saved successfully</span>
          </div>
        ) : settings?.aiConfigured && !isReplacing ? (
          <div className="token-status token-configured">
            <span className="token-status-icon">✓</span>
            <span>Token configured</span>
            <button
              className="btn-ghost btn-sm"
              onClick={handleReplace}
              type="button"
            >
              Replace
            </button>
          </div>
        ) : (
          <form className="settings-token-form" onSubmit={handleSaveToken}>
            <div className="form-group">
              <label htmlFor="hf-token" className="form-label">
                {isReplacing ? 'New HuggingFace Access Token' : 'HuggingFace Access Token'}
              </label>
              <input
                id="hf-token"
                type="password"
                className="form-input"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="hf_••••••••••••••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
                autoFocus={isReplacing}
              />
              <p className="settings-hint">
                Get a read token from{' '}
                <a
                  href="https://huggingface.co/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  huggingface.co/settings/tokens
                </a>
                . It is encrypted immediately and never displayed again.
              </p>
            </div>

            {tokenError && <p className="form-error">{tokenError}</p>}

            <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
              <button
                type="submit"
                className="btn-primary"
                disabled={saveHFToken.isPending || !tokenInput.trim()}
              >
                {saveHFToken.isPending ? 'Saving…' : isReplacing ? 'Save New Token' : 'Save Token'}
              </button>
              {isReplacing && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={handleCancelReplace}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        <div className="settings-model-info">
          <span className="settings-label">Model</span>
          <code className="settings-model-name">
            {settings?.aiModel ?? 'j-hartmann/emotion-english-distilroberta-base'}
          </code>
        </div>

        {/* Show nudge only when HF is configured but Groq is not */}
        {settings?.aiConfigured && !settings?.reflectionConfigured && (
          <p className="settings-hint" style={{ marginTop: 'var(--space-sm)' }}>
            Configure Groq below to unlock richer reflections.
          </p>
        )}

        {/* ── Reflection Generation (Groq) ──────────── */}
        <h3 className="settings-subsection-title" style={{ marginTop: 'var(--space-xl)' }}>
          Reflection Generation (Groq)
        </h3>
        <p className="settings-section-desc">
          Used to generate reflection summaries and follow-up questions from your entries.
          Your token is encrypted server-side and never returned to this device.
        </p>

        {groqTokenSaved ? (
          <div className="token-status token-configured">
            <span className="token-status-icon">✓</span>
            <span>Token saved successfully</span>
          </div>
        ) : settings?.reflectionConfigured && !isReplacingGroq ? (
          <div className="token-status token-configured">
            <span className="token-status-icon">✓</span>
            <span>Token configured</span>
            <button
              className="btn-ghost btn-sm"
              onClick={handleReplaceGroq}
              type="button"
            >
              Replace
            </button>
          </div>
        ) : (
          <form className="settings-token-form" onSubmit={handleSaveGroqToken}>
            <div className="form-group">
              <label htmlFor="groq-token" className="form-label">
                {isReplacingGroq ? 'New Groq API Key' : 'Groq API Key'}
              </label>
              <input
                id="groq-token"
                type="password"
                className="form-input"
                value={groqTokenInput}
                onChange={(e) => setGroqTokenInput(e.target.value)}
                placeholder="gsk_••••••••••••••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
                autoFocus={isReplacingGroq}
              />
              <p className="settings-hint">
                Get an API key from{' '}
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  console.groq.com/keys
                </a>
                . It is encrypted immediately and never displayed again.
              </p>
            </div>

            {groqTokenError && <p className="form-error">{groqTokenError}</p>}

            <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
              <button
                type="submit"
                className="btn-primary"
                disabled={saveGroqToken.isPending || !groqTokenInput.trim()}
              >
                {saveGroqToken.isPending ? 'Saving…' : isReplacingGroq ? 'Save New Token' : 'Save Token'}
              </button>
              {isReplacingGroq && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={handleCancelReplaceGroq}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        {/* ── Groq model ────────────────────────────────
            Redesigned as a standard vertical form-group to keep the Save button
            in a fixed position regardless of error/success state.
            The previous implementation placed this inside .settings-model-info
            (a display:flex; width:fit-content container) and rendered the error
            message as a sibling flex child outside the form — causing the button
            to shift whenever an error appeared.
        ─────────────────────────────────────────────── */}
        <form
          className="settings-token-form"
          onSubmit={handleSaveGroqModel}
          style={{ marginTop: 'var(--space-lg)' }}
        >
          <div className="form-group">
            <label htmlFor="groq-model" className="form-label">
              Model
            </label>
            <input
              id="groq-model"
              type="text"
              className="form-input"
              value={groqModelInput}
              onChange={(e) => {
                setGroqModelInput(e.target.value);
                setGroqModelSaved(false);
                setGroqModelError('');
              }}
              placeholder="llama-3.1-8b-instant"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="settings-hint">
              Groq model identifier. Defaults to{' '}
              <code style={{ fontSize: '0.78rem' }}>llama-3.1-8b-instant</code>.
              See{' '}
              <a
                href="https://console.groq.com/docs/models"
                target="_blank"
                rel="noopener noreferrer"
              >
                console.groq.com/docs/models
              </a>{' '}
              for available models.
            </p>
          </div>

          {/* Error always appears below the input, above the button row —
              the button row is the last element and never moves */}
          {groqModelError && <p className="form-error">{groqModelError}</p>}

          <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={updateGroqModel.isPending || !groqModelInput.trim()}
            >
              {updateGroqModel.isPending ? 'Saving…' : 'Save Model'}
            </button>
            {groqModelSaved && (
              <span style={{ fontSize: '0.78rem', color: 'var(--success)' }}>
                ✓ Model saved
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
