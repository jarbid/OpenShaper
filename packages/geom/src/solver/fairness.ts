// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fairness energies and their Gram matrices (design §6.13, §10.1–10.2).
 *
 * With the basis and weights fixed, a curve or surface is linear in its
 * Euclidean control points, so every energy here is a quadratic form
 * `Σ_c y_cᵀ F y_c` over the coordinates `c` of the control points `y` (the
 * shape, or a displacement from a reference) with one scalar matrix
 * `F = α G₁ + β G₂ (+ γ G₃ for curves)`:
 *
 * - curves: `G_k = ∫ R^(k) R^(k)ᵀ dt`, so `yᵀ G₂ y = ∫ |C″|²` (bending),
 *   `G₁` stretch `∫ |C′|²`, `G₃` jerk `∫ |C‴|²`;
 * - surfaces: membrane `G₁ = ∫∫ R_u R_uᵀ + R_v R_vᵀ` and thin plate
 *   `G₂ = ∫∫ R_uu R_uuᵀ + 2 R_uv R_uvᵀ + R_vv R_vvᵀ`, so
 *   `yᵀ G₂ y = ∫∫ |S_uu|² + 2|S_uv|² + |S_vv|²`.
 *
 * {@link fairnessEnergy} returns `α E₁ + β E₂ + γ E₃` with these integrals (no
 * factor ½; the solver's objective carries the ½, design §10.1).
 *
 * **Metric** (design §10.2, decision 23). `'parametric'` integrates in the
 * parameters as written. `'scaled'` (default) weights each knot span (curves)
 * or span pair (surfaces) by the reference geometry's speed there, so the
 * energy approximates its arc-length form and does not depend on how fast the
 * parameter runs: a derivative of order `k` in direction `u` is divided by
 * `λ_u^k`, and the area element multiplied by `λ_u` (curves) or `λ_u λ_v`.
 * The speed `λ_u` of a span pair is the **root-mean-square** `|S_u|` over it,
 * `√(∫∫ |S_u|² / area)`: for polynomial geometry that integrand is a
 * polynomial, so it is integrated exactly with the Gram matrices themselves,
 * and for a constant-speed span it is the speed. Piecewise constant, so
 * Gauss–Legendre stays exact; invariant under affine reparameterisation
 * (not under knot insertion: a finer partition follows the speed more
 * closely, so the scaled energy changes with it). A span whose speed is at
 * the rounding level (`≤ degenerateRel · M / L`, `M` the largest coordinate
 * of its control points, `L` the domain length: `degenerateRel`'s test for a
 * degenerate tangent; all its control points coincide) takes the RMS speed of
 * the other spans, and a geometry with no speed at all takes 1 (it is a
 * point: every energy is 0 up to rounding).
 *
 * **Quadrature** (design §10.2). Polynomial bases: `p + 1` Gauss–Legendre
 * points per direction and span, exact (each factor has degree at most `2p`).
 * Surfaces are assembled from one-dimensional span Gram matrices by Kronecker
 * products, which is the same exact integral at a fraction of the cost (P12).
 * Rational bases are not polynomial: the rule starts at `p + `{@link
 * RATIONAL_GL_EXTRA} points and grows per span (pair) until two successive
 * rules agree to `quadRel` relative (the largest entry of each block, and the
 * speed), up to `GL_MAX_ORDER`.
 */
import { makeScratch } from '../array';
import { checkCurveShape } from '../curve';
import { fail } from '../errors';
import { GL_MAX_ORDER, gaussLegendre } from '../quadrature';
import { checkSurfaceShape } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type { Basis, NurbsCurve, NurbsSurface } from '../types';
import { coo, cooAdd, cooToCsr } from '../linalg/sparse';
import type { Csr } from '../linalg/sparse';
import { curveLocal, surfaceLocal } from './local';

/** Weights of the fairness energy (design §6.13). */
export interface FairnessWeights {
  /** α: membrane / stretch, `∫ |S′|²`. Default 0. */
  readonly stretch?: number;
  /** β: thin plate / bending, `∫ |S″|²`. */
  readonly bend: number;
  /** γ: curves only, `∫ |C‴|²`. Default 0. */
  readonly jerk?: number;
  /** Default `'scaled'` (see the module comment). */
  readonly metric?: 'parametric' | 'scaled';
  /** Default: `'displacement'` in a `FairProblem`, `'shape'` in fits. */
  readonly on?: 'displacement' | 'shape';
}

/** Validated weights with defaults applied. */
export interface ResolvedFairness {
  readonly stretch: number;
  readonly bend: number;
  readonly jerk: number;
  readonly metric: 'parametric' | 'scaled';
  readonly on: 'displacement' | 'shape';
}

/**
 * Extra Gauss–Legendre points beyond `p + 1` that a rational span starts
 * with: the rational integrand is smooth but not polynomial (design §10.2:
 * `p + 3`). Only a starting point: the rule then grows until it converges to
 * `quadRel`.
 */
export const RATIONAL_GL_EXTRA = 2;

function weight(x: number | undefined, name: string, fallback: number): number {
  const v = x ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    fail('unsupported', `fairness ${name} must be a finite number ≥ 0; got ${String(v)}`, {
      value: v,
    });
  }
  return v;
}

/** Validates {@link FairnessWeights}; `jerk` is for curves only. */
export function checkFairness(
  w: FairnessWeights,
  kind: 'curve' | 'surface',
  defaultOn: 'displacement' | 'shape',
): ResolvedFairness {
  if (typeof w !== 'object' || w === null) fail('unsupported', 'fairness must be an object');
  const stretch = weight(w.stretch, 'stretch', 0);
  const bend = weight(w.bend, 'bend', Number.NaN);
  const jerk = weight(w.jerk, 'jerk', 0);
  if (kind === 'surface' && jerk !== 0) {
    fail('unsupported', 'fairness jerk (∫|C‴|²) applies to curves only');
  }
  const metric = w.metric ?? 'scaled';
  if (metric !== 'parametric' && metric !== 'scaled') {
    fail('unsupported', `fairness metric must be 'parametric' or 'scaled'; got ${String(metric)}`);
  }
  const on = w.on ?? defaultOn;
  if (on !== 'displacement' && on !== 'shape') {
    fail('unsupported', `fairness on must be 'displacement' or 'shape'; got ${String(on)}`);
  }
  return Object.freeze({ stretch, bend, jerk, metric, on });
}

/**
 * Where the scaled metric's speeds come from: the Euclidean control points of
 * a reference geometry (stride `dim`), or one constant speed per direction.
 */
export type SpeedSource =
  | { readonly kind: 'geometry'; readonly points: ArrayLike<number>; readonly dim: number }
  | { readonly kind: 'uniform'; readonly u: number; readonly v: number };

/** Non-empty spans of a basis: `[span index, start, end]` per span. */
function spans(b: Basis): { index: Int32Array; a: Float64Array; e: Float64Array } {
  const U = b.knots;
  const out: [number, number, number][] = [];
  if (b.kind === 'clamped') {
    for (let k = b.degree; k < b.count; k++) if (U[k + 1]! > U[k]!) out.push([k, U[k]!, U[k + 1]!]);
  } else {
    const n = b.count;
    for (let k = 0; k < n; k++) {
      const e = k + 1 < n ? U[k + 1]! : U[0]! + b.period;
      if (e > U[k]!) out.push([k, U[k]!, e]);
    }
  }
  return {
    index: Int32Array.from(out, (x) => x[0]),
    a: Float64Array.from(out, (x) => x[1]),
    e: Float64Array.from(out, (x) => x[2]),
  };
}

function maxAbs(a: Float64Array, o: number, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.abs(a[o + i]!);
    if (x > m) m = x;
  }
  return m;
}

/** Two successive quadratures agree: each block and the speeds to `rel`. */
function agree(
  x: Float64Array,
  y: Float64Array,
  blocks: number,
  size: number,
  rel: number,
): boolean {
  for (let b = 0; b < blocks; b++) {
    const o = b * size;
    const s = maxAbs(y, o, size);
    for (let i = 0; i < size; i++) if (Math.abs(x[o + i]! - y[o + i]!) > rel * s) return false;
  }
  return true;
}

/**
 * Speeds per span (pair) `√(sq/area)` with the degenerate fallback of the
 * module comment: a speed at most `floor[k]` (`degenerateRel · M / L`, the
 * rounding level of the derivative, as `degenerateRel` defines a degenerate
 * tangent) takes the RMS speed of the non-degenerate spans, or 1 when every
 * span is degenerate.
 */
function speeds(sq: Float64Array, area: Float64Array, floor: Float64Array): Float64Array {
  let tot = 0;
  let ar = 0;
  const ok = new Uint8Array(sq.length);
  for (let i = 0; i < sq.length; i++) {
    if (Math.sqrt(sq[i]! / area[i]!) > floor[i]!) {
      ok[i] = 1;
      tot += sq[i]!;
      ar += area[i]!;
    }
  }
  const global = ar > 0 ? Math.sqrt(tot / ar) : 1;
  return Float64Array.from(sq, (s, i) => (ok[i] ? Math.sqrt(s / area[i]!) : global));
}

/** `degenerateRel ·` (largest absolute coordinate of the `K` points at `idx[o·K …]`) `/ len`. */
function speedFloor(
  pts: ArrayLike<number>,
  dim: number,
  idx: Int32Array,
  o: number,
  K: number,
  len: number,
  tol: Tolerances,
): number {
  let M = 0;
  for (let e = 0; e < K; e++) {
    for (let c = 0; c < dim; c++) M = Math.max(M, Math.abs(pts[idx[o * K + e]! * dim + c]!));
  }
  return (tol.degenerateRel * M) / len;
}

/** The domain (period) length of a basis. */
function domainLength(b: Basis): number {
  return b.domain[1] - b.domain[0];
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * Parametric span Gram blocks of a curve: for span `s` and order `k = 1..3`,
 * block `B_k = ∫_span R^(k) R^(k)ᵀ` (`(p+1)²`, row-major) at
 * `blocks[(s·3 + k − 1)·(p+1)²]`, the span's control indices at
 * `idx[s·(p+1)]`, and `∫_span |C′|²` of the speed source (geometry only).
 */
function curveSpanBlocks(
  b: Basis,
  cw: ArrayLike<number>,
  h: number,
  rational: boolean,
  maxOrder: number,
  pts: ArrayLike<number> | null,
  dim: number,
  tol: Tolerances,
): {
  sp: ReturnType<typeof spans>;
  blocks: Float64Array;
  idx: Int32Array;
  speedSq: Float64Array;
} {
  const p = b.degree;
  const p1 = p + 1;
  const P2 = p1 * p1;
  const sp = spans(b);
  const ns = sp.index.length;
  // Polynomial: N^(k) ≡ 0 for k > p, so stop at p. Rational: R^(k) ≠ 0 for
  // every k (P&T eq. 4.8: a weighted line bends, a conic arc has jerk), so
  // the quotient rule needs the full order; dersBasisFuns zeroes N^(k > p).
  const nDer = rational ? Math.max(maxOrder, 1) : Math.min(Math.max(maxOrder, 1), p);
  const s = makeScratch(p, 3);
  const R = new Float64Array(4 * p1);
  const li = new Int32Array(p1);
  const blocks = new Float64Array(ns * 3 * P2);
  const idx = new Int32Array(ns * p1);
  const speedSq = new Float64Array(ns);
  // Work: 3 blocks + speed, for the current and the previous rule.
  const cur = new Float64Array(3 * P2 + 1);
  const prev = new Float64Array(3 * P2 + 1);
  const integrate = (k: number, ng: number, out: Float64Array): void => {
    out.fill(0);
    const { nodes, weights } = gaussLegendre(ng);
    const a = sp.a[k]!;
    const half = (sp.e[k]! - a) / 2;
    for (let g = 0; g < ng; g++) {
      const t = a + half * (nodes[g]! + 1);
      const wt = half * weights[g]!;
      curveLocal(b, cw, h, rational, t, sp.index[k]!, nDer, s, li, R);
      for (let o = 1; o <= Math.min(maxOrder, nDer); o++) {
        const ob = (o - 1) * P2;
        for (let i = 0; i < p1; i++) {
          const ri = wt * R[o * p1 + i]!;
          if (ri === 0) continue;
          for (let j = 0; j < p1; j++)
            out[ob + i * p1 + j] = out[ob + i * p1 + j]! + ri * R[o * p1 + j]!;
        }
      }
      if (pts !== null) {
        let sq = 0;
        for (let c = 0; c < dim; c++) {
          let d = 0;
          for (let j = 0; j < p1; j++) d += R[p1 + j]! * pts[li[j]! * dim + c]!;
          sq += d * d;
        }
        out[3 * P2] = out[3 * P2]! + wt * sq;
      }
    }
    for (let j = 0; j < p1; j++) idx[k * p1 + j] = li[j]!;
  };
  for (let k = 0; k < ns; k++) {
    let ng = rational ? p1 + RATIONAL_GL_EXTRA : p1;
    integrate(k, ng, cur);
    if (rational) {
      for (;;) {
        prev.set(cur);
        if (ng + 1 > GL_MAX_ORDER) break;
        ng++;
        integrate(k, ng, cur);
        const a = prev[3 * P2]!;
        const c = cur[3 * P2]!;
        if (agree(prev, cur, 3, P2, tol.quadRel) && Math.abs(a - c) <= tol.quadRel * Math.abs(c)) {
          break;
        }
      }
    }
    blocks.set(cur.subarray(0, 3 * P2), k * 3 * P2);
    speedSq[k] = cur[3 * P2]!;
  }
  return { sp, blocks, idx, speedSq };
}

/** The scalar fairness matrix `F` of a curve basis (with the curve's weights). */
export function curveFairnessMatrix(
  b: Basis,
  cw: ArrayLike<number>,
  dim: number,
  rational: boolean,
  fw: ResolvedFairness,
  speed: SpeedSource,
  tol: Tolerances,
): Csr {
  const c = [fw.stretch, fw.bend, fw.jerk];
  const maxOrder = fw.jerk > 0 ? 3 : fw.bend > 0 ? 2 : 1;
  const geom = fw.metric === 'scaled' && speed.kind === 'geometry' ? speed : null;
  const { sp, blocks, idx, speedSq } = curveSpanBlocks(
    b,
    cw,
    dim + 1,
    rational,
    maxOrder,
    geom === null ? null : geom.points,
    dim,
    tol,
  );
  const p1 = b.degree + 1;
  const P2 = p1 * p1;
  const ns = sp.index.length;
  const len = Float64Array.from(sp.a, (a, k) => sp.e[k]! - a);
  const lam =
    fw.metric === 'parametric'
      ? new Float64Array(ns).fill(1)
      : geom !== null
        ? speeds(
            speedSq,
            len,
            Float64Array.from(len, (_, k) =>
              speedFloor(geom.points, geom.dim, idx, k, p1, domainLength(b), tol),
            ),
          )
        : new Float64Array(ns).fill(speed.kind === 'uniform' ? speed.u : 1);
  const out = coo(b.count, b.count, ns * P2);
  for (let k = 0; k < ns; k++) {
    const L = lam[k]!;
    // Order o scales by λ^(1 − 2o): derivative ÷ λ^o, squared, times dt·λ.
    const f = [c[0]! / L, c[1]! / (L * L * L), c[2]! / (L * L * L * L * L)];
    for (let i = 0; i < p1; i++) {
      for (let j = 0; j < p1; j++) {
        let v = 0;
        for (let o = 0; o < 3; o++)
          if (f[o] !== 0) v += f[o]! * blocks[(k * 3 + o) * P2 + i * p1 + j]!;
        cooAdd(out, idx[k * p1 + i]!, idx[k * p1 + j]!, v);
      }
    }
  }
  return cooToCsr(out);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** One-dimensional span blocks `∫ N^(k) N^(k)ᵀ`, `k = 0, 1, 2`, for the Kronecker path. */
function polySpanBlocks1d(b: Basis): {
  sp: ReturnType<typeof spans>;
  blocks: Float64Array;
} {
  const p = b.degree;
  const p1 = p + 1;
  const P2 = p1 * p1;
  const sp = spans(b);
  const ns = sp.index.length;
  const s = makeScratch(p, 3);
  const R = new Float64Array(4 * p1);
  const li = new Int32Array(p1);
  const nDer = Math.min(2, p);
  const blocks = new Float64Array(ns * 3 * P2);
  const { nodes, weights } = gaussLegendre(p1);
  for (let k = 0; k < ns; k++) {
    const a = sp.a[k]!;
    const half = (sp.e[k]! - a) / 2;
    for (let g = 0; g < p1; g++) {
      const t = a + half * (nodes[g]! + 1);
      const wt = half * weights[g]!;
      curveLocal(b, [], 1, false, t, sp.index[k]!, nDer, s, li, R);
      for (let o = 0; o <= nDer; o++) {
        const ob = (k * 3 + o) * P2;
        for (let i = 0; i < p1; i++) {
          const ri = wt * R[o * p1 + i]!;
          for (let j = 0; j < p1; j++)
            blocks[ob + i * p1 + j] = blocks[ob + i * p1 + j]! + ri * R[o * p1 + j]!;
        }
      }
    }
  }
  return { sp, blocks };
}

/** Block slots of a surface span pair: membrane u, v; thin plate uu, uv, vv. */
const SB_U = 0;
const SB_V = 1;
const SB_UU = 2;
const SB_UV = 3;
const SB_VV = 4;
const SB_COUNT = 5;

/**
 * The scalar fairness matrix `F` of a surface (u-major flat control indices),
 * with the surface's weights. See the module comment.
 */
export function surfaceFairnessMatrix(
  bu: Basis,
  bv: Basis,
  cw: ArrayLike<number>,
  rational: boolean,
  fw: ResolvedFairness,
  speed: SpeedSource,
  tol: Tolerances,
): Csr {
  const p1 = bu.degree + 1;
  const q1 = bv.degree + 1;
  const K = p1 * q1;
  const K2 = K * K;
  const P1SQ = p1 * p1;
  const Q1SQ = q1 * q1;
  const nv = bv.count;
  const su = spans(bu);
  const sv = spans(bv);
  const nsu = su.index.length;
  const nsv = sv.index.length;
  const npair = nsu * nsv;
  const geom = fw.metric === 'scaled' && speed.kind === 'geometry' ? speed : null;
  const pts = geom === null ? null : geom.points;
  const needBend = fw.bend > 0;
  // Per span pair: the control indices, ∫∫|S_u|², ∫∫|S_v|², and (rational
  // only: polynomial blocks are Kronecker products formed on the fly) the 5
  // parametric blocks.
  const blocks = new Float64Array(rational ? npair * SB_COUNT * K2 : 0);
  const idx = new Int32Array(npair * K);
  const sqU = new Float64Array(npair);
  const sqV = new Float64Array(npair);
  const area = new Float64Array(npair);
  const lenU = new Float64Array(npair);
  const lenV = new Float64Array(npair);

  const U = rational ? null : polySpanBlocks1d(bu);
  const V = rational ? null : polySpanBlocks1d(bv);
  if (U !== null && V !== null) {
    const P2 = p1 * p1;
    const Q2 = q1 * q1;
    const X = new Float64Array(K);
    const M = new Float64Array(K);
    /**
     * `Σ_c Σ A_ik B_jl X_c[i, j] X_c[k, l]` over the span pair's control
     * points `X_c` (`p+1 × q+1` per coordinate): the speed integral of the
     * Kronecker block `A ⊗ B` without forming it (`M = X B`, then `A`).
     */
    const quad = (o: number, ua: number, vb: number): number => {
      if (pts === null) return 0;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        for (let e = 0; e < K; e++) X[e] = pts[idx[o * K + e]! * 3 + c]!;
        for (let i = 0; i < p1; i++) {
          for (let l = 0; l < q1; l++) {
            let m = 0;
            for (let j = 0; j < q1; j++) m += X[i * q1 + j]! * V.blocks[vb + j * q1 + l]!;
            M[i * q1 + l] = m;
          }
        }
        for (let i = 0; i < p1; i++) {
          for (let k = 0; k < p1; k++) {
            const aik = U.blocks[ua + i * p1 + k]!;
            if (aik === 0) continue;
            let r = 0;
            for (let l = 0; l < q1; l++) r += X[k * q1 + l]! * M[i * q1 + l]!;
            sum += aik * r;
          }
        }
      }
      return sum;
    };
    for (let a = 0; a < nsu; a++) {
      for (let b = 0; b < nsv; b++) {
        const o = a * nsv + b;
        for (let i = 0; i < p1; i++) {
          const iu = localIndexOf(bu, su.index[a]!, i) * nv;
          for (let j = 0; j < q1; j++)
            idx[o * K + i * q1 + j] = iu + localIndexOf(bv, sv.index[b]!, j);
        }
        lenU[o] = su.e[a]! - su.a[a]!;
        lenV[o] = sv.e[b]! - sv.a[b]!;
        area[o] = lenU[o]! * lenV[o]!;
        sqU[o] = quad(o, (a * 3 + 1) * P2, (b * 3 + 0) * Q2);
        sqV[o] = quad(o, (a * 3 + 0) * P2, (b * 3 + 1) * Q2);
      }
    }
  } else {
    const s = makeScratch(Math.max(bu.degree, bv.degree), 3);
    const L = 3; // slots (k, l), k, l ≤ 2
    const R = new Float64Array(9 * K);
    const li = new Int32Array(K);
    const size = SB_COUNT * K2 + 2;
    const cur = new Float64Array(size);
    const prev = new Float64Array(size);
    const integrate = (a: number, b: number, nu: number, nvq: number, out: Float64Array): void => {
      out.fill(0);
      const gu = gaussLegendre(nu);
      const gv = gaussLegendre(nvq);
      const ua = su.a[a]!;
      const hu = (su.e[a]! - ua) / 2;
      const va = sv.a[b]!;
      const hv = (sv.e[b]! - va) / 2;
      for (let g = 0; g < nu; g++) {
        const u = ua + hu * (gu.nodes[g]! + 1);
        for (let r = 0; r < nvq; r++) {
          const v = va + hv * (gv.nodes[r]! + 1);
          const wt = hu * hv * gu.weights[g]! * gv.weights[r]!;
          surfaceLocal(bu, bv, cw, true, u, v, su.index[a]!, sv.index[b]!, 2, 2, s, li, R);
          const slots: readonly [number, number][] = [
            [SB_U, 1 * L + 0],
            [SB_V, 0 * L + 1],
            [SB_UU, 2 * L + 0],
            [SB_UV, 1 * L + 1],
            [SB_VV, 0 * L + 2],
          ];
          for (const [slot, rs] of slots) {
            if (!needBend && slot >= SB_UU) continue;
            const ob = slot * K2;
            const orr = rs * K;
            for (let i = 0; i < K; i++) {
              const ri = wt * R[orr + i]!;
              if (ri === 0) continue;
              for (let j = 0; j < K; j++)
                out[ob + i * K + j] = out[ob + i * K + j]! + ri * R[orr + j]!;
            }
          }
          if (pts !== null) {
            let qu = 0;
            let qv = 0;
            for (let c = 0; c < 3; c++) {
              let du = 0;
              let dv = 0;
              for (let e = 0; e < K; e++) {
                const x = pts[li[e]! * 3 + c]!;
                du += R[(1 * L + 0) * K + e]! * x;
                dv += R[(0 * L + 1) * K + e]! * x;
              }
              qu += du * du;
              qv += dv * dv;
            }
            out[SB_COUNT * K2] = out[SB_COUNT * K2]! + wt * qu;
            out[SB_COUNT * K2 + 1] = out[SB_COUNT * K2 + 1]! + wt * qv;
          }
        }
      }
    };
    for (let a = 0; a < nsu; a++) {
      for (let b = 0; b < nsv; b++) {
        const o = a * nsv + b;
        let nu = p1 + RATIONAL_GL_EXTRA;
        let nq = q1 + RATIONAL_GL_EXTRA;
        integrate(a, b, nu, nq, cur);
        for (;;) {
          prev.set(cur);
          if (nu + 1 > GL_MAX_ORDER || nq + 1 > GL_MAX_ORDER) break;
          nu++;
          nq++;
          integrate(a, b, nu, nq, cur);
          if (agree(prev, cur, SB_COUNT, K2, tol.quadRel)) {
            const okU =
              Math.abs(prev[SB_COUNT * K2]! - cur[SB_COUNT * K2]!) <=
              tol.quadRel * Math.abs(cur[SB_COUNT * K2]!);
            const okV =
              Math.abs(prev[SB_COUNT * K2 + 1]! - cur[SB_COUNT * K2 + 1]!) <=
              tol.quadRel * Math.abs(cur[SB_COUNT * K2 + 1]!);
            if (okU && okV) break;
          }
        }
        blocks.set(cur.subarray(0, SB_COUNT * K2), o * SB_COUNT * K2);
        // The control indices do not depend on the point; take them from one evaluation.
        surfaceLocal(
          bu,
          bv,
          cw,
          true,
          su.a[a]!,
          sv.a[b]!,
          su.index[a]!,
          sv.index[b]!,
          0,
          0,
          s,
          li,
          R,
        );
        for (let e = 0; e < K; e++) idx[o * K + e] = li[e]!;
        sqU[o] = cur[SB_COUNT * K2]!;
        sqV[o] = cur[SB_COUNT * K2 + 1]!;
        lenU[o] = su.e[a]! - su.a[a]!;
        lenV[o] = sv.e[b]! - sv.a[b]!;
        area[o] = lenU[o]! * lenV[o]!;
      }
    }
  }

  let lu: Float64Array;
  let lv: Float64Array;
  if (fw.metric === 'parametric') {
    lu = new Float64Array(npair).fill(1);
    lv = new Float64Array(npair).fill(1);
  } else if (geom !== null) {
    const fu = new Float64Array(npair);
    const fv = new Float64Array(npair);
    for (let o = 0; o < npair; o++) {
      fu[o] = speedFloor(geom.points, 3, idx, o, K, domainLength(bu), tol);
      fv[o] = speedFloor(geom.points, 3, idx, o, K, domainLength(bv), tol);
    }
    lu = speeds(sqU, area, fu);
    lv = speeds(sqV, area, fv);
  } else {
    lu = new Float64Array(npair).fill(speed.kind === 'uniform' ? speed.u : 1);
    lv = new Float64Array(npair).fill(speed.kind === 'uniform' ? speed.v : 1);
  }
  // Direct accumulation into the tensor pattern, span pairs in order: the
  // same sums, in the same order, as triplets summed by `cooToCsr`.
  const pu = pattern1d(bu, su);
  const pv = pattern1d(bv, sv);
  const out = tensorPattern(pu, pv);
  const val = out.val;
  const rp = out.rowPtr;
  const { stretch: al, bend: be } = fw;
  for (let o = 0; o < npair; o++) {
    const a = lu[o]!;
    const b = lv[o]!;
    const ab = a * b;
    const fU = (al * ab) / (a * a);
    const fV = (al * ab) / (b * b);
    const fUU = (be * ab) / (a * a * a * a);
    const fUV = (2 * be * ab) / (a * a * b * b);
    const fVV = (be * ab) / (b * b * b * b);
    const io = o * K;
    const sa = (o / nsv) | 0;
    const sb = o - sa * nsv;
    // Slot of local entry ((i, j), (k, l)) in the row of (i, j):
    // rowPtr + posU(i, k) · |row of j in v| + posV(j, l).
    const pa = sa * P1SQ;
    const pb = sb * Q1SQ;
    if (U !== null && V !== null) {
      // Kronecker products of the 1D span blocks: entry ((i, j), (k, l)) of
      // `A ⊗ B` is `A_ik B_jl`, for (U, V) orders (1, 0), (0, 1), (2, 0), (1, 1), (0, 2).
      const P2 = p1 * p1;
      const Q2 = q1 * q1;
      const u0 = sa * 3 * P2;
      const u1 = u0 + P2;
      const u2 = u1 + P2;
      const v0 = sb * 3 * Q2;
      const v1 = v0 + Q2;
      const v2 = v1 + Q2;
      const Ub = U.blocks;
      const Vb = V.blocks;
      for (let i = 0; i < p1; i++) {
        for (let j = 0; j < q1; j++) {
          const row = idx[io + i * q1 + j]!;
          const jv = row - ((row / nv) | 0) * nv;
          const lenV = pv.ptr[jv + 1]! - pv.ptr[jv]!;
          for (let k = 0; k < p1; k++) {
            const ik = i * p1 + k;
            const base = rp[row]! + pu.pos[pa + ik]! * lenV;
            for (let l = 0; l < q1; l++) {
              const jl = j * q1 + l;
              let v = 0;
              if (al !== 0) {
                v += fU * (Ub[u1 + ik]! * Vb[v0 + jl]!) + fV * (Ub[u0 + ik]! * Vb[v1 + jl]!);
              }
              if (needBend) {
                v +=
                  fUU * (Ub[u2 + ik]! * Vb[v0 + jl]!) +
                  fUV * (Ub[u1 + ik]! * Vb[v1 + jl]!) +
                  fVV * (Ub[u0 + ik]! * Vb[v2 + jl]!);
              }
              const at = base + pv.pos[pb + jl]!;
              val[at] = val[at]! + v;
            }
          }
        }
      }
      continue;
    }
    const ob = o * SB_COUNT * K2;
    for (let i = 0; i < K; i++) {
      const row = idx[io + i]!;
      const iu = (i / q1) | 0;
      const ju = i - iu * q1;
      const jv = row - ((row / nv) | 0) * nv;
      const lenV = pv.ptr[jv + 1]! - pv.ptr[jv]!;
      for (let j = 0; j < K; j++) {
        const e = i * K + j;
        const ku = (j / q1) | 0;
        const lv = j - ku * q1;
        let v = 0;
        if (al !== 0) v += fU * blocks[ob + SB_U * K2 + e]! + fV * blocks[ob + SB_V * K2 + e]!;
        if (needBend) {
          v +=
            fUU * blocks[ob + SB_UU * K2 + e]! +
            fUV * blocks[ob + SB_UV * K2 + e]! +
            fVV * blocks[ob + SB_VV * K2 + e]!;
        }
        const at = rp[row]! + pu.pos[pa + iu * p1 + ku]! * lenV + pv.pos[pb + ju * q1 + lv]!;
        val[at] = val[at]! + v;
      }
    }
  }
  return out;
}

/**
 * The sparsity pattern of a 1D Gram matrix: row `i` holds every `k` that
 * shares a non-empty span with `i` (sorted; periodic indices wrap), and
 * `pos[s·(p+1)² + i·(p+1) + k]` is where local function `k` of span `s`
 * sits in the row of local function `i`.
 */
function pattern1d(
  b: Basis,
  sp: ReturnType<typeof spans>,
): { ptr: Int32Array; col: Int32Array; pos: Int32Array } {
  const n = b.count;
  const p1 = b.degree + 1;
  const ns = sp.index.length;
  const rows: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < ns; s++) {
    for (let i = 0; i < p1; i++) {
      const r = rows[localIndexOf(b, sp.index[s]!, i)]!;
      for (let k = 0; k < p1; k++) {
        const c = localIndexOf(b, sp.index[s]!, k);
        if (!r.includes(c)) r.push(c);
      }
    }
  }
  const ptr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    rows[i]!.sort((x, y) => x - y);
    ptr[i + 1] = ptr[i]! + rows[i]!.length;
  }
  const col = new Int32Array(ptr[n]!);
  for (let i = 0; i < n; i++) col.set(rows[i]!, ptr[i]!);
  const pos = new Int32Array(ns * p1 * p1);
  for (let s = 0; s < ns; s++) {
    for (let i = 0; i < p1; i++) {
      const r = rows[localIndexOf(b, sp.index[s]!, i)]!;
      for (let k = 0; k < p1; k++) {
        pos[(s * p1 + i) * p1 + k] = r.indexOf(localIndexOf(b, sp.index[s]!, k));
      }
    }
  }
  return { ptr, col, pos };
}

/** The tensor-product pattern (u-major `i·nv + j`) of two 1D patterns, zero values. */
function tensorPattern(
  pu: { ptr: Int32Array; col: Int32Array },
  pv: { ptr: Int32Array; col: Int32Array },
): Csr {
  const nu = pu.ptr.length - 1;
  const nv = pv.ptr.length - 1;
  const n = nu * nv;
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const r = i * nv + j;
      rowPtr[r + 1] = rowPtr[r]! + (pu.ptr[i + 1]! - pu.ptr[i]!) * (pv.ptr[j + 1]! - pv.ptr[j]!);
    }
  }
  const col = new Int32Array(rowPtr[n]!);
  let e = 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      for (let a = pu.ptr[i]!; a < pu.ptr[i + 1]!; a++) {
        const k = pu.col[a]! * nv;
        for (let c = pv.ptr[j]!; c < pv.ptr[j + 1]!; c++) col[e++] = k + pv.col[c]!;
      }
    }
  }
  return { rows: n, cols: n, rowPtr, col, val: new Float64Array(col.length) };
}

function localIndexOf(b: Basis, span: number, j: number): number {
  const c = span - b.degree + j;
  return c < 0 ? c + b.count : c;
}

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

function isSurface(g: NurbsCurve | NurbsSurface): g is NurbsSurface {
  return (g as NurbsSurface).u !== undefined;
}

/** Euclidean control points (stride `dim`) of a homogeneous net (stride `dim + 1`). */
export function euclidean(cw: ArrayLike<number>, count: number, dim: number): Float64Array {
  const h = dim + 1;
  const out = new Float64Array(count * dim);
  for (let i = 0; i < count; i++) {
    const w = cw[i * h + dim]!;
    for (let c = 0; c < dim; c++) out[i * dim + c] = w === 1 ? cw[i * h + c]! : cw[i * h + c]! / w;
  }
  return out;
}

function sameBasis(a: Basis, b: Basis): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.degree !== b.degree || a.count !== b.count) return false;
  if (a.kind === 'periodic' && b.kind === 'periodic' && a.period !== b.period) return false;
  for (let i = 0; i < a.knots.length; i++) if (a.knots[i] !== b.knots[i]) return false;
  return true;
}

/** The fairness matrix of `g` (scalar, over its control points) with speeds from `ref`. */
export function fairnessMatrixOf(
  g: NurbsCurve | NurbsSurface,
  fw: ResolvedFairness,
  ref: NurbsCurve | NurbsSurface,
  tol: Tolerances,
): Csr {
  if (isSurface(g)) {
    const r = ref as NurbsSurface;
    const pts = euclidean(r.cw, r.u.count * r.v.count, 3);
    return surfaceFairnessMatrix(
      g.u,
      g.v,
      g.cw,
      g.rational,
      fw,
      { kind: 'geometry', points: pts, dim: 3 },
      tol,
    );
  }
  const r = ref as NurbsCurve;
  const pts = euclidean(r.cw, r.basis.count, r.dim);
  return curveFairnessMatrix(
    g.basis,
    g.cw,
    g.dim,
    g.rational,
    fw,
    { kind: 'geometry', points: pts, dim: r.dim },
    tol,
  );
}

/**
 * The fairness energy `α E₁ + β E₂ (+ γ E₃)` of `g` (module comment), or, with
 * a `reference` on the same bases and weights, of the displacement
 * `g − reference` (the speeds of the scaled metric then come from the
 * reference, as in an edit). `w.on` is not read: the presence of
 * `reference` decides.
 */
export function fairnessEnergy(
  g: NurbsCurve | NurbsSurface,
  w: FairnessWeights,
  reference?: NurbsCurve | NurbsSurface,
): number {
  const surf = isSurface(g);
  if (surf) checkSurfaceShape(g);
  else checkCurveShape(g);
  const fw = checkFairness(w, surf ? 'surface' : 'curve', 'shape');
  const ref = reference ?? g;
  if (reference !== undefined) {
    if (isSurface(reference) !== surf) {
      fail('dimension-mismatch', 'reference must be the same kind of geometry (curve or surface)');
    }
    if (surf) {
      const r = reference as NurbsSurface;
      checkSurfaceShape(r);
      if (!sameBasis(g.u, r.u) || !sameBasis(g.v, r.v)) {
        fail('size-mismatch', 'reference must have the same bases as the surface');
      }
    } else {
      const r = reference as NurbsCurve;
      checkCurveShape(r);
      if (r.dim !== g.dim || !sameBasis(g.basis, r.basis)) {
        fail('size-mismatch', 'reference must have the same dimension and basis as the curve');
      }
    }
    const h = surf ? 4 : (g as NurbsCurve).dim + 1;
    for (let i = h - 1; i < g.cw.length; i += h) {
      if (g.cw[i] !== reference.cw[i]) {
        fail('size-mismatch', 'reference must have the same weights', { index: (i - h + 1) / h });
      }
    }
  }
  const tol = resolveTolerances();
  const F = fairnessMatrixOf(g, fw, ref, tol);
  const dim = surf ? 3 : (g as NurbsCurve).dim;
  const n = F.rows;
  const y = euclidean(g.cw, n, dim);
  if (reference !== undefined) {
    const r = euclidean(reference.cw, n, dim);
    for (let i = 0; i < y.length; i++) y[i] = y[i]! - r[i]!;
  }
  let e = 0;
  for (let i = 0; i < n; i++) {
    for (let p = F.rowPtr[i]!; p < F.rowPtr[i + 1]!; p++) {
      const j = F.col[p]!;
      let d = 0;
      for (let c = 0; c < dim; c++) d += y[i * dim + c]! * y[j * dim + c]!;
      e += F.val[p]! * d;
    }
  }
  return e;
}
