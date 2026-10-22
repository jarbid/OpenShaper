// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Law extraction and the offset factorisation of the converter
 * (docs/design/board2.md §9.7 items 4–6; step S7).
 *
 * The fitted band is read back as laws a shaper reads plus an offset layer
 * that carries the rest, so that building the document reproduces the fitted
 * band (the factorisation identity, item 6).
 *
 * - **Apex height: the one lane without an offset.** The apex row moves only
 *   with the outline and the apex-height law (§6.1), so the law itself must
 *   carry the fitted apex. Its keys start at the classic stations and the
 *   tips (values: the fitted apex height there, §5.7) and a key is added at
 *   the worst master column of every segment whose law misses the column's
 *   fitted apex height by more than `lawTolerance.apexHeight`, until none does
 *   (the law then matches the fit at every column within the build's own law
 *   fidelity). The converter then refits the band with the apex fixed at that
 *   law (`band-fit.ts`), and the identity is exact against that second fit.
 *   A fitted apex outside the profile's feasible interval (`H_u > 0`,
 *   `H_l > 0`, §5.3) is moved inside it first: see {@link apexBounds}.
 * - **Fullness and hardness**: keys at the classic stations and the tips with
 *   the values §5.7 measures on the fitted band there, clamped to the lane's
 *   range; the offsets carry the rest.
 * - **Insets**: §9.5's laws, unchanged (rows 0 and 6 are fixed in the fit).
 * - **Offsets**: the band rebuilt from the laws alone on the fit's basis; the
 *   difference to the fitted band, column by column in the column's frame and
 *   the components its rows allow (row 1 along `τ̂_d`, rows 2 and 4 along ẑ,
 *   row 5 along `n̂` and ẑ; rows 0, 3 and 6 coincide), interpolated over σ at
 *   the columns' σ by geom's `interpolatePeriodic` (one basis for every field,
 *   exact at the columns).
 *
 * Deviation from §9.7 item 4 (board2.md, S7 as built): the design fitted every
 * lane's key values at the stations by linear least squares, "auto handles are
 * linear in the values". The automatic handles are not linear in the values
 * (Fritsch–Carlson slopes are limited and zero at extrema, §5.2), and the apex
 * has no offset to carry a least-squares residual. So keys take the measured
 * values (interpolation), and the apex lane gets the adaptive keys above.
 */
import {
  createScratch,
  controlPointsInto,
  curveEvalInto,
  interpolatePeriodic,
} from '@openshaper/geom';
import type { NurbsSurface, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { columnAt } from '../band/band';
import type { BandContext } from '../band/band';
import { BAND_ROWS, measuredLawsAt } from '../band/profile';
import type { BandBasis, Column } from '../band/stations';
import { lawEvaluator } from '../law';
import { offsetEvaluator } from '../offsets';
import { laneRange } from '../params';
import { planArc, planFrame, sigmaAt } from '../plan';
import { paramOfX } from './band-fit';
import type { ConvertOptions } from './types';
import type { BuildParams, LawCurve, OffsetLayer, RailLane, RailLawValues } from '../types';

const STRIDE = BAND_ROWS * 3;

/** A classic station inside the board as a law key: board2 x, its loop parameter on the −y half, σ. */
export interface StationKey {
  readonly x: number;
  readonly u: number;
  readonly s: number;
}

/**
 * The law keys of the classic stations (§9.5): every real station strictly
 * inside the plan's x-range, at its loop parameter on the −y half, ascending
 * in σ ∈ (0, ½). Every lane the converter writes is keyed here (and at the tips).
 */
export function stationKeys(
  plan: PeriodicCurve<2>,
  stations: readonly number[],
  tol: Tolerances,
): readonly StationKey[] {
  const arc = planArc(plan, true, tol);
  const sc = createScratch({ maxDegree: plan.basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  curveEvalInto(plan, 0.5, 0, q, 0, sc);
  const nose = q[0]!;
  const keys: StationKey[] = [];
  for (const x of stations) {
    if (!(x > 0 && x < nose)) continue;
    const u = paramOfX(plan, x);
    const s = sigmaAt(arc, u);
    if (!(s > 0 && s < 0.5)) continue;
    keys.push({ x, u, s });
  }
  return keys.sort((a, b) => a.s - b.s);
}

/**
 * Whether a board2 x lies in a window the fits do not judge (§9.6): within
 * `tipWindow` of an end, in a classic floor zone, or within `creaseWindow` of
 * a real station.
 */
export function windowTest(
  stations: readonly number[],
  zones: readonly (readonly [number, number])[],
  length: number,
  o: Pick<ConvertOptions, 'tipWindow' | 'creaseWindow'>,
): (x: number) => boolean {
  return (x) =>
    x <= o.tipWindow ||
    x >= length - o.tipWindow ||
    zones.some(([a, b]) => x >= a && x <= b) ||
    stations.some((s) => Math.abs(x - s) <= o.creaseWindow);
}

/** The construction's inputs of every column (stage 7 of §6.3, before the snap). */
export interface ColumnInputs {
  /** Deck and bottom heights at E and T, the slopes along ô there, the effective insets. */
  readonly ez: Float64Array;
  readonly tz: Float64Array;
  readonly sd: Float64Array;
  readonly sb: Float64Array;
  readonly wd: Float64Array;
  readonly wt: Float64Array;
}

/** {@link ColumnInputs} of the columns of basis `b` under the context's laws (insets and surfaces). */
export function columnInputs(
  ctx: BandContext,
  b: BandBasis,
  columns: readonly Column[],
): ColumnInputs {
  const n = b.basis.count;
  const apex = new Float64Array(2 * n);
  controlPointsInto(b.apexPlan, apex, 0);
  const out = {
    ez: new Float64Array(n),
    tz: new Float64Array(n),
    sd: new Float64Array(n),
    sb: new Float64Array(n),
    wd: new Float64Array(n),
    wt: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const c = columns[i]!;
    const col = columnAt(ctx, apex[2 * i]!, apex[2 * i + 1]!, c.frame, c.u, c.sigma);
    out.ez[i] = col.profile.points[2]!;
    out.tz[i] = col.profile.points[20]!;
    out.sd[i] = col.profile.sd;
    out.sb[i] = col.profile.sb;
    out.wd[i] = col.laws.deckInset;
    out.wt[i] = col.laws.tuckInset;
  }
  return out;
}

/**
 * The apex heights a column's profile can take (§5.3): `H_l > 0` needs
 * `α > lo = s_b w_t / (E.z − T.z)` and `H_u > 0` needs
 * `α < hi = 1 + s_d w_d / (E.z − T.z)`. `apexHeightRange` keeps a margin of 5%
 * of the unit interval from 0 and 1 "to keep both profile triangles of
 * positive height" (§12.1); the same fractions are applied to `(lo, hi)`, and
 * the result is intersected with the range itself. `null` when empty.
 */
export function apexBounds(
  ez: number,
  tz: number,
  sd: number,
  sb: number,
  wd: number,
  wt: number,
  build: Pick<BuildParams, 'apexHeightRange'>,
): readonly [number, number] | null {
  const h = ez - tz;
  if (!(h > 0)) return null;
  const lo = (sb * wt) / h;
  const hi = 1 + (sd * wd) / h;
  const [r0, r1] = build.apexHeightRange;
  const a = Math.max(r0, lo + r0 * (hi - lo));
  const b = Math.min(r1, lo + r1 * (hi - lo));
  return a < b ? [a, b] : null;
}

/** `x` moved into `[a, b]`. */
export const clampTo = (x: number, [a, b]: readonly [number, number]): number =>
  Math.min(Math.max(x, a), b);

/** The apex height of column `i` of `net` against the construction's E.z and T.z. */
export function columnApex(net: Float64Array, inp: ColumnInputs, i: number): number {
  const az = net[i * STRIDE + 11]!;
  return (az - inp.tz[i]!) / (inp.ez[i]! - inp.tz[i]!);
}

/**
 * The apex-height law (module comment): `start` keys (σ ascending, 0 and ½
 * included) and the master columns' target values; keys are added at the
 * worst column of each segment that misses by more than `tolerance`.
 */
export function adaptiveLaw(
  start: readonly { readonly s: number; readonly value: number }[],
  targets: readonly { readonly sigma: number; readonly value: number }[],
  tolerance: number,
  tol?: Partial<Tolerances>,
): { law: LawCurve; added: number; worst: number } {
  const keys = start.map((k) => ({ s: k.s, value: k.value }));
  let added = 0;
  for (;;) {
    const law: LawCurve = { domain: 'half', keys: keys.map((k) => ({ ...k })) };
    const at = lawEvaluator(law, tol);
    // Worst miss per segment [keys[j], keys[j + 1]].
    const worst = new Map<number, { e: number; sigma: number; value: number }>();
    let overall = 0;
    for (const t of targets) {
      const e = Math.abs(at(t.sigma) - t.value);
      overall = Math.max(overall, e);
      if (!(e > tolerance)) continue;
      let j = 0;
      while (j + 2 < keys.length && keys[j + 1]!.s <= t.sigma) j++;
      const w = worst.get(j);
      if (w === undefined || e > w.e) worst.set(j, { e, sigma: t.sigma, value: t.value });
    }
    if (worst.size === 0) return { law, added, worst: overall };
    for (const w of worst.values()) {
      const same = keys.find((k) => k.s === w.sigma);
      if (same !== undefined) same.value = w.value;
      else {
        keys.push({ s: w.sigma, value: w.value });
        added++;
      }
    }
    keys.sort((p, q) => p.s - q.s);
  }
}

/** A law with keys at `sigmas` (ascending, 0 and ½ included) and the given values. */
export function keyedLaw(sigmas: readonly number[], values: readonly number[]): LawCurve {
  return { domain: 'half', keys: sigmas.map((s, k) => ({ s, value: values[k]! })) };
}

/** The six lanes §5.7 measures on `band` at loop parameter `u` (station plane of the plan frame there). */
export function measuredLanes(ctx: BandContext, band: NurbsSurface, u: number): RailLawValues {
  const frame = planFrame(ctx.plan, u, ctx.symmetric);
  if (frame === null) throw new Error(`the plan has no tangent at u = ${u}`);
  return measuredLawsAt(band, frame, ctx.bottomAt, u);
}

/** `value` clamped into the lane's range under `build`. */
export function inLane(lane: RailLane, value: number, build: BuildParams): number {
  return clampTo(value, laneRange(lane, build));
}

/** The offset values of one column (components of §6.1). */
interface ColumnOffsets {
  readonly deckHandleL: number;
  readonly apexUpperZ: number;
  readonly apexLowerZ: number;
  readonly tuckHandleN: number;
  readonly tuckHandleZ: number;
}

/**
 * The offset layer that turns the law-only net `lawNet` into `fitted` (module
 * comment), on the columns of `b`. Only master and self-paired columns are
 * read; a partner takes its master's values (the layer is read on σ ∈ [0, ½]
 * and mirrored on a symmetric board, S3 deviation 5).
 */
export function offsetLayer(
  columns: readonly Column[],
  inp: ColumnInputs,
  fitted: Float64Array,
  lawNet: Float64Array,
  symmetric: boolean,
  tol?: Partial<Tolerances>,
): OffsetLayer {
  const n = columns.length;
  const per: ColumnOffsets[] = new Array<ColumnOffsets>(n);
  for (let i = 0; i < n; i++) {
    const c = columns[i]!;
    if (c.role === 'partner') continue;
    const o = i * STRIDE;
    const d = (r: number, k: number): number => fitted[o + 3 * r + k]! - lawNet[o + 3 * r + k]!;
    const nx = c.frame.inward.x;
    const ny = c.frame.inward.y;
    const sd = inp.sd[i]!;
    const td = Math.hypot(1, sd);
    // τ̂_d = (ô + s_d ẑ)/√(1 + s_d²), ô = −n̂ (profile.ts).
    const deckHandleL = (-d(1, 0) * nx - d(1, 1) * ny + d(1, 2) * sd) / td;
    per[i] = {
      deckHandleL,
      apexUpperZ: d(2, 2),
      apexLowerZ: d(4, 2),
      tuckHandleN: d(5, 0) * nx + d(5, 1) * ny,
      tuckHandleZ: d(5, 2),
    };
  }
  for (let i = 0; i < n; i++)
    if (columns[i]!.role === 'partner') per[i] = per[columns[i]!.partner]!;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => columns[a]!.sigma - columns[b]!.sigma,
  );
  const sig = Float64Array.from(order, (i) => columns[i]!.sigma);
  const rows = [
    ['deckHandle', (v: ColumnOffsets) => [v.deckHandleL]],
    ['apexUpper', (v: ColumnOffsets) => [v.apexUpperZ]],
    ['apexLower', (v: ColumnOffsets) => [v.apexLowerZ]],
    ['tuckHandle', (v: ColumnOffsets) => [v.tuckHandleN, v.tuckHandleZ]],
  ] as const;
  /** The layer interpolating `values` (per column) at the columns' σ. */
  const layerOf = (values: readonly ColumnOffsets[]): OffsetLayer => {
    const fits = rows.map(([, pick]) => {
      const dim = pick(values[0]!).length as 1 | 2;
      const pts = new Float64Array(n * dim);
      order.forEach((i, k) => pick(values[i]!).forEach((v, c) => (pts[k * dim + c] = v)));
      return interpolatePeriodic(pts, dim, { params: sig, degree: 3, tol });
    });
    // interpolatePeriodic shifts its parameters (and knots) together; shift the
    // knots back so the fields are functions of σ itself.
    const f0 = fits[0]!;
    const shift = f0.params[0]! - sig[0]!;
    const knots = Array.from(f0.curve.basis.knots, (t) => t - shift);
    return {
      basis: { degree: 3, knots },
      rows: rows.map(([row], k) => {
        const c = fits[k]!.curve;
        const vals = new Float64Array(c.basis.count * c.dim);
        controlPointsInto(c, vals, 0);
        return { row, values: Array.from(vals) };
      }),
    };
  };
  const first = layerOf(per);
  // One step of iterative refinement (S7 as built): the columns crowd to a
  // few hundred-thousandths of the period at a plan fillet, where the
  // interpolation is ill-conditioned, and its solve's residual, relative to
  // the offsets, then reaches the identity's tolerance once the offsets are
  // large (a profile the construction carries badly). The residual, read back
  // exactly as the build reads the layer (σ on the −y half when symmetric), is
  // interpolated on the same parameters and added.
  const ev = offsetEvaluator(first, tol)!;
  const residual: ColumnOffsets[] = per.map((v, i) => {
    const s = columns[i]!.sigma;
    const at = ev(symmetric && s > 0.5 ? 1 - s : s);
    return {
      deckHandleL: v.deckHandleL - at.deckHandleL,
      apexUpperZ: v.apexUpperZ - at.apexUpperZ,
      apexLowerZ: v.apexLowerZ - at.apexLowerZ,
      tuckHandleN: v.tuckHandleN - at.tuckHandleN,
      tuckHandleZ: v.tuckHandleZ - at.tuckHandleZ,
    };
  });
  const correction = layerOf(residual);
  // Same parameters, same averaged knots: the two layers share one basis.
  if (correction.basis!.knots.some((t, k) => t !== first.basis!.knots[k])) return first;
  return {
    basis: first.basis,
    rows: first.rows.map((f, k) => ({
      row: f.row,
      values: f.values.map((v, e) => v + correction.rows[k]!.values[e]!),
    })),
  };
}

/** The largest coordinate difference between two nets (cm). */
export function netDistance(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k]! - b[k]!));
  return m;
}
