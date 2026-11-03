// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board as a STEP solid (docs/design/m3-exports.md, decision 5): one B-spline surface per side, fitted
 * to the evaluator, in geom's B-rep, written by geom's STEP writer.
 *
 * **Parametrisation.** Each side is one rectangle in `(s, t)`: `s = (ξ − lo) / (hi − lo)` along the
 * stringer and `t` around the section, bottom centre (0) over the apex (½) to deck centre (1). This holds on
 * a notched tail too: the notch zone is a change of the chord map inside the same rectangle (m1-model.md §2),
 * the notch bottom is the row `s = 0` collapsed to the vertical stringer edge, and the inner wall, the tip
 * and the outer rail are one `t` run across the rail. So the shell is the classic one: two hull faces (the
 * plus and the minus side), joined along the stringer, and a planar cap at each end that has width.
 *
 * **Ends.** `lo` and `hi` are the first and last station unless the end is a tip. A tip (a pointed tail or
 * nose: the section is narrower or thinner than `STEP_TIP_CHORD` or `STEP_TIP_THICKNESS`) is singular in ξ (the outline is not a
 * function of ξ there), so the fit never samples it: the surface is clipped where the section reaches
 * those minimums and a planar cap closes the clip, the classic export's answer. A blunt end (a squash tail,
 * a blunt nose) is a cap at the end station itself. A notch bottom is not clipped: the chord grows linearly
 * from it, and the two sides meet along one shared vertical edge, so there is no cap there.
 *
 * **Seams by construction.** The two sides share their `s` and `t` knots. The rows `t = 0` and `t = 1` (and
 * the notch-bottom row) of the plus fit lie on y = 0 (point constraints, then snapped), and the minus fit is
 * constrained to the plus fit's values there and then takes its control points exactly; a symmetric board's
 * minus side is the plus side with y negated. A cap's rows lie in the plane x = const (the chord of a
 * standard end is an x-plane), constrained and snapped, so the cap is an exact plane face.
 *
 * **Refinement.** Fit, measure the distance to the evaluator at the same `(s, t)` on a dense grid
 * (`STEP_CHECK_SAMPLES` points per span, disjoint from the fit's data), and bisect the spans of the cells
 * that miss. The direction of a cell's miss is guessed from the fourth difference of the evaluator's own
 * samples along each direction (the interpolation error of a cubic is that times a constant), so a channel
 * wall, which is steep in `t` only, adds `t` knots and a tip, which is steep in `s` only, adds `s` knots.
 */
import {
  approximateSurface,
  boundaryCurve,
  clampedBasis,
  createScratch,
  knotsFromBreaks,
  line2,
  makeBrep,
  makeCurve,
  makeSurface,
  orientBrep,
  planeSurface,
  surfaceDerivatives,
  surfaceEvalGridInto,
  writeStep,
} from '@openshaper/geom';
import type {
  Brep,
  BrepCoedge,
  BrepEdge,
  BrepFace,
  ClampedBasis,
  ClampedCurve,
  NurbsSurface,
  StepResult,
} from '@openshaper/geom';
import {
  STEP_ACCEPT_SHARE,
  STEP_CAP_MARGIN,
  STEP_CHECK_SAMPLES,
  STEP_CLIP_BISECT,
  STEP_CLIP_SCAN,
  STEP_CROSS_STEP,
  STEP_EDGE_SAMPLES,
  STEP_DEGREE,
  STEP_DIRECTION_SHARE,
  STEP_EDGE_WEIGHT,
  STEP_FIT_SAMPLES,
  STEP_MAX_CONTROLS,
  STEP_MAX_PASSES,
  STEP_MIN_SPAN,
  STEP_NOTCH_BLEND,
  STEP_START_HALF_SPANS,
  STEP_START_SPANS,
  STEP_STATION_GAP,
  STEP_TIP_CHORD,
  STEP_TIP_THICKNESS,
  STEP_TOLERANCE,
  STEP_WARP_TABLE,
} from './params';
import { createEvaluator } from './surface';
import type { BuiltBoard, SurfaceEvaluator } from './surface';

export interface BoardSolidOptions {
  /** The distance (cm) the surfaces may leave the evaluator. Default {@link STEP_TOLERANCE}, 0.5 mm. */
  readonly tolerance?: number;
  /** Called at the start of each fit pass (the slow step), with the pass number from 1. */
  readonly onPass?: (pass: number) => void;
  /** Control points per side the fit may grow to before it gives up. Default {@link STEP_MAX_CONTROLS}. */
  readonly maxControls?: number;
}

/** How an end of the solid is closed. */
export type EndKind = 'cap' | 'edge';

export interface BoardSolidReport {
  /** Largest distance (cm) from the surfaces to the evaluator at the same (ξ, t) on the dense grid. */
  readonly deviation: number;
  readonly passes: number;
  /** Control points of each side along s and t. */
  readonly controlCount: readonly [number, number];
  /** Spans of the s and t knot vectors. */
  readonly spans: readonly [number, number];
  /** The ξ range of the surface, and how far each end was clipped from the board's end (cm). */
  readonly range: readonly [number, number];
  readonly clipped: readonly [number, number];
  readonly tail: EndKind;
  readonly nose: EndKind;
  /** True if the deviation is within the tolerance (false if the passes ran out or the budget did). */
  readonly withinTolerance: boolean;
  /** True if the fit stopped because the net would exceed {@link STEP_MAX_CONTROLS} control points. */
  readonly overBudget: boolean;
}

/** Why a STEP fit failed, as data: the caller words the message in the editor's units. */
export class StepFitError extends Error {
  constructor(
    message: string,
    readonly kind: 'tolerance' | 'budget',
    /** The deviation reached and the tolerance asked for (cm). */
    readonly deviation: number,
    readonly tolerance: number,
  ) {
    super(message);
    this.name = 'StepFitError';
  }
}

export interface BoardSolid {
  readonly brep: Brep;
  /** The surfaces, in (s, t) with `ξ = range[0] + s · (range[1] − range[0])`. */
  readonly plus: NurbsSurface;
  readonly minus: NurbsSurface;
  readonly report: BoardSolidReport;
}

// --- small helpers ----------------------------------------------------------------------------

/** Strictly increasing breaks from 0 to 1 with `n` equal spans. */
const uniformBreaks = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

/** Knots of a clamped basis: ends at multiplicity degree + 1, `triple` (the section's apex) at `degree`, the rest simple. */
const basisOf = (breaks: readonly number[], triple: number | null): ClampedBasis => {
  const mults = breaks.map((b, i) =>
    i === 0 || i === breaks.length - 1 ? STEP_DEGREE + 1 : b === triple ? STEP_DEGREE : 1,
  );
  return clampedBasis(STEP_DEGREE, knotsFromBreaks(breaks, mults));
};

/** `fracs` of every span, then the last break. */
const positions = (
  breaks: readonly number[],
  fracs: readonly number[],
  last: boolean,
): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    for (const f of fracs) out.push(breaks[i]! + f * (breaks[i + 1]! - breaks[i]!));
  }
  if (last) out.push(breaks[breaks.length - 1]!);
  return out;
};

const FIT_FRACS = Array.from({ length: STEP_FIT_SAMPLES }, (_, i) => i / STEP_FIT_SAMPLES);
const CHECK_FRACS = Array.from(
  { length: STEP_CHECK_SAMPLES },
  (_, i) => (i + 0.5) / STEP_CHECK_SAMPLES,
);

interface Range {
  readonly lo: number;
  readonly hi: number;
}

/** The evaluator's points on the grid `us × vs` (s and t), u-major, stride 3. */
function sampleGrid(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  r: Range,
  us: readonly number[],
  vs: readonly number[],
  warp: Warp | null = null,
): Float64Array {
  const out = new Float64Array(us.length * vs.length * 3);
  const shifted = side === 1 ? warp : null;
  for (let i = 0; i < us.length; i++) {
    ev.row(side, r.lo + us[i]! * (r.hi - r.lo), 0);
    for (let j = 0; j < vs.length; j++) {
      const t = shifted === null ? vs[j]! : shifted(us[i]!, vs[j]!);
      ev.eval(t, 0, out, (i * vs.length + j) * 3);
    }
  }
  return out;
}

/** Where the minus side is sampled in `t` for a surface `(s, t)`: the identity away from the notch bottom. */
type Warp = (s: number, t: number) => number;

/**
 * On an asymmetric notched board the two sides collapse onto the same vertical segment at the notch bottom,
 * but their `t` run along it differently (the sections' apexes sit at different heights). The surfaces share
 * that row control point for point, so the minus side is sampled where its own point has the plus side's
 * height, fading out over {@link STEP_NOTCH_BLEND} of `s`. That is a reparametrisation: the points stay on
 * the evaluator's surface. Null where the two agree already, or where the heights are not monotone in `t`.
 */
function notchWarp(ev: SurfaceEvaluator, lo: number): Warp | null {
  const K = STEP_WARP_TABLE;
  const o = new Float64Array(3);
  const target = new Float64Array(K + 1);
  ev.row(0, lo, 0);
  for (let k = 0; k <= K; k++) {
    ev.eval(k / K, 0, o);
    target[k] = o[2]!;
  }
  ev.row(1, lo, 0);
  const zAt = (t: number): number => {
    ev.eval(t, 0, o);
    return o[2]!;
  };
  let prev = zAt(0);
  for (let k = 1; k <= K; k++) {
    const z = zAt(k / K);
    if (z < prev) return null;
    prev = z;
  }
  const table = new Float64Array(K + 1);
  let moved = 0;
  for (let k = 0; k <= K; k++) {
    let a = 0;
    let b = 1;
    for (let i = 0; i < STEP_CLIP_BISECT; i++) {
      const m = 0.5 * (a + b);
      if (zAt(m) < target[k]!) a = m;
      else b = m;
    }
    table[k] = 0.5 * (a + b);
    moved = Math.max(moved, Math.abs(table[k]! - k / K));
  }
  if (moved <= STEP_MIN_SPAN) return null;
  return (s, t) => {
    if (s >= STEP_NOTCH_BLEND) return t;
    const w = (1 - s / STEP_NOTCH_BLEND) ** 3;
    const pos = t * K;
    const k = Math.min(K - 1, Math.floor(pos));
    const f = pos - k;
    const tau = table[k]! * (1 - f) + table[k + 1]! * f;
    return t + w * (tau - t);
  };
}

// --- ends -------------------------------------------------------------------------------------

/** Half-width of the section at ξ (the smaller of the two sides) and its thickness. */
function sectionSize(
  ev: SurfaceEvaluator,
  mirror: boolean,
  xi: number,
): { chord: number; thickness: number } {
  const o = new Float64Array(9);
  let chord = Infinity;
  let thickness = Infinity;
  for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
    ev.row(side, xi, 0);
    ev.eval(0, 0, o, 0);
    ev.eval(0.5, 0, o, 3);
    ev.eval(1, 0, o, 6);
    chord = Math.min(chord, Math.abs(o[4]!));
    thickness = Math.min(thickness, o[8]! - o[2]!);
  }
  return { chord, thickness };
}

/** Where an end's surface stops: the end itself, or the nearest ξ inwards where the section reaches the tip minimum. */
function clipEnd(ev: SurfaceEvaluator, mirror: boolean, from: number, toward: number): number {
  const good = (xi: number): boolean => {
    const s = sectionSize(ev, mirror, xi);
    return s.chord >= STEP_TIP_CHORD && s.thickness >= STEP_TIP_THICKNESS;
  };
  if (good(from)) return from;
  let bad = from;
  let ok = Number.NaN;
  for (let i = 1; i <= STEP_CLIP_SCAN; i++) {
    const x = from + ((toward - from) * i) / STEP_CLIP_SCAN;
    if (good(x)) {
      ok = x;
      break;
    }
    bad = x;
  }
  if (Number.isNaN(ok)) return from;
  for (let i = 0; i < STEP_CLIP_BISECT; i++) {
    const m = 0.5 * (bad + ok);
    if (good(m)) ok = m;
    else bad = m;
  }
  return ok;
}

// --- one fit ----------------------------------------------------------------------------------

interface Layout {
  readonly range: Range;
  readonly mirror: boolean;
  readonly tail: EndKind;
  /** The minus side's `t` shift near an asymmetric notch bottom, or null. */
  readonly warp: Warp | null;
}

/** Control points of a surface as a plain array (stride 3, u-major). */
const controlsOf = (s: NurbsSurface): Float64Array => {
  const n = s.u.count * s.v.count;
  const out = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    const w = s.cw[4 * k + 3]!;
    out[3 * k] = s.cw[4 * k]! / w;
    out[3 * k + 1] = s.cw[4 * k + 1]! / w;
    out[3 * k + 2] = s.cw[4 * k + 2]! / w;
  }
  return out;
};

interface Grids {
  readonly ub: readonly number[];
  readonly vb: readonly number[];
  readonly u: ClampedBasis;
  readonly v: ClampedBasis;
}

function fitSide(ev: SurfaceEvaluator, side: 0 | 1, lay: Layout, g: Grids): NurbsSurface {
  const us = positions(g.ub, FIT_FRACS, true);
  const vs = positions(g.vb, FIT_FRACS, true);
  const points = sampleGrid(ev, side, lay.range, us, vs, lay.warp);
  const uv = new Float64Array(us.length * vs.length * 2);
  const weights = new Float64Array(us.length * vs.length).fill(1);
  for (let i = 0; i < us.length; i++) {
    for (let j = 0; j < vs.length; j++) {
      const k = i * vs.length + j;
      uv[2 * k] = us[i]!;
      uv[2 * k + 1] = vs[j]!;
      // the rows that are shared or planar are held by weight; `snap` then makes them exact
      if (i === 0 || j === 0 || i === us.length - 1 || j === vs.length - 1) {
        weights[k] = STEP_EDGE_WEIGHT;
      }
    }
  }
  const r = approximateSurface(points, { uv }, { u: g.u, v: g.v, dataWeights: weights });
  if (!r.ok)
    throw new Error(`STEP surface fit failed: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.value.surface;
}

/** Values of the basis functions of a clamped basis at its Greville abscissae: row k is `N_i(g_k)` for all i. */
function collocation(b: ClampedBasis): number[][] {
  const n = b.count;
  const p = STEP_DEGREE;
  const knots = b.knots;
  const rows: number[][] = [];
  for (let k = 0; k < n; k++) {
    let u = 0;
    for (let m = 1; m <= p; m++) u += knots[k + m]!;
    u /= p;
    let span = p;
    while (span < n - 1 && u >= knots[span + 1]!) span++;
    // Cox-de Boor for the p + 1 non-zero functions of the span (The NURBS Book, A2.2)
    const N = new Array<number>(p + 1).fill(0);
    const left = new Array<number>(p + 1).fill(0);
    const right = new Array<number>(p + 1).fill(0);
    N[0] = 1;
    for (let j = 1; j <= p; j++) {
      left[j] = u - knots[span + 1 - j]!;
      right[j] = knots[span + j]! - u;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const d = right[r + 1]! + left[j - r]!;
        const t = d === 0 ? 0 : N[r]! / d;
        N[r] = saved + right[r + 1]! * t;
        saved = left[j - r]! * t;
      }
      N[j] = saved;
    }
    const row = new Array<number>(n).fill(0);
    for (let r = 0; r <= p; r++) row[span - p + r] = N[r]!;
    rows.push(row);
  }
  return rows;
}

/** Solves `A x = b` for each right-hand side (Gaussian elimination with partial pivoting). */
function solveDense(
  A: readonly (readonly number[])[],
  rhs: readonly Float64Array[],
): Float64Array[] {
  const n = A.length;
  const M = A.map((r) => Float64Array.from(r));
  const B = rhs.map((r) => Float64Array.from(r));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    for (const b of B) [b[c], b[piv]] = [b[piv]!, b[c]!];
    const d = M[c]![c]!;
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r]![k]! -= f * M[c]![k]!;
      for (const b of B) b[r]! -= f * b[c]!;
    }
  }
  for (const b of B) {
    for (let r = n - 1; r >= 0; r--) {
      let v = b[r]!;
      for (let k = r + 1; k < n; k++) v -= M[r]![k]! * b[k]!;
      b[r] = v / M[r]![r]!;
    }
  }
  return B;
}

/** The evaluator's cross direction at a stringer row, per control column: `(dx, dz)` per unit of `dy` along `t`. */
interface Cross {
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  readonly ok: Uint8Array;
}

/**
 * How the evaluator leaves the stringer, at the Greville abscissa of each control column of `g.u`: the
 * ratios `dx / dy` and `dz / dy` of its section's first step from `t = 0` (`end` 0, the bottom) or from
 * `t = 1` (the deck). On a standard section the direction is purely along y (both are 0); in a notch zone
 * the chord is a fan chord (`dx ≠ 0`); under a vee the section leaves at a slope (`dz ≠ 0`).
 */
function crossAt(ev: SurfaceEvaluator, side: 0 | 1, lay: Layout, g: Grids, end: 0 | 1): Cross {
  const n = g.u.count;
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  const ok = new Uint8Array(n);
  const knots = g.u.knots;
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    let gr = 0;
    for (let k = 1; k <= STEP_DEGREE; k++) gr += knots[i + k]!;
    gr /= STEP_DEGREE;
    ev.row(side, lay.range.lo + gr * (lay.range.hi - lay.range.lo), 0);
    ev.eval(end, 0, a);
    ev.eval(end === 0 ? STEP_CROSS_STEP : 1 - STEP_CROSS_STEP, 0, b);
    const dy = b[1]! - a[1]!;
    if (Math.abs(dy) <= STEP_MIN_SPAN) continue;
    dx[i] = (b[0]! - a[0]!) / dy;
    dz[i] = (b[2]! - a[2]!) / dy;
    ok[i] = 1;
  }
  return { dx, dz, ok };
}

/**
 * Snaps the shared rows exactly: y = 0 on the stringer rows (and the notch edge), the cap rows in their
 * plane, and the minus side's stringer and notch-edge rows onto the plus side's. The control row next to a
 * stringer row is then placed on the line through the stringer row along the evaluator's own cross
 * direction (`cross`), offset only in y: the two faces leave the stringer in the direction the evaluator
 * does, so they meet tangent-continuously wherever the board is smooth and keep its crease where it is not.
 */
function snap(
  lay: Layout,
  nu: number,
  nv: number,
  plus: Float64Array,
  minus: Float64Array | null,
  cross: readonly [readonly [Cross, Cross], readonly [Cross, Cross]],
  colloc: readonly (readonly number[])[],
): void {
  const at = (i: number, j: number) => (i * nv + j) * 3;
  const first = lay.tail === 'edge' ? 1 : 0; // the notch edge is all on y = 0: its next row is free
  const lean = (net: Float64Array, side: 0 | 1): void => {
    const rows: [number, number, Cross][] = [
      [0, 1, cross[side][0]],
      [nv - 1, nv - 2, cross[side][1]],
    ];
    for (const [j0, j1, c] of rows) {
      const y = new Float64Array(nu);
      for (let i = 0; i < nu; i++) y[i] = net[at(i, j1) + 1]!;
      // collocation at the Greville abscissae: the next row minus the stringer row is, as a spline in s,
      // the evaluator's direction times that row's y there
      const rhs = [new Float64Array(nu), new Float64Array(nu)];
      const A = colloc.map((row, k) => {
        if (k < first || c.ok[k] === 0) {
          rhs[0]![k] = net[at(k, j1)]! - net[at(k, j0)]!;
          rhs[1]![k] = net[at(k, j1) + 2]! - net[at(k, j0) + 2]!;
          return row.map((_, i) => (i === k ? 1 : 0));
        }
        let yk = 0;
        for (let i = 0; i < nu; i++) yk += row[i]! * y[i]!;
        const end = k === 0 || k === nu - 1; // a cap's rows stay in their plane
        rhs[0]![k] = end ? 0 : c.dx[k]! * yk;
        rhs[1]![k] = c.dz[k]! * yk;
        return row;
      });
      const sol = solveDense(A, rhs);
      for (let i = 0; i < nu; i++) {
        net[at(i, j1)] = net[at(i, j0)]! + sol[0]![i]!;
        net[at(i, j1) + 2] = net[at(i, j0) + 2]! + sol[1]![i]!;
      }
    }
  };
  for (const j of [0, nv - 1]) {
    for (let i = 0; i < nu; i++) plus[at(i, j) + 1] = 0;
  }
  if (lay.tail === 'edge') {
    for (let j = 0; j < nv; j++) {
      plus[at(0, j)] = lay.range.lo;
      plus[at(0, j) + 1] = 0;
    }
  }
  lean(plus, 0);
  for (let j = 0; j < nv; j++) plus[at(0, j)] = lay.range.lo;
  for (let j = 0; j < nv; j++) plus[at(nu - 1, j)] = lay.range.hi;
  if (minus === null) return;
  for (const j of [0, nv - 1]) {
    for (let i = 0; i < nu; i++) {
      for (let c = 0; c < 3; c++) minus[at(i, j) + c] = plus[at(i, j) + c]!;
    }
  }
  lean(minus, 1);
  for (let j = 0; j < nv; j++) {
    minus[at(0, j)] = lay.range.lo;
    if (lay.tail === 'edge') {
      for (let c = 0; c < 3; c++) minus[at(0, j) + c] = plus[at(0, j) + c]!;
    }
    minus[at(nu - 1, j)] = lay.range.hi;
  }
}

const withControls = (g: Grids, pts: Float64Array): NurbsSurface =>
  makeSurface({ u: g.u, v: g.v, points: pts });

/** The y-mirror of a control net: y negated (`0 - y`, so a zero stays +0). */
const mirrorControls = (pts: Float64Array): Float64Array => {
  const out = pts.slice();
  for (let k = 1; k < out.length; k += 3) out[k] = 0 - out[k]!;
  return out;
};

// --- measuring --------------------------------------------------------------------------------

interface Marks {
  /** Largest deviation found (cm). */
  deviation: number;
  readonly u: Set<number>;
  readonly v: Set<number>;
}

/**
 * Measures a side on the dense grid and adds the spans to bisect to `marks`. The deviation of a cell that
 * misses `limit` is attributed to the direction whose fourth difference of the evaluator's samples
 * predicts the larger interpolation error (both if they are within {@link STEP_DIRECTION_SHARE}).
 */
function measureSide(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  lay: Layout,
  g: Grids,
  surface: NurbsSurface,
  limit: number,
  marks: Marks,
): void {
  const nuS = g.ub.length - 1;
  const nvS = g.vb.length - 1;
  const S = STEP_CHECK_SAMPLES;
  const us = positions(g.ub, CHECK_FRACS, false);
  const vs = positions(g.vb, CHECK_FRACS, false);
  const nvd = vs.length;
  const E = sampleGrid(ev, side, lay.range, us, vs, lay.warp);
  const F = new Float64Array(E.length);
  surfaceEvalGridInto(
    surface,
    Float64Array.from(us),
    Float64Array.from(vs),
    0,
    F,
    createScratch({ maxDegree: STEP_DEGREE }),
  );
  const dist = (i: number, j: number): number => {
    const o = (i * nvd + j) * 3;
    return Math.hypot(E[o]! - F[o]!, E[o + 1]! - F[o + 1]!, E[o + 2]! - F[o + 2]!);
  };
  // a fourth difference of E at (i0..i0+4) along u (step = nvd) or v (step = 1) from sample (i, j)
  const d4 = (o: number, step: number): number => {
    let x = 0;
    let y = 0;
    let z = 0;
    const c = [1, -4, 6, -4, 1];
    for (let k = 0; k < 5; k++) {
      x += c[k]! * E[o + 3 * step * k]!;
      y += c[k]! * E[o + 3 * step * k + 1]!;
      z += c[k]! * E[o + 3 * step * k + 2]!;
    }
    return Math.hypot(x, y, z);
  };
  // interpolation error of a cubic = h^4 f'''' / 384, h = S samples
  const gain = S ** 4 / 384;
  for (let a = 0; a < nuS; a++) {
    for (let b = 0; b < nvS; b++) {
      let worst = 0;
      let pu = 0;
      let pv = 0;
      for (let i = a * S; i < (a + 1) * S; i++) {
        for (let j = b * S; j < (b + 1) * S; j++) {
          worst = Math.max(worst, dist(i, j));
        }
      }
      marks.deviation = Math.max(marks.deviation, worst);
      if (worst <= limit) continue;
      for (let i = a * S; i + 4 <= (a + 1) * S - 1; i++) {
        for (let j = b * S; j < (b + 1) * S; j++)
          pu = Math.max(pu, gain * d4((i * nvd + j) * 3, nvd));
      }
      for (let j = b * S; j + 4 <= (b + 1) * S - 1; j++) {
        for (let i = a * S; i < (a + 1) * S; i++)
          pv = Math.max(pv, gain * d4((i * nvd + j) * 3, 1));
      }
      const none = pu === 0 && pv === 0;
      if (none || pu >= STEP_DIRECTION_SHARE * pv) marks.u.add(a);
      if (none || pv >= STEP_DIRECTION_SHARE * pu) marks.v.add(b);
    }
  }
}

/**
 * Measures the rows `snap` moves, which the interior grid never reaches: the stringer rows (t = 0 and 1), the
 * apex row (t = ½) and the end rows (s = 0 and 1), at {@link STEP_EDGE_SAMPLES} points per span. A miss on a
 * row along s marks the s spans, a miss on a row along t marks the t spans.
 */
function measureEdges(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  lay: Layout,
  g: Grids,
  surface: NurbsSurface,
  limit: number,
  marks: Marks,
): void {
  const fracs = Array.from({ length: STEP_EDGE_SAMPLES }, (_, i) => i / STEP_EDGE_SAMPLES);
  const sc = createScratch({ maxDegree: STEP_DEGREE });
  const row = (
    us: readonly number[],
    vs: readonly number[],
    spans: Set<number>,
    along: 'u' | 'v',
  ) => {
    // prettier-ignore
    const E = sampleGrid(ev, side, lay.range, us, vs, lay.warp);
    const F = new Float64Array(E.length);
    surfaceEvalGridInto(surface, Float64Array.from(us), Float64Array.from(vs), 0, F, sc);
    const breaks = along === 'u' ? g.ub : g.vb;
    for (let k = 0; k < E.length; k += 3) {
      const d = Math.hypot(E[k]! - F[k]!, E[k + 1]! - F[k + 1]!, E[k + 2]! - F[k + 2]!);
      marks.deviation = Math.max(marks.deviation, d);
      if (d <= limit) continue;
      const p = along === 'u' ? us[k / 3]! : vs[k / 3]!;
      let a = breaks.findIndex((b) => b > p) - 1;
      if (a < 0) a = breaks.length - 2;
      spans.add(a);
    }
  };
  const usAll = positions(g.ub, fracs, true);
  const vsAll = positions(g.vb, fracs, true);
  for (const v of [0, 0.5, 1]) row(usAll, [v], marks.u, 'u');
  for (const u of [0, 1]) row([u], vsAll, marks.v, 'v');
}

const bisect = (breaks: number[], spans: ReadonlySet<number>, triple: number | null): number => {
  let added = 0;
  const out: number[] = [];
  for (let i = 0; i < breaks.length; i++) {
    out.push(breaks[i]!);
    if (i + 1 < breaks.length && spans.has(i)) {
      const lo = breaks[i]!;
      const hi = breaks[i + 1]!;
      if (hi - lo > 2 * STEP_MIN_SPAN) {
        const mid = 0.5 * (lo + hi);
        if (mid !== triple) {
          out.push(mid);
          added++;
        }
      }
    }
  }
  breaks.length = 0;
  breaks.push(...out);
  return added;
};

// --- the solid --------------------------------------------------------------------------------

/**
 * Fits the surfaces and builds the closed B-rep of a built board. Throws if the fit cannot be made or the
 * B-rep is refused (the export reports the message).
 */
export function boardSolid(built: BuiltBoard, opts: BoardSolidOptions = {}): BoardSolid {
  const tolerance = opts.tolerance ?? STEP_TOLERANCE;
  const limit = STEP_ACCEPT_SHARE * tolerance;
  const maxControls = opts.maxControls ?? STEP_MAX_CONTROLS;
  const ev = createEvaluator(built);
  const mirror = built.doc.symmetry === 'mirror';

  // ends
  const notched = built.sides[0].frame.notch !== null;
  const xi0 = built.xiMin;
  const xi1 = built.xiMax;
  const tailEdge = notched && sectionSize(ev, mirror, xi0).thickness >= STEP_TIP_THICKNESS;
  const lo = tailEdge ? xi0 : clipEnd(ev, mirror, xi0, xi1);
  const hi = clipEnd(ev, mirror, xi1, xi0);
  const warp = !mirror && tailEdge ? notchWarp(ev, lo) : null;
  const lay: Layout = { range: { lo, hi }, mirror, tail: tailEdge ? 'edge' : 'cap', warp };

  // the first knots: equal spans and the stations
  const ub = uniformBreaks(STEP_START_SPANS);
  for (const x of built.sides[0].blend.xs) {
    const s = (x - lo) / (hi - lo);
    if (ub.every((b) => Math.abs(b - s) > STEP_STATION_GAP) && s > 0 && s < 1) ub.push(s);
  }
  ub.sort((a, b) => a - b);
  const vb = uniformBreaks(2 * STEP_START_HALF_SPANS);

  let grids: Grids = { ub, vb, u: basisOf(ub, null), v: basisOf(vb, 0.5) };
  let plusSurf!: NurbsSurface;
  let minusSurf!: NurbsSurface;
  let deviation = Infinity;
  let passes = 0;
  let overBudget = false;
  for (let pass = 1; pass <= STEP_MAX_PASSES; pass++) {
    passes = pass;
    opts.onPass?.(pass);
    const nu = grids.u.count;
    const nv = grids.v.count;
    const plusPts = controlsOf(fitSide(ev, 0, lay, grids));
    const minusPts = mirror ? null : controlsOf(fitSide(ev, 1, lay, grids));
    const crossOf = (side: 0 | 1): [Cross, Cross] => [
      crossAt(ev, side, lay, grids, 0),
      crossAt(ev, side, lay, grids, 1),
    ];
    snap(lay, nu, nv, plusPts, minusPts, [crossOf(0), mirror ? crossOf(0) : crossOf(1)], collocation(grids.u)); // prettier-ignore
    plusSurf = withControls(grids, plusPts);
    minusSurf = withControls(grids, minusPts ?? mirrorControls(plusPts));
    const marks: Marks = { deviation: 0, u: new Set(), v: new Set() };
    measureSide(ev, 0, lay, grids, plusSurf, limit, marks);
    measureEdges(ev, 0, lay, grids, plusSurf, limit, marks);
    if (!mirror) {
      measureSide(ev, 1, lay, grids, minusSurf, limit, marks);
      measureEdges(ev, 1, lay, grids, minusSurf, limit, marks);
    }
    deviation = marks.deviation;
    if (deviation <= limit || pass === STEP_MAX_PASSES) break;
    const added = bisect(ub, marks.u, null) + bisect(vb, marks.v, 0.5);
    if (added === 0) break;
    grids = { ub, vb, u: basisOf(ub, null), v: basisOf(vb, 0.5) };
    if (grids.u.count * grids.v.count > maxControls) {
      overBudget = true;
      break;
    }
  }

  const brep = assemble(plusSurf, minusSurf, lay);
  return {
    brep,
    plus: plusSurf,
    minus: minusSurf,
    report: {
      deviation,
      passes,
      controlCount: [plusSurf.u.count, plusSurf.v.count],
      spans: [ub.length - 1, vb.length - 1],
      range: [lo, hi],
      clipped: [lo - xi0, xi1 - hi],
      tail: lay.tail,
      nose: 'cap',
      withinTolerance: deviation <= tolerance && !overBudget,
      overBudget,
    },
  };
}

// --- topology ---------------------------------------------------------------------------------

/** Whether a surface's own normal (Su × Sv) points out of the board, sampled at the apex of the middle. */
const normalPointsOut = (s: NurbsSurface): boolean => {
  const d = surfaceDerivatives(s, 0.5, 0.5, 1);
  const n = {
    x: d.Su.y * d.Sv.z - d.Su.z * d.Sv.y,
    y: d.Su.z * d.Sv.x - d.Su.x * d.Sv.z,
    z: d.Su.x * d.Sv.y - d.Su.y * d.Sv.x,
  };
  return n.y * d.S.y > 0;
};

const coedge = (edge: number, sense: boolean, pcurve: ClampedCurve<2>): BrepCoedge => ({
  edge,
  sense,
  pcurve,
  master: 'curve3d',
});

/** The curve's points, projected to (y, z), as a plane pcurve with the curve's own basis. */
const planeCurve = (c: ClampedCurve<3>): ClampedCurve<2> => {
  const pts: number[] = [];
  for (let i = 0; i < c.basis.count; i++) {
    const w = c.cw[4 * i + 3]!;
    pts.push(c.cw[4 * i + 1]! / w, c.cw[4 * i + 2]! / w);
  }
  return makeCurve({ dim: 2, basis: c.basis, points: pts }) as ClampedCurve<2>;
};

function assemble(plus: NurbsSurface, minus: NurbsSurface, lay: Layout): Brep {
  const curve = (s: NurbsSurface, e: 'u0' | 'u1' | 'v0' | 'v1'): ClampedCurve<3> =>
    boundaryCurve(s, e) as ClampedCurve<3>;
  const bottom = curve(plus, 'v0');
  const deck = curve(plus, 'v1');
  const tailP = curve(plus, 'u0');
  const tailM = curve(minus, 'u0');
  const noseP = curve(plus, 'u1');
  const noseM = curve(minus, 'u1');
  const pt = (c: ClampedCurve<3>, last: boolean) => {
    const i = last ? c.basis.count - 1 : 0;
    const w = c.cw[4 * i + 3]!;
    return { x: c.cw[4 * i]! / w, y: c.cw[4 * i + 1]! / w, z: c.cw[4 * i + 2]! / w };
  };
  // vertices: 0 tail bottom, 1 tail deck, 2 nose bottom, 3 nose deck
  const vertices = [
    { point: pt(bottom, false) },
    { point: pt(deck, false) },
    { point: pt(bottom, true) },
    { point: pt(deck, true) },
  ];
  const edges: BrepEdge[] = [];
  const add = (c: ClampedCurve<3>, start: number, end: number): number => {
    edges.push({ curve: c, start, end });
    return edges.length - 1;
  };
  const eBottom = add(bottom, 0, 2);
  const eDeck = add(deck, 1, 3);
  const eTailP = add(tailP, 0, 1);
  const eTailM = lay.tail === 'edge' ? eTailP : add(tailM, 0, 1);
  const eNoseP = add(noseP, 2, 3);
  const eNoseM = add(noseM, 2, 3);

  const pBottom = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
  const pDeck = line2({ x: 0, y: 1 }, { x: 1, y: 1 });
  const pTail = line2({ x: 0, y: 0 }, { x: 0, y: 1 });
  const pNose = line2({ x: 1, y: 0 }, { x: 1, y: 1 });

  const hull = (s: NurbsSurface, eTail: number, eNose: number): BrepFace => {
    const same = normalPointsOut(s);
    const coedges = same
      ? [
          coedge(eBottom, true, pBottom),
          coedge(eNose, true, pNose),
          coedge(eDeck, false, pDeck),
          coedge(eTail, false, pTail),
        ]
      : [
          coedge(eTail, true, pTail),
          coedge(eDeck, true, pDeck),
          coedge(eNose, false, pNose),
          coedge(eBottom, false, pBottom),
        ];
    return { surface: s, sameSense: same, outer: { coedges }, holes: [] };
  };

  const faces: BrepFace[] = [hull(plus, eTailP, eNoseP), hull(minus, eTailM, eNoseM)];

  // a cap: the plane x = const with (u, v) = (y, z), normal +x, so the nose is sameSense and the tail is not
  const cap = (
    cP: ClampedCurve<3>,
    cM: ClampedCurve<3>,
    eP: number,
    eM: number,
    nose: boolean,
  ): BrepFace => {
    const x = pt(cP, false).x;
    let y = 0;
    let zlo = Infinity;
    let zhi = -Infinity;
    for (const c of [cP, cM]) {
      for (let i = 0; i < c.basis.count; i++) {
        const w = c.cw[4 * i + 3]!;
        y = Math.max(y, Math.abs(c.cw[4 * i + 1]! / w));
        zlo = Math.min(zlo, c.cw[4 * i + 2]! / w);
        zhi = Math.max(zhi, c.cw[4 * i + 2]! / w);
      }
    }
    const m = STEP_CAP_MARGIN;
    const plane = planeSurface(
      { x, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { u: [-y - m, y + m], v: [zlo - m, zhi + m] },
    );
    const pP = planeCurve(cP);
    const pM = planeCurve(cM);
    const coedges = nose
      ? [coedge(eP, true, pP), coedge(eM, false, pM)]
      : [coedge(eM, true, pM), coedge(eP, false, pP)];
    return { surface: plane, sameSense: nose, outer: { coedges }, holes: [] };
  };
  faces.push(cap(noseP, noseM, eNoseP, eNoseM, true));
  if (lay.tail === 'cap') faces.push(cap(tailP, tailM, eTailP, eTailM, false));

  const made = makeBrep({
    vertices,
    edges,
    faces,
    shells: [{ faces: faces.map((_, i) => i), closed: true }],
    solids: [{ outer: 0 }],
  });
  if (!made.ok) {
    throw new Error(`STEP solid refused: ${made.issues.map((i) => i.message).join('; ')}`);
  }
  return orientBrep(made.value);
}

// --- STEP -------------------------------------------------------------------------------------

export interface BoardStepOptions extends BoardSolidOptions {
  /** `PRODUCT` and file name inside the file. */
  readonly name?: string;
  /** `FILE_NAME` timestamp (ISO 8601); defaults to a constant, so the bytes are reproducible. */
  readonly timestamp?: string;
  /** The unit the file declares and writes its coordinates in. Default millimetres, the STEP norm. */
  readonly unit?: 'mm' | 'cm' | 'in';
  /** Called after the surfaces are fitted and before the solid is checked and written. */
  readonly onWrite?: () => void;
}

export interface BoardStep {
  readonly text: string;
  readonly report: BoardSolidReport;
  readonly stats: StepResult['stats'];
}

/**
 * The STEP file of a built board, and what the fit achieved. Throws (with the reason) if the surfaces cannot
 * be fitted within the tolerance or the solid fails geom's `checkBrep`, which `writeStep` runs.
 */
export function boardStep(built: BuiltBoard, opts: BoardStepOptions = {}): BoardStep {
  const tolerance = opts.tolerance ?? STEP_TOLERANCE;
  const solid = boardSolid(built, opts);
  if (!solid.report.withinTolerance) {
    const { deviation, overBudget } = solid.report;
    throw new StepFitError(
      overBudget
        ? `The surface needs more detail than the STEP export can fit (over ${opts.maxControls ?? STEP_MAX_CONTROLS} control points per side); try fewer stations or a smaller feature.`
        : `The surface could not be fitted within ${(tolerance * 10).toFixed(2)} mm (it reached ${(deviation * 10).toFixed(2)} mm).`,
      overBudget ? 'budget' : 'tolerance',
      deviation,
      tolerance,
    );
  }
  opts.onWrite?.();
  const out = writeStep(solid.brep, {
    fileUnit: opts.unit ?? 'mm',
    modelUnit: 'cm',
    pcurves: 'trimmedOnly',
    originatingSystem: 'OpenShaper',
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
  });
  return { text: out.text, report: solid.report, stats: out.stats };
}
