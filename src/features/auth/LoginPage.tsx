/**
 * Login Page — magic link (OTP) authentication.
 */

import React, { useState } from 'react';
import { useAuth } from '../../app/providers/AuthProvider';
import { APP_NAME, APP_TAGLINE } from '../../shared/constants';

export default function LoginPage() {
  const { signInWithOtp, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  // If already authenticated, the router will redirect.
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
            <div className="auth-icon">✉️</div>
            <h2>Check your email</h2>
            <p>
              We sent a magic link to <strong>{email}</strong>.
              Click the link to sign in.
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
              <label htmlFor="email" className="form-label">Email address</label>
              <input
                id="email"
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                disabled={isSubmitting}
              />
            </div>

            {error && <p className="form-error">{error}</p>}

            <button
              type="submit"
              className="btn-primary btn-full"
              disabled={isSubmitting || !email}
            >
              {isSubmitting ? 'Sending...' : 'Send Magic Link'}
            </button>
          </form>
        )}

        <p className="auth-footer">
          This is an invite-only journal. If you don't have access yet,
          your account will be reviewed after sign-up.
        </p>
      </div>
    </div>
  );
}
