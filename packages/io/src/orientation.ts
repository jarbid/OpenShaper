// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Board orientation on import.
 *
 * Everything past the readers assumes the tail is at x=0 and the nose toward +x — the
 * specs panel, fin placement, handle naming, every construction readout. The readers
 * are where that is made true: the SRF reader reverses its nose-first curves, and the
 * Shape3D reader builds its tail section at 0. A `.brd` is the one format read
 * straight through, so a file written nose-first would load backwards. This turns it
 * around at the boundary, once, so no consumer ever has to ask which end is which.
 */
import {
  board,
  crossSection,
  getLength,
  getRockerAtPos,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';
import type { ImportWarning } from './import-warning';

/**
 * How much more the x=0 tip must lift than the x=length tip (cm) before that end is
 * taken to be the nose. Noses carry far more rocker than tails — 6–8 cm more on the
 * bundled boards — so a real reversal clears this easily, while a near-symmetric
 * rocker is left alone rather than flipped on a coin toss.
 */
export const NOSE_FIRST_ROCKER_MARGIN_CM = 1;

/** Reflect a spline end-for-end about x = length/2, keeping it running in +x. */
const mirrorSpline = (s: Spline, length: number): Spline =>
  splineFromKnots(
    [...s.knots].reverse().map((k) =>
      knot(
        vec2(length - k.end.x, k.end.y),
        // Reversing the order swaps which neighbour each handle points at.
        vec2(length - k.tangentToNext.x, k.tangentToNext.y),
        vec2(length - k.tangentToPrev.x, k.tangentToPrev.y),
        k.continuous,
        k.other,
      ),
    ),
  );

/**
 * The same board turned end-for-end. Cross-section profiles lie in the transverse
 * plane, so only their stations move; fins are specified from the tail, so they
 * need nothing.
 */
export const mirrorLengthwise = (b: BezierBoard): BezierBoard => {
  const length = getLength(b);
  return board(
    mirrorSpline(b.outline, length),
    mirrorSpline(b.bottom, length),
    mirrorSpline(b.deck, length),
    b.crossSections
      .map((cs) => crossSection(length - cs.position, cs.spline))
      .sort((p, q) => p.position - q.position),
    b.interpolationType,
    b.fins,
  );
};

/** Whether the x=0 end is clearly the nose: it lifts more than the other end. */
export const isNoseFirst = (b: BezierBoard): boolean =>
  getRockerAtPos(b, 0) - getRockerAtPos(b, getLength(b)) > NOSE_FIRST_ROCKER_MARGIN_CM;

/** Turn a nose-first board around, noting it in `warnings`; otherwise return it as is. */
export const ensureTailAtZero = (b: BezierBoard, warnings: ImportWarning[]): BezierBoard => {
  if (!isNoseFirst(b)) return b;
  warnings.push({
    severity: 'info',
    message:
      'This board was stored nose-first, so it has been turned end-for-end to match how ' +
      'OpenShaper lays out boards. The shape itself is unchanged.',
  });
  return mirrorLengthwise(b);
};
