/**
 * AuthCallbackPage — handles the magic-link PKCE callback.
 *
 * Flow:
 *   1. Page loads with ?code= in URL (PKCE) or #access_token= in hash (implicit).
 *   2. For PKCE: we call exchangeCodeForSession(). Supabase's detectSessionInUrl
 *      handles the implicit/hash flow automatically before this component mounts.
 *   3. We then WAIT for AuthProvider to finish loading (isLoading → false) rather
 *      than navigating immediately after the exchange. This avoids the race where
 *      navigate('/') fires before onAuthStateChange has updated the auth state,
 *      causing ProtectedRoute to see isAuthenticated=false and redirect to /login.
 *   4. Once isLoading=false, we redirect based on the actual auth state:
 *        - isApproved  → /  (dashboard)
 *        - isPending   → /waitlist
 *        - otherwise   → /login
 *
 * Error cases:
 *   - URL contains ?error= (Supabase-returned error)
 *   - exchangeCodeForSession() fails
 *   - isLoading=false but !isAuthenticated (exchange silently failed)
 *
 * This page is NEVER permanently visible — it always redirects or shows an error.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../services/supabaseClient';
import { useAuth } from '../../app/providers/AuthProvider';

type ExchangeState = 'pending' | 'done' | 'error';

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { isLoading, isAuthenticated, isApproved, isPending } = useAuth();
  const exchanged = useRef(false);
  const [exchangeState, setExchangeState] = useState<ExchangeState>('pending');
  const [errorMessage, setErrorMessage] = useState('');

  // ── Step 1: Exchange the code (runs once) ──────────────────
  useEffect(() => {
    // Guard against React StrictMode double-invoke
    if (exchanged.current) return;
    exchanged.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const errorParam = params.get('error');
    const errorDescription = params.get('error_description');

    // Supabase returned an error in the URL (e.g. link expired before click)
    if (errorParam) {
      const msg = errorDescription
        ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
        : 'The magic link is invalid or has expired. Please request a new one.';
      // Use setTimeout to avoid the "setState synchronously in an effect" lint rule.
      // The URL error check is synchronous but the state updates must be deferred.
      setTimeout(() => {
        setErrorMessage(msg);
        setExchangeState('error');
      }, 0);
      return;
    }

    if (!code) {
      // No PKCE code in URL.
      // This happens when:
      //   a) The implicit flow was used (Supabase already handled #access_token= hash).
      //   b) The user refreshed the callback page after a successful exchange.
      //   c) The callback was navigated to programmatically.
      // In all cases, mark exchange as done and let the redirect effect below decide.
      setTimeout(() => setExchangeState('done'), 0);
      return;
    }

    // PKCE code exchange
    supabase.auth
      .exchangeCodeForSession(code)
      .then(({ error }) => {
        if (error) {
          setErrorMessage(
            error.message.includes('expired') || error.message.includes('invalid')
              ? 'This magic link has expired or already been used. Please request a new one.'
              : `Sign-in failed: ${error.message}`,
          );
          setExchangeState('error');
        } else {
          // Code exchange succeeded. onAuthStateChange in AuthProvider will fire
          // SIGNED_IN → set isLoading=true → loadProfile(). We do NOT navigate here.
          // Instead, Step 2 below watches for isLoading=false to redirect.
          setExchangeState('done');
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Unexpected error during sign-in.';
        setErrorMessage(msg);
        setExchangeState('error');
      });
  }, []); // navigate not included intentionally — it is stable and adding it causes re-runs

  // ── Step 2: Redirect once auth state has settled ───────────
  // We wait until BOTH conditions are true:
  //   - exchangeState === 'done'  (code exchange completed or was a no-op)
  //   - isLoading === false       (AuthProvider finished loading the profile)
  //
  // This prevents the race condition where we navigate to / before
  // onAuthStateChange has had a chance to set isAuthenticated=true, which
  // would cause ProtectedRoute to redirect us back to /login.
  useEffect(() => {
    if (exchangeState !== 'done') return;
    if (isLoading) return;

    if (isAuthenticated && isApproved) {
      navigate('/', { replace: true });
    } else if (isAuthenticated && isPending) {
      navigate('/waitlist', { replace: true });
    } else if (isAuthenticated) {
      // Authenticated but not approved and not pending — edge case (rejected?).
      // Let ProtectedRoute handle it.
      navigate('/', { replace: true });
    } else {
      // Exchange appeared to succeed but auth state says not authenticated.
      // This shouldn't happen normally — navigate to login as a safe fallback.
      navigate('/login', { replace: true });
    }
  }, [exchangeState, isLoading, isAuthenticated, isApproved, isPending, navigate]);

  // ── Render ─────────────────────────────────────────────────

  if (exchangeState === 'error') {
    return (
      <div className="loading-screen">
        <div
          style={{
            textAlign: 'center',
            maxWidth: '380px',
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <p style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>🔗</p>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 600,
              marginBottom: '0.5rem',
              color: 'var(--text-primary)',
            }}
          >
            Link expired
          </h2>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
              marginBottom: '1.5rem',
              lineHeight: 1.5,
            }}
          >
            {errorMessage}
          </p>
          <a
            href="/login"
            style={{
              display: 'inline-block',
              padding: '0.5rem 1.25rem',
              background: 'var(--accent-dim)',
              color: 'var(--accent)',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  // pending or done-but-still-loading — show a full-page spinner with text
  return (
    <div className="loading-screen">
      <div className="loading-spinner" />
      <p
        style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}
      >
        Signing you in…
      </p>
    </div>
  );
}
