// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom feature layers (docs/design/board2.md §6.2; stage 6 of §6.3).
 *
 * A feature is a displacement `d(x, y)` added to the base bottom's z. Its
 * longitudinal profile is a keyed `depth` over x in cm (zero outside its keys,
 * `law.ts`); its lateral shape is in **η = y / h_t(x)**, `h_t` the half-width of
 * the tuck loop's plan curve at x (channels use absolute cm from the tuck).
 * The tuck plan curve comes from stage 5 on the station basis
 * (`insetPlanCurve`): it depends on the plan, the laws and the offsets, never
 * on the bottom, so there is no cycle, and a feature edit reuses stages 2–5.
 *
 * | Kind       | d(x, y)                                                                         |
 * | ---------- | ------------------------------------------------------------------------------- |
 * | `vee`      | `depth(x) · g(|η|)`, `g` linear with a C¹ parabolic blend of half-width `r`     |
 * |            | at the stringer, normalised to `g(1) = 1`: the rails rise by `depth`            |
 * | `concave`  | `depth(x) · bump((|η| − centre) / width)`, `bump(t) = (1 − t²)²` on |t| < 1     |
 * | `channels` | `depth(x) · Σ_k bump((|y| − (h_t − c_k)) / (width/2))`, `c_k` the distance of   |
 * |            | channel k's centre from the tuck: `railInset + width/2 + k · pitch`             |
 *
 * A positive concave or channel depth raises the bottom into the board (the
 * hollow a concave is); S4 deviation 1 records the sign.
 *
 * **Fit** (§6.2). Each feature is sampled on a grid and fitted by least squares
 * on fixed bases with exact parameters (the height field's affine (u, v), so no
 * parameter correction, §3.4), separably (`tensorLeastSquares`: geom's
 * `approximateCurve` down every grid column, then along every row; the same
 * minimiser as `approximateSurface` on the grid, S4 review): the bottom's basis refined
 * by the feature's own knot lines, double knots (the feature is C¹ there) at its
 * depth keys' x and at its lateral break lines, placed with the tuck
 * half-width at the depth's largest key (exact where the tuck is straight;
 * elsewhere the lines curve with `h_t` and refinement resolves them, at the
 * cost of a fine tensor grid where they cross it: channels on the tail arc end
 * on a net of about 140 × 340). The fit
 * is verified at `verifyFactor ×` denser samples and the spans whose error
 * exceeds `safety · featureTol` are split (v in mirror pairs), at most
 * `edgeFit.maxPasses` times: the document's edge-fit sampling (S4 deviation 2).
 * A miss is a `not-converged` warning with the error, never silent.
 *
 * **Sum.** The fitted displacements and the base bottom are refined to the
 * union of their knots (exact) and added; the sum does not depend on the
 * features' order beyond rounding. On a symmetric board the total's partner
 * rows are then overwritten by their masters (bitwise symmetric, §3.7), and the
 * total is rebuilt as a height field, so its x and y are the exact Greville
 * images of its own knots. No enabled feature: the base bottom itself.
 */
import {
  approximateCurve,
  basisFunsInto,
  clampedBasis,
  createScratch,
  curveEvalInto,
  DEFAULT_EDGE_FIT,
  findSpan,
  refineKnotsSurface,
} from '@openshaper/geom';
import type {
  ClampedBasis,
  GeomIssue,
  NurbsSurface,
  PeriodicCurve,
  Scratch,
  Tolerances,
} from '@openshaper/geom';
import { heightFieldSurface } from './height-field';
import { causeOf, makeIssue } from './issues';
import { lawEvaluator } from './law';
import { planPieces, quadraticRoots, standardTailViolation } from './plan';
import type { Board2Issue, BoardDoc, BottomFeature, HeightFieldJSON } from './types';

// ---------------------------------------------------------------------------
// The tuck half-width h_t(x)
// ---------------------------------------------------------------------------

/** The tuck loop's half-width as a function of x (on its −y half). */
export interface TuckWidth {
  /** The tuck loop's x at the tail centre (u = 0) and the nose centre (u = ½). */
  readonly xMin: number;
  readonly xMax: number;
  /** `h_t(x)` for x in `[xMin, xMax]`: minus the −y half's y at that x. */
  readonly at: (x: number) => number;
  /** The smallest `h_t` over `[a, b]` (exact: the ends and the closed-form roots of y′). */
  readonly minOver: (a: number, b: number) => number;
}

/**
 * The half-width of the tuck plan curve, or `null` when its −y half is not a
 * graph over x (the standard-tail certificate of plan invariant 2, applied to
 * the tuck loop): then η is undefined. `h_t(x)` is found by bisection on the
 * loop parameter of the −y half to the last representable bit (x is strictly
 * increasing there by the certificate).
 */
export function tuckWidth(tuck: PeriodicCurve<2>, tol: Tolerances): TuckWidth | null {
  const pieces = planPieces(tuck, tol);
  if (standardTailViolation(pieces, tol) !== null) return null;
  const sc = createScratch({ maxDegree: tuck.basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  const at = (u: number): Float64Array => {
    curveEvalInto(tuck, u, 0, q, 0, sc);
    return q;
  };
  const xMin = at(0)[0]!;
  const xMax = at(0.5)[0]!;
  const paramOfX = (x: number): number => {
    let lo = 0;
    let hi = 0.5;
    for (;;) {
      const mid = 0.5 * (lo + hi);
      if (!(mid > lo && mid < hi)) break;
      if (at(mid)[0]! < x) lo = mid;
      else hi = mid;
    }
    return Math.abs(at(lo)[0]! - x) <= Math.abs(at(hi)[0]! - x) ? lo : hi;
  };
  const halfWidthAtParam = (u: number): number => -at(u)[1]!;
  return Object.freeze({
    xMin,
    xMax,
    at: (x: number) => halfWidthAtParam(paramOfX(x)),
    minOver: (a: number, b: number) => {
      const ua = paramOfX(a);
      const ub = paramOfX(b);
      let m = Math.min(halfWidthAtParam(ua), halfWidthAtParam(ub));
      for (const p of pieces) {
        if (p.u1 <= ua || p.u0 >= ub) continue;
        const d: [number, number, number] = [
          p.p[3]! - p.p[1]!,
          p.p[5]! - p.p[3]!,
          p.p[7]! - p.p[5]!,
        ];
        for (const s of quadraticRoots(d)) {
          const u = p.u0 + s * (p.u1 - p.u0);
          if (u > ua && u < ub) m = Math.min(m, halfWidthAtParam(u));
        }
      }
      return m;
    },
  });
}

// ---------------------------------------------------------------------------
// The closed forms
// ---------------------------------------------------------------------------

/** `(1 − t²)²` on |t| < 1, else 0: zero value and slope at its edges (§6.2). */
export function bump(t: number): number {
  if (!(Math.abs(t) < 1)) return 0;
  const s = 1 - t * t;
  return s * s;
}

/**
 * The vee's lateral profile: `g(t) = t²/(2r) / (1 − r/2)` for `t < r`, else
 * `(t − r/2) / (1 − r/2)`; C¹ at `t = r`, flat at the stringer, `g(1) = 1`.
 */
export function veeProfile(t: number, r: number): number {
  const norm = 1 - r / 2;
  return (t < r ? (t * t) / (2 * r) : t - r / 2) / norm;
}

/** A channel's distance of its centre from the tuck (cm). */
const channelOffset = (f: { width: number; pitch: number; railInset: number }, k: number): number =>
  f.railInset + f.width / 2 + k * f.pitch;

/**
 * The feature's displacement at plan point `(x, y)` with depth `depth = depth(x)`
 * and tuck half-width `ht = h_t(x)` (the table of the module comment).
 */
export function featureDisplacement(
  f: BottomFeature,
  depth: number,
  y: number,
  ht: number,
): number {
  if (depth === 0) return 0;
  const eta = Math.abs(y) / ht;
  switch (f.kind) {
    case 'vee':
      return depth * veeProfile(eta, f.stringerRadius);
    case 'concave':
      return depth * bump((eta - (f.layout === 'single' ? 0 : f.centre)) / f.width);
    case 'channels': {
      let s = 0;
      for (let k = 0; k < f.count; k++) {
        s += bump((Math.abs(y) - (ht - channelOffset(f, k))) / (f.width / 2));
      }
      return depth * s;
    }
  }
}

/** The |y| of the feature's lateral break lines (where it is only C¹) at tuck half-width `ht`. */
function breakLines(f: BottomFeature, ht: number): number[] {
  switch (f.kind) {
    case 'vee':
      return [f.stringerRadius * ht];
    case 'concave': {
      const c = f.layout === 'single' ? 0 : f.centre;
      return [c - f.width, c + f.width].filter((e) => e > 0).map((e) => e * ht);
    }
    case 'channels': {
      const out: number[] = [];
      for (let k = 0; k < f.count; k++) {
        const c = ht - channelOffset(f, k);
        out.push(c - f.width / 2, c + f.width / 2);
      }
      return out.filter((y) => y > 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry-dependent feature checks (S1 deviation 6 left them to this step)
// ---------------------------------------------------------------------------

/** The depth's support `[first key, last key]` (x, cm). */
const support = (f: BottomFeature): readonly [number, number] => [
  f.depth.keys[0]!.s,
  f.depth.keys[f.depth.keys.length - 1]!.s,
];

/**
 * The checks of enabled features that need the tuck loop (`feature-invalid`):
 * the depth must start and end at 0 (it is zero outside its keys, so anything
 * else is a jump no fit can follow); its support must lie strictly inside the
 * tuck loop's x-range (η needs `h_t > 0`); channels must not reach the
 * stringer anywhere on the support. A tuck loop that is not a graph over x is
 * reported once (η undefined).
 */
export function featureIssues(
  features: readonly BottomFeature[],
  width: TuckWidth | null,
): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const enabled = features.filter((f) => f.enabled);
  if (enabled.length === 0) return out;
  const issue = (f: BottomFeature, message: string, value?: number): Board2Issue =>
    makeIssue('feature-invalid', `feature '${f.id}': ${message}`, {
      at: { feature: f.id },
      ...(value === undefined ? {} : { value }),
    });
  if (width === null) {
    for (const f of enabled) {
      out.push(issue(f, 'the tuck loop is not a graph over x, so η = y / h_t(x) is undefined'));
    }
    return out;
  }
  for (const f of enabled) {
    const keys = f.depth.keys;
    const first = keys[0]!;
    const last = keys[keys.length - 1]!;
    if (first.value !== 0 || last.value !== 0) {
      out.push(
        issue(
          f,
          `depth must start and end at 0 (it is 0 outside its keys); got ${first.value} and ${last.value}`,
        ),
      );
    }
    const [a, b] = support(f);
    if (!(a > width.xMin && b < width.xMax)) {
      out.push(
        issue(
          f,
          `depth keys x [${a}, ${b}] must lie strictly inside the tuck loop's x-range (${width.xMin}, ${width.xMax})`,
        ),
      );
      continue;
    }
    if (f.kind === 'channels') {
      const reach = channelOffset(f, f.count - 1) + f.width / 2;
      const h = width.minOver(a, b);
      if (!(reach <= h)) {
        out.push(
          issue(
            f,
            `the innermost channel reaches ${reach} cm from the tuck, past the stringer where the tuck half-width is ${h} cm`,
            h,
          ),
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knot multisets
// ---------------------------------------------------------------------------

/** The interior knots of a clamped knot vector on [0, 1] of degree `p`. */
const interiorOf = (knots: readonly number[], p: number): number[] =>
  knots.slice(p + 1, knots.length - p - 1);

const fullKnots = (interior: readonly number[], p: number): number[] => [
  ...Array.from({ length: p + 1 }, () => 0),
  ...interior,
  ...Array.from({ length: p + 1 }, () => 1),
];

/** Multiplicity per value of a sorted multiset. */
function counts(xs: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** The union of knot multisets (each value at its largest multiplicity), sorted. */
function unionKnots(sets: readonly (readonly number[])[]): number[] {
  const m = new Map<number, number>();
  for (const s of sets) {
    for (const [x, c] of counts(s)) m.set(x, Math.max(m.get(x) ?? 0, c));
  }
  const out: number[] = [];
  for (const [x, c] of [...m].sort((a, b) => a[0] - b[0])) {
    for (let k = 0; k < c; k++) out.push(x);
  }
  return out;
}

/** `whole − part` as multisets (`part ⊆ whole`), sorted. */
function knotDifference(whole: readonly number[], part: readonly number[]): number[] {
  const have = counts(part);
  const out: number[] = [];
  for (const x of whole) {
    const c = have.get(x) ?? 0;
    if (c > 0) have.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Adds `x` to the multiset `set` until its multiplicity is `mult` (values
 * strictly inside (0, 1) only). A value within `near` of a knot already there
 * is that knot (geom refuses distinct knots closer than `knotRel`).
 */
function raise(set: number[], x: number, mult: number, near: number): void {
  if (!(x > near && x < 1 - near)) return;
  const at = set.find((k) => Math.abs(k - x) <= near);
  const v = at ?? x;
  let have = 0;
  for (const k of set) if (k === v) have++;
  for (; have < mult; have++) set.push(v);
}

/** Distinct spans `[a, b]` of a clamped knot vector's breakpoints. */
function spansOf(full: readonly number[]): [number, number][] {
  const br = [...new Set(full)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < br.length; k++) out.push([br[k]!, br[k + 1]!]);
  return out;
}

/** `n` interior samples per span, at `(k + ½)/n` of each. */
function spanSamples(spans: readonly [number, number][], n: number): Float64Array {
  const out = new Float64Array(spans.length * n);
  spans.forEach(([a, b], s) => {
    for (let k = 0; k < n; k++) out[s * n + k] = a + ((k + 0.5) / n) * (b - a);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Fitting one feature
// ---------------------------------------------------------------------------

/** One feature fitted onto the bottom's basis refined by its own knots. */
export interface FeatureFit {
  readonly id: string;
  /** Interior knots in u and v (on [0, 1]). */
  readonly knotsU: readonly number[];
  readonly knotsV: readonly number[];
  /** The displacement's control values, u-major. */
  readonly z: Float64Array;
  /** Largest verified |fit − d(x, η)| over the field (cm). */
  readonly error: number;
  readonly passes: number;
}

interface FitContext {
  readonly hf: HeightFieldJSON;
  readonly width: TuckWidth;
  readonly featureTol: number;
  readonly samplesPerSpan: number;
  readonly verifyFactor: number;
  readonly safety: number;
  readonly maxPasses: number;
  readonly symmetric: boolean;
  readonly tol: Tolerances;
}

/** The closed-form displacement on a grid of (u, v) (field parameters), u-major. */
function sampleGrid(
  f: BottomFeature,
  c: FitContext,
  depthAt: (x: number) => number,
  us: Float64Array,
  vs: Float64Array,
): Float64Array {
  const [x0, x1] = c.hf.x;
  const [y0, y1] = c.hf.y;
  const out = new Float64Array(us.length * vs.length);
  for (let i = 0; i < us.length; i++) {
    const x = x0 + us[i]! * (x1 - x0);
    const depth = depthAt(x);
    if (depth === 0) continue;
    const ht = c.width.at(x);
    for (let j = 0; j < vs.length; j++) {
      out[i * vs.length + j] = featureDisplacement(f, depth, y0 + vs[j]! * (y1 - y0), ht);
    }
  }
  return out;
}

/**
 * Midpoints of the failing v spans. On a symmetric board each failing span and
 * its mirror twin (span `n − 1 − k`: the knots are symmetric) are split at
 * `m` and `1 − m`, `m` from the lower twin's own knots, so the new knots are
 * mirror pairs; the middle span is split at ½.
 */
function splitV(
  spans: readonly [number, number][],
  failing: readonly number[],
  symmetric: boolean,
) {
  const add = new Set<number>();
  const n = spans.length;
  for (const k of failing) {
    if (!symmetric) {
      const [a, b] = spans[k]!;
      add.add(0.5 * (a + b));
      continue;
    }
    const lower = Math.min(k, n - 1 - k);
    if (lower === n - 1 - lower) {
      add.add(0.5);
      continue;
    }
    const [a, b] = spans[lower]!;
    const m = 0.5 * (a + b);
    add.add(m);
    add.add(1 - m);
  }
  return [...add];
}

/**
 * The feature's own knot lines (module comment): the bottom's interior knots
 * plus double knots at the depth keys' u and at the lateral break lines' v
 * (both sides), sorted.
 */
function ownKnots(f: BottomFeature, c: FitContext): { U: number[]; V: number[] } {
  const { hf } = c;
  const [x0, x1] = hf.x;
  const [y0, y1] = hf.y;
  const U = interiorOf(hf.knotsU, hf.degreeU);
  for (const k of f.depth.keys) raise(U, (k.s - x0) / (x1 - x0), 2, c.tol.knotRel);
  const V = interiorOf(hf.knotsV, hf.degreeV);
  let peak = f.depth.keys[0]!;
  for (const k of f.depth.keys) if (Math.abs(k.value) > Math.abs(peak.value)) peak = k;
  for (const y of breakLines(f, c.width.at(peak.s))) {
    const v = (y - y0) / (y1 - y0);
    raise(V, v, 2, c.tol.knotRel);
    raise(V, c.symmetric ? 1 - v : (-y - y0) / (y1 - y0), 2, c.tol.knotRel);
  }
  return { U: U.sort((a, b) => a - b), V: V.sort((a, b) => a - b) };
}

/**
 * One value per cluster of knots closer than `near` across the sets (a chain of
 * gaps each ≤ `near`): the cluster's smallest knot of the first set if it has
 * one (the base bottom's knots never move), else its smallest. So two
 * features whose break lines coincide up to rounding (a vee's `r · h_t` and a
 * double concave's `(c − w) · h_t`) share one knot: geom refuses distinct
 * knots closer than `knotRel`. Order-independent in the other sets: it depends
 * on their pooled values only.
 *
 * `mirrored` (the v knots of a symmetric board, whose feature knots come in
 * exact pairs `v`, `1 − v`): a cluster without a base knot is represented by
 * its knot nearest ½ instead, the largest below ½ and the smallest above, so
 * the representatives of mirror clusters are again an exact pair (`1 − v` is
 * monotone in v under rounding) and the total's v knots stay symmetric.
 */
function canonicalKnots(
  sets: readonly (readonly number[])[],
  near: number,
  mirrored = false,
): Map<number, number> {
  const first = new Set(sets[0] ?? []);
  const pool = [...new Set(sets.flat())].sort((a, b) => a - b);
  const map = new Map<number, number>();
  let cluster: number[] = [];
  const nearestHalf = (): number => {
    let best = cluster[0]!;
    for (const x of cluster) if (Math.abs(x - 0.5) < Math.abs(best - 0.5)) best = x;
    return best;
  };
  const close = (): void => {
    const rep = cluster.find((x) => first.has(x)) ?? (mirrored ? nearestHalf() : cluster[0]!);
    for (const x of cluster) map.set(x, rep);
    cluster = [];
  };
  for (const x of pool) {
    if (cluster.length > 0 && !(x - cluster[cluster.length - 1]! <= near)) close();
    cluster.push(x);
  }
  if (cluster.length > 0) close();
  return map;
}

/** The non-zero basis functions at each parameter: its span (P&T) and `p + 1` values. */
interface Collocation {
  readonly span: Int32Array;
  readonly n: Float64Array;
}

function collocation(b: ClampedBasis, ts: Float64Array, sc: Scratch): Collocation {
  const w = b.degree + 1;
  const span = new Int32Array(ts.length);
  const n = new Float64Array(ts.length * w);
  for (let k = 0; k < ts.length; k++) {
    span[k] = findSpan(b, ts[k]!);
    basisFunsInto(b, span[k]!, ts[k]!, n, k * w, sc);
  }
  return Object.freeze({ span, n });
}

/** Columns fitted per `approximateCurve` call: its largest dimension. */
const FIT_DIM = 3;

/**
 * Fits `count` columns of `length` values at `params` on the clamped basis
 * `b` (geom's `approximateCurve`, `FIT_DIM` columns per call) and hands each
 * column's control values to `put`; geom's issue when it refuses one.
 */
function fitColumns(
  count: number,
  length: number,
  at: (k: number, c: number) => number,
  b: ClampedBasis,
  params: Float64Array,
  tol: Tolerances,
  put: (c: number, a: number, value: number) => void,
): GeomIssue | null {
  const pts = new Float64Array(length * FIT_DIM);
  const stride = FIT_DIM + 1;
  for (let c0 = 0; c0 < count; c0 += FIT_DIM) {
    const m = Math.min(FIT_DIM, count - c0);
    pts.fill(0);
    for (let k = 0; k < length; k++) {
      for (let c = 0; c < m; c++) pts[k * FIT_DIM + c] = at(k, c0 + c);
    }
    const fit = approximateCurve(pts, FIT_DIM, { degree: b.degree, knots: b.knots, params, tol });
    if (!fit.ok) {
      return fit.issues.find((i) => i.severity === 'error') ?? fit.issues[0]!;
    }
    const cw = fit.value.curve.cw;
    for (let a = 0; a < b.count; a++) {
      for (let c = 0; c < m; c++) put(c0 + c, a, cw[a * stride + c]! / cw[a * stride + FIT_DIM]!);
    }
  }
  return null;
}

/**
 * The least-squares fit of grid data on a tensor-product basis, separably.
 * `d` (u-major, `us.length × vs.length`) at the exact parameters `us × vs`;
 * returns the control values (u-major, `bu.count × bv.count`) minimising the
 * sum of squared residuals. On a grid the collocation matrix is the Kronecker
 * product `Bu ⊗ Bv`, whose pseudo-inverse is `Bu⁺ ⊗ Bv⁺` (both of full column
 * rank: every span holds `samplesPerSpan > p` samples), so fitting every data
 * column in u and then every resulting row in v is the same minimiser as
 * `approximateSurface` on the whole grid, up to rounding: curve fits instead
 * of one banded solve with `bu.count · bv.count` unknowns and bandwidth
 * `≈ p · bv.count` (S4 review: 111 s of a 149 s channel fit on the tail arc).
 */
export function tensorLeastSquares(
  d: Float64Array,
  us: Float64Array,
  vs: Float64Array,
  bu: ClampedBasis,
  bv: ClampedBasis,
  tol: Tolerances,
): Float64Array | GeomIssue {
  const mv = vs.length;
  // Every data column (one v sample) in u: E is bu.count × mv.
  const E = new Float64Array(bu.count * mv);
  const e1 = fitColumns(
    mv,
    us.length,
    (k, c) => d[k * mv + c]!,
    bu,
    us,
    tol,
    (c, a, value) => {
      E[a * mv + c] = value;
    },
  );
  if (e1 !== null) return e1;
  // Every row of E (one u control index) in v.
  const z = new Float64Array(bu.count * bv.count);
  const e2 = fitColumns(
    bu.count,
    mv,
    (k, c) => E[c * mv + k]!,
    bv,
    vs,
    tol,
    (c, a, value) => {
      z[c * bv.count + a] = value;
    },
  );
  return e2 ?? z;
}

function fitFeature(
  f: BottomFeature,
  c: FitContext,
  U: number[],
  V: number[],
): FeatureFit | Board2Issue {
  const { hf } = c;
  const p = hf.degreeU;
  const q = hf.degreeV;
  const [x0, x1] = hf.x;
  const [y0, y1] = hf.y;
  const depthAt = lawEvaluator(f.depth, c.tol);
  const sc = createScratch({ maxDegree: Math.max(p, q), maxDerivs: 0 });
  const geomIssue = (message: string, cause?: GeomIssue): Board2Issue =>
    makeIssue('geom', `feature '${f.id}': fit: ${message}`, {
      at: { feature: f.id },
      ...(cause === undefined ? {} : { cause }),
    });

  let best: FeatureFit | null = null;
  let knotsU = U;
  let knotsV = V;
  for (let pass = 0; ; pass++) {
    const fullU = fullKnots(knotsU, p);
    const fullV = fullKnots(knotsV, q);
    const spansU = spansOf(fullU);
    const spansV = spansOf(fullV);
    const us = spanSamples(spansU, c.samplesPerSpan);
    const vs = spanSamples(spansV, c.samplesPerSpan);
    let bu: ClampedBasis;
    let bv: ClampedBasis;
    let z: Float64Array;
    try {
      bu = clampedBasis(p, fullU, c.tol);
      bv = clampedBasis(q, fullV, c.tol);
      const r = tensorLeastSquares(sampleGrid(f, c, depthAt, us, vs), us, vs, bu, bv, c.tol);
      if (!(r instanceof Float64Array)) return geomIssue(r.message, r);
      z = r;
    } catch (e) {
      return geomIssue(e instanceof Error ? e.message : String(e), causeOf(e));
    }

    // Verify at verifyFactor × the samples, one u sample at a time (z only: the field's x
    // and y are affine, §3.4); the error per u span and per v span.
    const n = c.samplesPerSpan * c.verifyFactor;
    const vu = spanSamples(spansU, n);
    const vv = spanSamples(spansV, n);
    const cu = collocation(bu, vu, sc);
    const cv = collocation(bv, vv, sc);
    const nvc = bv.count;
    const row = new Float64Array(nvc);
    const errU = new Float64Array(spansU.length);
    const errV = new Float64Array(spansV.length);
    let error = 0;
    for (let i = 0; i < vu.length; i++) {
      row.fill(0);
      for (let a = 0; a <= p; a++) {
        const w = cu.n[i * (p + 1) + a]!;
        const o = (cu.span[i]! - p + a) * nvc;
        for (let j = 0; j < nvc; j++) row[j] = row[j]! + w * z[o + j]!;
      }
      const x = x0 + vu[i]! * (x1 - x0);
      const depth = depthAt(x);
      const ht = depth === 0 ? 0 : c.width.at(x);
      const si = Math.floor(i / n);
      for (let j = 0; j < vv.length; j++) {
        let s = 0;
        const o = cv.span[j]! - q;
        for (let b = 0; b <= q; b++) s += cv.n[j * (q + 1) + b]! * row[o + b]!;
        const exact = depth === 0 ? 0 : featureDisplacement(f, depth, y0 + vv[j]! * (y1 - y0), ht);
        const e = Math.abs(s - exact);
        const sj = Math.floor(j / n);
        if (e > errU[si]!) errU[si] = e;
        if (e > errV[sj]!) errV[sj] = e;
        if (e > error) error = e;
      }
    }
    const fit: FeatureFit = Object.freeze({
      id: f.id,
      knotsU: Object.freeze([...knotsU]),
      knotsV: Object.freeze([...knotsV]),
      z,
      error,
      passes: pass,
    });
    if (best === null || error < best.error) best = fit;
    if (error <= c.featureTol || pass >= c.maxPasses) break;
    const limit = c.safety * c.featureTol;
    const addU: number[] = [];
    spansU.forEach(([a, b], k) => {
      if (errU[k]! > limit) addU.push(0.5 * (a + b));
    });
    const failV: number[] = [];
    errV.forEach((e, k) => {
      if (e > limit) failV.push(k);
    });
    const addV = splitV(spansV, failV, c.symmetric);
    if (addU.length === 0 && addV.length === 0) break;
    knotsU = [...knotsU, ...addU].sort((a, b) => a - b);
    knotsV = [...knotsV, ...addV.filter((v) => !knotsV.includes(v))].sort((a, b) => a - b);
  }
  return best!;
}

// ---------------------------------------------------------------------------
// The bottom with its features (stage 6)
// ---------------------------------------------------------------------------

/** The bottom total and what its fit achieved. */
export interface FeatureBottom {
  /** The bottom with every enabled feature added (the base bottom when there is none). */
  readonly surface: NurbsSurface;
  /** The total as a height field (the document's extent, the union knots, the summed z). */
  readonly hf: HeightFieldJSON;
  /** Per enabled feature, in document order. */
  readonly fits: readonly FeatureFit[];
  /** The largest verified fit error over the features (0 when none). */
  readonly error: number;
}

/**
 * Stage 6 of §6.3: the bottom with its enabled features, fitted, made
 * compatible and added (module comment). `tuck` is the tuck plan curve of
 * stage 5 on the station basis (`insetPlanCurve`). Returns the feature checks'
 * errors (`feature-invalid`), a fit geom refuses (`geom`), or the total with a
 * `not-converged` warning per feature whose fit missed `featureTol`.
 */
export function bottomWithFeatures(
  doc: BoardDoc,
  base: NurbsSurface,
  tuck: PeriodicCurve<2>,
  tol: Tolerances,
): { readonly value: FeatureBottom | null; readonly issues: readonly Board2Issue[] } {
  const enabled = doc.features.filter((f) => f.enabled);
  if (enabled.length === 0) {
    return {
      value: Object.freeze({ surface: base, hf: doc.bottom, fits: [], error: 0 }),
      issues: [],
    };
  }
  const width = tuckWidth(tuck, tol);
  const issues = [...featureIssues(doc.features, width)];
  if (issues.length > 0 || width === null) return { value: null, issues };

  const hf = doc.bottom;
  const ef = { ...DEFAULT_EDGE_FIT, ...doc.build.edgeFit };
  const c: FitContext = {
    hf,
    width,
    featureTol: doc.build.featureTol,
    samplesPerSpan: ef.samplesPerSpan,
    verifyFactor: ef.verifyFactor,
    safety: ef.safety,
    maxPasses: ef.maxPasses,
    symmetric: doc.symmetry === 'mirror-y',
    tol,
  };
  const own = enabled.map((f) => ownKnots(f, c));
  const mapU = canonicalKnots(
    [interiorOf(hf.knotsU, hf.degreeU), ...own.map((k) => k.U)],
    tol.knotRel,
  );
  const mapV = canonicalKnots(
    [interiorOf(hf.knotsV, hf.degreeV), ...own.map((k) => k.V)],
    tol.knotRel,
    c.symmetric,
  );
  const fits: FeatureFit[] = [];
  for (const [i, f] of enabled.entries()) {
    const r = fitFeature(
      f,
      c,
      own[i]!.U.map((x) => mapU.get(x)!),
      own[i]!.V.map((x) => mapV.get(x)!),
    );
    if ('code' in r) return { value: null, issues: [r] };
    fits.push(r);
    if (r.error > c.featureTol) {
      issues.push(
        makeIssue(
          'not-converged',
          `feature '${f.id}': fit error ${r.error} cm after ${r.passes} refinement pass(es) exceeds featureTol ${c.featureTol}`,
          { severity: 'warning', at: { feature: f.id }, value: r.error },
        ),
      );
    }
  }

  // Compatible bases (exact refinement) and the sum.
  const p = hf.degreeU;
  const q = hf.degreeV;
  // Knots the features' refinements placed within knotRel of each other share one value
  // (each relabelled by less than knotRel of the domain: a rounding-level change of a
  // fitted displacement; a merge of two of one feature's own knots is refused).
  const snapU = canonicalKnots(
    [interiorOf(hf.knotsU, p), ...fits.map((r) => r.knotsU)],
    tol.knotRel,
  );
  const snapV = canonicalKnots(
    [interiorOf(hf.knotsV, q), ...fits.map((r) => r.knotsV)],
    tol.knotRel,
    c.symmetric,
  );
  const snap = (xs: readonly number[], m: Map<number, number>) => xs.map((x) => m.get(x)!);
  const baseU = snap(interiorOf(hf.knotsU, p), snapU);
  const baseV = snap(interiorOf(hf.knotsV, q), snapV);
  for (const r of fits) {
    for (const [xs, m] of [
      [r.knotsU, snapU],
      [r.knotsV, snapV],
    ] as const) {
      if (new Set(snap(xs, m)).size !== new Set(xs).size) {
        return {
          value: null,
          issues: [
            makeIssue(
              'geom',
              `feature '${r.id}': two of its knots fall within knotRel of one knot of another feature`,
              { at: { feature: r.id } },
            ),
          ],
        };
      }
    }
  }
  const fitKnots = fits.map((r) => ({ U: snap(r.knotsU, snapU), V: snap(r.knotsV, snapV) }));
  const allU = unionKnots([baseU, ...fitKnots.map((k) => k.U)]);
  const allV = unionKnots([baseV, ...fitKnots.map((k) => k.V)]);
  const refinedZ = (s: NurbsSurface, ownU: readonly number[], ownV: readonly number[]) => {
    let r = s;
    const du = knotDifference(allU, ownU);
    const dv = knotDifference(allV, ownV);
    if (du.length > 0) r = refineKnotsSurface(r, 'u', du, tol);
    if (dv.length > 0) r = refineKnotsSurface(r, 'v', dv, tol);
    const z = new Float64Array(r.u.count * r.v.count);
    for (let k = 0; k < z.length; k++) z[k] = r.cw[4 * k + 2]! / r.cw[4 * k + 3]!;
    return z;
  };
  // The base knots are their clusters' representatives, so the base bottom is unchanged.
  const sum = refinedZ(base, baseU, baseV);
  for (const [i, r] of fits.entries()) {
    const k = fitKnots[i]!;
    const own: HeightFieldJSON = {
      ...hf,
      knotsU: fullKnots(k.U, p),
      knotsV: fullKnots(k.V, q),
      z: Array.from(r.z),
    };
    const d = refinedZ(heightFieldSurface(own, 'none', tol), k.U, k.V);
    for (let k = 0; k < sum.length; k++) sum[k] = sum[k]! + d[k]!;
  }
  const nv = allV.length + q + 1;
  if (c.symmetric) {
    // The exact mirror overwrite (§3.7): partner rows j ↔ m − 1 − j take their master's z.
    const nu = sum.length / nv;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; 2 * j < nv - 1; j++) sum[i * nv + (nv - 1 - j)] = sum[i * nv + j]!;
    }
  }
  const total: HeightFieldJSON = Object.freeze({
    ...hf,
    knotsU: fullKnots(allU, p),
    knotsV: fullKnots(allV, q),
    z: Array.from(sum),
  });
  let error = 0;
  for (const r of fits) error = Math.max(error, r.error);
  return {
    value: Object.freeze({
      surface: heightFieldSurface(total, doc.symmetry, tol),
      hf: total,
      fits: Object.freeze(fits),
      error,
    }),
    issues,
  };
}
