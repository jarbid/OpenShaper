// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tensor-product B-spline and NURBS surfaces: factories, accessors,
 * copy-on-write edits, evaluation, exact iso and boundary curves (design §6.6).
 *
 * Storage is one homogeneous net `cw` (P&T's Pw, stride 4), **u-major**:
 * control point `(i, j)` starts at `(i · v.count + j) · 4` (decision 2). The API
 * speaks Euclidean points plus separate weights (decision 3); `rational` is
 * derived by the factory (decision 4). Evaluation runs A2.2 / A2.3 per
 * direction, A3.6 on Pw (A3.5 / A4.3 at order 0) and A4.4.
 *
 * - Allocating evaluators (`surfacePoint`, `surfaceDerivatives`) validate both
 *   parameters: they throw beyond `paramRel` slack outside a clamped domain
 *   and wrap periodic ones.
 * - `*Into` kernels clamp or wrap and never throw on parameters (decision 11);
 *   they check buffer sizes (O(1)) and allocate nothing (the grid kernel grows
 *   its scratch once for a larger grid, then reuses it).
 * - Derivative layout `[S, Su, Sv, Suu, Suv, Svv]`, 3 values each (§4.6).
 *   Default side at an interior knot is the right-hand limit in each direction.
 */
import { checkOut, growF64, growI32, makeScratch, scratchFor, toF64, toNumbers } from './array';
import type { Scratch, ScratchImpl } from './array';
import {
  basisToJSON,
  checkParam,
  evalBasisInto,
  reviveBasis,
  sanitizeParam,
  spanOf,
} from './basis';
import type { BasisJSON } from './basis';
import { polySurfaceDerivs, ratSurfaceDerivs, surfaceDerivsH } from './book/surface';
import {
  buildCw,
  checkAffine,
  checkBasisShape,
  checkHomogeneous,
  curveFromHomogeneous,
  replacePoints,
  replaceWeights,
  spanFromHint,
} from './curve';
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type {
  Affine3,
  Basis,
  Box3,
  Interval,
  NumArray,
  NurbsCurve,
  NurbsSurface,
  ParamDir,
  Point3,
  ReadonlyF64,
  Side,
  SurfaceDerivs,
  SurfaceEdge,
} from './types';

/** A surface as plain JSON-safe arrays: bases, Euclidean points (u-major, stride 3) and, if rational, weights. */
export interface SurfaceJSON {
  readonly u: BasisJSON;
  readonly v: BasisJSON;
  readonly points: readonly number[];
  readonly weights?: readonly number[];
}

/** The position and first partial derivatives (order-1 result of {@link surfaceDerivatives}). */
export type SurfaceDerivs1 = Pick<SurfaceDerivs, 'S' | 'Su' | 'Sv'>;

/** The side of a knot to evaluate in each direction (default right). */
export interface SurfaceSide {
  readonly u?: Side;
  readonly v?: Side;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function freezeSurface(u: Basis, v: Basis, cw: Float64Array, rational: boolean): NurbsSurface {
  return Object.freeze({ u, v, cw, rational }) as unknown as NurbsSurface;
}

/**
 * O(1) consistency check run by every public surface entry point: the bases
 * are validated records and the net has `u.count · v.count · 4` values.
 */
export function checkSurfaceShape(s: NurbsSurface): void {
  if (typeof s !== 'object' || s === null) fail('size-mismatch', 'expected a surface');
  checkBasisShape(s.u);
  checkBasisShape(s.v);
  if (!(s.cw instanceof Float64Array) || s.cw.length !== s.u.count * s.v.count * 4) {
    fail('size-mismatch', 'surface net does not match its bases (use makeSurface)');
  }
}

/**
 * A surface from Euclidean control points (u-major, stride 3: point `(i, j)` at
 * `(i · v.count + j) · 3`) and optional weights (default 1: a polynomial
 * B-spline surface). Validates and copies; `rational` is `false` iff every
 * weight is exactly 1. The bases are kept by reference.
 */
export function makeSurface(spec: {
  readonly u: Basis;
  readonly v: Basis;
  readonly points: ArrayLike<number>;
  readonly weights?: ArrayLike<number>;
}): NurbsSurface {
  checkBasisShape(spec.u);
  checkBasisShape(spec.v);
  const { cw, rational } = buildCw(3, spec.u.count * spec.v.count, spec.points, spec.weights);
  return freezeSurface(spec.u, spec.v, cw, rational);
}

/** A surface from homogeneous control points `[w·x, w·y, w·z, w]` (u-major, stride 4). Validates and copies. */
export function surfaceFromHomogeneous(spec: {
  readonly u: Basis;
  readonly v: Basis;
  readonly cw: ArrayLike<number>;
}): NurbsSurface {
  checkBasisShape(spec.u);
  checkBasisShape(spec.v);
  const count = spec.u.count * spec.v.count;
  if (spec.cw.length !== count * 4) {
    fail('size-mismatch', `expected ${count * 4} homogeneous values; got ${spec.cw.length}`, {
      value: spec.cw.length,
    });
  }
  const cw = toF64(spec.cw);
  return freezeSurface(spec.u, spec.v, cw, checkHomogeneous(cw, count, 3));
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isArrayLike = (x: unknown): x is ArrayLike<number> =>
  isRecord(x) && typeof (x as { length?: unknown }).length === 'number';

function basisField(x: unknown, dir: ParamDir): Basis {
  if (!isRecord(x)) fail('size-mismatch', `surface ${dir} basis is malformed`);
  return reviveBasis(x.kind, x.degree, x.knots, x.period);
}

/**
 * Validates an untrusted value back into a surface: a structured clone of a
 * `NurbsSurface` (from a worker) or a {@link SurfaceJSON}. Everything is
 * re-validated; the bases are rebuilt, so they are not shared with other
 * surfaces (a sample plan built for the original does not match the copy).
 */
export function reviveSurface(x: unknown): NurbsSurface {
  if (!isRecord(x)) fail('size-mismatch', 'reviveSurface expects a surface object');
  const u = basisField(x.u, 'u');
  const v = basisField(x.v, 'v');
  if ('cw' in x) {
    if (!isArrayLike(x.cw)) fail('size-mismatch', 'cloned surface net is malformed');
    return surfaceFromHomogeneous({ u, v, cw: x.cw });
  }
  if (!isArrayLike(x.points)) fail('size-mismatch', 'surface JSON has no points');
  if (x.weights !== undefined && !isArrayLike(x.weights))
    fail('size-mismatch', 'surface JSON weights malformed');
  return makeSurface({ u, v, points: x.points, weights: x.weights as ArrayLike<number> });
}

/**
 * Plain arrays for JSON. `reviveSurface(surfaceToJSON(s))` is bitwise for
 * polynomial surfaces; a rational one may differ by an ulp per coordinate.
 */
export function surfaceToJSON(s: NurbsSurface): SurfaceJSON {
  checkSurfaceShape(s);
  const n = s.u.count * s.v.count;
  const points = new Float64Array(n * 3);
  const weights = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const w = s.cw[k * 4 + 3]!;
    for (let c = 0; c < 3; c++)
      points[k * 3 + c] = s.rational ? s.cw[k * 4 + c]! / w : s.cw[k * 4 + c]!;
    weights[k] = w;
  }
  return Object.freeze({
    u: basisToJSON(s.u),
    v: basisToJSON(s.v),
    points: toNumbers(points),
    ...(s.rational ? { weights: toNumbers(weights) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Accessors and copy-on-write edits
// ---------------------------------------------------------------------------

function netIndex(s: NurbsSurface, i: number, j: number): number {
  checkSurfaceShape(s);
  const ok =
    Number.isInteger(i) &&
    Number.isInteger(j) &&
    i >= 0 &&
    j >= 0 &&
    i < s.u.count &&
    j < s.v.count;
  if (!ok) {
    fail(
      'size-mismatch',
      `control point (${i}, ${j}) is outside [0, ${s.u.count}) × [0, ${s.v.count})`,
      { index: i, value: j },
    );
  }
  return (i * s.v.count + j) * 4;
}

/** Euclidean control point `(i, j)` (`Pw / w`). */
export function surfaceControlPoint(s: NurbsSurface, i: number, j: number): Point3 {
  const q = netIndex(s, i, j);
  const w = s.cw[q + 3]!;
  return { x: s.cw[q]! / w, y: s.cw[q + 1]! / w, z: s.cw[q + 2]! / w };
}

/** Weight of control point `(i, j)`. */
export function surfaceControlWeight(s: NurbsSurface, i: number, j: number): number {
  return s.cw[netIndex(s, i, j) + 3]!;
}

/**
 * A copy with new Euclidean control points, keeping weights and both bases (by
 * reference, so sample plans stay valid). Without `indices`, `points` holds all
 * `u.count · v.count · 3` values (u-major); with them, `points[k·3 …]` replaces
 * the control point with flat index `indices[k] = i · v.count + j`.
 */
export function withSurfaceControlPoints(
  s: NurbsSurface,
  points: ArrayLike<number>,
  indices?: ArrayLike<number>,
): NurbsSurface {
  checkSurfaceShape(s);
  const cw = replacePoints(s.cw, 3, s.u.count * s.v.count, points, indices);
  return freezeSurface(s.u, s.v, cw, s.rational);
}

/** A copy with new weights (flat indices as {@link withSurfaceControlPoints}); Euclidean points kept, `rational` re-derived. */
export function withSurfaceWeights(
  s: NurbsSurface,
  weights: ArrayLike<number>,
  indices?: ArrayLike<number>,
): NurbsSurface {
  checkSurfaceShape(s);
  const { cw, rational } = replaceWeights(s.cw, 3, s.u.count * s.v.count, weights, indices);
  return freezeSurface(s.u, s.v, cw, rational);
}

/**
 * A copy with a whole new homogeneous net (the solver's output, or a net
 * received from a worker), keeping both bases by reference. Validates O(n).
 */
export function withSurfaceControlNet(s: NurbsSurface, cw: ArrayLike<number>): NurbsSurface {
  checkSurfaceShape(s);
  return surfaceFromHomogeneous({ u: s.u, v: s.v, cw });
}

/** The parameter domains of both directions. */
export function surfaceDomain(s: NurbsSurface): { readonly u: Interval; readonly v: Interval } {
  checkSurfaceShape(s);
  return Object.freeze({ u: s.u.domain, v: s.v.domain });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Net offsets of the `degree + 1` rows (or columns) of `span` into
 * `out[o …]`: `idx · stride` with `idx = span − degree + r`, wrapped once for a
 * periodic basis (its spans start at index `−degree`).
 */
export function spanOffsets(
  b: Basis,
  span: number,
  stride: number,
  out: Int32Array,
  o: number,
): void {
  const p = b.degree;
  const n = b.count;
  for (let r = 0; r <= p; r++) {
    let idx = span - p + r;
    if (idx < 0) idx += n;
    out[o + r] = idx * stride;
  }
}

/**
 * The evaluation core: `SKL` to order `nDer` at sanitized `(u, v)` in the span
 * pair, into `sc.f[sc.oS …]` (6 slots of stride 3, the first
 * `(nDer + 1)(nDer + 2)/2` written). A2.2 / A2.3 → A3.6 on Pw → A4.4.
 */
export function evalSurfaceSpan(
  s: NurbsSurface,
  u: number,
  v: number,
  spanU: number,
  spanV: number,
  nDer: number,
  sc: ScratchImpl,
): void {
  const f = sc.f;
  const iw = sc.iw;
  const c0 = sc.maxDegree + 1;
  evalBasisInto(s.u, u, spanU, nDer, sc, sc.oN, sc.oWin);
  evalBasisInto(s.v, v, spanV, nDer, sc, sc.oNv, sc.oWinV);
  spanOffsets(s.u, spanU, s.v.count * 4, iw, 0);
  spanOffsets(s.v, spanV, 4, iw, c0);
  surfaceDerivsH(
    s.u.degree,
    s.v.degree,
    nDer,
    f,
    sc.oN,
    f,
    sc.oNv,
    s.cw,
    iw,
    0,
    iw,
    c0,
    f,
    sc.oTmp,
    f,
    sc.oSw,
  );
  if (s.rational) ratSurfaceDerivs(f, sc.oSw, nDer, f, sc.oS);
  else polySurfaceDerivs(f, sc.oSw, nDer, f, sc.oS);
}

/** Values per sample for derivative order `nDer`: 3, 9 or 18. */
export function surfaceStride(nDer: number): number {
  return (3 * (nDer + 1) * (nDer + 2)) >> 1;
}

function checkNDer2(nDer: number): void {
  if (!(nDer === 0 || nDer === 1 || nDer === 2)) {
    fail('unsupported', `surface derivative order must be 0, 1 or 2; got ${nDer}`, {
      value: nDer,
    });
  }
}

/** The scratch for a surface (degree `max(p, q)`), after the O(1) capacity check. */
export function surfaceScratch(s: NurbsSurface, sc: Scratch, nDer: number): ScratchImpl {
  const P = s.u.degree > s.v.degree ? s.u.degree : s.v.degree;
  return scratchFor(sc, P, nDer);
}

/** A fresh scratch for an allocating wrapper. */
export function ownScratch(s: NurbsSurface, nDer: number): ScratchImpl {
  return makeScratch(s.u.degree > s.v.degree ? s.u.degree : s.v.degree, nDer);
}

/**
 * Evaluates `[S, Su, Sv, Suu, Suv, Svv]` to order `nDer` (3, 9 or 18 values)
 * into `out[o …]`. Clamps (clamped) or wraps (periodic) each parameter and
 * never throws on them; NaN evaluates at the domain start. `side` picks the
 * one-sided limit at a knot per direction (default right).
 */
export function surfaceEvalInto(
  s: NurbsSurface,
  u: number,
  v: number,
  nDer: 0 | 1 | 2,
  out: Float64Array,
  o: number,
  sc: Scratch,
  side?: SurfaceSide,
): void {
  checkNDer2(nDer);
  checkSurfaceShape(s);
  const impl = surfaceScratch(s, sc, nDer);
  const stride = surfaceStride(nDer);
  checkOut(out, o, stride, 'surfaceEvalInto');
  const uu = sanitizeParam(s.u, u);
  const vv = sanitizeParam(s.v, v);
  evalSurfaceSpan(
    s,
    uu,
    vv,
    spanOf(s.u, uu, side?.u === 'left'),
    spanOf(s.v, vv, side?.v === 'left'),
    nDer,
    impl,
  );
  const f = impl.f;
  for (let k = 0; k < stride; k++) out[o + k] = f[impl.oS + k]!;
}

/**
 * Evaluates the grid `us × vs` (any order; ascending is amortised O(1) per span
 * search) into `out`, row-major: sample `(i, j)` starts at
 * `(i · vs.length + j) · stride`, stride 3, 9 or 18 as {@link surfaceEvalInto},
 * whose values it reproduces bit for bit (a `Float32Array` receives them
 * rounded). Separable: the v basis is computed once per `vs[j]` and the u basis
 * once per `us[i]` (design §9). Right-hand limits.
 */
export function surfaceEvalGridInto(
  s: NurbsSurface,
  us: ReadonlyF64,
  vs: ReadonlyF64,
  nDer: 0 | 1 | 2,
  out: NumArray,
  sc: Scratch,
): void {
  checkNDer2(nDer);
  checkSurfaceShape(s);
  const impl = surfaceScratch(s, sc, nDer);
  const stride = surfaceStride(nDer);
  const nu = us.length;
  const nv = vs.length;
  checkOut(out, 0, nu * nv * stride, 'surfaceEvalGridInto');
  const bu = s.u;
  const bv = s.v;
  const p = bu.degree;
  const q = bv.degree;
  const nb = (nDer + 1) * (q + 1);
  // The v bases and column offsets, in the scratch's growable buffers.
  const G = growF64(impl, nv * nb);
  const I = growI32(impl, nv * (q + 1));
  const f = impl.f;
  let span = -1;
  for (let j = 0; j < nv; j++) {
    const v = sanitizeParam(bv, vs[j]!);
    span = spanFromHint(bv, v, span);
    evalBasisInto(bv, v, span, nDer, impl, impl.oNv, impl.oWinV);
    for (let k = 0; k < nb; k++) G[j * nb + k] = f[impl.oNv + k]!;
    spanOffsets(bv, span, 4, I, j * (q + 1));
  }
  const rowStride = bv.count * 4;
  span = -1;
  for (let i = 0; i < nu; i++) {
    const u = sanitizeParam(bu, us[i]!);
    span = spanFromHint(bu, u, span);
    evalBasisInto(bu, u, span, nDer, impl, impl.oN, impl.oWin);
    spanOffsets(bu, span, rowStride, impl.iw, 0);
    for (let j = 0; j < nv; j++) {
      surfaceDerivsH(
        p,
        q,
        nDer,
        f,
        impl.oN,
        G,
        j * nb,
        s.cw,
        impl.iw,
        0,
        I,
        j * (q + 1),
        f,
        impl.oTmp,
        f,
        impl.oSw,
      );
      if (s.rational) ratSurfaceDerivs(f, impl.oSw, nDer, f, impl.oS);
      else polySurfaceDerivs(f, impl.oSw, nDer, f, impl.oS);
      const o = (i * nv + j) * stride;
      for (let k = 0; k < stride; k++) out[o + k] = f[impl.oS + k]!;
    }
  }
}

function point3(f: ArrayLike<number>, o: number): Point3 {
  return { x: f[o]!, y: f[o + 1]!, z: f[o + 2]! };
}

/** A3.5 / A4.3: the point at `(u, v)`. Throws outside a clamped domain (beyond `paramRel`); wraps periodic. */
export function surfacePoint(s: NurbsSurface, u: number, v: number): Point3 {
  checkSurfaceShape(s);
  const tol = resolveTolerances();
  const uu = checkParam(s.u, u, undefined, tol);
  const vv = checkParam(s.v, v, undefined, tol);
  const sc = ownScratch(s, 0);
  evalSurfaceSpan(s, uu, vv, spanOf(s.u, uu, false), spanOf(s.v, vv, false), 0, sc);
  return point3(sc.f, sc.oS);
}

/**
 * A3.6 + A4.4: the point and its partial derivatives at `(u, v)` to `order`
 * (1: `S, Su, Sv`; 2: also `Suu, Suv, Svv`), from the given side of a knot in
 * each direction (default right; the inner side at a clamped end). Throws
 * outside a clamped domain or for a side that does not exist there.
 */
export function surfaceDerivatives(
  s: NurbsSurface,
  u: number,
  v: number,
  order: 2,
  side?: SurfaceSide,
): SurfaceDerivs;
export function surfaceDerivatives(
  s: NurbsSurface,
  u: number,
  v: number,
  order: 1,
  side?: SurfaceSide,
): SurfaceDerivs1;
export function surfaceDerivatives(
  s: NurbsSurface,
  u: number,
  v: number,
  order: 1 | 2,
  side?: SurfaceSide,
): SurfaceDerivs1 | SurfaceDerivs;
export function surfaceDerivatives(
  s: NurbsSurface,
  u: number,
  v: number,
  order: 1 | 2,
  side?: SurfaceSide,
): SurfaceDerivs1 | SurfaceDerivs {
  if (!(order === 1 || order === 2)) {
    fail('unsupported', `surface derivative order must be 1 or 2; got ${String(order)}`, {
      value: order,
    });
  }
  checkSurfaceShape(s);
  const tol = resolveTolerances();
  const uu = checkParam(s.u, u, side?.u, tol);
  const vv = checkParam(s.v, v, side?.v, tol);
  const sc = ownScratch(s, order);
  evalSurfaceSpan(
    s,
    uu,
    vv,
    spanOf(s.u, uu, side?.u === 'left'),
    spanOf(s.v, vv, side?.v === 'left'),
    order,
    sc,
  );
  const f = sc.f;
  const o = sc.oS;
  const first = { S: point3(f, o), Su: point3(f, o + 3), Sv: point3(f, o + 6) };
  if (order === 1) return Object.freeze(first);
  return Object.freeze({
    ...first,
    Suu: point3(f, o + 9),
    Suv: point3(f, o + 12),
    Svv: point3(f, o + 15),
  });
}

// ---------------------------------------------------------------------------
// Iso and boundary curves (exact)
// ---------------------------------------------------------------------------

/**
 * The exact isoparametric curve at `fixed = value`: for `fixed = 'u'` the
 * curve in v with homogeneous control points `Qw_j = Σ_i N_i(value) · Pw_ij`
 * and the surface's v basis (shared by reference), so it evaluates to
 * `S(value, v)` for every v (bit for bit: the same sums in the same order);
 * `'v'` likewise in u (the same sums re-associated). A polynomial surface
 * gives a polynomial curve (weights exactly 1, since `Σ N_i = 1`). `value` is validated as in
 * {@link surfacePoint} (right-hand limit at a knot; the surface is continuous
 * there unless a full-multiplicity knot splits it).
 */
export function isoCurve(s: NurbsSurface, fixed: ParamDir, value: number): NurbsCurve<3> {
  checkSurfaceShape(s);
  if (fixed !== 'u' && fixed !== 'v')
    fail('unsupported', `fixed must be 'u' or 'v'; got ${String(fixed)}`);
  const b = fixed === 'u' ? s.u : s.v;
  const t = checkParam(b, value, undefined, resolveTolerances());
  const sc = ownScratch(s, 0);
  const span = spanOf(b, t, false);
  evalBasisInto(b, t, span, 0, sc, sc.oN, sc.oWin);
  const N = sc.f;
  const nv = s.v.count;
  const p = b.degree;
  const iw = sc.iw;
  const Pw = s.cw;
  if (fixed === 'u') {
    spanOffsets(b, span, nv * 4, iw, 0);
    const cw = new Float64Array(nv * 4);
    for (let j = 0; j < nv; j++) {
      // The same accumulation order as A3.6's temp[s] (bitwise S(value, v) when polynomial).
      let x = 0.0;
      let y = 0.0;
      let z = 0.0;
      let w = 0.0;
      for (let r = 0; r <= p; r++) {
        const n = N[sc.oN + r]!;
        const i = iw[r]! + j * 4;
        x += n * Pw[i]!;
        y += n * Pw[i + 1]!;
        z += n * Pw[i + 2]!;
        w += n * Pw[i + 3]!;
      }
      cw[j * 4] = x;
      cw[j * 4 + 1] = y;
      cw[j * 4 + 2] = z;
      cw[j * 4 + 3] = s.rational ? w : 1; // Σ N_i = 1: keep a polynomial surface's iso polynomial
    }
    return curveFromHomogeneous({ dim: 3, basis: s.v, cw });
  }
  const nu = s.u.count;
  spanOffsets(b, span, 4, iw, 0);
  const cw = new Float64Array(nu * 4);
  for (let i = 0; i < nu; i++) {
    let x = 0.0;
    let y = 0.0;
    let z = 0.0;
    let w = 0.0;
    for (let c = 0; c <= p; c++) {
      const n = N[sc.oN + c]!;
      const k = i * nv * 4 + iw[c]!;
      x += n * Pw[k]!;
      y += n * Pw[k + 1]!;
      z += n * Pw[k + 2]!;
      w += n * Pw[k + 3]!;
    }
    cw[i * 4] = x;
    cw[i * 4 + 1] = y;
    cw[i * 4 + 2] = z;
    cw[i * 4 + 3] = s.rational ? w : 1;
  }
  return curveFromHomogeneous({ dim: 3, basis: s.u, cw });
}

/**
 * A natural boundary as an exact curve: the first or last row (`u0`, `u1`: a
 * curve in v) or column (`v0`, `v1`: a curve in u) of the net, with the other
 * direction's basis. Only a clamped direction has boundaries (`unsupported`
 * for an edge across a periodic direction).
 */
export function boundaryCurve(s: NurbsSurface, edge: SurfaceEdge): NurbsCurve<3> {
  checkSurfaceShape(s);
  if (edge !== 'u0' && edge !== 'u1' && edge !== 'v0' && edge !== 'v1') {
    fail('unsupported', `edge must be u0, u1, v0 or v1; got ${String(edge)}`);
  }
  const fixedU = edge[0] === 'u';
  const b = fixedU ? s.u : s.v;
  if (b.kind !== 'clamped') {
    fail(
      'unsupported',
      `edge ${edge} crosses the periodic ${edge[0]} direction: no natural boundary`,
    );
  }
  const nu = s.u.count;
  const nv = s.v.count;
  const last = edge[1] === '1';
  if (fixedU) {
    const i = last ? nu - 1 : 0;
    const cw = (s.cw as Float64Array).slice(i * nv * 4, (i + 1) * nv * 4);
    return curveFromHomogeneous({ dim: 3, basis: s.v, cw });
  }
  const j = last ? nv - 1 : 0;
  const cw = new Float64Array(nu * 4);
  for (let i = 0; i < nu; i++) {
    for (let c = 0; c < 4; c++) cw[i * 4 + c] = s.cw[(i * nv + j) * 4 + c]!;
  }
  return curveFromHomogeneous({ dim: 3, basis: s.u, cw });
}

// ---------------------------------------------------------------------------
// Affine maps and bounds
// ---------------------------------------------------------------------------

/** The image under a row-major 3×4 affine map (NURBS are affinely invariant); weights and bases kept. */
export function transformSurface(s: NurbsSurface, m: Affine3): NurbsSurface {
  checkSurfaceShape(s);
  checkAffine(m, 12);
  const n = s.u.count * s.v.count;
  const cw = new Float64Array(n * 4);
  for (let k = 0; k < n; k++) {
    const q = k * 4;
    const x = s.cw[q]!;
    const y = s.cw[q + 1]!;
    const z = s.cw[q + 2]!;
    const w = s.cw[q + 3]!;
    cw[q] = m[0] * x + m[1] * y + m[2] * z + m[3] * w;
    cw[q + 1] = m[4] * x + m[5] * y + m[6] * z + m[7] * w;
    cw[q + 2] = m[8] * x + m[9] * y + m[10] * z + m[11] * w;
    cw[q + 3] = w;
  }
  return freezeSurface(s.u, s.v, cw, s.rational);
}

/** Axis-aligned bound of the Euclidean control points (contains the surface: convex hull property). */
export function surfaceBounds(s: NurbsSurface): Box3 {
  checkSurfaceShape(s);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const n = s.u.count * s.v.count;
  for (let k = 0; k < n; k++) {
    const w = s.cw[k * 4 + 3]!;
    for (let c = 0; c < 3; c++) {
      const x = s.cw[k * 4 + c]! / w;
      if (x < min[c]!) min[c] = x;
      if (x > max[c]!) max[c] = x;
    }
  }
  return Object.freeze({
    min: { x: min[0]!, y: min[1]!, z: min[2]! },
    max: { x: max[0]!, y: max[1]!, z: max[2]! },
  });
}

/**
 * The magnitude `M` of the `(p + 1)(q + 1)` control points of one span pair
 * (offsets `R[ro + r] + C[co + s]` into `Pw`): their largest absolute
 * Euclidean coordinate, `max |x_i| / w_i` (one division per point), the
 * curves' `M` (`speedFloor`). It is the scale of the rounding in the
 * derivatives evaluated there. (A bound such as `max |Pw| / min w` would be
 * up to the weight ratio too large and flag regular points of a strongly
 * weighted patch as degenerate.)
 */
export function localMagnitude(
  Pw: ReadonlyF64,
  p: number,
  q: number,
  R: Int32Array,
  ro: number,
  C: Int32Array,
  co: number,
): number {
  let M = 0;
  for (let r = 0; r <= p; r++) {
    for (let c = 0; c <= q; c++) {
      const i = R[ro + r]! + C[co + c]!;
      let a = Math.abs(Pw[i]!);
      const y = Math.abs(Pw[i + 1]!);
      const z = Math.abs(Pw[i + 2]!);
      if (y > a) a = y;
      if (z > a) a = z;
      const x = a / Pw[i + 3]!;
      if (x > M) M = x;
    }
  }
  return M;
}
