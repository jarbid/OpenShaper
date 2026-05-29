import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The subset of Vite-injected env we read. Typed locally (rather than via
 * `vite/client`) so this package builds standalone with `tsc`.
 */
interface AccountsEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_DEV_TIER?: string;
}

const env: AccountsEnv = (import.meta as unknown as { env?: AccountsEnv }).env ?? {};

const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

/**
 * True when Supabase credentials are present. When false the app runs in
 * local-first mode: no auth, everyone is on the free tier, and nothing talks to
 * the network. This is the default developer experience (no project required).
 */
export const isAuthConfigured = Boolean(url && anonKey);

/** Shared Supabase client, or `null` when auth is not configured. */
export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(url!, anonKey!)
  : null;

/**
 * Dev-only tier override (`VITE_DEV_TIER`) used to exercise Pro/Team gates
 * before Stripe billing exists. Returns `null` when unset.
 */
export const readDevTier = (): string | null => env.VITE_DEV_TIER ?? null;
