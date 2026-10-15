// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact orientation and in-circle predicates (design §6.17, §12, decisions 26
 * and 27).
 *
 * The arithmetic is Shewchuk's adaptive exact predicates as vendored from
 * `robust-predicates` 3.0.3 (`vendor/robust-predicates.ts`, public domain). The
 * sign is Shewchuk's throughout geom: **`orient2d > 0` ⇔ a, b, c turn
 * counter-clockwise in a y-up frame** ((u, v) is y-up), which is the opposite
 * of `robust-predicates`' own `orient2d` (checked in its source: it returns
 * `(ay − cy)(bx − cx) − (ax − cx)(by − cy)`). `incircle > 0` ⇔ d lies strictly
 * inside the circle through a counter-clockwise a, b, c.
 *
 * Both return a value whose **sign** is exact for any finite doubles (the
 * magnitude is an approximation of the determinant). No tolerance is involved.
 *
 * **State.** The adaptive stages need work buffers. Upstream keeps them at
 * module level; geom keeps none (decision 14), so a triangulation creates its
 * own set with {@link makePredicates} and the public functions below create one
 * only on the rare call whose fast filter is inconclusive.
 */
import { makeIncircle, makeOrient2d } from './vendor/robust-predicates';

/** A predicate pair with its own work buffers (one per triangulation; not reentrant across threads). */
export interface Predicates {
  /** `> 0` ⇔ counter-clockwise (y up); exact sign. */
  readonly orient2d: (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => number;
  /** `> 0` ⇔ d strictly inside the circle through counter-clockwise a, b, c; exact sign. */
  readonly incircle: (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
  ) => number;
}

type Raw6 = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => number;
type Raw8 = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
) => number;

/** A fresh predicate pair owning its adaptive-stage buffers (internal). */
export function makePredicates(): Predicates {
  const o = makeOrient2d() as Raw6;
  const ic = makeIncircle() as Raw8;
  return Object.freeze({
    // Upstream's orient2d is negative for counter-clockwise: flip it.
    orient2d: (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
      -o(ax, ay, bx, by, cx, cy),
    incircle: ic,
  });
}

/**
 * Shewchuk's first-stage error bounds, from the unit roundoff `ε = 2⁻⁵³`
 * (`ccwerrboundA`, `iccerrboundA` in the vendored source): a determinant
 * larger than the bound times the permanent has the right sign.
 */
const EPS = Number.EPSILON / 2;
const CCW_BOUND_A = (3 + 16 * EPS) * EPS;
const ICC_BOUND_A = (10 + 96 * EPS) * EPS;

/**
 * Orientation of the triangle a, b, c: `> 0` counter-clockwise (y up), `< 0`
 * clockwise, `0` collinear. The sign is exact. Allocation-free unless the
 * points are nearly collinear (then the adaptive stage runs on fresh buffers).
 */
export function orient2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const detleft = (ax - cx) * (by - cy);
  const detright = (ay - cy) * (bx - cx);
  const det = detleft - detright;
  if (Math.abs(det) >= CCW_BOUND_A * Math.abs(detleft + detright)) return det;
  return makePredicates().orient2d(ax, ay, bx, by, cx, cy);
}

/**
 * In-circle test: `> 0` when d lies strictly inside the circle through a, b, c
 * (given counter-clockwise), `< 0` outside, `0` cocircular. The sign is exact
 * (and flips if a, b, c are clockwise). Allocation-free unless nearly
 * cocircular.
 */
export function incircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const adx = ax - dx;
  const bdx = bx - dx;
  const cdx = cx - dx;
  const ady = ay - dy;
  const bdy = by - dy;
  const cdy = cy - dy;
  const bdxcdy = bdx * cdy;
  const cdxbdy = cdx * bdy;
  const alift = adx * adx + ady * ady;
  const cdxady = cdx * ady;
  const adxcdy = adx * cdy;
  const blift = bdx * bdx + bdy * bdy;
  const adxbdy = adx * bdy;
  const bdxady = bdx * ady;
  const clift = cdx * cdx + cdy * cdy;
  const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * blift +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
  if (Math.abs(det) > ICC_BOUND_A * permanent) return det;
  return makePredicates().incircle(ax, ay, bx, by, cx, cy, dx, dy);
}
