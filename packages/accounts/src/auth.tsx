import type { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isAuthConfigured, supabase } from './supabase';

/** Result of a sign-in attempt: `{}` on success, `{ error }` otherwise. */
type AuthResult = { error?: string };

export interface AuthState {
  user: User | null;
  session: Session | null;
  /** True while the initial session is being restored. */
  loading: boolean;
  /** False when Supabase is not configured — the app is in local mode. */
  configured: boolean;
  signInWithPassword: (email: string, password: string) => Promise<AuthResult>;
  /** Email magic-link / OTP sign-in. */
  signInWithOtp: (email: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const notConfigured: AuthResult = { error: 'Auth is not configured' };

/**
 * Provides auth state to the tree. Subscribes to Supabase auth changes when
 * configured; otherwise yields a stable signed-out, local-mode state.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isAuthConfigured);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      configured: isAuthConfigured,
      async signInWithPassword(email, password) {
        if (!supabase) return notConfigured;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return error ? { error: error.message } : {};
      },
      async signInWithOtp(email) {
        if (!supabase) return notConfigured;
        const { error } = await supabase.auth.signInWithOtp({ email });
        return error ? { error: error.message } : {};
      },
      async signOut() {
        await supabase?.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Read auth state. Must be called inside an {@link AuthProvider}. */
export function useSession(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useSession must be used within <AuthProvider>');
  return ctx;
}
