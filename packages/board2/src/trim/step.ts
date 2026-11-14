// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board as a STEP solid (docs/design/trim-blend-plan.md, "STEP"): two trimmed panel faces and
 * the rail's strip faces, in geom's B-rep, written by geom's STEP writer.
 *
 * **The faces.** The deck and the bottom are each one B-spline height field over the plan, fitted to the
 * panels the kernel mesh is built on (`TrimMesh.panels`, held to the least thickness; the bottom with its
 * relief at full value), and trimmed by their band edge: one closed outer loop. The rail is split along
 * the loop at the stringer's two crossings (the nose and the tail or crotch) and at both ends of every
 * corner arc; between two splits it is two strip faces, the deck blend (band edge to apex) and the tuck
 * (bottom band edge to apex). A strip face runs along the loop in `u` (its arc length, normalised) and
 * across the blend in `v`, which is the conic parameter `t` of the kernel's own strip (`railStrips`), so
 * the face is fitted to exactly the points the mesh places, relief fade and all.
 *
 * **Non-rational.** A blend is a conic only where the relief is zero, and the conic's control points and
 * weight change along the loop as the kernel's laws and panels do, so the strips are fitted either way.
 * A cubic in `v` follows a conic to well under the tolerance with a few spans, so every face is a
 * polynomial bicubic (measured: see the report's `across` spans).
 *
 * **Shared edges, exactly.** Every edge is one curve used as a boundary row or column of the faces either
 * side of it, control point for control point:
 *
 * - the apex line of a stretch is the `v = 1` row of its deck blend and of its tuck (they share the `u` knots);
 * - the cross curve at a split is the end column of the two faces either side (all deck blends share one
 *   `v` basis, all tucks another);
 * - a band edge is the `v = 0` row of its strip face, and lies on its panel through a pcurve: the panel
 *   is `S(x, y) = (x, y, f(x, y))` (its control points sit at the Greville abscissae, so its `(u, v)` is the
 *   plan point exactly), so the pcurve is the band edge's own plan curve, and the edge's height is fitted
 *   to `f` along it until the gap is under {@link STEP_RAILS_EDGE_GAP}, a quarter of what `checkBrep`
 *   accepts.
 *
 * The corners of each face are the split's three vertices, fixed in every fit, so the curves meet there
 * exactly. With `N` splits: `3N` vertices, `5N` edges, `2N + 2` faces.
 *
 * **Mirror boards.** The plus half is fitted (from the nose crossing to the tail crossing, both placed on
 * y = 0) and the minus half is its mirror, `0 − y`, as `step.ts` makes its minus side; the panels are fitted
 * across the stringer on a symmetric basis and made exactly symmetric.
 *
 * **Refinement.** As `step.ts`: fit, measure against the kernel on points the fit did not use, bisect the
 * spans that miss, until the deviation is under {@link STEP_ACCEPT_SHARE} of the tolerance or the passes or
 * the control budget run out. A panel is measured on a dense plan grid inside its band edge. A strip is
 * measured at every loop sample at across-parameters between the fit's, and at the kernel's section
 * halfway between samples; its band edge and apex rows too. A strip's miss is put down to its across spans
 * when that section alone cannot be fitted in the across basis, else to its span along the loop.
 */
import {
  clampedBasis,
  knotsFromBreaks,
  line2,
  makeBrep,
  makeCurve,
  makeSurface,
  orientBrep,
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
  STEP_CHECK_SAMPLES,
  STEP_DEGREE,
  STEP_DIRECTION_SHARE,
  STEP_FIT_SAMPLES,
  STEP_MAX_PASSES,
  STEP_MIN_SPAN,
  STEP_RAILS_ACROSS_SHARE,
  STEP_RAILS_ACROSS_START,
  STEP_RAILS_CROSS_SAMPLES,
  STEP_RAILS_EDGE_CHECK,
  STEP_RAILS_EDGE_FIT,
  STEP_RAILS_EDGE_GAP,
  STEP_RAILS_MAX_CONTROLS,
  STEP_RAILS_NEWTON_STEP,
  STEP_RAILS_NEWTON_STEPS,
  STEP_RAILS_PANEL_MARGIN,
  STEP_RAILS_PANEL_START_X,
  STEP_RAILS_PANEL_START_Y,
  STEP_RAILS_SMOOTH,
  STEP_RAILS_SPAN_DATA,
  STEP_RAILS_SPLIT_GAP,
  STEP_RAILS_STRIP_START,
  STEP_TOLERANCE,
} from '../params';
import { StepFitError } from '../step';
import type { BuiltRails } from './native';
import { trimMeshOf } from './native';
import { railStrips } from './solid';
import type { Panels, RailPlace, RailSection, RailStrips } from './solid';

export interface RailsSolidOptions {
  /** The distance (cm) the faces may leave the kernel. Default {@link STEP_TOLERANCE}, 0.5 mm. */
  readonly tolerance?: number;
  /** Called at the start of each fit pass (panels first, then strips), with the pass number from 1. */
  readonly onPass?: (pass: number) => void;
  /** Control points of the whole solid the fit may grow to before it gives up. Default {@link STEP_RAILS_MAX_CONTROLS}. */
  readonly maxControls?: number;
}

export interface RailsSolidReport {
  /** Largest distance (cm) from a face to the kernel on the check points: the larger of the two below. */
  readonly deviation: number;
  /** Largest vertical distance (cm) from a panel face to the kernel's panel, inside its band edge. */
  readonly panelDeviation: number;
  /** Largest distance (cm) from a strip face to the kernel's strip at the same (loop place, t). */
  readonly stripDeviation: number;
  /** Largest gap (cm) between a band edge's 3D curve and its panel along the trim, as sampled by the fit. */
  readonly edgeGap: number;
  /** Fit passes: the panels', then the strips'. */
  readonly passes: readonly [number, number];
  /** Splits along the loop, N: the solid has 2N + 2 faces. */
  readonly splits: number;
  readonly faces: number;
  /** Control points of the whole solid. */
  readonly controlCount: number;
  /** Control points of the deck and the bottom panel, along x and across y. */
  readonly panelControls: readonly [readonly [number, number], readonly [number, number]];
  /** Spans across a deck blend and across a tuck (shared by every face of its kind). */
  readonly across: readonly [number, number];
  /** True if the deviation is within the tolerance and every band edge within its gap. */
  readonly withinTolerance: boolean;
  /** True if the fit stopped because the solid would exceed its control budget. */
  readonly overBudget: boolean;
}

export interface RailsSolid {
  readonly brep: Brep;
  /** The two panel surfaces, `S(x, y) = (x, y, f(x, y))`. */
  readonly deck: NurbsSurface;
  readonly bottom: NurbsSurface;
  readonly report: RailsSolidReport;
}

// --- numerics -------------------------------------------------------------------------------

const P = STEP_DEGREE;

/** A clamped cubic basis with simple interior knots at `breaks`. */
function basisOf(breaks: readonly number[]): ClampedBasis {
  const mults = breaks.map((_, i) => (i === 0 || i === breaks.length - 1 ? P + 1 : 1));
  return clampedBasis(P, knotsFromBreaks(breaks, mults));
}

const LEFT = new Float64Array(P + 1);
const RIGHT = new Float64Array(P + 1);

/** The `P + 1` non-zero basis functions at `t` into `N`; returns the index of the first (The NURBS Book, A2.1, A2.2). */
function basisAt(b: ClampedBasis, t: number, N: Float64Array): number {
  const K = b.knots;
  const n = b.count;
  let span: number;
  if (t >= K[n]!) span = n - 1;
  else if (t <= K[P]!) span = P;
  else {
    let lo = P;
    let hi = n;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (t >= K[m]!) lo = m;
      else hi = m;
    }
    span = lo;
  }
  N[0] = 1;
  for (let j = 1; j <= P; j++) {
    LEFT[j] = t - K[span + 1 - j]!;
    RIGHT[j] = K[span + j]! - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r]! / (RIGHT[r + 1]! + LEFT[j - r]!);
      N[r] = saved + RIGHT[r + 1]! * tmp;
      saved = LEFT[j - r]! * tmp;
    }
    N[j] = saved;
  }
  return span - P;
}

/** A symmetric banded matrix (lower band stored), and its Cholesky solve in place. */
class Banded {
  readonly a: Float64Array;
  constructor(
    readonly n: number,
    readonly bw: number,
  ) {
    this.a = new Float64Array(n * (bw + 1));
  }
  add(i: number, j: number, v: number): void {
    if (j > i) this.a[j * (this.bw + 1) + j - i]! += v;
    else this.a[i * (this.bw + 1) + i - j]! += v;
  }
  diagMax(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) m = Math.max(m, this.a[i * (this.bw + 1)]!);
    return m;
  }
  /** Factors in place and solves for every right-hand side (each overwritten with its solution). */
  solve(rhs: readonly Float64Array[]): void {
    const { n, bw, a } = this;
    const w = bw + 1;
    for (let j = 0; j < n; j++) {
      let d = a[j * w]!;
      for (let k = Math.max(0, j - bw); k < j; k++) d -= a[j * w + j - k]! ** 2;
      const l = Math.sqrt(Math.max(d, 0)) || 1;
      a[j * w] = l;
      for (let i = j + 1; i <= Math.min(n - 1, j + bw); i++) {
        let s = a[i * w + i - j]!;
        for (let k = Math.max(0, i - bw); k < j; k++) s -= a[i * w + i - k]! * a[j * w + j - k]!;
        a[i * w + i - j] = s / l;
      }
    }
    for (const b of rhs) {
      for (let i = 0; i < n; i++) {
        let s = b[i]!;
        for (let k = Math.max(0, i - bw); k < i; k++) s -= a[i * w + i - k]! * b[k]!;
        b[i] = s / a[i * w]!;
      }
      for (let i = n - 1; i >= 0; i--) {
        let s = b[i]!;
        for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= a[k * w + k - i]! * b[k]!;
        b[i] = s / a[i * w]!;
      }
    }
  }
}

/**
 * Adds `λ` times the squared second differences of a run of `count` control values (at `index(k)`) to
 * the normal matrix: the smoothing term of every fit (`STEP_RAILS_SMOOTH`). `fixed(k)` is the value of a
 * fixed control (moved to the right-hand side) or null for an unknown, whose row is `unknown(k)`.
 */
function smoothRun(
  M: Banded,
  rhs: readonly Float64Array[],
  count: number,
  lambda: number,
  unknown: (k: number) => number,
  fixed: (k: number, c: number) => number | null,
): void {
  const d = [1, -2, 1];
  for (let k = 0; k + 2 < count; k++) {
    for (let a = 0; a < 3; a++) {
      const ia = unknown(k + a);
      if (ia < 0) continue;
      for (let b = 0; b < 3; b++) {
        const ib = unknown(k + b);
        if (ib >= 0) {
          if (ib <= ia) M.add(ia, ib, lambda * d[a]! * d[b]!);
        } else {
          for (let c = 0; c < rhs.length; c++) {
            rhs[c]![ia]! -= lambda * d[a]! * d[b]! * fixed(k + b, c)!;
          }
        }
      }
    }
  }
}

/**
 * The least-squares cubic on `b` through values `vals` (stride `dim`) at `ts`, its first and last control
 * points fixed at `first` and `last`. Returns the control points (stride `dim`).
 */
function fitCurve(
  b: ClampedBasis,
  ts: ArrayLike<number>,
  vals: ArrayLike<number>,
  dim: number,
  first: ArrayLike<number>,
  last: ArrayLike<number>,
): Float64Array {
  const n = b.count;
  const out = new Float64Array(n * dim);
  for (let c = 0; c < dim; c++) {
    out[c] = first[c]!;
    out[(n - 1) * dim + c] = last[c]!;
  }
  const m = n - 2;
  const M = new Banded(m, P);
  const rhs = Array.from({ length: dim }, () => new Float64Array(m));
  const N = new Float64Array(P + 1);
  for (let k = 0; k < ts.length; k++) {
    const i0 = basisAt(b, ts[k]!, N);
    const r = new Float64Array(dim);
    for (let c = 0; c < dim; c++) r[c] = vals[k * dim + c]!;
    for (let a = 0; a <= P; a++) {
      const i = i0 + a;
      if (i === 0 || i === n - 1) for (let c = 0; c < dim; c++) r[c]! -= N[a]! * out[i * dim + c]!;
    }
    for (let a = 0; a <= P; a++) {
      const i = i0 + a - 1;
      if (i < 0 || i >= m) continue;
      for (let c = 0; c < dim; c++) rhs[c]![i]! += N[a]! * r[c]!;
      for (let bb = 0; bb <= a; bb++) {
        const j = i0 + bb - 1;
        if (j >= 0 && j < m) M.add(i, j, N[a]! * N[bb]!);
      }
    }
  }
  smoothRun(
    M,
    rhs,
    n,
    STEP_RAILS_SMOOTH * (M.diagMax() || 1),
    (k) => (k === 0 || k === n - 1 ? -1 : k - 1),
    (k, c) => out[k * dim + c]!,
  );
  M.solve(rhs);
  for (let i = 0; i < m; i++) for (let c = 0; c < dim; c++) out[(i + 1) * dim + c] = rhs[c]![i]!;
  return out;
}

/** Evaluates a polynomial curve (controls stride `dim`) at t into `out`. */
function curveAt(
  b: ClampedBasis,
  pts: ArrayLike<number>,
  dim: number,
  t: number,
  out: Float64Array,
): void {
  const N = new Float64Array(P + 1);
  const i0 = basisAt(b, t, N);
  for (let c = 0; c < dim; c++) {
    let s = 0;
    for (let a = 0; a <= P; a++) s += N[a]! * pts[(i0 + a) * dim + c]!;
    out[c] = s;
  }
}

/** A polynomial surface patch: bases and control points (u-major, stride 3). */
interface Patch {
  readonly u: ClampedBasis;
  readonly v: ClampedBasis;
  readonly pts: Float64Array;
}

const NU = new Float64Array(P + 1);
const NV = new Float64Array(P + 1);

function patchAt(s: Patch, u: number, v: number, out: Float64Array): void {
  const i0 = basisAt(s.u, u, NU);
  const j0 = basisAt(s.v, v, NV);
  const nv = s.v.count;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let a = 0; a <= P; a++) {
    for (let b = 0; b <= P; b++) {
      const w = NU[a]! * NV[b]!;
      const o = ((i0 + a) * nv + j0 + b) * 3;
      x += w * s.pts[o]!;
      y += w * s.pts[o + 1]!;
      z += w * s.pts[o + 2]!;
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/** Breaks positions: `fracs` of every span, and the last break when `last`. */
function positions(breaks: readonly number[], fracs: readonly number[], last: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    for (const f of fracs) out.push(breaks[i]! + f * (breaks[i + 1]! - breaks[i]!));
  }
  if (last) out.push(breaks[breaks.length - 1]!);
  return out;
}

const FIT_FRACS = Array.from({ length: STEP_FIT_SAMPLES }, (_, i) => i / STEP_FIT_SAMPLES);
const CHECK_FRACS = Array.from(
  { length: STEP_CHECK_SAMPLES },
  (_, i) => (i + 0.5) / STEP_CHECK_SAMPLES,
);
const EDGE_FIT_FRACS = Array.from(
  { length: STEP_RAILS_EDGE_FIT },
  (_, i) => i / STEP_RAILS_EDGE_FIT,
);
const EDGE_CHECK_FRACS = Array.from(
  { length: STEP_RAILS_EDGE_CHECK },
  (_, i) => (i + 0.5) / STEP_RAILS_EDGE_CHECK,
);
const CROSS_FRACS = Array.from(
  { length: STEP_RAILS_CROSS_SAMPLES },
  (_, i) => i / STEP_RAILS_CROSS_SAMPLES,
);

/** The span of `breaks` holding `p`. */
function spanIndex(breaks: readonly number[], p: number): number {
  let lo = 0;
  let hi = breaks.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (breaks[m]! <= p) lo = m;
    else hi = m;
  }
  return lo;
}

/** Bisects the marked spans of `breaks` in place; returns how many were added. */
function bisect(breaks: number[], spans: ReadonlySet<number>): number {
  const out: number[] = [];
  let added = 0;
  for (let i = 0; i < breaks.length; i++) {
    out.push(breaks[i]!);
    if (i + 1 < breaks.length && spans.has(i) && breaks[i + 1]! - breaks[i]! > 2 * STEP_MIN_SPAN) {
      out.push(0.5 * (breaks[i]! + breaks[i + 1]!));
      added++;
    }
  }
  breaks.length = 0;
  breaks.push(...out);
  return added;
}

// --- the panels -----------------------------------------------------------------------------

/** Sorted x where the closed polygon (`xs`, `ys`) crosses the line y = `y`. */
function rowCrossings(xs: Float64Array, ys: Float64Array, y: number): number[] {
  const n = xs.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    const ya = ys[i]!;
    const yb = ys[k]!;
    if (ya > y !== yb > y) out.push(xs[i]! + ((y - ya) / (yb - ya)) * (xs[k]! - xs[i]!));
  }
  return out.sort((a, b) => a - b);
}

/** Whether x lies inside, given a row's sorted crossings (even-odd). */
function insideRow(cross: readonly number[], x: number): boolean {
  let c = 0;
  while (c < cross.length && cross[c]! < x) c++;
  return c % 2 === 1;
}

/** A panel's height at (x, y): the deck, or the bottom with its relief at full value. */
function panelHeight(panels: Panels, which: 0 | 1): (x: number, y: number) => number {
  const g = new Float64Array(6);
  const lift = new Float64Array(3);
  const relief = which === 1 ? panels.relief : undefined;
  const base =
    panels.both !== undefined
      ? (x: number, y: number): number => {
          panels.both!(x, y, g);
          return g[3 * which]!;
        }
      : which === 0
        ? panels.deck
        : panels.bottom;
  if (relief === undefined) return base;
  return (x, y) => {
    relief(x, y, lift);
    return base(x, y) + lift[0]!;
  };
}

/** One panel's fit: its breaks, the height field, and what it reached. */
interface PanelFit {
  readonly xb: number[];
  readonly yb: number[];
  surface: Patch;
  deviation: number;
}

/** Symmetric breaks over [−h, h] with a break at 0: `half` (from 0 to h) mirrored. */
const mirrorBreaks = (half: readonly number[]): number[] => [
  ...half
    .slice(1)
    .reverse()
    .map((b) => 0 - b),
  ...half,
];

/**
 * Fits the height field `f` on the panel's breaks to the kernel `height` at the data points inside the
 * outline (`outline`), smoothing the control points the data leave free; a mirror board's net is made
 * exactly symmetric. The control points' x and y are the Greville abscissae, so `S(x, y) = (x, y, f)`.
 */
function fitPanel(
  fit: PanelFit,
  height: (x: number, y: number) => number,
  outline: { xs: Float64Array; ys: Float64Array },
  mirror: boolean,
): void {
  const bu = basisOf(fit.xb);
  const bv = basisOf(fit.yb);
  const nu = bu.count;
  const nv = bv.count;
  const n = nu * nv;
  const M = new Banded(n, P * nv + P);
  const rhs = new Float64Array(n);
  const xs = positions(fit.xb, FIT_FRACS, true);
  const ys = positions(fit.yb, FIT_FRACS, true);
  const coef = new Float64Array((P + 1) * (P + 1));
  const idx = new Int32Array((P + 1) * (P + 1));
  const Nx = new Float64Array(P + 1);
  const Ny = new Float64Array(P + 1);
  for (const y of ys) {
    const cross = rowCrossings(outline.xs, outline.ys, y);
    const j0 = basisAt(bv, y, Ny);
    for (const x of xs) {
      if (!insideRow(cross, x)) continue;
      const z = height(x, y);
      const i0 = basisAt(bu, x, Nx);
      let q = 0;
      for (let a = 0; a <= P; a++) {
        for (let b = 0; b <= P; b++) {
          coef[q] = Nx[a]! * Ny[b]!;
          idx[q++] = (i0 + a) * nv + j0 + b;
        }
      }
      for (let p = 0; p < q; p++) {
        rhs[idx[p]!]! += coef[p]! * z;
        for (let r = 0; r <= p; r++) M.add(idx[p]!, idx[r]!, coef[p]! * coef[r]!);
      }
    }
  }
  const lambda = STEP_RAILS_SMOOTH * (M.diagMax() || 1);
  for (let j = 0; j < nv; j++) {
    smoothRun(
      M,
      [rhs],
      nu,
      lambda,
      (k) => k * nv + j,
      () => null,
    );
  }
  for (let i = 0; i < nu; i++) {
    smoothRun(
      M,
      [rhs],
      nv,
      lambda,
      (k) => i * nv + k,
      () => null,
    );
  }
  M.solve([rhs]);
  const greville = (b: ClampedBasis): Float64Array => {
    const g = new Float64Array(b.count);
    for (let i = 0; i < b.count; i++) {
      let s = 0;
      for (let k = 1; k <= P; k++) s += b.knots[i + k]!;
      g[i] = s / P;
    }
    return g;
  };
  const gx = greville(bu);
  const gy = greville(bv);
  if (mirror) {
    for (let j = 0; j < nv; j++) gy[nv - 1 - j] = j < nv - 1 - j ? 0 - gy[j]! : gy[nv - 1 - j]!;
    if (nv % 2 === 1) gy[(nv - 1) / 2] = 0;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv - 1 - j; j++) {
        const m = 0.5 * (rhs[i * nv + j]! + rhs[i * nv + nv - 1 - j]!);
        rhs[i * nv + j] = m;
        rhs[i * nv + nv - 1 - j] = m;
      }
    }
  }
  const pts = new Float64Array(n * 3);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const o = (i * nv + j) * 3;
      pts[o] = gx[i]!;
      pts[o + 1] = gy[j]!;
      pts[o + 2] = rhs[i * nv + j]!;
    }
  }
  fit.surface = { u: bu, v: bv, pts };
}

/**
 * Measures a panel on the dense grid inside its band edge (`rim`) and marks the spans to bisect: a
 * cell's miss is put down to x, y or both by the fourth differences of the kernel's own samples along
 * each, as `step.ts` does.
 */
function measurePanel(
  fit: PanelFit,
  height: (x: number, y: number) => number,
  rim: { xs: Float64Array; ys: Float64Array },
  limit: number,
  marks: { x: Set<number>; y: Set<number> },
): number {
  const S = STEP_CHECK_SAMPLES;
  const xs = positions(fit.xb, CHECK_FRACS, false);
  const ys = positions(fit.yb, CHECK_FRACS, false);
  const nx = xs.length;
  const ny = ys.length;
  const K = new Float64Array(nx * ny).fill(NaN);
  const D = new Float64Array(nx * ny);
  const p = new Float64Array(3);
  let worst = 0;
  for (let j = 0; j < ny; j++) {
    const cross = rowCrossings(rim.xs, rim.ys, ys[j]!);
    for (let i = 0; i < nx; i++) {
      if (!insideRow(cross, xs[i]!)) continue;
      const z = height(xs[i]!, ys[j]!);
      patchAt(fit.surface, xs[i]!, ys[j]!, p);
      K[i * ny + j] = z;
      D[i * ny + j] = Math.abs(p[2]! - z);
      worst = Math.max(worst, D[i * ny + j]!);
    }
  }
  // the rim itself, where the strips start: a miss there marks its cell both ways
  for (let k = 0; k < rim.xs.length; k++) {
    const x = rim.xs[k]!;
    const y = rim.ys[k]!;
    patchAt(fit.surface, x, y, p);
    const d = Math.abs(p[2]! - height(x, y));
    worst = Math.max(worst, d);
    if (d > limit) {
      marks.x.add(spanIndex(fit.xb, x));
      marks.y.add(spanIndex(fit.yb, y));
    }
  }
  const gain = S ** 4 / 384;
  const d4 = (i: number, j: number, di: number, dj: number): number => {
    const c = [1, -4, 6, -4, 1];
    let s = 0;
    for (let k = 0; k < 5; k++) s += c[k]! * K[(i + k * di) * ny + j + k * dj]!;
    return Number.isNaN(s) ? 0 : Math.abs(s);
  };
  for (let a = 0; a + 1 < fit.xb.length; a++) {
    for (let b = 0; b + 1 < fit.yb.length; b++) {
      let miss = 0;
      for (let i = a * S; i < (a + 1) * S; i++) {
        for (let j = b * S; j < (b + 1) * S; j++) miss = Math.max(miss, D[i * ny + j]!);
      }
      if (miss <= limit) continue;
      let pu = 0;
      let pv = 0;
      for (let i = a * S; i + 4 < (a + 1) * S; i++) {
        for (let j = b * S; j < (b + 1) * S; j++) pu = Math.max(pu, gain * d4(i, j, 1, 0));
      }
      for (let j = b * S; j + 4 < (b + 1) * S; j++) {
        for (let i = a * S; i < (a + 1) * S; i++) pv = Math.max(pv, gain * d4(i, j, 0, 1));
      }
      const none = pu === 0 && pv === 0;
      if (none || pu >= STEP_DIRECTION_SHARE * pv) marks.x.add(a);
      if (none || pv >= STEP_DIRECTION_SHARE * pu) marks.y.add(b);
    }
  }
  return worst;
}

// --- places on the loop and the splits -----------------------------------------------------

/** A place on the loop with the rail's section there, and its arc length (unwrapped along a walk). */
interface Place {
  readonly at: RailPlace;
  readonly section: RailSection;
  /** Position in sample index space: sample `i` at `i`, a place between samples at `i + f`. */
  readonly pos: number;
}

/** The loop and what a place on it needs. */
interface Ring {
  readonly built: BuiltRails;
  readonly strips: RailStrips;
  readonly samples: readonly Place[];
  readonly n: number;
  readonly perimeter: number;
}

/** Arc length at a position in sample index space (unwrapped: one perimeter per lap). */
function arcAt(ring: Ring, pos: number): number {
  const { n } = ring;
  const lap = Math.floor(pos / n);
  const q = pos - lap * n;
  const i = Math.floor(q);
  const f = q - i;
  const s = ring.built.loop.s;
  return lap * ring.perimeter + s[i]! + f * (s[i + 1]! - s[i]!);
}

/** The place at fraction `f` from sample `i` to the next, read linearly (the normal renormalised). */
function placeBetween(ring: Ring, i: number, f: number, onAxis: boolean): Place {
  const { loop, laws } = ring.built;
  const k = (i + 1) % ring.n;
  const lerp = (a: ArrayLike<number>): number => a[i]! + f * (a[k]! - a[i]!);
  let nx = lerp(loop.nx);
  let ny = lerp(loop.ny);
  const l = Math.hypot(nx, ny);
  nx /= l;
  ny /= l;
  let y = lerp(loop.y);
  if (onAxis) {
    // a mirror board's place on the stringer: on y = 0, its normal along x, as the board is symmetric
    y = 0;
    nx = nx < 0 ? -1 : 1;
    ny = 0;
  }
  const at: RailPlace = {
    x: lerp(loop.x),
    y,
    nx,
    ny,
    deckWidth: lerp(laws.deckWidth),
    tuckWidth: lerp(laws.tuckWidth),
    deckRho: lerp(laws.deckRho),
    tuckRho: lerp(laws.tuckRho),
    apex: lerp(laws.apex),
    deckEdge: lerp(laws.deckEdge),
    bottomEdge: lerp(laws.bottomEdge),
  };
  return { at, section: ring.strips.section(at), pos: i + f };
}

/**
 * The place halfway between two places of a stretch, read linearly between them (the normal
 * renormalised): the kernel's section where its mesh has none, and never across a split, where the
 * kernel's own laws may turn.
 */
function halfway(ring: Ring, a: Place, b: Place): Place {
  const mix = (p: number, q: number): number => 0.5 * (p + q);
  let nx = mix(a.at.nx, b.at.nx);
  let ny = mix(a.at.ny, b.at.ny);
  const l = Math.hypot(nx, ny);
  nx /= l;
  ny /= l;
  const at: RailPlace = {
    x: mix(a.at.x, b.at.x),
    y: mix(a.at.y, b.at.y),
    nx,
    ny,
    deckWidth: mix(a.at.deckWidth, b.at.deckWidth),
    tuckWidth: mix(a.at.tuckWidth, b.at.tuckWidth),
    deckRho: mix(a.at.deckRho, b.at.deckRho),
    tuckRho: mix(a.at.tuckRho, b.at.tuckRho),
    apex: mix(a.at.apex, b.at.apex),
    deckEdge: mix(a.at.deckEdge, b.at.deckEdge),
    bottomEdge: mix(a.at.bottomEdge, b.at.bottomEdge),
  };
  return { at, section: ring.strips.section(at), pos: mix(a.pos, b.pos) };
}

/**
 * Where the loop is split, in loop order from the nose: at the stringer's two crossings and at both ends of
 * every corner arc; a corner's end closer than {@link STEP_RAILS_SPLIT_GAP} samples to a split already
 * made is dropped. On a mirror board a crossing is one place on y = 0 (the halves are mirrors). On an
 * asymmetric board each side has its own rail laws, which change between the last sample of one side
 * and the first of the other (the plus side's from y = 0); the kernel's mesh bridges them with one
 * quad, so both samples are splits and the stretch between them is a face of its own.
 */
function splitPositions(ring: Ring, mirror: boolean): { splits: Place[]; tail: number } {
  const { loop } = ring.built;
  const n = ring.n;
  const crossings: Place[][] = [];
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    const a = loop.y[i]!;
    const b = loop.y[k]!;
    if (mirror) {
      if (a === 0) crossings.push([placeBetween(ring, i, 0, true)]);
      else if (b !== 0 && a > 0 !== b > 0)
        crossings.push([placeBetween(ring, i, a / (a - b), true)]);
    } else if (a >= 0 !== b >= 0) {
      crossings.push([ring.samples[i]!, ring.samples[k]!]);
    }
  }
  if (crossings.length !== 2) {
    throw new Error(`the outline crosses the stringer ${crossings.length} times, not twice`);
  }
  const noseFirst = crossings[0]![0]!.at.x > crossings[1]![0]!.at.x;
  const nose = noseFirst ? crossings[0]! : crossings[1]!;
  const tail = noseFirst ? crossings[1]! : crossings[0]!;
  // both ends of every corner arc: its first sample, and the first sample after it
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n;
    const inArc = loop.corner[i] !== 0;
    const wasArc = loop.corner[prev] !== 0;
    if (inArc !== wasArc || (inArc && loop.seg[i] !== loop.seg[prev])) ends.push(i);
  }
  const near = (a: number, b: number): boolean => {
    const d = Math.abs(a - b);
    return Math.min(d, n - d) < STEP_RAILS_SPLIT_GAP;
  };
  const all: Place[] = [...nose, ...tail];
  for (const i of ends) {
    if (all.every((p) => !near(p.pos, i))) all.push(ring.samples[i]!);
  }
  // in loop order from the nose
  const from = nose[0]!.pos;
  const ahead = (p: Place): number => (p.pos - from + n) % n;
  all.sort((a, b) => ahead(a) - ahead(b));
  return { splits: all, tail: all.indexOf(tail[0]!) };
}

// --- strips ---------------------------------------------------------------------------------

/** A stretch of the rail between two splits, fitted once (a mirror board's minus half is mirrored). */
interface Stretch {
  readonly from: Place;
  readonly to: Place;
  /** The loop samples strictly between the splits, which the fit reads, with their u. */
  readonly inner: readonly Place[];
  readonly us: readonly number[];
  /** The places the fit is checked at: the splits, the samples, and the kernel's section halfway between each two (`halfway`). */
  readonly checks: readonly { readonly p: Place; readonly u: number }[];
  /**
   * The knots along the stretch: `coarse` for the curves fitted to loop samples (the band edges' plan
   * curves, the apex line), split only while a span holds loop samples; `breaks` for the faces, which
   * also split where a band edge's height leaves its panel, and which always refine `coarse`.
   */
  readonly coarse: number[];
  readonly breaks: number[];
}

function stretchOf(ring: Ring, from: Place, to: Place): Stretch {
  const n = ring.n;
  let end = to.pos;
  while (end <= from.pos) end += n;
  const s0 = arcAt(ring, from.pos);
  const s1 = arcAt(ring, end);
  const uOf = (pos: number): number => (arcAt(ring, pos) - s0) / (s1 - s0);
  const inner: Place[] = [];
  const us: number[] = [];
  for (let k = Math.floor(from.pos) + 1; k < end; k++) {
    inner.push({ ...ring.samples[k % n]!, pos: k });
    us.push(uOf(k));
  }
  const fitted = [from, ...inner, { ...to, pos: end }];
  const fittedUs = [0, ...us, 1];
  const checks: { p: Place; u: number }[] = [];
  for (let q = 0; q < fitted.length; q++) {
    checks.push({ p: fitted[q]!, u: fittedUs[q]! });
    if (q + 1 < fitted.length) {
      const p = halfway(ring, fitted[q]!, fitted[q + 1]!);
      checks.push({ p, u: uOf(p.pos) });
    }
  }
  const spans = Math.max(1, Math.ceil((s1 - s0) / STEP_RAILS_STRIP_START));
  const breaks = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  return { from, to: { ...to, pos: end }, inner, us, checks, coarse: breaks.slice(), breaks };
}

/**
 * Splits a stretch where its strip missed (`marks`, spans of `breaks`): the span of `coarse` under each,
 * unless it holds fewer than {@link STEP_RAILS_SPAN_DATA} loop samples (the fit could not place it), and
 * the new knot goes into `breaks` too. Returns the knots added.
 */
function splitCoarse(st: Stretch, marks: ReadonlySet<number>): number {
  const spans = new Set<number>();
  for (const a of marks) {
    const c = spanIndex(st.coarse, 0.5 * (st.breaks[a]! + st.breaks[a + 1]!));
    const lo = st.coarse[c]!;
    const hi = st.coarse[c + 1]!;
    let inside = 0;
    for (const u of st.us) if (u >= lo && u < hi) inside++;
    if (inside >= STEP_RAILS_SPAN_DATA) spans.add(c);
  }
  const before = st.coarse.length;
  bisect(st.coarse, spans);
  const known = new Set(st.breaks);
  const added = st.coarse.filter((b) => !known.has(b));
  if (added.length > 0) {
    st.breaks.push(...added);
    st.breaks.sort((x, y) => x - y);
  }
  return st.coarse.length - before;
}

/** A curve fitted on a coarser basis, put on `fine` (a refinement of it): sampled and fitted again, exact to rounding. */
function refined(
  coarse: ClampedBasis,
  pts: Float64Array,
  dim: number,
  fine: ClampedBasis,
  breaks: readonly number[],
): Float64Array {
  if (fine.count === coarse.count) return pts;
  const ts = positions(breaks, EDGE_FIT_FRACS, true);
  const vals = new Float64Array(ts.length * dim);
  const o = new Float64Array(dim);
  ts.forEach((t, k) => {
    curveAt(coarse, pts, dim, t, o);
    vals.set(o, dim * k);
  });
  return fitCurve(fine, ts, vals, dim, pts.subarray(0, dim), pts.subarray(pts.length - dim));
}

/** A strip point of the kernel: side 0 the deck blend, 1 the tuck. */
function kernelPoint(ring: Ring, p: Place, side: 0 | 1, t: number, out: Float64Array): void {
  ring.strips.point(p.at, p.section, side, t, out);
}

/** Everything fitted for one stretch: its basis, its three rows and its two strip patches. */
interface StretchFit {
  readonly u: ClampedBasis;
  /** Band edges (deck, bottom) and the apex line: controls stride 3. */
  readonly edge: readonly [Float64Array, Float64Array];
  readonly apex: Float64Array;
  readonly strip: readonly [Patch, Patch];
}

/** The three vertices of a split: deck band edge, apex, bottom band edge (the band edges on their panels). */
function vertexOf(p: Place, side: 0 | 1, panel: Patch): Float64Array {
  const h = side === 0 ? p.section.deck : p.section.tuck;
  const q = new Float64Array(3);
  patchAt(panel, h.qx, h.qy, q);
  return Float64Array.of(h.qx, h.qy, q[2]!);
}
const apexOf = (p: Place): Float64Array => Float64Array.of(p.at.x, p.at.y, p.section.apex);

/** The cross curve of a split on one side: the kernel's section fitted in the across basis, ends fixed. */
function fitCross(
  ring: Ring,
  p: Place,
  side: 0 | 1,
  v: ClampedBasis,
  vb: readonly number[],
  start: Float64Array,
  end: Float64Array,
): Float64Array {
  const ts = positions(vb, CROSS_FRACS, true);
  const vals = new Float64Array(ts.length * 3);
  const q = new Float64Array(3);
  ts.forEach((t, k) => {
    kernelPoint(ring, p, side, t, q);
    vals.set(q, 3 * k);
  });
  return fitCurve(v, ts, vals, 3, start, end);
}

/** A band edge's 3D curve: its plan curve fitted to the kernel's band edge, its height to the panel under it. */
function fitEdge(
  st: Stretch,
  u: ClampedBasis,
  side: 0 | 1,
  panel: Patch,
  start: Float64Array,
  end: Float64Array,
): Float64Array {
  const xy = new Float64Array(st.inner.length * 2);
  st.inner.forEach((p, k) => {
    const h = side === 0 ? p.section.deck : p.section.tuck;
    xy[2 * k] = h.qx;
    xy[2 * k + 1] = h.qy;
  });
  const c = basisOf(st.coarse);
  const plan = refined(c, fitCurve(c, st.us, xy, 2, start.subarray(0, 2), end.subarray(0, 2)), 2, u, st.breaks); // prettier-ignore
  const ts = positions(st.breaks, EDGE_FIT_FRACS, true);
  const zs = new Float64Array(ts.length);
  const q = new Float64Array(3);
  const at = new Float64Array(2);
  ts.forEach((t, k) => {
    curveAt(u, plan, 2, t, at);
    patchAt(panel, at[0]!, at[1]!, q);
    zs[k] = q[2]!;
  });
  const z = fitCurve(u, ts, zs, 1, start.subarray(2), end.subarray(2));
  const out = new Float64Array(u.count * 3);
  for (let i = 0; i < u.count; i++) {
    out[3 * i] = plan[2 * i]!;
    out[3 * i + 1] = plan[2 * i + 1]!;
    out[3 * i + 2] = z[i]!;
  }
  return out;
}

/** The largest gap between a band edge's height and its panel's along it, and the spans that miss `gap`. */
function edgeGapOf(
  st: Stretch,
  u: ClampedBasis,
  edge: Float64Array,
  panel: Patch,
  gap: number,
  marks: Set<number>,
): number {
  const ts = positions(st.breaks, EDGE_CHECK_FRACS, false);
  const e = new Float64Array(3);
  const q = new Float64Array(3);
  let worst = 0;
  for (const t of ts) {
    curveAt(u, edge, 3, t, e);
    patchAt(panel, e[0]!, e[1]!, q);
    const d = Math.abs(q[2]! - e[2]!);
    worst = Math.max(worst, d);
    if (d > gap) marks.add(spanIndex(st.breaks, t));
  }
  return worst;
}

/**
 * The strip patch on bases `u` × `v` closest (least squares) to the kernel's strip at the stretch's
 * samples and the across parameters `ts`, with its four boundary rows and columns fixed. The data are a
 * full grid, so the solve separates: `(Nuᵀ Nu) Y (Nvᵀ Nv) = Nuᵀ R Nv` over the interior control points,
 * `R` the data less the boundary's part.
 */
function fitStrip(
  ring: Ring,
  st: Stretch,
  side: 0 | 1,
  u: ClampedBasis,
  v: ClampedBasis,
  vb: readonly number[],
  rows: readonly [Float64Array, Float64Array],
  cols: readonly [Float64Array, Float64Array],
): Patch {
  const nu = u.count;
  const nv = v.count;
  const pts = new Float64Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) {
    for (let c = 0; c < 3; c++) {
      pts[i * nv * 3 + c] = rows[0][3 * i + c]!;
      pts[(i * nv + nv - 1) * 3 + c] = rows[1][3 * i + c]!;
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let c = 0; c < 3; c++) {
      pts[j * 3 + c] = cols[0][3 * j + c]!;
      pts[((nu - 1) * nv + j) * 3 + c] = cols[1][3 * j + c]!;
    }
  }
  if (nu < 3 || nv < 3) return { u, v, pts };
  const us = [0, ...st.us, 1];
  const places = [st.from, ...st.inner, st.to];
  const ts = positions(vb, FIT_FRACS, true);
  // The collocation rows (first index, values), then the smoothing rows: √λ times the second
  // differences of the control points, with no data. Appended to both directions the objective stays
  // ‖Nu′ X Nv′ᵀ − D′‖², so the solve still separates, and the smoothing reaches the boundary controls.
  type Row = { readonly i0: number; readonly N: Float64Array };
  const rowsOf = (b: ClampedBasis, params: readonly number[]): Row[] => {
    const out: Row[] = params.map((t) => {
      const N = new Float64Array(P + 1);
      return { i0: basisAt(b, t, N), N };
    });
    const w = Math.sqrt(STEP_RAILS_SMOOTH * params.length);
    for (let k = 0; k + 2 < b.count; k++) out.push({ i0: k, N: Float64Array.of(w, -2 * w, w) });
    return out;
  };
  const ns = us.length;
  const nt = ts.length;
  const Ru = rowsOf(u, us);
  const Rv = rowsOf(v, ts);
  const q = new Float64Array(3);
  const boundary = (i: number, j: number): boolean =>
    i === 0 || i === nu - 1 || j === 0 || j === nv - 1;
  // R = D′ − Nu′ X_B Nv′ᵀ, per coordinate (D′ is the kernel's points, zero on the smoothing rows)
  const R = new Float64Array(Ru.length * Rv.length * 3);
  for (let a = 0; a < Ru.length; a++) {
    for (let b = 0; b < Rv.length; b++) {
      if (a < ns && b < nt) kernelPoint(ring, places[a]!, side, ts[b]!, q);
      else q.fill(0);
      const { i0, N } = Ru[a]!;
      const { i0: j0, N: M } = Rv[b]!;
      for (let c = 0; c < 3; c++) {
        let s = q[c]!;
        for (let x = 0; x < N.length; x++) {
          for (let y = 0; y < M.length; y++) {
            const i = i0 + x;
            const j = j0 + y;
            if (boundary(i, j)) s -= N[x]! * M[y]! * pts[(i * nv + j) * 3 + c]!;
          }
        }
        R[(a * Rv.length + b) * 3 + c] = s;
      }
    }
  }
  const mi = nu - 2;
  const mj = nv - 2;
  /** Nᵀ N over the interior control points. */
  const gram = (rows: readonly Row[], m: number): Banded => {
    const G = new Banded(m, P);
    for (const { i0, N } of rows) {
      for (let x = 0; x < N.length; x++) {
        const i = i0 + x - 1;
        if (i < 0 || i >= m) continue;
        for (let y = 0; y <= x; y++) {
          const j = i0 + y - 1;
          if (j >= 0 && j < m) G.add(i, j, N[x]! * N[y]!);
        }
      }
    }
    return G;
  };
  // T = Nu_I′ᵀ R Nv_I′, per coordinate (mi × mj)
  const T = Array.from({ length: 3 }, () => new Float64Array(mi * mj));
  for (let a = 0; a < Ru.length; a++) {
    const { i0, N } = Ru[a]!;
    for (let b = 0; b < Rv.length; b++) {
      const { i0: j0, N: M } = Rv[b]!;
      for (let x = 0; x < N.length; x++) {
        const i = i0 + x - 1;
        if (i < 0 || i >= mi) continue;
        for (let y = 0; y < M.length; y++) {
          const j = j0 + y - 1;
          if (j < 0 || j >= mj) continue;
          const w = N[x]! * M[y]!;
          for (let c = 0; c < 3; c++) T[c]![i * mj + j]! += w * R[(a * Rv.length + b) * 3 + c]!;
        }
      }
    }
  }
  // Y = Gu⁻¹ T Gv⁻¹: columns through Gu, then rows through Gv
  const cols2: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    for (let j = 0; j < mj; j++) {
      const col = new Float64Array(mi);
      for (let i = 0; i < mi; i++) col[i] = T[c]![i * mj + j]!;
      cols2.push(col);
    }
  }
  gram(Ru, mi).solve(cols2);
  const rows2: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < mi; i++) {
      const row = new Float64Array(mj);
      for (let j = 0; j < mj; j++) row[j] = cols2[c * mj + j]![i]!;
      rows2.push(row);
    }
  }
  gram(Rv, mj).solve(rows2);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < mi; i++) {
      for (let j = 0; j < mj; j++) pts[((i + 1) * nv + j + 1) * 3 + c] = rows2[c * mi + i]![j]!;
    }
  }
  return { u, v, pts };
}

/**
 * The distance from `q` to the patch's nearest point, by Gauss-Newton from (u, v) with the derivatives
 * by central differences, the parameters held in the patch's domain.
 */
function nearest(patch: Patch, u: number, v: number, q: Float64Array): number {
  const h = STEP_RAILS_NEWTON_STEP;
  const f = new Float64Array(3);
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  let best = Infinity;
  for (let it = 0; it < STEP_RAILS_NEWTON_STEPS; it++) {
    patchAt(patch, u, v, f);
    const r = [f[0]! - q[0]!, f[1]! - q[1]!, f[2]! - q[2]!];
    best = Math.min(best, Math.hypot(r[0]!, r[1]!, r[2]!));
    const du = [0, 0, 0];
    const dv = [0, 0, 0];
    patchAt(patch, clamp(u + h), v, a);
    patchAt(patch, clamp(u - h), v, b);
    const su = clamp(u + h) - clamp(u - h);
    for (let c = 0; c < 3; c++) du[c] = (a[c]! - b[c]!) / su;
    patchAt(patch, u, clamp(v + h), a);
    patchAt(patch, u, clamp(v - h), b);
    const sv = clamp(v + h) - clamp(v - h);
    for (let c = 0; c < 3; c++) dv[c] = (a[c]! - b[c]!) / sv;
    const dot = (x: number[], y: number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
    const A = dot(du, du);
    const B = dot(du, dv);
    const C = dot(dv, dv);
    const g0 = dot(du, r);
    const g1 = dot(dv, r);
    const det = A * C - B * B;
    if (!(det > 0)) break;
    u = clamp(u - (C * g0 - B * g1) / det);
    v = clamp(v - (A * g1 - B * g0) / det);
  }
  patchAt(patch, u, v, f);
  return Math.min(best, Math.hypot(f[0]! - q[0]!, f[1]! - q[1]!, f[2]! - q[2]!));
}

/**
 * Measures one strip patch against the kernel: at every place of the stretch (its samples and the kernel's
 * section halfway between them) at across-parameters between the fit's, and along its two rows. Marks
 * the spans to bisect; returns the largest distance.
 */
function measureStrip(
  ring: Ring,
  st: Stretch,
  side: 0 | 1,
  patch: Patch,
  panel: Patch,
  vb: readonly number[],
  limit: number,
  uMarks: Set<number>,
  vMarks: Set<number>,
): number {
  const checks = st.checks;
  const ts = [0, ...positions(vb, CHECK_FRACS, false), 1];
  const fitTs = positions(vb, FIT_FRACS, true);
  const q = new Float64Array(3);
  const f = new Float64Array(3);
  let worst = 0;
  const section = new Float64Array(fitTs.length * 3);
  for (const { p, u } of checks) {
    let miss = 0;
    // what the strip can be blamed for: on its band edge row the distance to the band edge on the fitted
    // panel (the row is fixed there; the panel's own miss is the panel's to refine)
    let own = 0;
    for (const t of ts) {
      kernelPoint(ring, p, side, t, q);
      patchAt(patch, u, t, f);
      let d = Math.hypot(q[0]! - f[0]!, q[1]! - f[1]!, q[2]! - f[2]!);
      // the same parameter is a first guess; past the limit, the distance is to the nearest point
      if (d > limit) d = nearest(patch, u, t, q);
      miss = Math.max(miss, d);
      if (t === 0) {
        const r = new Float64Array(3);
        patchAt(panel, q[0]!, q[1]!, r);
        r[0] = q[0]!;
        r[1] = q[1]!;
        let e = Math.hypot(r[0]! - f[0]!, r[1]! - f[1]!, r[2]! - f[2]!);
        if (e > limit) e = nearest(patch, u, t, r);
        own = Math.max(own, e);
      } else own = Math.max(own, d);
    }
    worst = Math.max(worst, miss);
    if (own <= limit) continue;
    // is the across basis enough for this one section? fit it alone, ends held, and look
    fitTs.forEach((t, k) => {
      kernelPoint(ring, p, side, t, q);
      section.set(q, 3 * k);
    });
    const a0 = new Float64Array(3);
    const a1 = new Float64Array(3);
    kernelPoint(ring, p, side, 0, a0);
    kernelPoint(ring, p, side, 1, a1);
    const alone = fitCurve(patch.v, fitTs, section, 3, a0, a1);
    let acrossMiss = 0;
    for (const t of ts) {
      kernelPoint(ring, p, side, t, q);
      curveAt(patch.v, alone, 3, t, f);
      const d = Math.hypot(q[0]! - f[0]!, q[1]! - f[1]!, q[2]! - f[2]!);
      if (d > STEP_RAILS_ACROSS_SHARE * limit) vMarks.add(spanIndex(vb as number[], t));
      acrossMiss = Math.max(acrossMiss, d);
    }
    if (acrossMiss <= STEP_RAILS_ACROSS_SHARE * limit) uMarks.add(spanIndex(st.breaks, u));
  }
  return worst;
}

// --- topology -------------------------------------------------------------------------------

const surfaceOf = (p: Patch): NurbsSurface => makeSurface({ u: p.u, v: p.v, points: p.pts });
const curve3 = (b: ClampedBasis, pts: Float64Array): ClampedCurve<3> =>
  makeCurve({ dim: 3, basis: b, points: pts }) as ClampedCurve<3>;
const plan2 = (b: ClampedBasis, pts: Float64Array): ClampedCurve<2> => {
  const xy = new Float64Array(b.count * 2);
  for (let i = 0; i < b.count; i++) {
    xy[2 * i] = pts[3 * i]!;
    xy[2 * i + 1] = pts[3 * i + 1]!;
  }
  return makeCurve({ dim: 2, basis: b, points: xy }) as ClampedCurve<2>;
};
/** The y-mirror of control points (stride 3): `0 − y`, so a zero stays +0. */
const mirrored = (pts: Float64Array): Float64Array => {
  const out = pts.slice();
  for (let k = 1; k < out.length; k += 3) out[k] = 0 - out[k]!;
  return out;
};
const mirrorPatch = (p: Patch): Patch => ({ u: p.u, v: p.v, pts: mirrored(p.pts) });

/** One face of the ring of strips, in loop order: what it is fitted to and which way its `u` runs. */
interface RingFace {
  readonly fit: StretchFit;
  /** True where the face's `u` runs against the loop (a mirror board's minus half). */
  readonly reversed: boolean;
}

/** One split of the ring: its cross curves (deck blend, tuck) and its three vertices. */
interface RingSplit {
  readonly cross: readonly [Float64Array, Float64Array];
}

/** Whether a patch's own normal (Su × Sv) points out of the board, judged at its middle. */
function pointsOut(p: Patch, outward: readonly [number, number, number]): boolean {
  const e = 1 / 4;
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const c = new Float64Array(3);
  const d = new Float64Array(3);
  patchAt(p, 0.5 - e, 0.5, a);
  patchAt(p, 0.5 + e, 0.5, b);
  patchAt(p, 0.5, 0.5 - e, c);
  patchAt(p, 0.5, 0.5 + e, d);
  const su = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const sv = [d[0]! - c[0]!, d[1]! - c[1]!, d[2]! - c[2]!];
  const n = [
    su[1]! * sv[2]! - su[2]! * sv[1]!,
    su[2]! * sv[0]! - su[0]! * sv[2]!,
    su[0]! * sv[1]! - su[1]! * sv[0]!,
  ];
  return n[0]! * outward[0] + n[1]! * outward[1] + n[2]! * outward[2] > 0;
}

function assemble(
  deck: NurbsSurface,
  bottom: NurbsSurface,
  faces: readonly RingFace[],
  splits: readonly RingSplit[],
  v: readonly [ClampedBasis, ClampedBasis],
): Brep {
  const N = faces.length;
  const vertices: { point: { x: number; y: number; z: number } }[] = [];
  const pt = (a: Float64Array, i: number) => ({ x: a[3 * i]!, y: a[3 * i + 1]!, z: a[3 * i + 2]! });
  // per split: deck band edge, apex, bottom band edge, from the deck cross curve's ends and the tuck's start
  const vid = splits.map((s) => {
    const nv0 = v[0].count;
    const d = vertices.push({ point: pt(s.cross[0], 0) }) - 1;
    const a = vertices.push({ point: pt(s.cross[0], nv0 - 1) }) - 1;
    const b = vertices.push({ point: pt(s.cross[1], 0) }) - 1;
    return { d, a, b };
  });
  const edges: BrepEdge[] = [];
  const add = (c: ClampedCurve<3>, start: number, end: number): number =>
    edges.push({ curve: c, start, end }) - 1;
  const cross = splits.map((s, j) => ({
    deck: add(curve3(v[0], s.cross[0]), vid[j]!.d, vid[j]!.a),
    tuck: add(curve3(v[1], s.cross[1]), vid[j]!.b, vid[j]!.a),
  }));
  const coedge = (edge: number, sense: boolean, pcurve: ClampedCurve<2>): BrepCoedge => ({
    edge,
    sense,
    pcurve,
    master: 'curve3d',
  });
  const pV0 = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
  const pV1 = line2({ x: 0, y: 1 }, { x: 1, y: 1 });
  const pU0 = line2({ x: 0, y: 0 }, { x: 0, y: 1 });
  const pU1 = line2({ x: 1, y: 0 }, { x: 1, y: 1 });
  const out: BrepFace[] = [];
  const deckTrim: BrepCoedge[] = [];
  const bottomTrim: BrepCoedge[] = [];
  faces.forEach((f, k) => {
    // the splits at the face's u = 0 and u = 1
    const j0 = f.reversed ? (k + 1) % N : k;
    const j1 = f.reversed ? k : (k + 1) % N;
    const u = f.fit.u;
    const eDeck = add(curve3(u, f.fit.edge[0]), vid[j0]!.d, vid[j1]!.d);
    const eTuck = add(curve3(u, f.fit.edge[1]), vid[j0]!.b, vid[j1]!.b);
    const eApex = add(curve3(u, f.fit.apex), vid[j0]!.a, vid[j1]!.a);
    deckTrim.push(coedge(eDeck, !f.reversed, plan2(u, f.fit.edge[0])));
    bottomTrim.push(coedge(eTuck, f.reversed, plan2(u, f.fit.edge[1])));
    for (const side of [0, 1] as const) {
      const patch = f.fit.strip[side];
      const row = side === 0 ? eDeck : eTuck;
      const c0 = side === 0 ? cross[j0]!.deck : cross[j0]!.tuck;
      const c1 = side === 0 ? cross[j1]!.deck : cross[j1]!.tuck;
      // outward: away from the loop in plan, up off the deck blend, down off the tuck
      const mid = new Float64Array(3);
      const edgeMid = new Float64Array(3);
      patchAt(patch, 0.5, 1, mid);
      patchAt(patch, 0.5, 0, edgeMid);
      const outward: [number, number, number] = [
        mid[0]! - edgeMid[0]!,
        mid[1]! - edgeMid[1]!,
        side === 0 ? 1 : -1,
      ];
      const same = pointsOut(patch, outward);
      const coedges = same
        ? [coedge(row, true, pV0), coedge(c1, true, pU1), coedge(eApex, false, pV1), coedge(c0, false, pU0)]
        : [coedge(c0, true, pU0), coedge(eApex, true, pV1), coedge(c1, false, pU1), coedge(row, false, pV0)]; // prettier-ignore
      out.push({ surface: surfaceOf(patch), sameSense: same, outer: { coedges }, holes: [] });
    }
  });
  // the panels: the deck's normal is up, so its loop runs with the loop (counter-clockwise in plan);
  // the bottom's is down, so its loop runs the other way
  out.push({ surface: deck, sameSense: true, outer: { coedges: deckTrim }, holes: [] });
  out.push({
    surface: bottom,
    sameSense: false,
    outer: { coedges: bottomTrim.slice().reverse() },
    holes: [],
  });
  const made = makeBrep({
    vertices,
    edges,
    faces: out,
    shells: [{ faces: out.map((_, i) => i), closed: true }],
    solids: [{ outer: 0 }],
  });
  if (!made.ok) {
    throw new Error(`STEP solid refused: ${made.issues.map((i) => i.message).join('; ')}`);
  }
  return orientBrep(made.value);
}

// --- the solid ------------------------------------------------------------------------------

/**
 * Fits the faces of a built rails board and builds its closed B-rep (module comment). Throws if the
 * outline does not cross the stringer twice or the B-rep is refused.
 */
export function railsSolid(built: BuiltRails, opts: RailsSolidOptions = {}): RailsSolid {
  const tolerance = opts.tolerance ?? STEP_TOLERANCE;
  const limit = STEP_ACCEPT_SHARE * tolerance;
  const maxControls = opts.maxControls ?? STEP_RAILS_MAX_CONTROLS;
  // the minus half is the plus half's mirror only if the board is symmetric and its sides share one rail
  const mirror = built.board.symmetry !== 'asymmetric' && built.board.rails.minus === undefined;
  const mesh = trimMeshOf(built);
  const panels = mesh.panels;
  const strips = railStrips(panels);
  const { loop, laws } = built;
  const n = loop.n;
  const samples: Place[] = [];
  for (let i = 0; i < n; i++) {
    const at: RailPlace = {
      x: loop.x[i]!,
      y: loop.y[i]!,
      nx: loop.nx[i]!,
      ny: loop.ny[i]!,
      deckWidth: laws.deckWidth[i]!,
      tuckWidth: laws.tuckWidth[i]!,
      deckRho: laws.deckRho[i]!,
      tuckRho: laws.tuckRho[i]!,
      apex: laws.apex[i]!,
      deckEdge: laws.deckEdge[i]!,
      bottomEdge: laws.bottomEdge[i]!,
    };
    samples.push({ at, section: strips.section(at), pos: i });
  }
  const ring: Ring = { built, strips, samples, n, perimeter: loop.s[n]! };
  let pass = 0;

  // --- the panels: fit, measure inside the band edge, refine ---
  const rim = (side: 0 | 1) => ({
    xs: Float64Array.from(samples, (p) => (side === 0 ? p.section.deck : p.section.tuck).qx),
    ys: Float64Array.from(samples, (p) => (side === 0 ? p.section.deck : p.section.tuck).qy),
  });
  const rims = [rim(0), rim(1)] as const;
  const outline = { xs: loop.x, ys: loop.y };
  let x0 = Infinity;
  let x1 = -Infinity;
  let yHi = 0;
  let yLo = 0;
  for (const r of rims) {
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, r.xs[i]!);
      x1 = Math.max(x1, r.xs[i]!);
      yHi = Math.max(yHi, r.ys[i]!);
      yLo = Math.min(yLo, r.ys[i]!);
    }
  }
  x0 -= STEP_RAILS_PANEL_MARGIN;
  x1 += STEP_RAILS_PANEL_MARGIN;
  yHi += STEP_RAILS_PANEL_MARGIN;
  yLo -= STEP_RAILS_PANEL_MARGIN;
  if (mirror) {
    yHi = Math.max(yHi, -yLo);
    yLo = 0 - yHi;
  }
  const even = (a: number, b: number, step: number): number[] => {
    const k = Math.max(1, Math.ceil((b - a) / step));
    return Array.from({ length: k + 1 }, (_, i) => (i === k ? b : a + ((b - a) * i) / k));
  };
  const yBreaks = (): number[] =>
    mirror
      ? mirrorBreaks(even(0, yHi, STEP_RAILS_PANEL_START_Y))
      : even(yLo, yHi, STEP_RAILS_PANEL_START_Y);
  const fits: [PanelFit, PanelFit] = [
    { xb: even(x0, x1, STEP_RAILS_PANEL_START_X), yb: yBreaks(), surface: null!, deviation: Infinity }, // prettier-ignore
    { xb: even(x0, x1, STEP_RAILS_PANEL_START_X), yb: yBreaks(), surface: null!, deviation: Infinity }, // prettier-ignore
  ];
  const heights = [panelHeight(panels, 0), panelHeight(panels, 1)] as const;
  let overBudget = false;
  let panelPasses = 0;
  const done = [false, false];
  for (let k = 1; k <= STEP_MAX_PASSES && !(done[0] && done[1]); k++) {
    panelPasses = k;
    opts.onPass?.(++pass);
    for (const side of [0, 1] as const) {
      if (done[side]) continue;
      const fit = fits[side];
      fitPanel(fit, heights[side], outline, mirror);
      const marks = { x: new Set<number>(), y: new Set<number>() };
      fit.deviation = measurePanel(fit, heights[side], rims[side], limit, marks);
      if (fit.deviation <= limit || k === STEP_MAX_PASSES) {
        done[side] = true;
        continue;
      }
      if (mirror) {
        // a symmetric basis stays symmetric: mark the mirror of every y span too
        const m = fit.yb.length - 1;
        for (const b of [...marks.y]) marks.y.add(m - 1 - b);
      }
      const added = bisect(fit.xb, marks.x) + bisect(fit.yb, marks.y);
      if (added === 0) done[side] = true;
    }
    const controls = fits.reduce((s, f) => s + (f.xb.length + 2) * (f.yb.length + 2), 0);
    if (controls > maxControls) {
      overBudget = true;
      break;
    }
  }
  const deckPanel = fits[0].surface;
  const bottomPanel = fits[1].surface;
  const panelPatches = [deckPanel, bottomPanel] as const;

  // --- the strips ---
  const { splits: splitPlaces, tail } = splitPositions(ring, mirror);
  const ringSplits = mirror ? splitPlaces.slice(0, tail + 1) : splitPlaces;
  const stretches: Stretch[] = [];
  const count = mirror ? ringSplits.length - 1 : ringSplits.length;
  for (let k = 0; k < count; k++) {
    stretches.push(stretchOf(ring, ringSplits[k]!, ringSplits[(k + 1) % ringSplits.length]!));
  }
  const vb: [number[], number[]] = [
    even(0, 1, 1 / STEP_RAILS_ACROSS_START),
    even(0, 1, 1 / STEP_RAILS_ACROSS_START),
  ];
  let stretchFits: StretchFit[] = [];
  let crosses: [Float64Array, Float64Array][] = [];
  let stripDeviation = Infinity;
  let edgeGap = Infinity;
  let stripPasses = 0;
  const vertices = ringSplits.map((p) => ({
    deck: vertexOf(p, 0, deckPanel),
    tuck: vertexOf(p, 1, bottomPanel),
    apex: apexOf(p),
  }));
  // one pass at least, so that a solid is built even when the panels already broke the budget
  for (let k = 1; k <= STEP_MAX_PASSES; k++) {
    stripPasses = k;
    opts.onPass?.(++pass);
    const v = [basisOf(vb[0]), basisOf(vb[1])] as const;
    crosses = ringSplits.map((p, j) => [
      fitCross(ring, p, 0, v[0], vb[0], vertices[j]!.deck, vertices[j]!.apex),
      fitCross(ring, p, 1, v[1], vb[1], vertices[j]!.tuck, vertices[j]!.apex),
    ]);
    const vMarks = [new Set<number>(), new Set<number>()] as const;
    let worst = 0;
    let gapWorst = 0;
    let added = 0;
    stretchFits = stretches.map((st, idx) => {
      const j0 = idx;
      const j1 = (idx + 1) % ringSplits.length;
      const u = basisOf(st.breaks);
      const edge = [
        fitEdge(st, u, 0, deckPanel, vertices[j0]!.deck, vertices[j1]!.deck),
        fitEdge(st, u, 1, bottomPanel, vertices[j0]!.tuck, vertices[j1]!.tuck),
      ] as const;
      const apexXyz = new Float64Array(st.inner.length * 3);
      st.inner.forEach((p, q) => apexXyz.set(apexOf(p), 3 * q));
      const c = basisOf(st.coarse);
      const apex = refined(c, fitCurve(c, st.us, apexXyz, 3, vertices[j0]!.apex, vertices[j1]!.apex), 3, u, st.breaks); // prettier-ignore
      const strip = ([0, 1] as const).map(
        (side) =>
        fitStrip(ring, st, side, u, v[side], vb[side], [edge[side], apex], [crosses[j0]![side], crosses[j1]![side]]), // prettier-ignore
      ) as unknown as readonly [Patch, Patch];
      return { u, edge, apex, strip };
    });
    stretches.forEach((st, idx) => {
      const f = stretchFits[idx]!;
      const uMarks = new Set<number>();
      const gapMarks = new Set<number>();
      for (const side of [0, 1] as const) {
        worst = Math.max(
          worst,
          measureStrip(
            ring,
            st,
            side,
            f.strip[side],
            panelPatches[side],
            vb[side],
            limit,
            uMarks,
            vMarks[side],
          ),
        );
        gapWorst = Math.max(
          gapWorst,
          edgeGapOf(st, f.u, f.edge[side], panelPatches[side], STEP_RAILS_EDGE_GAP, gapMarks),
        );
      }
      if (k < STEP_MAX_PASSES) {
        // a band edge's height is fitted to its panel at samples of its own, so a gap may split any span;
        // a strip's miss only a span that still holds loop samples
        const mids = [...gapMarks]
          .filter((a) => st.breaks[a + 1]! - st.breaks[a]! > 2 * STEP_MIN_SPAN)
          .map((a) => 0.5 * (st.breaks[a]! + st.breaks[a + 1]!));
        added += splitCoarse(st, uMarks);
        const known = new Set(st.breaks);
        for (const m of mids) {
          if (!known.has(m)) {
            st.breaks.push(m);
            added++;
          }
        }
        st.breaks.sort((x, y) => x - y);
      }
    });
    stripDeviation = worst;
    edgeGap = gapWorst;
    if (overBudget || (worst <= limit && gapWorst <= STEP_RAILS_EDGE_GAP)) break;
    if (k === STEP_MAX_PASSES) break;
    added += bisect(vb[0], vMarks[0]) + bisect(vb[1], vMarks[1]);
    if (added === 0) break;
    if (controlsOf() > maxControls) {
      overBudget = true;
      break;
    }
  }
  function controlsOf(): number {
    const panelsN = fits.reduce((s, f) => s + (f.xb.length + 2) * (f.yb.length + 2), 0);
    const across = vb[0].length + vb[1].length + 4;
    const along = stretches.reduce((s, st) => s + st.breaks.length + 2, 0);
    return panelsN + (mirror ? 2 : 1) * along * across;
  }

  // the ring of faces in loop order: a mirror board's plus half, then its mirror back to the nose
  const acrossBases = [basisOf(vb[0]), basisOf(vb[1])] as const;
  let faces: RingFace[];
  let ringCross: RingSplit[];
  if (mirror) {
    const mir = (f: StretchFit): StretchFit => ({
      u: f.u,
      edge: [mirrored(f.edge[0]), mirrored(f.edge[1])],
      apex: mirrored(f.apex),
      strip: [mirrorPatch(f.strip[0]), mirrorPatch(f.strip[1])],
    });
    faces = [
      ...stretchFits.map((fit) => ({ fit, reversed: false })),
      ...stretchFits
        .slice()
        .reverse()
        .map((f) => ({ fit: mir(f), reversed: true })),
    ];
    const plus = crosses.map((c) => ({ cross: c }));
    const minus = crosses
      .slice(1, -1)
      .reverse()
      .map((c) => ({ cross: [mirrored(c[0]), mirrored(c[1])] as const }));
    ringCross = [...plus, ...minus];
  } else {
    faces = stretchFits.map((fit) => ({ fit, reversed: false }));
    ringCross = crosses.map((c) => ({ cross: c }));
  }
  const deck = surfaceOf(deckPanel);
  const bottom = surfaceOf(bottomPanel);
  const brep = assemble(deck, bottom, faces, ringCross, acrossBases);
  const controlCount = brep.faces.reduce((s, f) => s + f.surface.u.count * f.surface.v.count, 0);
  const deviation = Math.max(fits[0].deviation, fits[1].deviation, stripDeviation);
  return {
    brep,
    deck,
    bottom,
    report: {
      deviation,
      panelDeviation: Math.max(fits[0].deviation, fits[1].deviation),
      stripDeviation,
      edgeGap,
      passes: [panelPasses, stripPasses],
      splits: ringCross.length,
      faces: brep.faces.length,
      controlCount,
      panelControls: [
        [deckPanel.u.count, deckPanel.v.count],
        [bottomPanel.u.count, bottomPanel.v.count],
      ],
      across: [vb[0].length - 1, vb[1].length - 1],
      withinTolerance: deviation <= tolerance && edgeGap <= STEP_RAILS_EDGE_GAP && !overBudget,
      overBudget,
    },
  };
}

// --- STEP -----------------------------------------------------------------------------------

export interface RailsStepOptions extends RailsSolidOptions {
  /** `PRODUCT` and file name inside the file. */
  readonly name?: string;
  /** `FILE_NAME` timestamp (ISO 8601); defaults to a constant, so the bytes are reproducible. */
  readonly timestamp?: string;
  /** The unit the file declares and writes its coordinates in. Default millimetres, the STEP norm. */
  readonly unit?: 'mm' | 'cm' | 'in';
  /** Called after the faces are fitted and before the solid is checked and written. */
  readonly onWrite?: () => void;
}

export interface RailsStep {
  readonly text: string;
  readonly report: RailsSolidReport;
  readonly stats: StepResult['stats'];
}

/**
 * The STEP file of a built rails board, and what the fit achieved. Throws a {@link StepFitError} if the
 * faces cannot be fitted within the tolerance or the budget, and geom's error if the solid fails
 * `checkBrep`, which `writeStep` runs.
 */
export function railsStep(built: BuiltRails, opts: RailsStepOptions = {}): RailsStep {
  const tolerance = opts.tolerance ?? STEP_TOLERANCE;
  const solid = railsSolid(built, opts);
  if (!solid.report.withinTolerance) {
    const { deviation, overBudget } = solid.report;
    throw new StepFitError(
      overBudget
        ? `The surface needs more detail than the STEP export can fit (over ${opts.maxControls ?? STEP_RAILS_MAX_CONTROLS} control points); try fewer stations or a smaller feature.`
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
