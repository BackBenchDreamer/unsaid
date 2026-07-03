/**
 * Auth Context — provides authentication state to the entire app.
 *
 * This is the single source of auth truth in the React tree.
 * It reads from the service layer, never from Supabase directly.
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { authService } from '../../services/authService';
import type { AppUser } from '../../entities/user';

interface AuthContextValue {
  session: Session | null;
  user: AppUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isApproved: boolean;
  isAdmin: boolean;
  isPending: boolean;
  signInWithOtp: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const profile = await authService.getProfile();
      setUser(profile);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Initial session load.
    authService.getSession().then(({ session: s }) => {
      setSession(s);
      if (s) {
        loadProfile().finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    // Listen for auth state changes (magic link callback, tab focus refresh, sign-out).
    // MUST set isLoading=true before the async profile fetch so the router never makes
    // routing decisions in the window where session exists but user is still null.
    // Without this, clicking a magic link causes: session=set, user=null → ProtectedRoute
    // sees isApproved=false and redirects to /login before the profile even arrives.
    const { data: { subscription } } = authService.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) {
        setIsLoading(true);
        loadProfile().finally(() => setIsLoading(false));
      } else {
        setUser(null);
        setIsLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [loadProfile]);

  const signInWithOtp = useCallback(async (email: string) => {
    await authService.signInWithOtp(email);
  }, []);

  const signOut = useCallback(async () => {
    await authService.signOut();
    setSession(null);
    setUser(null);
  }, []);

  const value: AuthContextValue = {
    session,
    user,
    isLoading,
    isAuthenticated: !!session,
    isApproved: user?.status === 'approved',
    isAdmin: user?.role === 'admin',
    isPending: user?.status === 'pending',
    signInWithOtp,
    signOut,
    refreshProfile: loadProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- provider pattern: hook must live alongside its context
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
