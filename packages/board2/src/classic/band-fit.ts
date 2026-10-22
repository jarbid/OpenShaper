// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The band fit of the converter (docs/design/board2.md §9.7 items 2–3, §9.8;
 * step S7, see "S7 as built" there for the deviations).
 *
 * **Data.** Classic loft samples on the rail: in each row, the deck-side ring
 * points outside the deck-edge loop, the sampled apex, and the bottom-side
 * points outside the tuck loop, both halves (the loft rows lie in the solid
 * span, so the floor zones are excluded; rows in the tip windows are left out,
 * their columns are not fitted). Samples within the crease windows are data
 * but not judged (as for the height fields, §9.6).
 *
 * **Unknowns: the DOF map of §3.5 and §3.7, written out, with the apex
 * fixed.** The band's control net is the initial band's (built on the apex
 * law, `rail.ts`) plus, per master (or self-paired) column outside the tip
 * windows, five displacements along the structural directions read off the
 * initial net (as `bandRowRules` reads them): row 1 along `τ̂_d` (row 1 −
 * row 0), rows 2 and 4 along ẑ, row 5 along `n̂` (the horizontal part of
 * row 0 − row 3) and ẑ; rows 0, 3 and 6 are fixed. Partner columns are the
 * exact mirrors of their masters. Since the rules are linear,
 * `S(u, v) = S₀(u, v) + J(u, v) w`, and the fit is the linear least squares
 *
 *     minimise  Σ_k |S₀(u_k, v_k) + J_k w − q_k|²  +  β δᵀ (G₂ ⊗ I₃) δ,   δ = J_net w,
 *
 * with the thin plate `G₂` of the band's bases (parametric metric, as the
 * height fields; u periodic) on the displacement from the initial band (§9.7
 * item 3). This is what geom's `FairProblem` with the band's DOF rules solves;
 * written out here the data's normal equations are assembled once per
 * parameter set and every fairness trial is one small banded factorisation.
 *
 * **Data-scale unknowns.** The band basis crowds its columns where the plan
 * turns fast (a few hundredths of a millimetre apart at a 0.5 cm fillet, for
 * `maxFrameTurn`), far closer than the data rows (`sampleSpacingX`), and
 * there the least squares has nothing to tell neighbouring columns apart: at
 * small fairness their displacements zig-zag by metres while the surface
 * between them barely moves. So the unknowns are the displacements of the
 * **kept** masters only, at least `minSigma` apart in σ (the row spacing over
 * the loop's length), and every other master interpolates its two kept
 * neighbours linearly in σ (`w = R c`, `Rᵀ H R` stays banded).
 *
 * **Bounds** keep every column a valid convex profile (`profileRows`): the
 * deck handle between `fMin` of the way to the corner `C_u` and short of the
 * apex vertical, the upper apex handle between `fMin` and 1 of `H_u`, the
 * lower between `fMin` and 1 of `H_l`, the tuck handle inboard of the apex
 * vertical (`solveBand`); interpolated masters are moved into their own bounds.
 *
 * **Fairness** (§9.8): the largest weight whose fit meets `surfaceTol` on the
 * judged samples; when even the smallest weight of the bracket cannot (the
 * classic rail outside what the profile construction carries: a profile
 * corner, a box rail), the largest weight that keeps every judged sample
 * within `surfaceTol` of where the smallest weight puts it.
 *
 * **Parameters.** Initial (u, v) by projection onto the initial band
 * (`projectPointsToSurfaceInto`, seeded per sample from the plan parameter of
 * its row and its place on the ring), then `bandCorrectionPasses` passes of
 * re-projection (warm: each sample from its previous foot) and a new search
 * (P&T §9.4.1 parameter correction).
 */
import {
  clampedBasis,
  createScratch,
  curveEvalInto,
  findSpan,
  basisFunsInto,
  makeSurface,
  projectPointsToSurfaceInto,
} from '@openshaper/geom';
import type { NurbsSurface, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { BAND_V_KNOTS } from '../band/band';
import { BAND_ROWS } from '../band/profile';
import type { BandBasis, Column } from '../band/stations';
import { cholFactor, cholRcond, cholSolve, gram1d } from './lsq';
import type { ColumnInputs } from './extract';
import type { RowClassifier } from './membership';
import type { LoftSamples } from './sample';
import type { ConvertOptions } from './types';

const STRIDE = BAND_ROWS * 3;

/** The loop parameter on the −y half where the plan's x equals `x` (x increases there: standard tail). */
export function paramOfX(plan: PeriodicCurve<2>, x: number): number {
  const sc = createScratch({ maxDegree: plan.basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  const xAt = (u: number): number => {
    curveEvalInto(plan, u, 0, q, 0, sc);
    return q[0]!;
  };
  let lo = 0;
  let hi = 0.5;
  for (;;) {
    const mid = 0.5 * (lo + hi);
    if (!(mid > lo && mid < hi)) break;
    if (xAt(mid) < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xAt(lo) - x) <= Math.abs(xAt(hi) - x) ? lo : hi;
}

/** Rail samples with judged flags and projection seeds (module comment). */
export interface BandSamples {
  /** (x, y, z) triples, board2 coordinates. */
  readonly points: Float64Array;
  /** 1 outside the crease and tip windows. */
  readonly judged: Uint8Array;
  /** (u, v) seeds for the first projection. */
  readonly seeds: Float64Array;
}

/**
 * The rail samples of the loft rows (module comment). `shift` moves classic x
 * into board2 x; `deckEdge` and `tuck` classify plan points against the inset
 * loops; `inWindow` says whether a board2 x is in a crease or tip window (not
 * judged), `inTip` whether it is in a tip zone (not data: see `frozen` in
 * {@link bandFitFrame}).
 */
export function bandSamples(
  loft: LoftSamples,
  shift: number,
  deckEdge: RowClassifier,
  tuck: RowClassifier,
  inWindow: (x: number) => boolean,
  inTip: (x: number) => boolean,
  plan: PeriodicCurve<2>,
): BandSamples {
  const nf = loft.fractions.length;
  const pts: number[] = [];
  const judged: number[] = [];
  const seeds: number[] = [];
  for (let r = 0; r < loft.x.length; r++) {
    const x = loft.x[r]! - shift;
    if (inTip(x)) continue;
    const a = loft.apex[r]!;
    const dc = deckEdge.crossings(x);
    const tc = tuck.crossings(x);
    const keep: number[] = [];
    for (let k = 0; k < nf; k++) {
      const y = loft.y[r * nf + k]!;
      if (!(y > 0)) continue;
      if (k > a && deckEdge.inside(dc, y)) continue;
      if (k < a && tuck.inside(tc, y)) continue;
      keep.push(k);
    }
    if (keep.length === 0) continue;
    // Seeds: u from the plan, v from the ring position (0 at the deck edge, ½ at the apex, 1 at the tuck).
    const um = paramOfX(plan, x);
    const kd = Math.max(a, ...keep.filter((k) => k > a));
    const kt = Math.min(a, ...keep.filter((k) => k < a));
    const j = inWindow(x) ? 0 : 1;
    for (const k of keep) {
      const v = k >= a ? (0.5 * (kd + 1 - k)) / (kd + 1 - a) : 0.5 + (0.5 * (a - k)) / (a - kt + 1);
      const y = loft.y[r * nf + k]!;
      const z = loft.z[r * nf + k]!;
      pts.push(x, -y, z, x, y, z);
      judged.push(j, j);
      seeds.push(um, v, 1 - um, v);
    }
  }
  return {
    points: Float64Array.from(pts),
    judged: Uint8Array.from(judged),
    seeds: Float64Array.from(seeds),
  };
}

/** Projects the samples onto `band` from `seeds` (uv pairs); returns the feet and distances. */
export function projectSamples(
  band: NurbsSurface,
  points: Float64Array,
  seeds: Float64Array,
  tol: Tolerances,
): { uv: Float64Array; distance: Float64Array } {
  const n = points.length / 3;
  const uv = new Float64Array(2 * n);
  const distance = new Float64Array(n);
  projectPointsToSurfaceInto(band, points, uv, distance, { seeds, tol });
  return { uv, distance };
}

/** The five column displacements (module comment). */
const S1 = 0;
const B2 = 1;
const B4 = 2;
const N5 = 3;
const Z5 = 4;
const DOFS = 5;

/** The band fit's geometry: the initial net, its columns' masters and directions. */
export interface BandFitFrame {
  readonly basis: BandBasis;
  /** Initial (target) net, `nu × 7` points, u-major. */
  readonly target: Float64Array;
  readonly nu: number;
  /** Per column: the unknown block of its master (−1 when frozen), and −1 for a partner (y mirrored), else 1. */
  readonly master: Int32Array;
  readonly sy: Float64Array;
  /** Master columns in unknown order (ascending u). */
  readonly masters: Int32Array;
  /** Per column: `τ̂_d` and `n̂` (unit, 3 each) of its master, unmirrored. */
  readonly tau: Float64Array;
  readonly inward: Float64Array;
  /** The displacements solved for (all six, or five with the apex fixed). */
  readonly free: readonly number[];
  /**
   * Bounds of every unknown (module comment): the deck handle between
   * `fMin` of the way to the corner `C_u` and the corner itself (on the apex
   * vertical), the apex handles at least `fMin` of `H_u` and `H_l`, the tuck
   * handle inboard of the apex vertical. `fMin` is `fullnessRange[0]`; the
   * handles stay `margin` (geom's `point` tolerance) inboard of the vertical, so
   * the rebuild's rounding cannot put them past it.
   */
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  /**
   * The unknowns' columns (module comment, "Data-scale unknowns"): per master
   * `m`, its displacements are `(1 − t_m) c_{j0_m} + t_m c_{j1_m}` over the
   * kept masters' `c` (a kept master has `j0 = j1` and `t = 0`).
   */
  readonly kept: number;
  readonly j0: Int32Array;
  readonly j1: Int32Array;
  readonly t: Float64Array;
}

/** The frame of a fit on band basis `b` with initial net `target`. */
export function bandFitFrame(
  b: BandBasis,
  columns: readonly Column[],
  target: Float64Array,
  inputs: ColumnInputs,
  fMin: number,
  margin: number,
  minSigma: number,
  frozen: (x: number) => boolean = () => false,
): BandFitFrame {
  const nu = b.basis.count;
  const masterCols: number[] = [];
  for (let i = 0; i < nu; i++) {
    if (columns[i]!.role !== 'partner' && !frozen(target[i * STRIDE + 9]!)) masterCols.push(i);
  }
  masterCols.sort((p, q) => columns[p]!.u - columns[q]!.u);
  const block = new Int32Array(nu).fill(-1);
  masterCols.forEach((i, m) => (block[i] = m));
  const master = new Int32Array(nu);
  const sy = new Float64Array(nu);
  for (let i = 0; i < nu; i++) {
    const c = columns[i]!;
    master[i] = c.role === 'partner' ? block[c.partner]! : block[i]!;
    sy[i] = c.role === 'partner' ? -1 : 1;
  }
  const tau = new Float64Array(3 * nu);
  const inward = new Float64Array(3 * nu);
  for (const i of masterCols) {
    const o = i * STRIDE;
    const tx = target[o + 3]! - target[o]!;
    const ty = target[o + 4]! - target[o + 1]!;
    const tz = target[o + 5]! - target[o + 2]!;
    const tl = Math.hypot(tx, ty, tz);
    const nx = target[o]! - target[o + 9]!;
    const ny = target[o + 1]! - target[o + 10]!;
    const nl = Math.hypot(nx, ny);
    tau.set([tx / tl, ty / tl, tz / tl], 3 * i);
    inward.set([nx / nl, ny / nl, 0], 3 * i);
  }
  for (let i = 0; i < nu; i++) {
    if (columns[i]!.role !== 'partner' || block[columns[i]!.partner]! < 0) continue;
    const p = columns[i]!.partner;
    tau.set(tau.subarray(3 * p, 3 * p + 3), 3 * i);
    inward.set(inward.subarray(3 * p, 3 * p + 3), 3 * i);
  }
  const free = [S1, B2, B4, N5, Z5];
  const nd = free.length;
  const lo = new Float64Array(masterCols.length * nd).fill(-Infinity);
  const hi = new Float64Array(masterCols.length * nd).fill(Infinity);
  masterCols.forEach((i, m) => {
    const o = i * STRIDE;
    const P = (r: number, c: number): number => target[o + 3 * r + c]!;
    const t = tau.subarray(3 * i, 3 * i + 3);
    const nx = inward[3 * i]!;
    const ny = inward[3 * i + 1]!;
    // The deck handle runs from P0 along τ̂_d to the corner C_u on the apex vertical.
    const corner = inputs.wd[i]! * Math.hypot(1, inputs.sd[i]!);
    const dh0 =
      (P(1, 0) - P(0, 0)) * t[0]! + (P(1, 1) - P(0, 1)) * t[1]! + (P(1, 2) - P(0, 2)) * t[2]!;
    const az = P(3, 2);
    const hu = inputs.ez[i]! + inputs.sd[i]! * inputs.wd[i]! - az;
    const hl = az - (inputs.tz[i]! + inputs.sb[i]! * inputs.wt[i]!);
    const inb5 = (P(5, 0) - P(3, 0)) * nx + (P(5, 1) - P(3, 1)) * ny;
    const k = (d: number): number => m * nd + free.indexOf(d);
    lo[k(S1)] = fMin * corner - dh0;
    // Fullness at most 1: the upper apex handle no higher than the corner C_u.
    hi[k(B2)] = hu - (P(2, 2) - az);
    // Inboard of the apex vertical by fMin of the inset (and at least `margin`).
    const room = (w: number): number => Math.max(margin, fMin * w);
    hi[k(S1)] = corner - dh0 - room(inputs.wd[i]!) * Math.hypot(1, inputs.sd[i]!);
    lo[k(B2)] = fMin * hu - (P(2, 2) - az);
    hi[k(B4)] = az - P(4, 2) - fMin * hl;
    lo[k(B4)] = az - P(4, 2) - (1 - fMin) * hl;
    lo[k(N5)] = room(inputs.wt[i]!) - inb5;
  });
  // Kept masters: the first, the last, and every one at least `minSigma` past
  // the previous kept one; the rest interpolate their two kept neighbours in σ.
  const M = masterCols.length;
  const keptAt: number[] = [];
  masterCols.forEach((i, m) => {
    const s = columns[i]!.sigma;
    if (
      m === 0 ||
      m === M - 1 ||
      s - columns[masterCols[keptAt[keptAt.length - 1]!]!]!.sigma >= minSigma
    )
      keptAt.push(m);
  });
  const j0 = new Int32Array(M);
  const j1 = new Int32Array(M);
  const tt = new Float64Array(M);
  for (let j = 0; j < keptAt.length; j++) {
    const a = keptAt[j]!;
    const e = j + 1 < keptAt.length ? keptAt[j + 1]! : a;
    const sa = columns[masterCols[a]!]!.sigma;
    const se = columns[masterCols[e]!]!.sigma;
    for (let m = a; m <= e; m++) {
      if (m === e && e !== a) break;
      j0[m] = j;
      j1[m] = m === a ? j : j + 1;
      tt[m] = m === a ? 0 : (columns[masterCols[m]!]!.sigma - sa) / (se - sa);
    }
  }
  return Object.freeze({
    basis: b,
    target,
    nu,
    master,
    sy,
    kept: keptAt.length,
    j0,
    j1,
    t: tt,
    masters: Int32Array.from(masterCols),
    tau,
    inward,
    free,
    lo,
    hi,
  });
}

/**
 * The 3-vector that unit displacement `d` of column `i`'s master adds to
 * control point (i, row) (y mirrored on a partner), or `null` when none.
 */
function direction(f: BandFitFrame, i: number, row: number, d: number, out: Float64Array): boolean {
  if (f.master[i]! < 0) return false;
  const sy = f.sy[i]!;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  switch (d) {
    case S1:
      if (row !== 1) return false;
      out[0] = f.tau[3 * i]!;
      out[1] = sy * f.tau[3 * i + 1]!;
      out[2] = f.tau[3 * i + 2]!;
      return true;
    case B2:
      if (row !== 2) return false;
      out[2] = 1;
      return true;
    case B4:
      if (row !== 4) return false;
      out[2] = 1;
      return true;
    case N5:
      if (row !== 5) return false;
      out[0] = f.inward[3 * i]!;
      out[1] = sy * f.inward[3 * i + 1]!;
      return true;
    case Z5:
      if (row !== 5) return false;
      out[2] = 1;
      return true;
  }
  return false;
}

/** The band's (u, v) bases: the band basis and the clamped seven-row v basis (§3.5). */
function bases(f: BandFitFrame) {
  return { bu: f.basis.basis, bv: clampedBasis(3, BAND_V_KNOTS) };
}

/** A fit problem: the frame, the samples at fixed parameters, and the assembled normal equations. */
export interface BandFitProblem {
  readonly frame: BandFitFrame;
  readonly n: number;
  readonly points: Float64Array;
  /** Per sample: u span, v span and the 4 + 4 basis values. */
  readonly su: Int32Array;
  readonly sv: Int32Array;
  readonly nuv: Float64Array;
  readonly nvv: Float64Array;
  readonly size: number;
  readonly bw: number;
  readonly Hd: Float64Array;
  readonly gd: Float64Array;
  readonly Kf: Float64Array;
  /** Bounds of the kept unknowns. */
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  /** tr(data normal matrix) / tr(fairness): β = ratio × this. */
  readonly betaScale: number;
}

/** Assembles the fit of `frame` to `points` at parameters `uv` (module comment). */
export function bandFitProblem(
  frame: BandFitFrame,
  points: Float64Array,
  uv: Float64Array,
): BandFitProblem {
  const { bu, bv } = bases(frame);
  const p = bu.degree;
  const q = bv.degree;
  const nu = frame.nu;
  const n = points.length / 3;
  const nd = frame.free.length;
  const dpos = new Int32Array(DOFS).fill(-1);
  frame.free.forEach((d, k) => (dpos[d] = k));
  const size = frame.masters.length * nd;
  const sc = createScratch({ maxDegree: Math.max(p, q), maxDerivs: 0 });
  const su = new Int32Array(n);
  const sv = new Int32Array(n);
  const nuv = new Float64Array(4 * n);
  const nvv = new Float64Array(4 * n);
  const T = frame.target;
  const dir = new Float64Array(3);
  // Local rows: up to 4 columns × 6 unknowns, three coordinates each.
  const keys = new Int32Array(4 * DOFS);
  const vals = new Float64Array(3 * 4 * DOFS);
  const rowsOf: { m: number; keys: Int32Array; vals: Float64Array; e: Float64Array }[] = [];
  let bw = 0;
  const local = (k: number): { m: number; e: [number, number, number] } => {
    const u = uv[2 * k]!;
    const v = uv[2 * k + 1]!;
    const ku = findSpan(bu, u);
    const kv = findSpan(bv, v);
    su[k] = ku;
    sv[k] = kv;
    basisFunsInto(bu, ku, u, nuv, 4 * k, sc);
    basisFunsInto(bv, kv, v, nvv, 4 * k, sc);
    let m = 0;
    const e: [number, number, number] = [points[3 * k]!, points[3 * k + 1]!, points[3 * k + 2]!];
    for (let a = 0; a <= p; a++) {
      const i = (((ku - p + a) % nu) + nu) % nu;
      for (let b2 = 0; b2 <= q; b2++) {
        const row = kv - q + b2;
        const c = nuv[4 * k + a]! * nvv[4 * k + b2]!;
        if (c === 0) continue;
        const o = i * STRIDE + row * 3;
        e[0] -= c * T[o]!;
        e[1] -= c * T[o + 1]!;
        e[2] -= c * T[o + 2]!;
        for (const d of frame.free) {
          if (!direction(frame, i, row, d, dir)) continue;
          const key = frame.master[i]! * nd + dpos[d]!;
          let s = 0;
          while (s < m && keys[s] !== key) s++;
          if (s === m) {
            keys[m] = key;
            vals[3 * m] = 0;
            vals[3 * m + 1] = 0;
            vals[3 * m + 2] = 0;
            m++;
          }
          vals[3 * s] = vals[3 * s]! + c * dir[0]!;
          vals[3 * s + 1] = vals[3 * s + 1]! + c * dir[1]!;
          vals[3 * s + 2] = vals[3 * s + 2]! + c * dir[2]!;
        }
      }
    }
    return { m, e };
  };
  for (let k = 0; k < n; k++) {
    const { m, e } = local(k);
    let lo = Infinity;
    let hi = -Infinity;
    for (let s = 0; s < m; s++) {
      lo = Math.min(lo, keys[s]!);
      hi = Math.max(hi, keys[s]!);
    }
    if (m > 0) bw = Math.max(bw, hi - lo);
    rowsOf.push({ m, keys: keys.slice(0, m), vals: vals.slice(0, 3 * m), e: Float64Array.from(e) });
  }

  // Fairness: δᵀ (G₂ ⊗ I₃) δ with δ = J w; G₂ = Gu₂⊗Gv₀ + 2 Gu₁⊗Gv₁ + Gu₀⊗Gv₂.
  const [gu0, gu1, gu2] = gram1d(bu);
  const [gv0, gv1, gv2] = gram1d(bv);
  const terms = [
    [gu2, gv0, 1],
    [gu1, gv1, 2],
    [gu0, gv2, 1],
  ] as const;
  const R = BAND_ROWS;
  // Per column and row, the (unknown, 3-vector) pairs.
  const jac: { key: number; x: number; y: number; z: number }[][] = [];
  for (let i = 0; i < nu; i++) {
    for (let r = 0; r < R; r++) {
      const l: { key: number; x: number; y: number; z: number }[] = [];
      for (const d of frame.free) {
        if (!direction(frame, i, r, d, dir)) continue;
        l.push({ key: frame.master[i]! * nd + dpos[d]!, x: dir[0]!, y: dir[1]!, z: dir[2]! });
      }
      jac.push(l);
    }
  }
  const fair: { a: number; b: number; v: number }[] = [];
  for (let i = 0; i < nu; i++) {
    for (let di = -p; di <= p; di++) {
      const i2 = (((i + di) % nu) + nu) % nu;
      for (let r = 0; r < R; r++) {
        const J1 = jac[i * R + r]!;
        if (J1.length === 0) continue;
        for (let r2 = 0; r2 < R; r2++) {
          const J2 = jac[i2 * R + r2]!;
          if (J2.length === 0) continue;
          let g = 0;
          for (const [A, B, w] of terms) g += w * A[i * nu + i2]! * B[r * R + r2]!;
          if (g === 0) continue;
          for (const x1 of J1) {
            for (const x2 of J2) {
              if (x2.key > x1.key) continue;
              const dot = x1.x * x2.x + x1.y * x2.y + x1.z * x2.z;
              if (dot !== 0) fair.push({ a: x1.key, b: x2.key, v: g * dot });
            }
          }
        }
      }
    }
  }
  for (const e of fair) bw = Math.max(bw, e.a - e.b);
  const W = bw + 1;
  const Hd = new Float64Array(size * W);
  const gd = new Float64Array(size);
  for (const row of rowsOf) {
    for (let s = 0; s < row.m; s++) {
      const a = row.keys[s]!;
      const ax = row.vals[3 * s]!;
      const ay = row.vals[3 * s + 1]!;
      const az = row.vals[3 * s + 2]!;
      gd[a] = gd[a]! + ax * row.e[0]! + ay * row.e[1]! + az * row.e[2]!;
      for (let t = 0; t < row.m; t++) {
        const b = row.keys[t]!;
        if (b > a) continue;
        Hd[a * W + (b - a + bw)] =
          Hd[a * W + (b - a + bw)]! +
          ax * row.vals[3 * t]! +
          ay * row.vals[3 * t + 1]! +
          az * row.vals[3 * t + 2]!;
      }
    }
  }
  const Kf = new Float64Array(size * W);
  for (const e of fair) Kf[e.a * W + (e.b - e.a + bw)] = Kf[e.a * W + (e.b - e.a + bw)]! + e.v;
  // The data-scale unknowns: w = R c (module comment), R with at most two
  // entries per row, so Rᵀ H R stays banded.
  const toKept = (wi: number): readonly (readonly [number, number])[] => {
    const m = (wi / nd) | 0;
    const k = wi - m * nd;
    const a = frame.j0[m]! * nd + k;
    const b = frame.j1[m]! * nd + k;
    const t = frame.t[m]!;
    return a === b || t === 0
      ? [[a, 1]]
      : [
          [a, 1 - t],
          [b, t],
        ];
  };
  const sizeC = frame.kept * nd;
  let bwC = 0;
  for (let i = 0; i < size; i++)
    for (let j = Math.max(0, i - bw); j <= i; j++)
      for (const [a] of toKept(i))
        for (const [b] of toKept(j)) bwC = Math.max(bwC, Math.abs(a - b));
  const WC = bwC + 1;
  const reduce = (A: Float64Array): Float64Array => {
    const out = new Float64Array(sizeC * WC);
    for (let i = 0; i < size; i++) {
      for (let j = Math.max(0, i - bw); j <= i; j++) {
        const v = A[i * W + (j - i + bw)]!;
        if (v === 0) continue;
        // M = Rᵀ A R from A's lower band: a diagonal entry gives M_ab for b ≤ a;
        // an off-diagonal (i, j) and its mirror (j, i) give M_ab and M_ba, of
        // which the lower one is stored (both when a = b).
        for (const [a, wa] of toKept(i)) {
          for (const [b, wb] of toKept(j)) {
            const x = wa * wb * v;
            if (i === j) {
              if (b <= a) out[a * WC + (b - a + bwC)] = out[a * WC + (b - a + bwC)]! + x;
            } else {
              const r = Math.max(a, b);
              const c = Math.min(a, b);
              out[r * WC + (c - r + bwC)] = out[r * WC + (c - r + bwC)]! + (a === b ? 2 * x : x);
            }
          }
        }
      }
    }
    return out;
  };
  const HdC = reduce(Hd);
  const KfC = reduce(Kf);
  const gdC = new Float64Array(sizeC);
  for (let i = 0; i < size; i++) for (const [a, wa] of toKept(i)) gdC[a] = gdC[a]! + wa * gd[i]!;
  const lo = new Float64Array(sizeC);
  const hi = new Float64Array(sizeC);
  for (let m = 0; m < frame.masters.length; m++) {
    if (frame.t[m] !== 0 || frame.j0[m] !== frame.j1[m]) continue;
    for (let k = 0; k < nd; k++) {
      lo[frame.j0[m]! * nd + k] = frame.lo[m * nd + k]!;
      hi[frame.j0[m]! * nd + k] = frame.hi[m * nd + k]!;
    }
  }
  let trH = 0;
  let trK = 0;
  for (let i = 0; i < sizeC; i++) {
    trH += HdC[i * WC + bwC]!;
    trK += KfC[i * WC + bwC]!;
  }
  return Object.freeze({
    frame,
    n,
    points,
    su,
    sv,
    nuv,
    nvv,
    size: sizeC,
    bw: bwC,
    Hd: HdC,
    gd: gdC,
    Kf: KfC,
    lo,
    hi,
    betaScale: trK > 0 ? trH / trK : 1,
  });
}

/**
 * The displacements of every master from the kept masters' `c` (module
 * comment), each moved into its own bounds: an interpolated master can leave
 * the interval its own column allows.
 */
export function expandDisplacements(f: BandFitFrame, c: Float64Array): Float64Array {
  const nd = f.free.length;
  const M = f.masters.length;
  const w = new Float64Array(M * nd);
  for (let m = 0; m < M; m++) {
    const t = f.t[m]!;
    for (let k = 0; k < nd; k++) {
      const a = c[f.j0[m]! * nd + k]!;
      const v = t === 0 ? a : (1 - t) * a + t * c[f.j1[m]! * nd + k]!;
      w[m * nd + k] = Math.min(Math.max(v, f.lo[m * nd + k]!), f.hi[m * nd + k]!);
    }
  }
  return w;
}

/** The net of displacements `w` (partners mirrored exactly from their masters). */
export function netOf(f: BandFitFrame, w: Float64Array | null): Float64Array {
  const net = f.target.slice();
  if (w === null) return net;
  const nd = f.free.length;
  const dir = new Float64Array(3);
  for (const i of f.masters) {
    const m = f.master[i]!;
    for (let r = 0; r < BAND_ROWS; r++) {
      f.free.forEach((d, k) => {
        if (!direction(f, i, r, d, dir)) return;
        const x = w[m * nd + k]!;
        const o = i * STRIDE + r * 3;
        net[o] = net[o]! + x * dir[0]!;
        net[o + 1] = net[o + 1]! + x * dir[1]!;
        net[o + 2] = net[o + 2]! + x * dir[2]!;
      });
    }
  }
  // Partners: the exact mirror of their master column (y negated).
  const pairing = f.basis.pairing;
  if (pairing !== null) {
    for (let i = 0; i < f.nu; i++) {
      if (pairing.role[i] !== 'partner') continue;
      const p = pairing.partner[i]!;
      for (let r = 0; r < BAND_ROWS; r++) {
        net[i * STRIDE + r * 3] = net[p * STRIDE + r * 3]!;
        net[i * STRIDE + r * 3 + 1] = -net[p * STRIDE + r * 3 + 1]!;
        net[i * STRIDE + r * 3 + 2] = net[p * STRIDE + r * 3 + 2]!;
      }
    }
  }
  return net;
}

/** The band surface of a net on the frame's bases. */
export function bandSurface(f: BandFitFrame, net: Float64Array): NurbsSurface {
  const { bu, bv } = bases(f);
  return makeSurface({ u: bu, v: bv, points: net });
}

/**
 * Whether every master column of `net` is a profile the factorised document
 * can carry (module comment): rows 1 and 5 inboard of the apex vertical, the
 * deck handle along `+τ̂_d`, the apex handles of positive length, the tuck
 * handle of positive length.
 */
export function validColumns(f: BandFitFrame, net: Float64Array): boolean {
  for (const i of f.masters) {
    const o = i * STRIDE;
    const ax = net[o + 9]!;
    const ay = net[o + 10]!;
    const az = net[o + 11]!;
    const nx = f.inward[3 * i]!;
    const ny = f.inward[3 * i + 1]!;
    const inboard = (r: number): number =>
      (net[o + 3 * r]! - ax) * nx + (net[o + 3 * r + 1]! - ay) * ny;
    const t = f.tau.subarray(3 * i, 3 * i + 3);
    const deckHandle =
      (net[o + 3]! - net[o]!) * t[0]! +
      (net[o + 4]! - net[o + 1]!) * t[1]! +
      (net[o + 5]! - net[o + 2]!) * t[2]!;
    const tuckHandle = Math.hypot(
      net[o + 15]! - net[o + 18]!,
      net[o + 16]! - net[o + 19]!,
      net[o + 17]! - net[o + 20]!,
    );
    if (
      !(inboard(1) >= 0) ||
      !(inboard(5) >= 0) ||
      !(deckHandle > 0) ||
      !(net[o + 8]! - az > 0) ||
      !(az - net[o + 14]! > 0) ||
      !(tuckHandle > 0)
    )
      return false;
  }
  return true;
}

/** |S(u_k, v_k) − q_k| per sample for a net (the parametric residual the least squares minimises). */
export function residuals(P: BandFitProblem, net: Float64Array): Float64Array {
  const { bu, bv } = bases(P.frame);
  const p = bu.degree;
  const q = bv.degree;
  const nu = P.frame.nu;
  const out = new Float64Array(P.n);
  for (let k = 0; k < P.n; k++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let a = 0; a <= p; a++) {
      const i = (((P.su[k]! - p + a) % nu) + nu) % nu;
      for (let b = 0; b <= q; b++) {
        const c = P.nuv[4 * k + a]! * P.nvv[4 * k + b]!;
        const o = i * STRIDE + (P.sv[k]! - q + b) * 3;
        x += c * net[o]!;
        y += c * net[o + 1]!;
        z += c * net[o + 2]!;
      }
    }
    out[k] = Math.hypot(x - P.points[3 * k]!, y - P.points[3 * k + 1]!, z - P.points[3 * k + 2]!);
  }
  return out;
}

/** Factors and solves `H x = g` (banded, one refinement step); `null` when not determined. */
function bandSolve(
  H0: Float64Array,
  g: Float64Array,
  size: number,
  bw: number,
  pivotRel: number,
): Float64Array | null {
  const H = H0.slice();
  if (cholFactor(H, size, bw, pivotRel) >= 0) return null;
  if (!(cholRcond(H0, H, size, bw) > pivotRel)) return null;
  const x = g.slice();
  cholSolve(H, size, bw, x);
  const r = bandMul(H0, size, bw, x);
  for (let i = 0; i < size; i++) r[i] = g[i]! - r[i]!;
  cholSolve(H, size, bw, r);
  for (let i = 0; i < size; i++) x[i] = x[i]! + r[i]!;
  return x;
}

/** `A x` for a symmetric band matrix stored as its lower band. */
function bandMul(A: Float64Array, size: number, bw: number, x: Float64Array): Float64Array {
  const W = bw + 1;
  const out = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let s = A[i * W + bw]! * x[i]!;
    for (let j = Math.max(0, i - bw); j < i; j++) {
      const v = A[i * W + (j - i + bw)]!;
      s += v * x[j]!;
      out[j] = out[j]! + v * x[i]!;
    }
    out[i] = out[i]! + s;
  }
  return out;
}

/**
 * The displacements at fairness `beta` within the frame's bounds (module
 * comment), or `null` when the system is not determined. Bounds by holding:
 * solve with the held unknowns fixed at their bounds, hold every free unknown
 * that leaves its interval at the bound it crossed, and repeat until no free
 * unknown leaves (the held set only grows, so this ends after at most one
 * round per unknown; the sample files take a few). Nothing is released, so the
 * result is the least squares on the final free set, not the exact bounded
 * optimum: the bounds bind only at columns whose classic profile the
 * construction cannot carry (profile corners, tips), and there the fit is
 * already off by more than the difference (S7 as built).
 */
export function solveBand(
  P: BandFitProblem,
  beta: number,
  pivotRel: number,
): { readonly w: Float64Array; readonly rounds: number } | null {
  const { size, bw } = P;
  const W = bw + 1;
  const { lo, hi } = P;
  const H = new Float64Array(size * W);
  for (let e = 0; e < H.length; e++) H[e] = P.Hd[e]! + beta * P.Kf[e]!;
  const held = new Int8Array(size); // −1 at lo, +1 at hi
  const value = (j: number): number => (held[j]! < 0 ? lo[j]! : hi[j]!);
  for (let round = 1; ; round++) {
    // The system with held unknowns eliminated (identity rows, right-hand side moved).
    const A = H.slice();
    const g = P.gd.slice();
    for (let j = 0; j < size; j++) {
      if (held[j] === 0) continue;
      const v = value(j);
      for (let i = Math.max(0, j - bw); i <= Math.min(size - 1, j + bw); i++) {
        if (i === j) continue;
        const e = i > j ? i * W + (j - i + bw) : j * W + (i - j + bw);
        g[i] = g[i]! - H[e]! * v;
      }
    }
    for (let j = 0; j < size; j++) {
      if (held[j] === 0) continue;
      for (let i = Math.max(0, j - bw); i <= Math.min(size - 1, j + bw); i++) {
        const e = i > j ? i * W + (j - i + bw) : j * W + (i - j + bw);
        A[e] = i === j ? 1 : 0;
      }
      g[j] = value(j);
    }
    const x = bandSolve(A, g, size, bw, pivotRel);
    if (x === null) return null;
    let changed = false;
    for (let j = 0; j < size; j++) {
      if (held[j] !== 0) continue;
      if (x[j]! < lo[j]!) {
        held[j] = -1;
        changed = true;
      } else if (x[j]! > hi[j]!) {
        held[j] = 1;
        changed = true;
      }
    }
    if (!changed) {
      for (let j = 0; j < size; j++) if (held[j] !== 0) x[j] = value(j);
      return { w: x, rounds: round };
    }
  }
}

/** A trial of the search: the net, its judged residual and validity. */
export interface BandTrial {
  readonly ratio: number;
  readonly net: Float64Array;
  readonly residual: Float64Array;
  readonly judgedMax: number;
  readonly valid: boolean;
}

/** Judged maximum of a residual array. */
function judgedMax(res: Float64Array, judged: Uint8Array): number {
  let m = 0;
  for (let k = 0; k < res.length; k++) if (judged[k] === 1 && res[k]! > m) m = res[k]!;
  return m;
}

/** The trial at `ratio`, or `null` when not determined there. */
export function bandTrial(
  P: BandFitProblem,
  judged: Uint8Array,
  ratio: number,
  tol: Tolerances,
): BandTrial | null {
  const solved = solveBand(P, ratio * P.betaScale, tol.pivotRel);
  if (solved === null) return null;
  const net = netOf(P.frame, expandDisplacements(P.frame, solved.w));
  const residual = residuals(P, net);
  return {
    ratio,
    net,
    residual,
    judgedMax: judgedMax(residual, judged),
    valid: validColumns(P.frame, net),
  };
}

/**
 * The fairness search of the module comment on fixed parameters: the smallest
 * valid ratio by log bisection, then the largest ratio above it whose fit is
 * valid and meets `surfaceTol` (log bisection, `fairnessSearchSteps` halvings).
 * `null` when no ratio of the bracket gives a valid fit (the caller keeps the
 * initial band).
 */
export function searchBand(
  P: BandFitProblem,
  judged: Uint8Array,
  o: Pick<ConvertOptions, 'surfaceTol' | 'fairnessRatioBracket' | 'fairnessSearchSteps'>,
  tol: Tolerances,
): BandTrial | null {
  const [r0, r1] = o.fairnessRatioBracket;
  const steps = o.fairnessSearchSteps;
  const at = (r: number): BandTrial | null => bandTrial(P, judged, r, tol);
  const ok = (t: BandTrial | null): t is BandTrial => t !== null && t.valid;
  // The smallest valid (and determined) ratio.
  let low = at(r0);
  if (!ok(low)) {
    const top = at(r1);
    if (!ok(top)) return null;
    let lo = Math.log(r0);
    let hi = Math.log(r1);
    low = top;
    for (let s = 0; s < steps; s++) {
      const mid = 0.5 * (lo + hi);
      const t = at(Math.exp(mid));
      if (ok(t)) {
        hi = mid;
        low = t;
      } else lo = mid;
    }
  }
  // The discrepancy principle above it (module comment): every judged sample
  // within surfaceTol, or, when even the least fairness cannot do that,
  // within surfaceTol of where the least fairness puts it.
  const base = low;
  const attainable = base.judgedMax <= o.surfaceTol;
  const meets = (t: BandTrial | null): t is BandTrial => {
    if (!ok(t)) return false;
    if (attainable) return t.judgedMax <= o.surfaceTol;
    for (let k = 0; k < judged.length; k++) {
      if (judged[k] === 1 && t.residual[k]! > base.residual[k]! + o.surfaceTol) return false;
    }
    return true;
  };
  const top = at(r1);
  if (meets(top)) return top;
  let best: BandTrial = low;
  let lo = Math.log(low.ratio);
  let hi = Math.log(r1);
  for (let s = 0; s < steps; s++) {
    const mid = 0.5 * (lo + hi);
    const t = at(Math.exp(mid));
    if (meets(t)) {
      lo = mid;
      best = t;
    } else hi = mid;
  }
  return best;
}

/** The free fit's outcome (module comment). */
export interface BandFit {
  readonly net: Float64Array;
  readonly ratio: number;
  /** Final parameters and true (projected) distances. */
  readonly uv: Float64Array;
  readonly distance: Float64Array;
  /** Largest projected distance over the judged samples and over all, cm. */
  readonly judgedMax: number;
  readonly allMax: number;
  readonly meets: boolean;
  /** The search found no valid fit and the initial band was kept. */
  readonly keptInitial: boolean;
  readonly corrections: number;
}

/**
 * The fit of `frame` to `samples`, starting at parameters `uv0` (module
 * comment): the search, then `passes` parameter corrections at the chosen
 * ratio, then the true distances.
 */
export function fitBand(
  frame: BandFitFrame,
  samples: BandSamples,
  uv0: Float64Array,
  passes: number,
  o: Pick<ConvertOptions, 'surfaceTol' | 'fairnessRatioBracket' | 'fairnessSearchSteps'>,
  tol: Tolerances,
): BandFit {
  let uv = uv0;
  let net = frame.target;
  let ratio = NaN;
  let corrections = 0;
  let keptInitial = true;
  for (let k = 0; ; k++) {
    const P = bandFitProblem(frame, samples.points, uv);
    const found = searchBand(P, samples.judged, o, tol);
    if (found === null) break;
    net = found.net;
    ratio = found.ratio;
    keptInitial = false;
    if (k > 0) corrections++;
    if (k >= passes) break;
    uv = projectSamples(bandSurface(frame, net), samples.points, uv, tol).uv;
  }
  const pr = projectSamples(bandSurface(frame, net), samples.points, uv, tol);
  let jm = 0;
  let am = 0;
  for (let k = 0; k < pr.distance.length; k++) {
    const d = pr.distance[k]!;
    if (d > am) am = d;
    if (samples.judged[k] === 1 && d > jm) jm = d;
  }
  return {
    net,
    ratio,
    uv: pr.uv,
    distance: pr.distance,
    judgedMax: jm,
    allMax: am,
    meets: jm <= o.surfaceTol,
    keptInitial,
    corrections,
  };
}
