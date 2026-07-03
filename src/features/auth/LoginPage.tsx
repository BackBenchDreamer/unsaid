/**
 * Login Page — magic link sign-in.
 * Minimal, typographic. Large serif logo, generous spacing.
 */

import React, { useState } from 'react';
import { useAuth } from '../../app/providers/AuthProvider';
import { APP_NAME, APP_TAGLINE } from '../../shared/constants';

function MailIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: 'var(--accent)' }}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

export default function LoginPage() {
  const { signInWithOtp, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  if (isAuthenticated) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await signInWithOtp(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send magic link');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-brand">
          <h1 className="auth-logo">{APP_NAME}</h1>
          <p className="auth-tagline">{APP_TAGLINE}</p>
        </div>

        {sent ? (
          <div className="auth-message">
            <div className="auth-icon-wrap">
              <MailIcon />
            </div>
            <h2>Check your inbox</h2>
            <p>
              We sent a magic link to <strong>{email}</strong>.
              Click it to sign in — no password needed.
            </p>
            <button
              className="btn-ghost"
              onClick={() => { setSent(false); setEmail(''); }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email address
              </label>
              <input
                id="email"
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                autoComplete="email"
                disabled={isSubmitting}
              />
            </div>

            {error && <p className="form-error">{error}</p>}

            <button
              type="submit"
              className="btn-primary btn-full"
              disabled={isSubmitting || !email}
            >
              {isSubmitting ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}

        <p className="auth-footer">
          This is an invite-only journal. New accounts are reviewed before access is granted.
        </p>
      </div>
    </div>
  );
}
