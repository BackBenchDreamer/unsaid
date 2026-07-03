/**
 * Settings Page — user preferences and AI configuration.
 *
 * Sections:
 *   1. Appearance — dark/light theme toggle
 *   2. AI Integration — HuggingFace token (write-only after save)
 */

import { useState } from 'react';
import { useSettings, useUpdateTheme, useSaveHFToken } from './hooks';

export default function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const updateTheme = useUpdateTheme();
  const saveToken = useSaveHFToken();

  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  // isReplacing: true while the user is actively replacing a previously saved token.
  // Required because aiConfigured stays true (from the DB) until the new token is saved,
  // so toggling tokenSaved alone is not enough to reveal the form.
  const [isReplacing, setIsReplacing] = useState(false);
  const [tokenError, setTokenError] = useState('');

  const handleThemeToggle = (theme: 'dark' | 'light') => {
    updateTheme.mutate(theme);
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setTokenError('');
    if (!tokenInput.trim()) return;

    try {
      await saveToken.mutateAsync(tokenInput.trim());
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

  if (isLoading) {
    return (
      <div className="page settings-page">
        <div className="loading-spinner" />
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

      {/* ── AI Integration ─────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">AI Integration</h2>
        <p className="settings-section-desc">
          UnSaid uses HuggingFace to analyse the emotional tone of your entries.
          Your token is encrypted server-side and never returned to this device.
        </p>

        {tokenSaved ? (
          // Just saved — confirm state
          <div className="token-status token-configured">
            <span className="token-status-icon">✓</span>
            <span>Token saved successfully</span>
          </div>
        ) : settings?.aiConfigured && !isReplacing ? (
          // Token already on file and user hasn't clicked Replace yet
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
          // No token saved yet, OR user clicked Replace
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
                disabled={saveToken.isPending || !tokenInput.trim()}
              >
                {saveToken.isPending ? 'Saving…' : isReplacing ? 'Save New Token' : 'Save Token'}
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
      </section>
    </div>
  );
}
