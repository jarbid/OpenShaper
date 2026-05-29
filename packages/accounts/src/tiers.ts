/**
 * The Free / Pro / Team tier model and the pure entitlement logic behind the
 * single gate seam. No React, no Supabase — kept pure so it is unit-testable
 * and so every gate decision in the app funnels through one place.
 */

export type Tier = 'free' | 'pro' | 'team';

/**
 * A gateable capability. Features absent from {@link FEATURE_MIN_TIER} are free
 * for everyone (e.g. PDF export, native save). Add a feature here only when it
 * needs a minimum tier.
 */
export type Feature =
  | 'export.pdf'
  | 'export.stl'
  | 'export.dxf'
  | 'cloud.sync'
  | 'boards.unlimited';

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, team: 2 };

/** Minimum tier required for each gated feature. Unlisted features are free. */
export const FEATURE_MIN_TIER: Partial<Record<Feature, Tier>> = {
  'export.stl': 'pro',
  'export.dxf': 'pro',
  'cloud.sync': 'pro',
  'boards.unlimited': 'pro',
};

/** Whether a tier is high enough to use a feature. */
export function tierAllows(tier: Tier, feature: Feature): boolean {
  const min = FEATURE_MIN_TIER[feature];
  return min === undefined ? true : TIER_RANK[tier] >= TIER_RANK[min];
}

function isTier(value: unknown): value is Tier {
  return value === 'free' || value === 'pro' || value === 'team';
}

/**
 * Resolve the effective tier. Precedence (highest first):
 *   1. a dev override (e.g. `VITE_DEV_TIER`) — for testing gates without Stripe,
 *   2. the signed-in account's tier (from a subscription row / app_metadata),
 *   3. `free`.
 * Unknown/empty values are ignored at each step.
 */
export function resolveTier(opts: { devTier?: string | null; accountTier?: string | null }): Tier {
  if (isTier(opts.devTier)) return opts.devTier;
  if (isTier(opts.accountTier)) return opts.accountTier;
  return 'free';
}
