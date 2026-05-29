import type { ReactNode } from 'react';
import { useEntitlements } from './entitlements';
import type { Feature } from './tiers';

export interface RequireTierProps {
  /** The capability being gated. */
  feature: Feature;
  /** Rendered when the user's tier allows the feature. */
  children: ReactNode;
  /** Rendered instead (e.g. an upsell) when it does not. Defaults to nothing. */
  fallback?: ReactNode;
}

/**
 * Declarative gate: renders `children` when the current tier allows `feature`,
 * otherwise `fallback`. A thin wrapper over {@link useEntitlements} so gating
 * stays at the one seam.
 */
export function RequireTier({ feature, children, fallback = null }: RequireTierProps) {
  const { can } = useEntitlements();
  return <>{can(feature) ? children : fallback}</>;
}
