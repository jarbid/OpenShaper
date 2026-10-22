// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The converter's line fits (docs/design/board2.md §9.3, §9.4): the plan loop
 * from the filleted classic outline, and the rocker and deck lines from the
 * classic bottom and deck curves. Both fit exact samples of the classic curves
 * (`outline.ts`) to `lineTol` by least squares on a basis refined adaptively.
 *
 * **Adaptive knots, kept symmetric.** geom's adaptive `approximateCurve` picks
 * its own knots worst span first, which would not keep a plan's knot set
 * mirror-symmetric (§3.7), and needs parameters from exactly 0 (a stringer
 * line's data start past the plan margin). So the fit runs on given knots and
 * this module refines them: every span holding a sample whose error exceeds
 * `lineTol` gets one knot midway between the two middle distinct parameters it
 * holds (geom's own rule, so both halves keep data), with its mirror `1 − m` on
 * the loop. The parameters of the loop's +y half are the exact mirrors of the
 * −y half's, so mirrored spans choose mirrored knots. It stops when every
 * span meets `lineTol`, when none can be split (a candidate within `knotRel` of
 * a knot is dropped) or after `maxPasses` refinements (`LINE_REFINE_PASSES`);
 * the errors are measured on the result, never assumed, and the converter
 * reports a fit that stopped above `lineTol`.
 *
 * **Plan loop** (§9.3): periodic cubic, period 1, centripetal parameters
 * (`u = 0` at the tail centre, `u = ½` at the nose centre exactly), point
 * constraints at both centres and tangents ∥ ŷ there, then the exact
 * symmetrisation (pairs averaged and mirrored, the self-paired y set to 0).
 *
 * **Stringer lines** (§9.4): non-parametric 1D splines, parameter the affine
 * image of x over the height fields' x-extent. Their knots come from the
 * data's own parameters, so every span holds data: the end spans reach over
 * the plan margin, where the line is the polynomial continuation of its last
 * data span. No span is data-free, so no fairness is needed (S6 deviation).
 */
import {
  approximateCurve,
  controlPointsInto,
  createScratch,
  curveEvalInto,
  makeCurve,
  refineKnots,
  resolveTolerances,
} from '@openshaper/geom';
import type {
  ClampedCurve,
  GeomIssue,
  NurbsCurve,
  PeriodicCurve,
  Tolerances,
} from '@openshaper/geom';
import { periodicPairing } from '../symmetry';
import type { PlanLoopJSON } from '../types';
import { LINE_CORRECTION_PASSES, LINE_REFINE_PASSES } from './params';

/** The outcome of an adaptive line fit: the curve, its knots and the errors it achieved. */
export interface LineFit<C> {
  readonly curve: C;
  /** Interior knots (clamped) or one period (periodic). */
  readonly knots: readonly number[];
  /** Per sample, the distance to the fit at the sample's parameter. */
  readonly errors: Float64Array;
  readonly maxError: number;
  /** Refinement passes made (fits − 1). */
  readonly passes: number;
}

/** A failed fit: geom's issue and the pass it happened in. */
export interface LineFitFailure {
  readonly message: string;
  readonly cause?: GeomIssue;
}

/** Knots midway between the two middle distinct parameters of each failing span (geom's rule). */
function splitCandidates(
  spans: readonly (readonly [number, number])[],
  params: Float64Array,
  bad: (k: number) => boolean,
): number[] {
  const out: number[] = [];
  // params need not be sorted; bucket the indices by span.
  const order = Array.from(params.keys()).sort((a, b) => params[a]! - params[b]!);
  let s = 0;
  let k = 0;
  while (s < spans.length) {
    const [a, b] = spans[s]!;
    const inside: number[] = [];
    let failing = false;
    while (k < order.length && params[order[k]!]! < b) {
      const i = order[k]!;
      if (params[i]! >= a) {
        if (inside.length === 0 || inside[inside.length - 1] !== params[i]) inside.push(params[i]!);
        if (bad(i)) failing = true;
      }
      k++;
    }
    if (failing && inside.length >= 2) {
      const h = inside.length >> 1;
      out.push(0.5 * (inside[h - 1]! + inside[h]!));
    }
    s++;
  }
  return out;
}

/** `knots` with the candidates added, dropping any within `gap` of a knot (circularly when `period`). */
function addKnots(
  knots: readonly number[],
  cands: readonly number[],
  gap: number,
  period: boolean,
): number[] {
  const taken = [...knots];
  const dist = (x: number, y: number): number => {
    const d = Math.abs(x - y);
    return period ? Math.min(d, 1 - d) : d;
  };
  for (const c of cands) {
    if (taken.some((t) => dist(t, c) <= gap)) continue;
    taken.push(c);
  }
  return taken.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Plan loop
// ---------------------------------------------------------------------------

/** The plan loop's data: the full loop from the tail centre, counter-clockwise. */
export interface LoopData {
  /** (x, y) pairs. */
  readonly points: Float64Array;
  /** Loop parameters: [0, ½] on the −y half, `1 − u` on the +y half. */
  readonly params: Float64Array;
  /** Per sample: inside a fillet zone (the fillet's index), else −1. */
  readonly fillet: Int32Array;
  readonly nose: number;
}

/**
 * The loop data from the +y half (tail centre to nose centre, the centres on
 * y = 0): the −y half is its mirror run tail to nose, the +y half runs back.
 * Centripetal parameters on the −y half, scaled so the nose is at exactly ½.
 */
export function loopData(
  half: readonly (readonly [number, number])[],
  fillet: readonly number[],
): LoopData {
  const m = half.length - 1;
  const cum = new Float64Array(m + 1);
  for (let k = 1; k <= m; k++) {
    const d = Math.hypot(half[k]![0] - half[k - 1]![0], half[k]![1] - half[k - 1]![1]);
    cum[k] = cum[k - 1]! + Math.sqrt(d);
  }
  const n = 2 * m;
  const points = new Float64Array(2 * n);
  const params = new Float64Array(n);
  const fz = new Int32Array(n);
  for (let k = 0; k <= m; k++) {
    points[2 * k] = half[k]![0];
    points[2 * k + 1] = k === 0 || k === m ? 0 : -half[k]![1];
    params[k] = k === m ? 0.5 : (0.5 * cum[k]!) / cum[m]!;
    fz[k] = fillet[k]!;
  }
  for (let k = m - 1; k >= 1; k--) {
    const i = n - k;
    points[2 * i] = half[k]![0];
    points[2 * i + 1] = half[k]![1];
    params[i] = 1 - params[k]!;
    fz[i] = fillet[k]!;
  }
  return Object.freeze({ points, params, fillet: fz, nose: half[m]![0] });
}

/** Uniform symmetric start knots: an even count, spans at most `spacing` long (in the data's chord measure). */
function startKnotsPeriodic(perimeter: number, spacing: number): number[] {
  let n = Math.max(8, Math.ceil(perimeter / spacing));
  if (n % 2 === 1) n++;
  return Array.from({ length: n }, (_, i) => i / n);
}

/**
 * The plan loop (§9.3): the adaptive symmetric fit of the loop data to
 * `lineTol`, constrained at both centres, then symmetrised exactly; at most
 * `maxPasses` refinements.
 */
export function fitPlanLoop(
  data: LoopData,
  lineTol: number,
  startSpacing: number,
  tolIn?: Partial<Tolerances>,
  maxPasses: number = LINE_REFINE_PASSES,
): LineFit<PeriodicCurve<2>> | LineFitFailure {
  const tol = resolveTolerances(tolIn);
  const n = data.params.length;
  let perimeter = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    perimeter += Math.hypot(
      data.points[2 * j]! - data.points[2 * k]!,
      data.points[2 * j + 1]! - data.points[2 * k + 1]!,
    );
  }
  let knots = startKnotsPeriodic(perimeter, startSpacing);
  const constraints = [
    { kind: 'point' as const, t: 0, value: { x: 0, y: 0 } },
    { kind: 'point' as const, t: 0.5, value: { x: data.nose, y: 0 } },
    { kind: 'tangentDirection' as const, t: 0, direction: { x: 0, y: 1 } },
    { kind: 'tangentDirection' as const, t: 0.5, direction: { x: 0, y: 1 } },
  ];
  const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
  const q = new Float64Array(2);
  for (let pass = 0; ; pass++) {
    let curve: PeriodicCurve<2>;
    let fitted: ArrayLike<number>;
    try {
      const r = approximateCurve(data.points, 2, {
        degree: 3,
        periodic: true,
        knots,
        params: data.params,
        constraints,
        parameterCorrection: LINE_CORRECTION_PASSES,
        tol,
      });
      if (!r.ok) {
        const cause = r.issues.find((i) => i.severity === 'error') ?? r.issues[0];
        return {
          message: `plan loop fit: ${cause?.message ?? 'failed'}`,
          ...(cause ? { cause } : {}),
        };
      }
      curve = symmetrise(r.value.curve as PeriodicCurve<2>, tol);
      fitted = r.value.params;
    } catch (e) {
      return { message: `plan loop fit: ${e instanceof Error ? e.message : String(e)}` };
    }
    const errors = new Float64Array(n);
    let maxError = 0;
    for (let k = 0; k < n; k++) {
      curveEvalInto(curve, fitted[k]!, 0, q, 0, sc);
      const e = Math.hypot(q[0]! - data.points[2 * k]!, q[1]! - data.points[2 * k + 1]!);
      errors[k] = e;
      if (e > maxError) maxError = e;
    }
    const spans = knots.map((a, i) => [a, i + 1 < knots.length ? knots[i + 1]! : 1] as const);
    const cands =
      maxError > lineTol ? splitCandidates(spans, data.params, (k) => errors[k]! > lineTol) : [];
    // Candidates from the −y half only, with their exact mirrors: the corrected
    // parameters are symmetric only to the correction's convergence.
    const mirrored = cands.filter((c) => c > 0 && c < 0.5).flatMap((c) => [c, 1 - c]);
    const next = addKnots(knots, mirrored, tol.knotRel, true);
    if (next.length === knots.length || pass >= maxPasses) {
      return Object.freeze({ curve, knots: Object.freeze(knots), errors, maxError, passes: pass });
    }
    knots = next;
  }
}

/**
 * The exact symmetrisation (§9.3): each master and the mirror of its partner
 * averaged, the partner set to the mirror of the result, a self-paired point's
 * y set to 0. A fit of mirrored data on a mirrored basis is symmetric up to
 * rounding, so this moves points by rounding only.
 */
function symmetrise(c: PeriodicCurve<2>, tol: Tolerances): PeriodicCurve<2> {
  const r = periodicPairing(c.basis, tol);
  if (!r.ok) throw new Error(`plan loop: ${r.message}`);
  const { partner, role } = r.pairing;
  const n = c.basis.count;
  const p = new Float64Array(2 * n);
  controlPointsInto(c, p, 0);
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const j = partner[i]!;
    if (role[i] === 'self') {
      out[2 * i] = p[2 * i]!;
      out[2 * i + 1] = 0;
    } else if (role[i] === 'master') {
      const x = 0.5 * (p[2 * i]! + p[2 * j]!);
      const y = 0.5 * (p[2 * i + 1]! - p[2 * j + 1]!);
      out[2 * i] = x;
      out[2 * i + 1] = y;
      out[2 * j] = x;
      out[2 * j + 1] = -y;
    }
  }
  return makeCurve({ dim: 2, basis: c.basis, points: out }) as PeriodicCurve<2>;
}

/** The plan loop as document JSON. */
export function planLoopJSON(c: PeriodicCurve<2>): PlanLoopJSON {
  const n = c.basis.count;
  const p = new Float64Array(2 * n);
  controlPointsInto(c, p, 0);
  return { degree: c.basis.degree, knots: Array.from(c.basis.knots), points: Array.from(p) };
}

// ---------------------------------------------------------------------------
// Stringer lines
// ---------------------------------------------------------------------------

/** The full clamped knot vector of interior knots `inner` on [0, 1]. */
export function clampedKnots(inner: readonly number[], p: number): number[] {
  return [...new Array<number>(p + 1).fill(0), ...inner, ...new Array<number>(p + 1).fill(1)];
}

/**
 * A stringer line (§9.4): samples `(x, z)` (x ascending) fitted as a 1D cubic
 * spline in `u = (x − x0)/(x1 − x0)` to `lineTol`, knots refined adaptively
 * from a uniform start `startSpacing` cm apart (only knots strictly inside the
 * data's parameter range, so every span holds data); at most `maxPasses`
 * refinements.
 */
export function fitStringerLine(
  xs: Float64Array,
  zs: Float64Array,
  extent: readonly [number, number],
  lineTol: number,
  startSpacing: number,
  tolIn?: Partial<Tolerances>,
  maxPasses: number = LINE_REFINE_PASSES,
): LineFit<ClampedCurve<1>> | LineFitFailure {
  const tol = resolveTolerances(tolIn);
  const [x0, x1] = extent;
  const n = xs.length;
  const params = new Float64Array(n);
  for (let k = 0; k < n; k++) params[k] = (xs[k]! - x0) / (x1 - x0);
  const lo = params[0]!;
  const hi = params[n - 1]!;
  const count = Math.max(1, Math.ceil((x1 - x0) / startSpacing));
  let inner: number[] = [];
  for (let i = 1; i < count; i++) {
    const u = i / count;
    if (u > lo && u < hi) inner.push(u);
  }
  const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
  const q = new Float64Array(1);
  for (let pass = 0; ; pass++) {
    let curve: ClampedCurve<1>;
    try {
      const r = approximateCurve(zs, 1, { degree: 3, knots: clampedKnots(inner, 3), params, tol });
      if (!r.ok) {
        const cause = r.issues.find((i) => i.severity === 'error') ?? r.issues[0];
        return {
          message: `stringer line fit: ${cause?.message ?? 'failed'}`,
          ...(cause ? { cause } : {}),
        };
      }
      curve = r.value.curve as ClampedCurve<1>;
    } catch (e) {
      return { message: `stringer line fit: ${e instanceof Error ? e.message : String(e)}` };
    }
    const errors = new Float64Array(n);
    let maxError = 0;
    for (let k = 0; k < n; k++) {
      curveEvalInto(curve, params[k]!, 0, q, 0, sc);
      const e = Math.abs(q[0]! - zs[k]!);
      errors[k] = e;
      if (e > maxError) maxError = e;
    }
    const bounds = [0, ...inner, 1];
    const spans = bounds
      .slice(0, -1)
      .map((a, i) => [a, i + 2 === bounds.length ? Infinity : bounds[i + 1]!] as const);
    const cands =
      maxError > lineTol ? splitCandidates(spans, params, (k) => errors[k]! > lineTol) : [];
    const next = addKnots(inner, cands, tol.knotRel, false);
    if (next.length === inner.length || pass >= maxPasses) {
      return Object.freeze({ curve, knots: Object.freeze(inner), errors, maxError, passes: pass });
    }
    inner = next;
  }
}

/** A 1D line on another clamped basis that contains its knots (exact refinement). */
export function lineOnKnots(
  line: ClampedCurve<1>,
  full: readonly number[],
  tol: Tolerances,
): NurbsCurve<1> {
  const have = Array.from(line.basis.knots);
  const add: number[] = [];
  const pool = [...have];
  for (const k of full) {
    const i = pool.indexOf(k);
    if (i >= 0) pool.splice(i, 1);
    else add.push(k);
  }
  if (add.length === 0) return line;
  if (pool.length > 0)
    throw new Error('lineOnKnots: the target basis lacks some of the line’s knots');
  // Exact knot insertion: the same curve on the finer basis.
  return refineKnots(line, add, tol);
}
