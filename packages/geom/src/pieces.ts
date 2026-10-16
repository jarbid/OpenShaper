// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rational Bézier pieces of planar clamped curves, for the certified
 * subdivision searches of trimming and integration (internal; design §11.3:
 * "found on the Bézier pieces … by sign-isolated bisection").
 *
 * - **Decomposition** inserts every interior knot to multiplicity `p` with
 *   P&T A5.1 (`book/refine.ts`), so piece `i` has the control points
 *   `i·p … i·p + p` (P&T §5.4, "decomposing a curve into Bézier segments").
 *   Knot insertion keeps the curve and its parameterisation, so a piece maps
 *   its local `s ∈ [0, 1]` affinely to `[t0, t1]`. Consecutive pieces share
 *   their end control point (one stored copy), so their ends are bitwise
 *   equal, and the curve's first and last control points are kept unaltered.
 *   Track A's `decomposeBezier` (step A1) will replace this when it lands; the
 *   result is the same.
 * - **Subdivision** is de Casteljau on homogeneous points (P&T eq. 1.9 /
 *   A1.5's triangle, keeping both edges of the triangle), exact up to rounding;
 *   the split point is computed once and shared by both halves.
 * - **Certificates.** With positive weights a rational Bézier piece lies in the
 *   convex hull of its Euclidean control points (P&T §4.2, property 4), hence
 *   in their bounding box, and it is variation diminishing (property 6): a
 *   control polygon monotone in a coordinate means the piece is monotone in it
 *   and crosses each line of that coordinate at most once.
 */
import { curveKnotIns } from './book/refine';
import type { ClampedCurve } from './types';

/** A rational Bézier piece: homogeneous `[w·x, w·y, w]` per control point, on `[t0, t1]`. */
export interface Piece {
  readonly p: number;
  readonly w: Float64Array;
  readonly t0: number;
  readonly t1: number;
}

/** P&T A5.1 applied until every interior knot has multiplicity `p`: the Bézier pieces of `c`. */
export function bezierPieces(c: ClampedCurve<2>): Piece[] {
  const p = c.basis.degree;
  let U: Float64Array = Float64Array.from(c.basis.knots);
  let Pw: Float64Array = Float64Array.from(c.cw);
  let np = c.basis.count - 1;
  // Distinct interior knots and multiplicities.
  const a = U[p]!;
  const b = U[np + 1]!;
  let i = p + 1;
  while (i <= np) {
    const u = U[i]!;
    let s = 1;
    while (i + s <= np && U[i + s] === u) s++;
    if (u > a && u < b && s < p) {
      const k = i + s - 1; // U[k] ≤ u < U[k + 1]
      const r = p - s;
      const { UQ, Qw } = curveKnotIns(np, p, U, Pw, 3, u, k, s, r);
      U = UQ;
      Pw = Qw;
      np += r;
      i += s + r;
    } else i += s;
  }
  const pieces: Piece[] = [];
  const nPieces = np / p;
  for (let k = 0; k < nPieces; k++) {
    const w = Pw.slice(3 * k * p, 3 * (k * p + p + 1));
    pieces.push({ p, w, t0: U[p + k * p]!, t1: U[p + (k + 1) * p]! });
  }
  return pieces;
}

/** de Casteljau split of `pc` at local `s ∈ (0, 1)`: left `[t0, t]`, right `[t, t1]`. */
export function splitPiece(pc: Piece, s: number): [Piece, Piece] {
  const p = pc.p;
  const n = 3 * (p + 1);
  const tmp = Float64Array.from(pc.w);
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let c = 0; c < 3; c++) {
    L[c] = tmp[c]!;
    R[3 * p + c] = tmp[3 * p + c]!;
  }
  for (let r = 1; r <= p; r++) {
    for (let j = 0; j <= p - r; j++) {
      for (let c = 0; c < 3; c++) {
        tmp[3 * j + c] = (1 - s) * tmp[3 * j + c]! + s * tmp[3 * (j + 1) + c]!;
      }
    }
    for (let c = 0; c < 3; c++) {
      L[3 * r + c] = tmp[c]!;
      R[3 * (p - r) + c] = tmp[3 * (p - r) + c]!;
    }
  }
  const t = pc.t0 + s * (pc.t1 - pc.t0);
  return [
    { p, w: L, t0: pc.t0, t1: t },
    { p, w: R, t0: t, t1: pc.t1 },
  ];
}

/** Euclidean coordinate `k` (0: x, 1: y) of control point `j`. */
export const ctrl = (pc: Piece, j: number, k: number): number =>
  pc.w[3 * j + k]! / pc.w[3 * j + 2]!;

/** Bounding box `[minX, minY, maxX, maxY]` of the Euclidean control points (contains the piece). */
export function pieceBox(pc: Piece): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let j = 0; j <= pc.p; j++) {
    const x = ctrl(pc, j, 0);
    const y = ctrl(pc, j, 1);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Whether the control polygon is monotone (non-strictly) in coordinate `k`: the piece is. */
export function monotone(pc: Piece, k: number): boolean {
  let up = true;
  let down = true;
  for (let j = 1; j <= pc.p; j++) {
    const d = ctrl(pc, j, k) - ctrl(pc, j - 1, k);
    if (d > 0) down = false;
    if (d < 0) up = false;
  }
  return up || down;
}

/** The point at local `s` by de Casteljau (homogeneous, then divided). */
export function piecePoint(pc: Piece, s: number): [number, number] {
  const p = pc.p;
  const tmp = Float64Array.from(pc.w);
  for (let r = 1; r <= p; r++) {
    for (let j = 0; j <= p - r; j++) {
      for (let c = 0; c < 3; c++) {
        tmp[3 * j + c] = (1 - s) * tmp[3 * j + c]! + s * tmp[3 * (j + 1) + c]!;
      }
    }
  }
  return [tmp[0]! / tmp[2]!, tmp[1]! / tmp[2]!];
}

/**
 * The parameters `t` in `(pc.t0, pc.t1)` where coordinate `k` equals `value`:
 * the pieces whose box straddles `value` are subdivided until monotone, then
 * the single crossing is isolated by bisection on the sign of
 * `coordinate − value` down to rounding (the midpoint stops moving), or to
 * `minWidth` in `t`. A piece lying on the line (constant coordinate) has no
 * isolated crossing and contributes none. Depth is bounded by rounding.
 */
export function crossings(
  pc: Piece,
  k: number,
  value: number,
  minWidth: number,
  out: number[],
): void {
  const box = pieceBox(pc);
  const lo = box[k]!;
  const hi = box[k + 2]!;
  if (!(lo < value && value < hi)) return;
  if (!monotone(pc, k)) {
    if (pc.t1 - pc.t0 <= minWidth) return;
    const [l, r] = splitPiece(pc, 0.5);
    crossings(l, k, value, minWidth, out);
    // The split point is both halves' shared end, so a crossing exactly there
    // straddles neither half's box strictly: record it here.
    if (ctrl(r, 0, k) === value) out.push(r.t0);
    crossings(r, k, value, minWidth, out);
    return;
  }
  // Monotone and strictly straddling: one crossing inside.
  let a = 0;
  let b = 1;
  const fa = ctrl(pc, 0, k) - value;
  for (;;) {
    const m = 0.5 * (a + b);
    if (!(m > a && m < b) || (b - a) * (pc.t1 - pc.t0) <= minWidth) break;
    const fm = piecePoint(pc, m)[k]! - value;
    if (fm === 0) {
      a = m;
      b = m;
      break;
    }
    if (fm > 0 === fa > 0) a = m;
    else b = m;
  }
  out.push(pc.t0 + 0.5 * (a + b) * (pc.t1 - pc.t0));
}
