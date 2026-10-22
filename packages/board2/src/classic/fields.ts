// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deck and bottom height-field fits (docs/design/board2.md §9.6, §9.8).
 *
 * - **Bases.** u knots: the stringer line's knots (mandatory: the stringer
 *   identity needs the line on the field's basis, so they enter as they are,
 *   millimetres apart at a line fillet) and a uniform grid at
 *   `surfaceKnotSpacing.x`, a grid knot closer than `minKnotSpacing` to a line
 *   knot dropped; v knots: symmetric uniform at `surfaceKnotSpacing.y`.
 * - **Fit.** Least squares at the data's exact plan parameters (a height
 *   field's vertical residual bounds the normal distance: **no parameter
 *   correction**), the stringer identity (§3.4), thin-plate fairness
 *   (parametric metric): the minimiser of geom's `approximateSurface` with the
 *   identity as `n_u` point constraints, solved for z alone by `lsq.ts` with
 *   the data's normal equations assembled once per basis (step S7: the search
 *   solves one basis a dozen times; x and y are the field's affine Greville
 *   map and need no solve).
 * - **Refinement.** With the smallest fairness of the bracket, every u span and
 *   v span holding a judged sample (inside the face, outside the crease and tip
 *   windows) whose vertical residual exceeds `surfaceTol` is halved, at most
 *   `maxRefinePasses` times. u spans only while the halves stay at least
 *   `minKnotSpacing` long: a finer u basis would resolve the classic station
 *   creases (lines of constant x) as curvature. v spans with their mirrors and
 *   without that floor: a v knot is a line of constant y, which no station
 *   crease follows, and what it resolves is the sections' own shape across the
 *   face (S6 as built, deviation 10).
 * - **Fairness.** Then, on the final basis, the largest weight that still meets
 *   `surfaceTol` on the judged samples (§9.8, `fairness.ts`). The basis is
 *   decided with negligible fairness first so that the search runs once, on
 *   one basis (S6 as built).
 * - **Symmetrisation.** Mirrored data on mirrored knots give a symmetric fit up
 *   to rounding; rows j and m − 1 − j are averaged (exact symmetry, §3.7).
 */
import { clampedBasis, controlPointsInto } from '@openshaper/geom';
import type { ClampedBasis, ClampedCurve, GeomIssue, Tolerances } from '@openshaper/geom';
import { stringerParam } from '../height-field';
import type { HeightFieldJSON } from '../types';
import { dataTrace, discrepancySearch, smallestFeasible, thinPlateTrace } from './fairness';
import { clampedKnots, lineOnKnots } from './lines';
import { fieldProblem, solveField } from './lsq';
import type { FieldProblem } from './lsq';
import type { ConvertOptions } from './types';

/** Samples for one height field: board2 plan coordinates and z, and which are judged. */
export interface FieldData {
  /** (x, y, z) triples. */
  readonly points: Float64Array;
  /** 1 where the residual counts (inside the face, outside crease and tip windows). */
  readonly judged: Uint8Array;
}

/** A fitted height field and what it achieved. */
export interface FieldFit {
  readonly field: HeightFieldJSON;
  /** Largest vertical residual over the judged samples, cm. */
  readonly maxResidual: number;
  /** The same over every sample (windows and the trim strip included). */
  readonly maxResidualAll: number;
  readonly ratio: number;
  readonly meets: boolean;
  readonly passes: number;
  readonly fits: number;
}

export interface FieldFitFailure {
  readonly message: string;
  readonly cause?: GeomIssue;
  /** The data and fairness do not determine the net (move the fairness up). */
  readonly undetermined?: boolean;
}

type FieldOptions = Pick<
  ConvertOptions,
  | 'surfaceTol'
  | 'surfaceKnotSpacing'
  | 'minKnotSpacing'
  | 'maxRefinePasses'
  | 'fairnessRatioBracket'
  | 'fairnessSearchSteps'
>;

/** Sorted union of two knot lists (exact duplicates once). */
function union(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((p, q) => p - q);
}

/** The start u knots: the line's, plus a uniform grid kept `minKnotSpacing` (in u) clear of them. */
export function startKnotsU(
  lineInner: readonly number[],
  extent: number,
  o: FieldOptions,
): number[] {
  const count = Math.max(1, Math.ceil(extent / o.surfaceKnotSpacing.x));
  const clear = o.minKnotSpacing / extent;
  const grid: number[] = [];
  for (let i = 1; i < count; i++) {
    const u = i / count;
    if (lineInner.every((k) => Math.abs(k - u) >= clear)) grid.push(u);
  }
  return union(lineInner, grid);
}

/** Symmetric uniform v knots at most `surfaceKnotSpacing.y` apart. */
export function startKnotsV(extent: number, o: FieldOptions): number[] {
  const count = Math.max(1, Math.ceil(extent / o.surfaceKnotSpacing.y));
  return Array.from({ length: count - 1 }, (_, i) => (i + 1) / count);
}

/**
 * Fits one height field (module comment). `extent` is the field's
 * `[x0, x1] × [y0, y1]` (`y0 = −y1`); `line` the stringer line (a 1D spline in
 * the field's u on a basis whose knots are a subset of the field's).
 */
export function fitField(
  data: FieldData,
  extentX: readonly [number, number],
  extentY: readonly [number, number],
  line: ClampedCurve<1>,
  o: FieldOptions,
  tol: Tolerances,
): FieldFit | FieldFitFailure {
  const [x0, x1] = extentX;
  const [y0, y1] = extentY;
  const n = data.points.length / 3;
  const uv = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    uv[2 * k] = (data.points[3 * k]! - x0) / (x1 - x0);
    uv[2 * k + 1] = (data.points[3 * k + 1]! - y0) / (y1 - y0);
  }
  const lineInner = Array.from(line.basis.knots).slice(4, -4);
  let ku = startKnotsU(lineInner, x1 - x0, o);
  let kv = startKnotsV(y1 - y0, o);
  const zs = new Float64Array(n);
  for (let k = 0; k < n; k++) zs[k] = data.points[3 * k + 2]!;
  const vs = stringerParam({ y: [y0, y1] });
  let fits = 0;

  interface Trial {
    readonly z: Float64Array;
    readonly residual: Float64Array;
    readonly judgedMax: number;
    readonly allMax: number;
  }
  // The problem on the current bases, assembled once and solved at every ratio (lsq.ts).
  let problem: { bu: ClampedBasis; bv: ClampedBasis; P: FieldProblem } | null = null;
  const problemOn = (bu: ClampedBasis, bv: ClampedBasis): FieldProblem => {
    if (problem !== null && problem.bu === bu && problem.bv === bv) return problem.P;
    const c = new Float64Array(bu.count);
    controlPointsInto(lineOnKnots(line, Array.from(bu.knots), tol), c, 0);
    const P = fieldProblem(bu, bv, uv, zs, vs, c);
    problem = { bu, bv, P };
    return P;
  };
  const fitOn = (bu: ClampedBasis, bv: ClampedBasis, beta: number): Trial | FieldFitFailure => {
    fits++;
    try {
      const r = solveField(problemOn(bu, bv), beta, tol.pivotRel);
      if (!r.ok) return { message: `height-field fit: ${r.message}`, undetermined: true };
      let judgedMax = 0;
      let allMax = 0;
      for (let k = 0; k < n; k++) {
        const e = r.residual[k]!;
        if (e > allMax) allMax = e;
        if (data.judged[k] === 1 && e > judgedMax) judgedMax = e;
      }
      return { z: r.z, residual: r.residual, judgedMax, allMax };
    } catch (e) {
      return { message: `height-field fit: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
  const isFailure = (t: Trial | FieldFitFailure): t is FieldFitFailure => 'message' in t;
  type FieldTrial = { fit: Trial; meets: boolean } | null | 'failed';
  const bases = (): { bu: ClampedBasis; bv: ClampedBasis } => ({
    bu: clampedBasis(3, clampedKnots(ku, 3), tol),
    bv: clampedBasis(3, clampedKnots(kv, 3), tol),
  });
  const betaOf = (bu: ClampedBasis, bv: ClampedBasis): number =>
    dataTrace(bu, bv, uv) / thinPlateTrace(bu, bv);

  // A trial: null when the data and fairness do not determine the net
  // (schoenberg-whitney), 'failed' for any other failure. A failure is kept to
  // be returned only when no ratio gives a fit; a fit found elsewhere stands
  // (review of S6).
  let failure: FieldFitFailure | null = null;
  const trialOn =
    (bu: ClampedBasis, bv: ClampedBasis, beta: number) =>
    (ratio: number): FieldTrial => {
      const t = fitOn(bu, bv, ratio * beta);
      if (isFailure(t)) {
        if (t.undetermined === true) return null;
        failure = t;
        return 'failed';
      }
      return { fit: t, meets: t.judgedMax <= o.surfaceTol };
    };
  const [r0, r1] = o.fairnessRatioBracket;

  // Refinement with the least fairness that determines the net.
  let passes = 0;
  let ratio = r0;
  let current: { fit: Trial; meets: boolean } | null = null;
  for (; ; passes++) {
    const { bu, bv } = bases();
    const trial = trialOn(bu, bv, betaOf(bu, bv));
    const first = trial(ratio);
    if (first !== null && first !== 'failed') current = first;
    else {
      const f = smallestFeasible(trial, ratio, r1, o.fairnessSearchSteps);
      if (f === null)
        return (
          failure ?? { message: 'height-field fit: no fairness in the bracket determines the net' }
        );
      ratio = f.ratio;
      current = f.trial;
    }
    const t = current.fit;
    if (t.judgedMax <= o.surfaceTol || passes >= o.maxRefinePasses) break;
    const badU = new Set<number>();
    const badV = new Set<number>();
    const bu0 = [0, ...ku, 1];
    const bv0 = [0, ...kv, 1];
    const spanOf = (bs: readonly number[], x: number): number => {
      let lo = 0;
      let hi = bs.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bs[mid]! <= x) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    for (let k = 0; k < n; k++) {
      if (data.judged[k] !== 1 || !(t.residual[k]! > o.surfaceTol)) continue;
      badU.add(spanOf(bu0, uv[2 * k]!));
      badV.add(spanOf(bv0, uv[2 * k + 1]!));
    }
    const addU: number[] = [];
    for (const s of badU) {
      const a = bu0[s]!;
      const b = bu0[s + 1]!;
      if ((b - a) * (x1 - x0) >= 2 * o.minKnotSpacing) addU.push(0.5 * (a + b));
    }
    // v spans are split in mirror pairs: each failing span is mapped to the
    // lower of itself and its mirror (the knots are symmetric, so the spans pair
    // by index), split there, and the split mirrored, so the knots stay
    // symmetric to rounding of `1 − m`.
    const addV: number[] = [];
    const last = bv0.length - 2;
    for (const s0 of new Set([...badV].map((s) => Math.min(s, last - s)))) {
      const a = bv0[s0]!;
      const b = bv0[s0 + 1]!;
      const m = 0.5 * (a + b);
      addV.push(m);
      if (s0 !== last - s0) addV.push(1 - m);
    }
    if (addU.length === 0 && addV.length === 0) break;
    ku = union(ku, addU);
    kv = union(kv, addV);
  }

  // The discrepancy principle on the final basis, from the least fairness found.
  const { bu, bv } = bases();
  const choice = discrepancySearch(
    trialOn(bu, bv, betaOf(bu, bv)),
    ratio,
    r1,
    current!,
    o.fairnessSearchSteps,
  );
  const t = choice.fit;

  // Exact symmetrisation of the z net (rows j and m − 1 − j averaged).
  const nu = bu.count;
  const nv = bv.count;
  const z = new Array<number>(nu * nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) z[i * nv + j] = t.z[i * nv + j]!;
    for (let j = 0; 2 * j < nv; j++) {
      const jj = nv - 1 - j;
      const avg = jj === j ? z[i * nv + j]! : 0.5 * (z[i * nv + j]! + z[i * nv + jj]!);
      z[i * nv + j] = avg;
      z[i * nv + jj] = avg;
    }
  }
  return Object.freeze({
    field: {
      degreeU: 3,
      degreeV: 3,
      knotsU: Array.from(bu.knots),
      knotsV: Array.from(bv.knots),
      x: [x0, x1] as const,
      y: [y0, y1] as const,
      z,
    },
    maxResidual: t.judgedMax,
    maxResidualAll: t.allMax,
    ratio: choice.ratio,
    meets: choice.meets,
    passes,
    fits,
  });
}
