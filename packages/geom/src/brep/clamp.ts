// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact periodic → clamped conversion of surfaces (design §4.4), internal to the
 * B-rep and STEP layers. Periodic geometry leaves geom only through this
 * conversion: STEP has no periodic B-spline, and a trim loop needs a clamped
 * surface (decision 29).
 *
 * This is the surface form of `toClamped` of step A1 (which lands on the
 * other track); when A1 is merged, this module should call it. It is written
 * on the same book code, so the two agree:
 *
 * 1. **Unroll** (design §4.4). A periodic basis of degree `p` with `n` unique
 *    control points and one period of knots `t_0 … t_{n−1}` extends to the
 *    bi-infinite sequence `t_{i + k·n} = t_i + k·T`. Over `[t_0, t_0 + T]` the
 *    basis functions that do not vanish are those with index `−p … n − 1`
 *    (function `i` multiplies control point `i mod n`), an ordinary
 *    **unclamped** B-spline on the knots `t_{−p} … t_{n+p}`, with `n + p`
 *    control points and exactly the periodic curve on the domain.
 * 2. **Clamp** by P&T A5.1: insert the domain ends until each has multiplicity
 *    `p`, then drop the control points and knots outside the domain (the same
 *    steps as `clampUnclamped` for curves). Knot insertion is exact, so the
 *    clamped surface is the same function of `(u, v)` on `[t_0, t_0 + T]`; its
 *    two end rows coincide (a closed surface), which the STEP writer reports as
 *    `u_closed` / `v_closed`.
 *
 * The parameter domain is kept (`[t_0, t_0 + T]`), so pcurves of the periodic
 * surface are pcurves of the clamped one, unchanged.
 */
import { clampedBasis } from '../basis';
import { surfaceFromHomogeneous } from '../surface';
import type { Basis, NurbsSurface, PeriodicBasis } from '../types';
import { curveKnotIns } from '../book/refine';

/** Index of the first knot of the run (equal values) containing `i`. */
function runStart(U: ArrayLike<number>, i: number): number {
  while (i > 0 && U[i - 1] === U[i]) i--;
  return i;
}

/** Index of the last knot of the run containing `i`. */
function runEnd(U: ArrayLike<number>, i: number): number {
  while (i < U.length - 1 && U[i + 1] === U[i]) i++;
  return i;
}

/** The unrolled knots `t_{−p} … t_{n+p}` and the control point (mod n) behind each function. */
function unroll(b: PeriodicBasis): { knots: Float64Array; source: Int32Array } {
  const n = b.count;
  const p = b.degree;
  const T = b.period;
  const knots = new Float64Array(n + 2 * p + 1);
  for (let k = 0; k < knots.length; k++) {
    const i = k - p;
    const wraps = Math.floor(i / n);
    knots[k] = b.knots[i - wraps * n]! + wraps * T;
  }
  const source = new Int32Array(n + p);
  for (let m = 0; m < n + p; m++) {
    const i = m - p;
    source[m] = i - Math.floor(i / n) * n;
  }
  return { knots, source };
}

/**
 * The clamped knots for an unclamped vector `U` of degree `p` (`count = U.length − p − 1`
 * functions) and, per fibre, the clamped homogeneous points. Insertion and trimming as
 * `clampUnclamped`; the knot work is done on `fibres[0]` and the others follow the same
 * indices (insertion indices depend only on the knots).
 */
function clampFibres(
  p: number,
  U0: Float64Array,
  fibres: readonly Float64Array[],
): { knots: Float64Array; fibres: Float64Array[] } {
  const h = 4;
  let U: Float64Array = U0;
  let P: Float64Array[] = fibres.map((f) => Float64Array.from(f));
  let n = U.length - p - 2; // index of the last control point
  const a = U[p]!;
  const b = U[n + 1]!;
  const insert = (u: number, k: number, s: number, r: number): void => {
    let UQ = U;
    const Q: Float64Array[] = [];
    for (let f = 0; f < P.length; f++) {
      const ins = curveKnotIns(n, p, U, P[f]!, h, u, k, s, r);
      UQ = ins.UQ;
      Q.push(ins.Qw);
    }
    U = UQ;
    P = Q;
    n += r;
  };
  // Clamp the start: insert `a` until its multiplicity is p.
  let k = runEnd(U, p);
  let s = k - runStart(U, p) + 1;
  if (s < p) {
    insert(a, k, s, p - s);
    k += p - s;
  }
  const L = k; // last index of the a-run, now of multiplicity ≥ p
  // Clamp the end: the new knots go after the b-run's first index F, which stays put.
  const F = runStart(U, n + 1);
  const bEnd = runEnd(U, F);
  s = bEnd - F + 1;
  if (s < p) insert(b, bEnd, s, p - s);
  // Keep knots L − p … F + p and control points L − p … F − 1 (the only functions
  // that reach [a, b]); the outermost knot of each end is set to the domain end.
  const first = L - p;
  const last = F - 1;
  const knots = U.slice(first, F + p + 1);
  knots[0] = a;
  knots[knots.length - 1] = b;
  return {
    knots,
    fibres: P.map((f) => f.slice(first * h, (last + 1) * h)),
  };
}

/** Clamps one direction of a surface net (`dir`), returning the new basis and net. */
function clampDirection(s: NurbsSurface, dir: 'u' | 'v'): { u: Basis; v: Basis; cw: Float64Array } {
  const bu = s.u;
  const bv = s.v;
  const b = dir === 'u' ? bu : bv;
  if (b.kind !== 'periodic') return { u: bu, v: bv, cw: s.cw as Float64Array };
  const { knots: V, source } = unroll(b);
  const nu = bu.count;
  const nv = bv.count;
  const m = b.count + b.degree; // functions of the unrolled basis
  // One fibre per index of the other direction, in the unrolled order.
  const other = dir === 'u' ? nv : nu;
  const fibres: Float64Array[] = [];
  for (let o = 0; o < other; o++) {
    const f = new Float64Array(m * 4);
    for (let j = 0; j < m; j++) {
      const src = source[j]!;
      const at = dir === 'u' ? (src * nv + o) * 4 : (o * nv + src) * 4;
      for (let c = 0; c < 4; c++) f[j * 4 + c] = s.cw[at + c]!;
    }
    fibres.push(f);
  }
  const out = clampFibres(b.degree, V, fibres);
  const basis = clampedBasis(b.degree, out.knots);
  const count = basis.count;
  const newU = dir === 'u' ? basis : bu;
  const newV = dir === 'v' ? basis : bv;
  const cw = new Float64Array(newU.count * newV.count * 4);
  for (let o = 0; o < other; o++) {
    const f = out.fibres[o]!;
    for (let j = 0; j < count; j++) {
      const at = dir === 'u' ? (j * nv + o) * 4 : (o * count + j) * 4;
      for (let c = 0; c < 4; c++) cw[at + c] = f[j * 4 + c]!;
    }
  }
  return { u: newU, v: newV, cw };
}

/**
 * The surface as an exactly equal surface clamped in both directions on the
 * same parameter domain (`[t_0, t_0 + T]` for a periodic direction). A surface
 * that is already clamped comes back as it is (same object).
 */
export function clampSurface(s: NurbsSurface): NurbsSurface {
  if (s.u.kind === 'clamped' && s.v.kind === 'clamped') return s;
  const a = clampDirection(s, 'u');
  const first: NurbsSurface =
    a.cw === s.cw ? s : surfaceFromHomogeneous({ u: a.u, v: a.v, cw: a.cw });
  const b = clampDirection(first, 'v');
  return b.cw === first.cw ? first : surfaceFromHomogeneous({ u: b.u, v: b.v, cw: b.cw });
}
