// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board as a STEP solid (docs/design/m3-exports.md, decision 5): one B-spline surface per side, fitted
 * to the evaluator, in geom's B-rep, written by geom's STEP writer.
 *
 * **Parametrisation.** Each side is one rectangle in `(s, t)`: `t` runs around the section, bottom centre (0)
 * over the apex (½) to deck centre (1), and `s` along the board by a map `ξ(s)` that both sides share: the
 * normalised mean of the two outlines' plan arc lengths (the path of the chord end `P(ξ)`, m1-model.md §2). At a
 * round tip the outline is vertical, so ξ is singular in the outline's own length; in `s` the rail runs at a
 * finite speed right up to the tip and the surface is smooth there, so the fit has nothing to fight. This holds
 * on a notched tail too: the notch zone is a change of the chord map inside the same rectangle, and the inner
 * wall, the tip and the outer rail are one `t` run across the rail.
 *
 * **Ends.** Nothing is clipped: the surface runs from the first station to the last. An end whose chord has
 * no length (a pointed or round tip, a notch bottom) is a collapsed row: the end row of both sides lies on the
 * vertical edge at `(ξ, 0)` from the rocker to the deck, one edge shared by the two faces, or on a single
 * point (a pole) where the end has no thickness either. An end with width (a squash transom, a blunt nose,
 * the converter's `bluntEnds`) is a real flat end of the model and keeps its planar cap.
 *
 * **Seams by construction.** The two sides share their `s` and `t` knots. The rows `t = 0` and `t = 1` and the
 * collapsed end rows of the plus fit lie on y = 0 (held by weight, then snapped), and the minus fit takes the
 * plus fit's control points there exactly; a symmetric board's minus side is the plus side with y negated. A
 * cap's rows lie in the plane x = const, so the cap is an exact plane face.
 *
 * **Tangency.** The control row next to a stringer row leans along the evaluator's own cross direction, so the
 * faces meet tangent-continuously along the stringer wherever the evaluator does. At a round tip the
 * evaluator's ∂S/∂s is along ±y (x and z are stationary there), so the row next to the tip row takes the tip
 * row's x and z: both faces leave the tip edge along ±y and meet tangent along it. A pinned tip (a corner in
 * plan) and a notch bottom keep the evaluator's crease, to within the fit.
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
  STEP_ARC_BISECT,
  STEP_ARC_TABLE,
  STEP_CAP_MARGIN,
  STEP_CHECK_SAMPLES,
  STEP_EDGE_SAMPLES,
  STEP_DEGREE,
  STEP_DIRECTION_SHARE,
  STEP_EDGE_WEIGHT,
  STEP_END_BLEND,
  STEP_FIT_SAMPLES,
  STEP_MAX_CONTROLS,
  STEP_MAX_PASSES,
  STEP_MIN_SPAN,
  STEP_POLE_THICKNESS,
  STEP_ROUND_SLOPE,
  STEP_START_HALF_SPANS,
  STEP_START_SPANS,
  STEP_STATION_GAP,
  STEP_TIP_WIDTH,
  STEP_TOLERANCE,
  STEP_WARP_BISECT,
  STEP_WARP_TABLE,
} from './params';
import { chainEval } from './chain';
import { outlineParam, xiOfParam } from './frame';
import type { PlanFrame } from './frame';
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

/**
 * How an end of the solid is closed: a planar cap (a blunt end), one vertical edge shared by the two faces
 * (a tip or a notch bottom with thickness), or a pole (a tip without thickness).
 */
export type EndKind = 'cap' | 'edge' | 'pole';

export interface BoardSolidReport {
  /** Largest distance (cm) from the surfaces to the evaluator at the same (ξ, t) on the dense grid. */
  readonly deviation: number;
  readonly passes: number;
  /** Control points of each side along s and t. */
  readonly controlCount: readonly [number, number];
  /** Spans of the s and t knot vectors. */
  readonly spans: readonly [number, number];
  /** The ξ range of the surface: the board's first and last station (nothing is clipped). */
  readonly range: readonly [number, number];
  readonly tail: EndKind;
  readonly nose: EndKind;
  /** Whether each end (tail, nose) is a round tip, across which the faces are made tangent. */
  readonly round: readonly [boolean, boolean];
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
  /** The surfaces, in (s, t); `xiOf(s)` is the station coordinate ξ of a row. */
  readonly plus: NurbsSurface;
  readonly minus: NurbsSurface;
  readonly xiOf: (s: number) => number;
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

// --- the s map --------------------------------------------------------------------------------

/** The shared map from the surface parameter s to the station coordinate ξ, and its inverse. */
interface Along {
  readonly lo: number;
  readonly hi: number;
  readonly xi: (s: number) => number;
  readonly sOf: (xi: number) => number;
}

/**
 * One side's plan arc length table: the chord end P(ξ) is the outline point O(p) (on the x = ξ branch and
 * in the notch zone alike), so the table runs over the outline parameter p, where the outline is regular,
 * and records ξ(p) and the arc length from the first station. Two-point Gauss per entry.
 */
function sideArc(f: PlanFrame, lo: number, hi: number): { xi: Float64Array; arc: Float64Array } {
  const buf = new Float64Array(3);
  outlineParam(f, lo, buf);
  const p0 = buf[0]!;
  outlineParam(f, hi, buf);
  const p1 = buf[0]!;
  const n = Math.max(1, Math.ceil((p1 - p0) * STEP_ARC_TABLE));
  const xi = new Float64Array(n + 1);
  const arc = new Float64Array(n + 1);
  const d = new Float64Array(6);
  const speed = (p: number): number => {
    chainEval(f.chain, p, 1, d, 0);
    return Math.hypot(d[2]!, d[3]!);
  };
  const g = 0.5 / Math.sqrt(3);
  xi[0] = lo;
  for (let k = 1; k <= n; k++) {
    const a = p0 + ((p1 - p0) * (k - 1)) / n;
    const b = p0 + ((p1 - p0) * k) / n;
    const m = 0.5 * (a + b);
    const h = b - a;
    arc[k] = arc[k - 1]! + 0.5 * h * (speed(m - g * h) + speed(m + g * h));
    xi[k] = k === n ? hi : Math.min(hi, Math.max(xi[k - 1]!, xiOfParam(f, b)));
  }
  return { xi, arc };
}

/** Piecewise-linear value of a non-decreasing table `ys(xs)` at x (clamped). */
function tableAt(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = xs.length - 1;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n]!) return ys[n]!;
  let a = 0;
  let b = n;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (xs[m]! <= x) a = m;
    else b = m;
  }
  const w = xs[b]! > xs[a]! ? (x - xs[a]!) / (xs[b]! - xs[a]!) : 0;
  return ys[a]! + w * (ys[b]! - ys[a]!);
}

/**
 * ξ(s), s the normalised mean of the two sides' plan arc lengths (one side on a mirror board), as a monotone
 * cubic (Fritsch-Carlson) through the table; its slope is 0 at a round tip, where the outline is vertical.
 */
function alongMap(built: BuiltBoard, mirror: boolean, round: readonly [boolean, boolean]): Along {
  const lo = built.xiMin;
  const hi = built.xiMax;
  const tables = (mirror ? [built.sides[0]] : built.sides).map((side) => {
    const t = sideArc(side.frame, lo, hi);
    const total = t.arc[t.arc.length - 1]!;
    return { xi: t.xi, s: t.arc.map((a) => a / total) };
  });
  let xs: Float64Array;
  let ss: Float64Array;
  if (tables.length === 1) {
    xs = tables[0]!.xi;
    ss = tables[0]!.s;
  } else {
    xs = Float64Array.from(new Set([...tables[0]!.xi, ...tables[1]!.xi])).sort();
    ss = xs.map((x) => 0.5 * (tableAt(tables[0]!.xi, tables[0]!.s, x) + tableAt(tables[1]!.xi, tables[1]!.s, x))); // prettier-ignore
  }
  // strictly increasing knots of the inverse, s → ξ
  const S: number[] = [0];
  const X: number[] = [lo];
  for (let k = 1; k < ss.length; k++) {
    if (ss[k]! > S[S.length - 1]! && xs[k]! > X[X.length - 1]!) {
      S.push(ss[k]!);
      X.push(xs[k]!);
    }
  }
  S[S.length - 1] = 1;
  X[X.length - 1] = hi;
  const n = S.length - 1;
  const delta = new Float64Array(n);
  for (let k = 0; k < n; k++) delta[k] = (X[k + 1]! - X[k]!) / (S[k + 1]! - S[k]!);
  const m = new Float64Array(n + 1);
  m[0] = round[0] ? 0 : delta[0]!;
  m[n] = round[1] ? 0 : delta[n - 1]!;
  for (let k = 1; k < n; k++) {
    const h0 = S[k]! - S[k - 1]!;
    const h1 = S[k + 1]! - S[k]!;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[k] = (w1 + w2) / (w1 / delta[k - 1]! + w2 / delta[k]!);
  }
  const xi = (s: number): number => {
    if (s <= 0) return lo;
    if (s >= 1) return hi;
    let a = 0;
    let b = n;
    while (b - a > 1) {
      const c = (a + b) >> 1;
      if (S[c]! <= s) a = c;
      else b = c;
    }
    const h = S[b]! - S[a]!;
    const u = (s - S[a]!) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * X[a]! +
      (u3 - 2 * u2 + u) * h * m[a]! +
      (-2 * u3 + 3 * u2) * X[b]! +
      (u3 - u2) * h * m[b]!
    );
  };
  const sOf = (x: number): number => {
    let a = 0;
    let b = 1;
    for (let i = 0; i < STEP_ARC_BISECT; i++) {
      const c = 0.5 * (a + b);
      if (xi(c) < x) a = c;
      else b = c;
    }
    return 0.5 * (a + b);
  };
  return { lo, hi, xi, sOf };
}

/** The evaluator's points on the grid `us × vs` (s and t), u-major, stride 3. */
function sampleGrid(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  along: Along,
  us: readonly number[],
  vs: readonly number[],
  warp: Warp | null = null,
): Float64Array {
  const out = new Float64Array(us.length * vs.length * 3);
  const shifted = side === 1 ? warp : null;
  for (let i = 0; i < us.length; i++) {
    ev.row(side, along.xi(us[i]!), 0);
    for (let j = 0; j < vs.length; j++) {
      const t = shifted === null ? vs[j]! : shifted(us[i]!, vs[j]!);
      ev.eval(t, 0, out, (i * vs.length + j) * 3);
    }
  }
  return out;
}

/** Where the minus side is sampled in `t` for a surface `(s, t)`: the identity away from a collapsed end. */
type Warp = (s: number, t: number) => number;

/**
 * On an asymmetric board the two sides collapse onto the same vertical edge at a notch bottom or a tip, but
 * their `t` runs along it differently (the sections' apexes sit at different heights). The surfaces share that
 * row control point for point, so the minus side is sampled where its own point has the plus side's height:
 * the table of that `t` along the edge at ξ. Null where the two agree already, or where the heights are not
 * monotone in `t`.
 */
function edgeWarp(ev: SurfaceEvaluator, xi: number): Float64Array | null {
  const K = STEP_WARP_TABLE;
  const o = new Float64Array(3);
  const target = new Float64Array(K + 1);
  ev.row(0, xi, 0);
  for (let k = 0; k <= K; k++) {
    ev.eval(k / K, 0, o);
    target[k] = o[2]!;
  }
  ev.row(1, xi, 0);
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
    for (let i = 0; i < STEP_WARP_BISECT; i++) {
      const m = 0.5 * (a + b);
      if (zAt(m) < target[k]!) a = m;
      else b = m;
    }
    table[k] = 0.5 * (a + b);
    moved = Math.max(moved, Math.abs(table[k]! - k / K));
  }
  return moved <= STEP_MIN_SPAN ? null : table;
}

/**
 * The minus side's warp from the edge tables of the two ends (null where an end needs none): the table's `t`
 * on the end row, fading out over {@link STEP_END_BLEND} of `s`. That is a reparametrisation: the points stay
 * on the evaluator's surface.
 */
function makeWarp(tables: readonly [Float64Array | null, Float64Array | null]): Warp | null {
  if (tables[0] === null && tables[1] === null) return null;
  const K = STEP_WARP_TABLE;
  const shift = (table: Float64Array, d: number, t: number): number => {
    const w = (1 - d / STEP_END_BLEND) ** 3;
    const pos = t * K;
    const k = Math.min(K - 1, Math.floor(pos));
    const f = pos - k;
    const tau = table[k]! * (1 - f) + table[k + 1]! * f;
    return t + w * (tau - t);
  };
  return (s, t) => {
    if (tables[0] !== null && s < STEP_END_BLEND) return shift(tables[0], s, t);
    if (tables[1] !== null && 1 - s < STEP_END_BLEND) return shift(tables[1], 1 - s, t);
    return t;
  };
}

// --- ends -------------------------------------------------------------------------------------

/** Half-width of the section at ξ (the larger of the two sides), its thickness and its centre height. */
function sectionSize(
  ev: SurfaceEvaluator,
  mirror: boolean,
  xi: number,
): { chord: number; thickness: number; z: number } {
  const o = new Float64Array(9);
  let chord = 0;
  let thickness = 0;
  let z = 0;
  for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
    ev.row(side, xi, 0);
    ev.eval(0, 0, o, 0);
    ev.eval(0.5, 0, o, 3);
    ev.eval(1, 0, o, 6);
    chord = Math.max(chord, Math.abs(o[4]!));
    thickness = Math.max(thickness, o[8]! - o[2]!);
    z = 0.5 * (o[2]! + o[8]!);
  }
  return { chord, thickness, z };
}

/** How the end at ξ closes (module comment, "Ends"). */
function endKind(ev: SurfaceEvaluator, mirror: boolean, xi: number): EndKind {
  const s = sectionSize(ev, mirror, xi);
  if (s.chord > STEP_TIP_WIDTH) return 'cap';
  return s.thickness > STEP_POLE_THICKNESS ? 'edge' : 'pole';
}

/**
 * Whether a tip is round: the outline of every side is vertical there (a standard end only, not a notch
 * bottom). The tangent is the end segment's first control-polygon leg of non-zero length, so a collapsed
 * handle (a zero tangent) still gives the direction the curve arrives in.
 */
function roundTip(built: BuiltBoard, mirror: boolean, end: 0 | 1): boolean {
  const buf = new Float64Array(3);
  for (const side of mirror ? [built.sides[0]] : built.sides) {
    const f = side.frame;
    if (end === 0 && f.notch !== null) return false;
    outlineParam(f, end === 0 ? built.xiMin : built.xiMax, buf);
    const k = Math.min(f.chain.segments - 1, Math.max(0, end === 0 ? Math.floor(buf[0]!) : Math.ceil(buf[0]!) - 1)); // prettier-ignore
    const c = f.chain.c;
    const o = 8 * k;
    // the end point and the other control points, nearest first
    const at = end === 0 ? [0, 2, 4, 6] : [6, 4, 2, 0];
    let dx = 0;
    let dy = 0;
    for (let i = 1; i < 4 && dx === 0 && dy === 0; i++) {
      dx = c[o + at[i]!]! - c[o + at[0]!]!;
      dy = c[o + at[i]! + 1]! - c[o + at[0]! + 1]!;
    }
    if (Math.abs(dx) > STEP_ROUND_SLOPE * Math.hypot(dx, dy)) return false;
  }
  return true;
}

// --- one fit ----------------------------------------------------------------------------------

interface Layout {
  readonly along: Along;
  readonly mirror: boolean;
  readonly ends: readonly [EndKind, EndKind];
  readonly round: readonly [boolean, boolean];
  /** Whether the tail is a notch bottom (a swallow or fish), not a tip. */
  readonly notched: boolean;
  /** The point a pole end collapses to (its centre height), per end. */
  readonly poleZ: readonly [number, number];
  /** The minus side's `t` shift near an asymmetric collapsed end, or null. */
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
  const points = sampleGrid(ev, side, lay.along, us, vs, lay.warp);
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

/** Per end (tail, nose): the evaluator's plan direction off a pinned tip edge per control row, or null. */
type Tips = readonly [Float64Array | null, Float64Array | null];

/** The evaluator's cross direction at a stringer row, per control column: `(dx, dz)` per unit of `dy` along `t`. */
interface Cross {
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  /** ∂z/∂t itself, for the column of a collapsed end, where the section has no width (dy = 0). */
  readonly tz: Float64Array;
  readonly ok: Uint8Array;
}

/**
 * How the evaluator leaves the stringer, at the Greville abscissa of each control column of `g.u`: the
 * ratios `dx / dy` and `dz / dy` of its section's tangent ∂S/∂t at `t = 0` (`end` 0, the bottom) or at
 * `t = 1` (the deck), exact from the evaluator. On a standard section the direction is purely along y (both are 0); in a notch zone
 * the chord is a fan chord (`dx ≠ 0`); under a vee the section leaves at a slope (`dz ≠ 0`).
 */
function crossAt(ev: SurfaceEvaluator, side: 0 | 1, lay: Layout, g: Grids, end: 0 | 1): Cross {
  const n = g.u.count;
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  const ok = new Uint8Array(n);
  const knots = g.u.knots;
  const tz = new Float64Array(n);
  const o = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    let gr = 0;
    for (let k = 1; k <= STEP_DEGREE; k++) gr += knots[i + k]!;
    gr /= STEP_DEGREE;
    // ∂S/∂t at the stringer (the minus side's warp only scales it there)
    ev.row(side, lay.along.xi(gr), 1);
    ev.eval(end, 1, o);
    const dy = o[7]!;
    tz[i] = o[8]!;
    if (Math.abs(dy) <= STEP_MIN_SPAN) continue;
    dx[i] = o[6]! / dy;
    dz[i] = o[8]! / dy;
    ok[i] = 1;
  }
  return { dx, dz, tz, ok };
}

/**
 * How the evaluator leaves a pinned tip edge or a notch bottom (a collapsed `edge` end that is not round), at
 * the Greville abscissa of each control row of `g.v`: the plan direction `(dx, dy)` (unit) of ∂S/∂ξ on the
 * end row, where the side's own fit is sampled (the minus side's warp included). The edge is
 * vertical, so the plan part of a cross tangent is the part that sets the angle between the faces. Null for
 * every other end.
 */
function tipAt(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  lay: Layout,
  g: Grids,
  e: 0 | 1,
): Float64Array | null {
  if (lay.ends[e] !== 'edge' || lay.round[e]) return null;
  const n = g.v.count;
  const knots = g.v.knots;
  const gv: number[] = [];
  for (let j = 0; j < n; j++) {
    let gr = 0;
    for (let k = 1; k <= STEP_DEGREE; k++) gr += knots[j + k]!;
    gv.push(gr / STEP_DEGREE);
  }
  // ∂S/∂ξ of the end row: the minus side's warp only adds a step along the (vertical) edge, out of the plan
  const s0 = e === 0 ? 0 : 1;
  const o = new Float64Array(6);
  const out = new Float64Array(2 * n);
  ev.row(side, lay.along.xi(s0), 1);
  for (let j = 0; j < n; j++) {
    const t = side === 1 && lay.warp !== null ? lay.warp(s0, gv[j]!) : gv[j]!;
    ev.eval(t, 1, o);
    const dx = o[3]!;
    const dy = o[4]!;
    const len = Math.hypot(dx, dy);
    if (len > STEP_MIN_SPAN) {
      out[2 * j] = dx / len;
      out[2 * j + 1] = dy / len;
    }
  }
  return out;
}

/**
 * Snaps the shared rows exactly: y = 0 on the stringer rows and on a collapsed end row (a pole's row onto its
 * point), the cap rows in their plane, and the minus side's stringer and collapsed rows onto the plus side's.
 * The control row next to a stringer row is then placed on the line through the stringer row along the
 * evaluator's own cross direction (`cross`), offset only in y: the two faces leave the stringer in the
 * direction the evaluator does, so they meet tangent-continuously wherever the board is smooth and keep its
 * crease where it is not. At a round tip the row next to the tip row takes the tip row's x and z, so both
 * faces leave the tip edge along ±y, as the evaluator does (module comment, "Tangency").
 */
function snap(
  lay: Layout,
  nu: number,
  nv: number,
  plus: Float64Array,
  minus: Float64Array | null,
  cross: readonly [readonly [Cross, Cross], readonly [Cross, Cross]],
  colloc: readonly (readonly number[])[],
  tips: readonly [Tips, Tips],
  collocV: readonly (readonly number[])[],
  vKnots: ArrayLike<number>,
): void {
  const at = (i: number, j: number) => (i * nv + j) * 3;
  const endRow = [0, nu - 1] as const;
  const nextRow = [1, nu - 2] as const;
  const collapsed = [lay.ends[0] !== 'cap', lay.ends[1] !== 'cap'] as const;
  const xiEnd = [lay.along.lo, lay.along.hi] as const;
  // the control step of a clamped cubic in t that has derivative 1 at t = 0 (bottom) and at t = 1 (deck)
  const m = vKnots.length;
  const edgeStep = [
    (vKnots[STEP_DEGREE + 1]! - vKnots[1]!) / STEP_DEGREE,
    -(vKnots[m - 2]! - vKnots[m - 2 - STEP_DEGREE]!) / STEP_DEGREE,
  ] as const;
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
        const end = k === 0 || k === nu - 1;
        const flat = (k === 0 && collapsed[0]) || (k === nu - 1 && collapsed[1]);
        if (flat || c.ok[k] === 0) {
          // a collapsed end column is all on its edge: at a tip the plus side gives its first step along the
          // edge the evaluator's own ∂z/∂t there, so that the stringer's cross direction runs into the tip as
          // the evaluator's does (the minus side shares that row as it is; a notch bottom keeps the fit's)
          const exact = flat && side === 0 && !(k === 0 && lay.notched);
          rhs[0]![k] = exact ? 0 : net[at(k, j1)]! - net[at(k, j0)]!;
          rhs[1]![k] = exact ? c.tz[k]! * edgeStep[j0 === 0 ? 0 : 1] : net[at(k, j1) + 2]! - net[at(k, j0) + 2]!; // prettier-ignore
          return row.map((_, i) => (i === k ? 1 : 0));
        }
        let yk = 0;
        for (let i = 0; i < nu; i++) yk += row[i]! * y[i]!;
        rhs[0]![k] = end ? 0 : c.dx[k]! * yk; // a cap's rows stay in their plane
        rhs[1]![k] = c.dz[k]! * yk;
        return row;
      });
      // a round tip: the column next to the tip column has its offset (so the tip row's x and z, below)
      for (const e of [0, 1] as const) {
        if (!lay.round[e] || nu < 4) continue;
        const k = nextRow[e];
        A[k] = A[k]!.map((_, i) => (i === k ? 1 : i === endRow[e] ? -1 : 0));
        rhs[0]![k] = 0;
        rhs[1]![k] = 0;
      }
      const sol = solveDense(A, rhs);
      for (let i = 0; i < nu; i++) {
        net[at(i, j1)] = net[at(i, j0)]! + sol[0]![i]!;
        net[at(i, j1) + 2] = net[at(i, j0) + 2]! + sol[1]![i]!;
      }
    }
  };
  /** A collapsed end row onto its edge (x = ξ, y = 0) or its pole. */
  const collapse = (net: Float64Array): void => {
    for (const e of [0, 1] as const) {
      if (!collapsed[e]) continue;
      for (let j = 0; j < nv; j++) {
        net[at(endRow[e], j)] = xiEnd[e];
        net[at(endRow[e], j) + 1] = 0;
        if (lay.ends[e] === 'pole') net[at(endRow[e], j) + 2] = lay.poleZ[e];
      }
    }
  };
  /** At a round tip the next row takes the tip row's x and z (all of it, the stringer rows included). */
  const roundOff = (net: Float64Array, from: number, to: number): void => {
    for (const e of [0, 1] as const) {
      if (!lay.round[e] || nu < 4) continue;
      for (let j = from; j < to; j++) {
        net[at(nextRow[e], j)] = net[at(endRow[e], j)]!;
        net[at(nextRow[e], j) + 2] = net[at(endRow[e], j) + 2]!;
      }
    }
  };
  /**
   * A pinned tip or a notch bottom: the plan part of the cross tangent along the end row is made parallel to
   * the evaluator's (`tips`) at the Greville abscissae of t, keeping the fit's length along it; the rows at
   * and next to the stringer rows keep the stringer's lean.
   */
  const tipLean = (net: Float64Array, side: 0 | 1): void => {
    for (const e of [0, 1] as const) {
      const dir = tips[side][e];
      if (dir === null || nv < 6) continue;
      const i0 = endRow[e];
      const i1 = nextRow[e];
      const n = 2 * nv;
      const A: number[][] = [];
      const rhs = new Float64Array(n);
      const D = (j: number, c: 0 | 1) => net[at(i1, j) + c]! - net[at(i0, j) + c]!;
      for (let k = 0; k < nv; k++) {
        const r0 = new Array<number>(n).fill(0);
        const r1 = new Array<number>(n).fill(0);
        const ex = dir[2 * k]!;
        const ey = dir[2 * k + 1]!;
        if (k < 2 || k > nv - 3 || (ex === 0 && ey === 0)) {
          r0[2 * k] = 1;
          r1[2 * k + 1] = 1;
          rhs[2 * k] = D(k, 0);
          rhs[2 * k + 1] = D(k, 1);
        } else {
          let along = 0;
          for (let j = 0; j < nv; j++) {
            const N = collocV[k]![j]!;
            if (N === 0) continue;
            r0[2 * j] = N * ey;
            r0[2 * j + 1] = -N * ex;
            r1[2 * j] = N * ex;
            r1[2 * j + 1] = N * ey;
            along += N * (D(j, 0) * ex + D(j, 1) * ey);
          }
          rhs[2 * k] = 0;
          rhs[2 * k + 1] = along;
        }
        A.push(r0, r1);
      }
      const sol = solveDense(A, [rhs])[0]!;
      for (let j = 2; j < nv - 2; j++) {
        net[at(i1, j)] = net[at(i0, j)]! + sol[2 * j]!;
        net[at(i1, j) + 1] = net[at(i0, j) + 1]! + sol[2 * j + 1]!;
      }
    }
  };
  /** The cap rows in their x-plane. */
  const caps = (net: Float64Array): void => {
    for (const e of [0, 1] as const) {
      if (collapsed[e]) continue;
      for (let j = 0; j < nv; j++) net[at(endRow[e], j)] = xiEnd[e];
    }
  };
  for (const j of [0, nv - 1]) {
    for (let i = 0; i < nu; i++) plus[at(i, j) + 1] = 0;
  }
  collapse(plus);
  roundOff(plus, 0, nv);
  lean(plus, 0);
  roundOff(plus, 0, nv);
  tipLean(plus, 0);
  caps(plus);
  if (minus === null) return;
  for (const j of [0, nv - 1]) {
    for (let i = 0; i < nu; i++) {
      for (let c = 0; c < 3; c++) minus[at(i, j) + c] = plus[at(i, j) + c]!;
    }
  }
  for (const e of [0, 1] as const) {
    if (!collapsed[e]) continue;
    for (let j = 0; j < nv; j++) {
      for (let c = 0; c < 3; c++) minus[at(endRow[e], j) + c] = plus[at(endRow[e], j) + c]!;
    }
  }
  lean(minus, 1);
  roundOff(minus, 1, nv - 1);
  tipLean(minus, 1);
  caps(minus);
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
  const E = sampleGrid(ev, side, lay.along, us, vs, lay.warp);
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
    const E = sampleGrid(ev, side, lay.along, us, vs, lay.warp);
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
  const lo = built.xiMin;
  const hi = built.xiMax;
  const ends = [endKind(ev, mirror, lo), endKind(ev, mirror, hi)] as const;
  const round = [
    ends[0] !== 'cap' && roundTip(built, mirror, 0),
    ends[1] !== 'cap' && roundTip(built, mirror, 1),
  ] as const;
  const along = alongMap(built, mirror, round);
  const warp = mirror
    ? null
    : makeWarp([
        ends[0] === 'edge' ? edgeWarp(ev, lo) : null,
        ends[1] === 'edge' ? edgeWarp(ev, hi) : null,
      ]);
  const poleZ = [sectionSize(ev, mirror, lo).z, sectionSize(ev, mirror, hi).z] as const;
  const notched = built.sides[0].frame.notch !== null;
  const lay: Layout = { along, mirror, ends, round, notched, poleZ, warp };

  // the first knots: equal spans and the stations
  const ub = uniformBreaks(STEP_START_SPANS);
  for (const x of built.sides[0].blend.xs) {
    const s = along.sOf(x);
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
    const tipsOf = (side: 0 | 1): Tips => [
      tipAt(ev, side, lay, grids, 0),
      tipAt(ev, side, lay, grids, 1),
    ];
    const tips = tipsOf(0);
    snap(lay, nu, nv, plusPts, minusPts, [crossOf(0), mirror ? crossOf(0) : crossOf(1)], collocation(grids.u), [tips, mirror ? tips : tipsOf(1)], collocation(grids.v), grids.v.knots); // prettier-ignore
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
    xiOf: along.xi,
    report: {
      deviation,
      passes,
      controlCount: [plusSurf.u.count, plusSurf.v.count],
      spans: [ub.length - 1, vb.length - 1],
      range: [lo, hi],
      tail: ends[0],
      nose: ends[1],
      round,
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
  const pt = (c: ClampedCurve<3>, last: boolean) => {
    const i = last ? c.basis.count - 1 : 0;
    const w = c.cw[4 * i + 3]!;
    return { x: c.cw[4 * i]! / w, y: c.cw[4 * i + 1]! / w, z: c.cw[4 * i + 2]! / w };
  };
  // vertices: the bottom and deck ends of the stringer at each end; one vertex where an end is a pole
  const vertices: { point: { x: number; y: number; z: number } }[] = [];
  const ends = ([0, 1] as const).map((e) => {
    const b = vertices.push({ point: pt(bottom, e === 1) }) - 1;
    const d = lay.ends[e] === 'pole' ? b : vertices.push({ point: pt(deck, e === 1) }) - 1;
    return { b, d };
  });
  const edges: BrepEdge[] = [];
  const add = (c: ClampedCurve<3>, start: number, end: number, degenerate = false): number => {
    edges.push(degenerate ? { curve: c, start, end, degenerate } : { curve: c, start, end });
    return edges.length - 1;
  };
  const eBottom = add(bottom, ends[0]!.b, ends[1]!.b);
  const eDeck = add(deck, ends[0]!.d, ends[1]!.d);
  // per end: the plus face's and the minus face's edge there (one shared edge on a collapsed end)
  const endEdges = ([0, 1] as const).map((e) => {
    const side = e === 0 ? 'u0' : 'u1';
    const { b, d } = ends[e]!;
    if (lay.ends[e] === 'edge') {
      const one = add(curve(plus, side), b, d);
      return [one, one] as const;
    }
    if (lay.ends[e] === 'pole') {
      return [add(curve(plus, side), b, d, true), add(curve(minus, side), b, d, true)] as const;
    }
    return [add(curve(plus, side), b, d), add(curve(minus, side), b, d)] as const;
  });

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

  const faces: BrepFace[] = [
    hull(plus, endEdges[0]![0], endEdges[1]![0]),
    hull(minus, endEdges[0]![1], endEdges[1]![1]),
  ];

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
  for (const e of [1, 0] as const) {
    if (lay.ends[e] !== 'cap') continue;
    const [eP, eM] = endEdges[e]!;
    faces.push(cap(edges[eP]!.curve, edges[eM]!.curve, eP, eM, e === 1));
  }

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
