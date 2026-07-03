/**
 * AuthCallbackPage — handles the PKCE magic-link callback.
 *
 * Supabase JS v2.60+ uses PKCE flow by default. After the user clicks the
 * magic link, Supabase verifies the token server-side and redirects here with
 * a short-lived `?code=` query parameter. This page calls
 * exchangeCodeForSession() to trade that code for a real session, then
 * navigates the user away. If it fails, it drops to /login with an error
 * message so the user can try again.
 *
 * This route must be registered in:
 *   1. src/app/router.tsx              — as <Route path="/auth/callback" .../>
 *   2. Supabase Dashboard              — Authentication → URL Configuration →
 *                                        Redirect URLs: http://localhost:5173/auth/callback
 *                                        (and your production domain equivalent)
 *   3. authService.signInWithOtp()     — emailRedirectTo points here
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../services/supabaseClient';

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  // Guard against React StrictMode double-invoke
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const code = new URLSearchParams(window.location.search).get('code');

    if (!code) {
      // No code — could be an old implicit-flow hash link. Supabase JS will
      // have already processed it via detectSessionInUrl. Just go home and
      // let the router decide based on auth state.
      navigate('/', { replace: true });
      return;
    }

    supabase.auth
      .exchangeCodeForSession(code)
      .then(({ error }) => {
        if (error) {
          // Code expired or already used — send back to login with message.
          navigate('/login?error=link_expired', { replace: true });
        } else {
          // Session established. onAuthStateChange will fire SIGNED_IN and
          // load the profile. Navigate to root so ProtectedRoute decides
          // the correct destination (/waitlist if pending, / if approved).
          navigate('/', { replace: true });
        }
      });
  }, [navigate]);

  return (
    <div className="loading-screen">
      <div className="loading-spinner" />
    </div>
  );
}
