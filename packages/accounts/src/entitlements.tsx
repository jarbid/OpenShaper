import { useMemo } from 'react';
import { useSession } from './auth';
import { readDevTier } from './supabase';
import { resolveTier, tierAllows, type Feature, type Tier } from './tiers';

export interface Entitlements {
  /** The user's effective tier. */
  tier: Tier;
  /** The single gate check — use this everywhere instead of `if (isPro)`. */
  can: (feature: Feature) => boolean;
}

/**
 * The single entitlement seam. Resolves the effective tier from the dev
 * override, then the signed-in account, then `free`, and exposes `can(feature)`.
 *
 * Tier currently comes from the user's `app_metadata.tier`; once Stripe billing
 * lands it will be backed by the `subscriptions` table (read through here, so no
 * call site changes).
 */
export function useEntitlements(): Entitlements {
  const { user } = useSession();
  return useMemo(() => {
    const meta = user?.app_metadata as { tier?: string } | undefined;
    const tier = resolveTier({ devTier: readDevTier(), accountTier: meta?.tier ?? null });
    return { tier, can: (feature: Feature) => tierAllows(tier, feature) };
  }, [user]);
}
