import type { Knot } from '@openshaper/kernel';
import type { SplineTarget } from '@openshaper/store';

export type TangentKind = 'prev' | 'next';
export type HandleSide = 'left' | 'right';

/**
 * Map a visual left/right handle to its spline-direction identity.
 *
 * Outline and rocker splines use the established prev=left / next=right convention.
 * A cross-section travels out from the centerline and then back in, so its handle
 * order must follow the two handles' actual horizontal positions at each knot.
 */
export const handleKindForVisualSide = (
  knot: Knot,
  target: SplineTarget,
  side: HandleSide,
): TangentKind => {
  const leftKind: TangentKind =
    target.kind === 'crossSection' && knot.tangentToPrev.x > knot.tangentToNext.x ? 'next' : 'prev';
  return side === 'left' ? leftKind : leftKind === 'prev' ? 'next' : 'prev';
};

/** Inverse of `handleKindForVisualSide`, used by labels for an existing selection. */
export const visualSideForHandleKind = (
  knot: Knot,
  target: SplineTarget,
  kind: TangentKind,
): HandleSide => (handleKindForVisualSide(knot, target, 'left') === kind ? 'left' : 'right');
