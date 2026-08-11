// SPDX-License-Identifier: GPL-3.0-or-later
import { lerp, vec2, type Vec2 } from './vec2';
import type { Knot } from './knot';
import { knot } from './knot';
import { maxX, maxY, scaleSpline, type Spline } from './bezier-spline';
import { splineFromKnots } from './bezier-spline';
import { coeffsOf, curveFromKnots, value } from './bezier-curve';

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

// --- control-point morph (legacy BezierBoardCrossSection.interpolate count-mismatch path) ---

// Knot similarity weights (legacy BezierKnot.COMPARE_*_WEIGHT).
const COMPARE_POS_WEIGHT = 4.0;
const COMPARE_ANGLE_WEIGHT = 15.0;
const COMPARE_TANGENT_LENGTH_WEIGHT = 0.3;

const vecLen = (v: Vec2): number => Math.hypot(v.x, v.y);

/** Angle between two vectors via acos(dot/(|a||b|)); NaN→0 (legacy VecMath.getVectorAngle). */
const vectorAngle = (a: Vec2, b: Vec2): number => {
  const angle = Math.acos((a.x * b.x + a.y * b.y) / (vecLen(a) * vecLen(b)));
  return Number.isNaN(angle) ? 0 : angle;
};

const knotsEqual = (a: Knot, b: Knot): boolean =>
  a.end.x === b.end.x &&
  a.end.y === b.end.y &&
  a.tangentToPrev.x === b.tangentToPrev.x &&
  a.tangentToPrev.y === b.tangentToPrev.y &&
  a.tangentToNext.x === b.tangentToNext.x &&
  a.tangentToNext.y === b.tangentToNext.y &&
  a.continuous === b.continuous &&
  a.other === b.other;

/**
 * Knot similarity metric (legacy BezierKnot.compareTo). Smaller = better match.
 * Note the legacy truncates the result to int; reproduced here.
 */
const knotCompare = (a: Knot, b: Knot): number => {
  if (knotsEqual(a, b)) return 0;
  let retVal = 0;
  // continuity
  retVal += (a.continuous === b.continuous ? 0 : 1) * 1.0;
  // position
  let posDiff = vecLen(vec2(b.end.x - a.end.x, b.end.y - a.end.y));
  posDiff /= 0.5;
  retVal += posDiff * posDiff * COMPARE_POS_WEIGHT;
  // tangent vectors (end → handle), legacy subVector(end, handle) = handle - end
  const tt1 = vec2(a.tangentToPrev.x - a.end.x, a.tangentToPrev.y - a.end.y);
  const tt2 = vec2(a.tangentToNext.x - a.end.x, a.tangentToNext.y - a.end.y);
  const ot1 = vec2(b.tangentToPrev.x - b.end.x, b.tangentToPrev.y - b.end.y);
  const ot2 = vec2(b.tangentToNext.x - b.end.x, b.tangentToNext.y - b.end.y);
  // tangent angles (degrees / 5)
  let angleDiff = (vectorAngle(tt1, ot1) * 180.0) / Math.PI;
  let angleDiff2 = (vectorAngle(tt2, ot2) * 180.0) / Math.PI;
  angleDiff /= 5.0;
  angleDiff2 /= 5.0;
  retVal += angleDiff * angleDiff * COMPARE_ANGLE_WEIGHT;
  retVal += angleDiff2 * angleDiff2 * COMPARE_ANGLE_WEIGHT;
  // tangent lengths
  const tanLen1Diff = Math.abs(vecLen(tt1) - vecLen(ot1));
  const tanLen2Diff = Math.abs(vecLen(tt2) - vecLen(ot2));
  retVal += tanLen1Diff * tanLen1Diff * COMPARE_TANGENT_LENGTH_WEIGHT;
  retVal += tanLen2Diff * tanLen2Diff * COMPARE_TANGENT_LENGTH_WEIGHT;
  return Math.trunc(retVal);
};

/** Closest t on the cubic from knots a→b to (x,y), legacy BezierCurve.getClosestT (32-split). */
const closestT = (
  a: Knot,
  b: Knot,
  x: number,
  y: number,
  t0 = 0,
  t1 = 1,
  nrOfSplits = 32,
): number => {
  const c = coeffsOf(curveFromKnots(a, b));
  let bestT = 0;
  let minDist = 1e9;
  const seg = (t1 - t0) / nrOfSplits;
  for (let i = 0; i < nrOfSplits; i++) {
    const ct = seg * i + t0;
    if (ct < 0 || ct > 1) continue;
    const p = value(c, ct);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= minDist) {
      minDist = d;
      bestT = ct;
    }
  }
  if (bestT - (t1 - t0) / 2 < 0.001) return bestT;
  if (nrOfSplits <= 2) return bestT;
  return closestT(a, b, x, y, bestT - seg, bestT + seg, Math.floor(nrOfSplits / 2));
};

const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 =>
  vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** De Casteljau split of the cubic from a→b at t, producing the inserted knot. */
const splitKnot = (a: Knot, b: Knot, t: number): Knot => {
  // q1..q3 from control polygon [a.end, a.next, b.prev, b.end]
  const q1 = lerpVec(a.end, a.tangentToNext, t);
  const q2 = lerpVec(a.tangentToNext, b.tangentToPrev, t);
  const q3 = lerpVec(b.tangentToPrev, b.end, t);
  const r2 = lerpVec(q1, q2, t);
  const r3 = lerpVec(q2, q3, t);
  const r1 = lerpVec(r2, r3, t);
  // legacy: points[0]=r1 (end), points[1]=r2 (tangentToPrev), points[2]=r3 (tangentToNext)
  return knot(r1, r2, r3, true, false);
};

/**
 * Insert a CP into `knots` so it gains one point near `nearPoint`, adjusting the
 * neighbours' inner tangents (legacy BezierSpline.getSplitControlPoint + the
 * neighbour-tangent fix-up in BezierBoardCrossSection.interpolate). Returns the new
 * knot array, or the original if no valid insertion point is found.
 */
const insertMatchingKnot = (knots: readonly Knot[], nearPoint: Vec2): Knot[] => {
  // Find the segment whose closest point is nearest to nearPoint (spline getSplitControlPoint).
  let nearestDist = 1e8;
  let segIndex = 0;
  let bestSegT = 0;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    const tc = closestT(a, b, nearPoint.x, nearPoint.y);
    const c = coeffsOf(curveFromKnots(a, b));
    const p = value(c, tc);
    const dist = Math.hypot(p.x - nearPoint.x, p.y - nearPoint.y);
    if (nearestDist > dist) {
      nearestDist = dist;
      segIndex = i;
      bestSegT = tc;
    }
  }
  const insertIndex = segIndex + 1; // legacy returns index+1
  if (insertIndex <= 0) return [...knots];

  const prevK = knots[insertIndex - 1]!;
  const nextK = knots[insertIndex]!;
  const newKnot = splitKnot(prevK, nextK, bestSegT);

  const result = [...knots];
  result.splice(insertIndex, 0, newKnot);

  // Neighbour tangent fix-up using a cubic spanning prev→next and ct = closest t of nearPoint.
  const ct = closestT(prevK, nextK, nearPoint.x, nearPoint.y);
  // prev.tangentToNext = prev.end + (prev.tangentToNext - prev.end) * ct
  const newPrevNext = vec2(
    prevK.end.x + (prevK.tangentToNext.x - prevK.end.x) * ct,
    prevK.end.y + (prevK.tangentToNext.y - prevK.end.y) * ct,
  );
  // next.tangentToPrev = next.end + (next.end - next.tangentToPrev) * (ct - 1)
  // (legacy: addVector(next.end, scale(subVector(next.tangentToPrev,next.end), ct-1)))
  const newNextPrev = vec2(
    nextK.end.x + (nextK.end.x - nextK.tangentToPrev.x) * (ct - 1),
    nextK.end.y + (nextK.end.y - nextK.tangentToPrev.y) * (ct - 1),
  );
  result[insertIndex - 1] = knot(
    prevK.end,
    prevK.tangentToPrev,
    newPrevNext,
    prevK.continuous,
    prevK.other,
  );
  result[insertIndex + 1] = knot(
    nextK.end,
    newNextPrev,
    nextK.tangentToNext,
    nextK.continuous,
    nextK.other,
  );
  return result;
};

/**
 * Resample `source` and `target` (knot arrays) so they have equal control-point
 * counts, inserting points into whichever has fewer (legacy
 * BezierBoardCrossSection.interpolate count-mismatch loop). Returns the (possibly
 * resampled) source and target knot arrays. Either array may be returned unchanged.
 */
const matchControlPointCounts = (
  source: readonly Knot[],
  target: readonly Knot[],
): { source: Knot[]; target: Knot[]; ok: boolean } => {
  let src = [...source];
  let tgt = [...target];
  if (src.length === tgt.length) return { source: src, target: tgt, ok: true };

  // most = the one with more CPs; other = the one we insert into.
  const sourceHasMore = src.length > tgt.length;
  let most = sourceHasMore ? src : tgt;
  let other = sourceHasMore ? tgt : src;

  const mostMaxX = maxX(splineFromKnots(most));
  const mostMaxY = maxY(splineFromKnots(most));
  const otherMaxX = maxX(splineFromKnots(other));
  const otherMaxY = maxY(splineFromKnots(other));
  const scaleX = otherMaxX / mostMaxX;
  const scaleY = otherMaxY / mostMaxY;

  while (most.length > other.length) {
    // Find the interior CP of `most` whose best match in `other` is worst.
    let worstMatchKnot: Knot | null = null;
    let worstMatch = 0;
    for (let i = 1; i < most.length - 1; i++) {
      const cur = most[i]!;
      let bestMatch = 1e7;
      for (let j = 1; j < other.length - 1; j++) {
        const o = other[j]!;
        // Scale other's endpoint into most's coordinate frame (tangents untouched).
        const scaled = knot(
          vec2(o.end.x * scaleX, o.end.y * scaleY),
          o.tangentToPrev,
          o.tangentToNext,
          o.continuous,
          o.other,
        );
        const m = knotCompare(cur, scaled);
        if (m < bestMatch) bestMatch = m;
      }
      if (bestMatch > worstMatch) {
        worstMatch = bestMatch;
        worstMatchKnot = cur;
      }
    }
    if (!worstMatchKnot) break;

    const before = other.length;
    other = insertMatchingKnot(other, worstMatchKnot.end);
    if (other.length === before) {
      // No valid insertion (legacy returns the unmodified clone → bail to source).
      return { source: src, target: tgt, ok: false };
    }
  }

  if (sourceHasMore) {
    src = most;
    tgt = other;
  } else {
    tgt = most;
    src = other;
  }
  return { source: src, target: tgt, ok: true };
};

/**
 * Interpolate from this cross-section toward `target` by t∈[0,1], legacy
 * BezierBoardCrossSection.interpolate(). The target is first scaled to this
 * section's thickness/width; if the two splines have different control-point
 * counts the sparser one is resampled (de Casteljau split at the worst-matching
 * CP) until counts agree; then each control point is linearly blended a+t·(b−a).
 *
 * When resampling cannot find a valid insertion point the legacy bails and returns
 * the (unscaled) source clone; that behaviour is reproduced.
 */
export const interpolateCrossSection = (
  source: CrossSection,
  target: CrossSection,
  t: number,
): CrossSection => {
  const scaledTarget = scaleCrossSection(target, csCenterThickness(source), csWidth(source));
  const a0 = source.spline.knots;
  const b0 = scaledTarget.spline.knots;

  let a = a0;
  let b = b0;
  if (a0.length !== b0.length) {
    const matched = matchControlPointCounts(a0, b0);
    if (!matched.ok) {
      // Legacy returns the source clone unchanged.
      return crossSection(source.position, splineFromKnots([...a0]));
    }
    a = matched.source;
    b = matched.target;
  }

  const blended = a.map((ak, i) => lerpKnot(ak, b[i]!, t));
  return crossSection(source.position, splineFromKnots(blended));
};
