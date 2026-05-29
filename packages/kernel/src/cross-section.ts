import { lerp } from './vec2';
import type { Knot } from './knot';
import { knot } from './knot';
import { maxX, scaleSpline, type Spline } from './bezier-spline';
import { splineFromKnots } from './bezier-spline';

/**
 * A board cross-section, ported from legacy `cadcore.BezierBoardCrossSection`.
 *
 * The profile spline runs in (x = distance from centerline, y = height); the
 * centerline is x=0. `getValueAt` along it gives the bottom, `getValueAtReverse`
 * the deck. A cross-section also carries its longitudinal position on the board.
 */
export interface CrossSection {
  readonly position: number;
  readonly spline: Spline;
}

export const crossSection = (position: number, spline: Spline): CrossSection => ({
  position,
  spline,
});

/** Full width = 2 × max x of the profile (legacy getWidth). */
export const csWidth = (cs: CrossSection): number => maxX(cs.spline) * 2;

/** Deck-center minus bottom-center height (legacy getCenterThickness). */
export const csCenterThickness = (cs: CrossSection): number => {
  const k = cs.spline.knots;
  if (k.length === 0) return 0;
  return k[k.length - 1]!.end.y - k[0]!.end.y;
};

/**
 * Scale to a target thickness (vertical) and width (horizontal), legacy scale().
 * Guards mirror the legacy: clamp tiny old dimensions to 0.1 and bail if the
 * scaled result would collapse below 0.1.
 */
export const scaleCrossSection = (
  cs: CrossSection,
  newThickness: number,
  newWidth: number,
): CrossSection => {
  let oldWidth = csWidth(cs);
  let oldThickness = csCenterThickness(cs);
  if (oldWidth < 0.1) oldWidth = 0.1;
  if (oldThickness < 0.1) oldThickness = 0.1;
  const tScale = Math.abs(newThickness / oldThickness);
  const wScale = Math.abs(newWidth / oldWidth);
  if (oldThickness * tScale <= 0.1) return cs;
  if (oldWidth * wScale <= 0.1) return cs;
  return crossSection(cs.position, scaleSpline(cs.spline, tScale, wScale));
};

const lerpKnot = (a: Knot, b: Knot, t: number): Knot =>
  knot(
    lerp(a.end, b.end, t),
    lerp(a.tangentToPrev, b.tangentToPrev, t),
    lerp(a.tangentToNext, b.tangentToNext, t),
    b.continuous,
    b.other,
  );

/**
 * Interpolate from this cross-section toward `target` by t∈[0,1], legacy
 * interpolate(). The target is first scaled to this section's thickness/width,
 * then each control point is linearly blended.
 *
 * Only the equal-control-point-count path is ported (the morphing path for
 * mismatched counts is a TODO; the golden boards use uniform counts).
 */
export const interpolateCrossSection = (
  source: CrossSection,
  target: CrossSection,
  t: number,
): CrossSection => {
  const scaledTarget = scaleCrossSection(target, csCenterThickness(source), csWidth(source));
  const a = source.spline.knots;
  const b = scaledTarget.spline.knots;
  if (a.length !== b.length) {
    throw new Error(
      `interpolateCrossSection: differing control-point counts (${a.length} vs ${b.length}) ` +
        'not yet supported (legacy morph path TODO)',
    );
  }
  const blended = a.map((ak, i) => lerpKnot(ak, b[i]!, t));
  return crossSection(source.position, splineFromKnots(blended));
};
