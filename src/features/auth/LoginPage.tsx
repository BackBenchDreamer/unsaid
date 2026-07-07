/**
 * Login Page — magic link sign-in.
 *
 * Three-state flow: idle → confirming → sent
 *
 *  idle       — email form; client-side typo validation runs on submit
 *  confirming — shows the entered email for explicit confirmation before
 *               any Supabase call (and thus any auth.users row) is made
 *  sent       — magic link dispatched; user told to check inbox
 *
 * Typo validation catches common domain misspellings and TLD errors so
 * phantom auth.users rows are blocked before they reach the network.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../app/providers/AuthProvider';
import { APP_NAME, APP_TAGLINE } from '../../shared/constants';

// ─── Typo detection ────────────────────────────────────────────────────────

/** TLD suffixes that are almost never real — usually a mis-key of .com/.net */
const SUSPICIOUS_TLDS = new Set([
  '.con', '.ocm', '.cmo', '.cpm', '.nte', '.rog', '.ogr', '.vom', '.cok',
]);

/** Common provider domains that are frequently mis-typed */
const MISTYPED_DOMAINS = new Set([
  'gamil.com', 'gmai.com', 'gmial.com', 'gmal.com', 'gmali.com',
  'yaho.com', 'yahooo.com', 'yhoo.com',
  'hotmial.com', 'hotmal.com', 'homail.com', 'hotmaill.com',
  'outlok.com', 'outloo.com', 'outlookk.com',
]);

/**
 * Returns a human-readable error string if the email looks like a typo,
 * or null if it passes all checks.
 */
function validateEmail(email: string): string | null {
  const lower = email.toLowerCase().trim();

  // Must contain exactly one @
  const atIdx = lower.lastIndexOf('@');
  if (atIdx < 1) return 'Please enter a valid email address.';

  const domain = lower.slice(atIdx + 1);
  if (!domain || !domain.includes('.')) return 'Please enter a valid email address.';

  // Check full domain against known mistyped providers
  if (MISTYPED_DOMAINS.has(domain)) {
    return `"${domain}" looks like a typo — did you mean a different domain?`;
  }

  // Check TLD against suspicious suffixes
  const dotIdx = domain.lastIndexOf('.');
  if (dotIdx !== -1) {
    const tld = domain.slice(dotIdx); // e.g. ".con"
    if (SUSPICIOUS_TLDS.has(tld)) {
      return `The domain ends in "${tld}" — is that correct? Common fix: "${tld.replace(/[co]{2,}$/, 'com')}"`;
    }
  }

  return null;
}

// ─── Icons ─────────────────────────────────────────────────────────────────

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

// ─── Component ─────────────────────────────────────────────────────────────

type FlowState = 'idle' | 'confirming' | 'sent';

export default function LoginPage() {
  const { signInWithOtp, isAuthenticated, isLoading, isApproved, isPending } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [flow, setFlow] = useState<FlowState>('idle');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Pre-populate error from ?error= query param (e.g. link_expired from /auth/callback)
  const [error, setError] = useState<string>(() => {
    const e = searchParams.get('error');
    if (e === 'link_expired') return 'That link has expired or already been used. Request a new one.';
    return '';
  });

  // Redirect authenticated users away from /login.
  // This handles three scenarios:
  //   1. User navigates to /login while already authenticated.
  //   2. User is on the "sent" waiting screen and authentication completes in
  //      another browser tab (cross-tab magic link sign-in).
  //   3. User refreshes /login after a session is already stored locally.
  // We wait until isLoading=false so we only act on settled auth state and
  // never redirect on the transient initial-load window where session is
  // being re-hydrated.
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) return;

    if (isApproved) {
      navigate('/', { replace: true });
    } else if (isPending) {
      navigate('/waitlist', { replace: true });
    } else {
      // Authenticated but not yet approved/pending — let ProtectedRoute decide.
      navigate('/', { replace: true });
    }
  }, [isLoading, isAuthenticated, isApproved, isPending, navigate]);

  // While auth is loading or we're about to redirect, render nothing.
  if (isLoading || isAuthenticated) return null;

  // ── idle: validate then advance to confirming ──────────────────────────
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const typoError = validateEmail(email);
    if (typoError) {
      setError(typoError);
      return;
    }

    setFlow('confirming');
  };

  // ── confirming: send the magic link ───────────────────────────────────
  const handleConfirm = async () => {
    setError('');
    setIsSubmitting(true);
    try {
      await signInWithOtp(email);
      setFlow('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send magic link');
      setFlow('idle'); // drop back to form so user can retry
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = () => {
    setFlow('idle');
    setError('');
    // email value preserved so the user can correct it in-place
  };

  // ── sent: try a different email ────────────────────────────────────────
  const handleReset = () => {
    setFlow('idle');
    setEmail('');
    setError('');
  };

  return (
    <div className="auth-page">
      <div className="auth-container">

        <div className="auth-brand">
          <h1 className="auth-logo">{APP_NAME}</h1>
          <p className="auth-tagline">{APP_TAGLINE}</p>
        </div>

        {/* ── sent ─────────────────────────────────────────────────── */}
        {flow === 'sent' && (
          <div className="auth-message">
            <div className="auth-icon-wrap">
              <MailIcon />
            </div>
            <h2>Check your inbox</h2>
            <p>
              We sent a magic link to <strong>{email}</strong>.
              Click it to sign in — no password needed.
            </p>
            <button className="btn-ghost" onClick={handleReset} type="button">
              Use a different email
            </button>
          </div>
        )}

        {/* ── confirming ───────────────────────────────────────────── */}
        {flow === 'confirming' && (
          <div className="auth-message">
            <div className="auth-icon-wrap">
              <MailIcon />
            </div>
            <h2>Confirm your email</h2>
            <p>
              We'll send a magic link to:
            </p>
            <p style={{ fontWeight: 600, wordBreak: 'break-all', margin: '0.25rem 0 1rem' }}>
              {email}
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
              Make sure that's correct — the link only works for this address.
            </p>
            {error && <p className="form-error">{error}</p>}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button
                className="btn-primary"
                onClick={handleConfirm}
                disabled={isSubmitting}
                type="button"
              >
                {isSubmitting ? 'Sending…' : 'Yes, send the link'}
              </button>
              <button
                className="btn-ghost"
                onClick={handleEdit}
                disabled={isSubmitting}
                type="button"
              >
                Edit email
              </button>
            </div>
          </div>
        )}

        {/* ── idle ─────────────────────────────────────────────────── */}
        {flow === 'idle' && (
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
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
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
              disabled={isSubmitting || !email.trim()}
            >
              Send magic link
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
