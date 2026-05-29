/**
 * @board-studio/accounts — auth (Supabase) and the single Free/Pro/Team
 * entitlement seam. All tier gating goes through `useEntitlements().can(...)`
 * or `<RequireTier>`; never scatter `if (isPro)` checks (CLAUDE.md principle 5).
 */
export { isAuthConfigured, supabase } from './supabase';
export { AuthProvider, useSession, type AuthState } from './auth';
export { useEntitlements, type Entitlements } from './entitlements';
export { RequireTier, type RequireTierProps } from './gate';
export { FEATURE_MIN_TIER, resolveTier, tierAllows, type Feature, type Tier } from './tiers';
