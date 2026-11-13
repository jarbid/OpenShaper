import type { Knot } from '@openshaper/kernel';
import { isStationTarget, type SplineTarget } from '@openshaper/store';

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

/**
 * What to call a knot's two tangent handles, in this spline's own terms.
 *
 * "Left" and "right" described where the handles are *drawn*, which stopped being
 * true when the board turn started drawing outline and rocker nose-up on a portrait
 * pane: the "left" handle is then below and the "right" one above. Rather than
 * thread the orientation into every label, name the handles by the thing they point
 * at — a board's tail and nose do not move when the pane does, and it is the
 * language a shaper would use anyway.
 *
 * Cross-sections keep left/right: they travel out from the centreline and back, so
 * neither end is nearer the nose, and they are never turned (a section is already
 * the shape of its pane). Their side is still resolved from the handles' actual
 * horizontal positions by {@link handleKindForVisualSide}.
 */
export const handleSideName = (target: SplineTarget, side: HandleSide): string =>
  // a rails board's station curve lies in the section's plane too
  target.kind === 'crossSection' || isStationTarget(target)
    ? side === 'left'
      ? 'Left'
      : 'Right'
    : // Outline and rocker run tail (x=0) to nose (x=length), and `prev` is the
      // lower-x neighbour — so the "left" side is the tail side in both layouts.
      side === 'left'
      ? 'Tail'
      : 'Nose';
