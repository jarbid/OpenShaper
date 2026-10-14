// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sample plans: incremental evaluation of fixed parameter sets (design §6.9,
 * §9, decision 18).
 *
 * A plan caches, per sample, everything that depends only on the knots: the
 * span, the basis values and derivatives in each direction, and the net
 * offsets of the control points the sample reads. Per control point it keeps a
 * CSR list of the samples it influences. Evaluating a plan is then only the
 * multiply-adds of A3.6 and the quotient of A4.4, with no span search, no
 * basis recursion and no modular arithmetic; after an edit only the samples
 * of the changed control points are recomputed.
 *
 * - **Validity.** A plan stores polynomial basis values, so it stays valid while
 *   control points and weights change, and is invalidated only by a new
 *   `Basis` (knot insertion, elevation, a revived copy): `planMatches` compares
 *   the bases by identity (`===`), O(1).
 * - **Bitwise.** Every value equals the corresponding allocating or `*Into`
 *   function's: the same kernels run in the same order (positions and
 *   derivatives: `surfaceEvalInto` / `curveEvalInto`; normals: `surfaceNormal`;
 *   curvatures: `principalCurvatures` / `curveCurvatureBatchInto`).
 * - **Locality.** A sample's outputs depend only on the control points it
 *   reads, and on the curve's or surface's `rational` flag: a dirty update
 *   after a change of `rational` must list every control point (see
 *   {@link evalSurfacePlanDirty}).
 * - **Order.** Samples keep the caller's order, so sample `k` is vertex `k` of
 *   the caller's mesh. A tessellation that orders its vertices span-major makes
 *   the touched ids of a dirty update a few contiguous runs.
 * - **Parameters.** Finite parameters are clamped (clamped direction) or wrapped
 *   (periodic) at build time, like the `*Into` kernels; right-hand limits at
 *   knots. A non-finite parameter is a contract violation at build time.
 */
import { checkOut, makeScratch, nextStamp, scratchFor } from './array';
import type { Scratch, ScratchImpl } from './array';
import { evalBasisAt, evalBasisInto, sanitizeParam, spanOf } from './basis';
import { curveDerivsH, curvePointH, polyCurveDerivs, ratCurveDerivs } from './book/curve';
import { polySurfaceDerivs, ratSurfaceDerivs, surfaceDerivsH } from './book/surface';
import { checkCurveShape } from './curve';
import { curvatureAt, speedFloor } from './curve-measure';
import { fail } from './errors';
import {
  checkSurfaceShape,
  localMagnitude,
  spanOffsets,
  surfaceScratch,
  surfaceStride,
} from './surface';
import { MEASURE_K, MEASURE_N, SAMPLE_DEGENERATE, surfaceMeasureAt } from './surface-measure';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type { Basis, NumArray, NurbsCurve, NurbsSurface, ReadonlyF64, ReadonlyI32 } from './types';

/** A plan over fixed `(u, v)` samples of every surface with bases `u` and `v`. */
export interface SurfaceSamplePlan {
  readonly kind: 'surface';
  readonly count: number;
  readonly nDer: 0 | 1 | 2;
  /** Identity is the validity key (`planMatches`). */
  readonly u: Basis;
  readonly v: Basis;
  /** The sanitized parameters, stride 2, in the caller's order. */
  readonly uv: ReadonlyF64;
  readonly spanU: ReadonlyI32;
  readonly spanV: ReadonlyI32;
  /** `count × (nDer + 1) × (p + 1)`: A2.3's `ders[k][r]` per sample. */
  readonly basisU: ReadonlyF64;
  /** `count × (nDer + 1) × (q + 1)`. */
  readonly basisV: ReadonlyF64;
  /** `count × (p + 1)`: net offset `i · v.count · 4` of each u row a sample reads. */
  readonly rowOff: ReadonlyI32;
  /** `count × (q + 1)`: net offset `j · 4` of each v column a sample reads. */
  readonly colOff: ReadonlyI32;
  /** CSR over control points (flat `i · v.count + j`): samples of `cp` are `cpSamples[cpStart[cp] … cpStart[cp + 1])`, ascending. */
  readonly cpStart: ReadonlyI32;
  readonly cpSamples: ReadonlyI32;
  /** Tolerances for the degenerate-normal and umbilic flags. */
  readonly tol: Tolerances;
}

/** A plan over fixed parameters of every curve with basis `basis`. */
export interface CurveSamplePlan {
  readonly kind: 'curve';
  readonly count: number;
  readonly nDer: 0 | 1 | 2 | 3;
  /** Identity is the validity key. */
  readonly basis: Basis;
  /** The sanitized parameters, in the caller's order. */
  readonly t: ReadonlyF64;
  readonly span: ReadonlyI32;
  /** `count × (nDer + 1) × (p + 1)`. */
  readonly basisT: ReadonlyF64;
  /** `count × (p + 1)`: the control point index each basis function multiplies (wrapped). */
  readonly cpIndex: ReadonlyI32;
  readonly cpStart: ReadonlyI32;
  readonly cpSamples: ReadonlyI32;
  /** Tolerances for the degenerate-tangent flag. */
  readonly tol: Tolerances;
}

/**
 * Output buffers of a plan evaluation; each one given must hold `count` samples.
 *
 * - `position`: stride 3 (curves: `dim`).
 * - `normal` (surfaces, `nDer ≥ 1`): stride 3; `(0, 0, 0)` with
 *   `SAMPLE_DEGENERATE` where the normal is undefined.
 * - `curvature` (`nDer = 2`; curves `nDer ≥ 2`): surfaces stride 2 (`k1, k2`,
 *   zero when degenerate); curves stride 1 (signed in 2D, unsigned in 3D, as
 *   `curveCurvatureBatchInto`).
 * - `derivatives`: the raw derivatives, stride 3, 9 or 18 for surfaces
 *   (`surfaceEvalInto`'s layout for the plan's `nDer`), `(nDer + 1) · dim` for
 *   curves.
 * - `flags`: `SAMPLE_DEGENERATE | SAMPLE_UMBILIC` (curves: `SAMPLE_DEGENERATE`
 *   where the tangent is degenerate); 0 when `nDer = 0`.
 */
export interface SampleOutputs {
  readonly position?: NumArray;
  readonly normal?: NumArray;
  readonly curvature?: NumArray;
  readonly derivatives?: Float64Array;
  readonly flags?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function checkFinite(a: ArrayLike<number>, what: string): void {
  for (let k = 0; k < a.length; k++) {
    if (!Number.isFinite(a[k]!)) {
      fail('non-finite', `${what} ${k} is not finite: ${a[k]}`, { index: k, value: a[k] });
    }
  }
}

/** CSR from `count` samples each reading `per` control points listed in `cps` (flat). */
function buildCsr(
  cps: Int32Array,
  count: number,
  per: number,
  nCp: number,
): { cpStart: Int32Array; cpSamples: Int32Array } {
  const cpStart = new Int32Array(nCp + 1);
  for (let k = 0; k < count * per; k++) cpStart[cps[k]! + 1]!++;
  for (let c = 0; c < nCp; c++) cpStart[c + 1] = cpStart[c + 1]! + cpStart[c]!;
  const fill = Int32Array.from(cpStart.subarray(0, nCp));
  const cpSamples = new Int32Array(count * per);
  for (let k = 0; k < count; k++) {
    for (let r = 0; r < per; r++) {
      const c = cps[k * per + r]!;
      cpSamples[fill[c]!] = k;
      fill[c]!++;
    }
  }
  return { cpStart, cpSamples };
}

function checkNDer(nDer: number, max: number): void {
  if (!Number.isInteger(nDer) || nDer < 0 || nDer > max) {
    fail('unsupported', `plan derivative order must be an integer in [0, ${max}]; got ${nDer}`, {
      value: nDer,
    });
  }
}

/**
 * A plan for the samples `uv` (stride 2: `u_k, v_k`) of every surface sharing
 * the bases of `s`, with derivatives to `nDer` (1 for normals, 2 for
 * curvatures). Cost O(count · (p + q)²); memory about
 * `count · ((nDer + 1)(p + q + 2) · 8 + (p + 1)(q + 1) · 4 + …)` bytes.
 */
export function planSurfaceSamples(
  s: NurbsSurface,
  uv: ArrayLike<number>,
  nDer: 0 | 1 | 2,
  tol?: Partial<Tolerances>,
): SurfaceSamplePlan {
  checkSurfaceShape(s);
  checkNDer(nDer, 2);
  if (uv.length % 2 !== 0) fail('size-mismatch', `uv needs pairs; got ${uv.length} values`);
  checkFinite(uv, 'parameter');
  const t = resolveTolerances(tol);
  const count = uv.length / 2;
  const bu = s.u;
  const bv = s.v;
  const p = bu.degree;
  const q = bv.degree;
  const nu = bu.count;
  const nv = bv.count;
  const sc = makeScratch(p > q ? p : q, nDer);
  const nbU = (nDer + 1) * (p + 1);
  const nbV = (nDer + 1) * (q + 1);
  const params = new Float64Array(2 * count);
  const spanU = new Int32Array(count);
  const spanV = new Int32Array(count);
  const basisU = new Float64Array(count * nbU);
  const basisV = new Float64Array(count * nbV);
  const rowOff = new Int32Array(count * (p + 1));
  const colOff = new Int32Array(count * (q + 1));
  const cps = new Int32Array(count * (p + 1) * (q + 1));
  const f = sc.f;
  for (let k = 0; k < count; k++) {
    const u = sanitizeParam(bu, uv[2 * k]!);
    const v = sanitizeParam(bv, uv[2 * k + 1]!);
    params[2 * k] = u;
    params[2 * k + 1] = v;
    const su = spanOf(bu, u, false);
    const sv = spanOf(bv, v, false);
    spanU[k] = su;
    spanV[k] = sv;
    evalBasisInto(bu, u, su, nDer, sc, sc.oN, sc.oWin);
    evalBasisInto(bv, v, sv, nDer, sc, sc.oNv, sc.oWinV);
    for (let j = 0; j < nbU; j++) basisU[k * nbU + j] = f[sc.oN + j]!;
    for (let j = 0; j < nbV; j++) basisV[k * nbV + j] = f[sc.oNv + j]!;
    spanOffsets(bu, su, nv * 4, rowOff, k * (p + 1));
    spanOffsets(bv, sv, 4, colOff, k * (q + 1));
    for (let r = 0; r <= p; r++) {
      const i = rowOff[k * (p + 1) + r]! / (nv * 4);
      for (let c = 0; c <= q; c++) {
        cps[(k * (p + 1) + r) * (q + 1) + c] = i * nv + colOff[k * (q + 1) + c]! / 4;
      }
    }
  }
  const { cpStart, cpSamples } = buildCsr(cps, count, (p + 1) * (q + 1), nu * nv);
  return Object.freeze({
    kind: 'surface',
    count,
    nDer,
    u: bu,
    v: bv,
    uv: params,
    spanU,
    spanV,
    basisU,
    basisV,
    rowOff,
    colOff,
    cpStart,
    cpSamples,
    tol: t,
  });
}

/**
 * A plan for the parameters `ts` of every curve sharing the basis of `c`, with
 * derivatives to `nDer` (2 for curvature).
 */
export function planCurveSamples(
  c: NurbsCurve,
  ts: ArrayLike<number>,
  nDer: 0 | 1 | 2 | 3,
  tol?: Partial<Tolerances>,
): CurveSamplePlan {
  checkCurveShape(c);
  checkNDer(nDer, 3);
  checkFinite(ts, 'parameter');
  const t = resolveTolerances(tol);
  const b = c.basis;
  const p = b.degree;
  const n = b.count;
  const count = ts.length;
  const sc = makeScratch(p, nDer);
  const nb = (nDer + 1) * (p + 1);
  const params = new Float64Array(count);
  const span = new Int32Array(count);
  const basisT = new Float64Array(count * nb);
  const cpIndex = new Int32Array(count * (p + 1));
  const f = sc.f;
  for (let k = 0; k < count; k++) {
    const x = sanitizeParam(b, ts[k]!);
    params[k] = x;
    const sp = spanOf(b, x, false);
    span[k] = sp;
    evalBasisAt(b, x, sp, nDer, sc);
    for (let j = 0; j < nb; j++) basisT[k * nb + j] = f[sc.oN + j]!;
    spanOffsets(b, sp, 1, cpIndex, k * (p + 1));
  }
  const { cpStart, cpSamples } = buildCsr(cpIndex, count, p + 1, n);
  return Object.freeze({
    kind: 'curve',
    count,
    nDer,
    basis: b,
    t: params,
    span,
    basisT,
    cpIndex,
    cpStart,
    cpSamples,
    tol: t,
  });
}

const isSurface = (g: NurbsSurface | NurbsCurve): g is NurbsSurface =>
  (g as NurbsSurface).u !== undefined && (g as NurbsSurface).v !== undefined;

/** Whether `plan` was built for the bases of `g` (identity, O(1)): the plan is valid for `g`. */
export function planMatches(
  plan: SurfaceSamplePlan | CurveSamplePlan,
  g: NurbsSurface | NurbsCurve,
): boolean {
  if (plan.kind === 'surface') return isSurface(g) && plan.u === g.u && plan.v === g.v;
  return !isSurface(g) && plan.basis === (g as NurbsCurve).basis;
}

/**
 * Flat indices (`i · v.count + j` for surfaces, `i` for curves) of the control
 * points whose homogeneous values differ between `a` and `b`, ascending: the
 * input of a dirty update from `a`'s outputs to `b`'s. When `rational` differs
 * every index is returned (the evaluation path changes everywhere). Both must
 * have the same shape (`size-mismatch` otherwise).
 */
export function changedControlPoints(
  a: NurbsSurface | NurbsCurve,
  b: NurbsSurface | NurbsCurve,
): Int32Array {
  let h: number;
  let n: number;
  if (isSurface(a) && isSurface(b)) {
    checkSurfaceShape(a);
    checkSurfaceShape(b);
    if (a.u.count !== b.u.count || a.v.count !== b.v.count) {
      fail('size-mismatch', 'surfaces have different control nets');
    }
    h = 4;
    n = a.u.count * a.v.count;
  } else if (!isSurface(a) && !isSurface(b)) {
    checkCurveShape(a);
    checkCurveShape(b);
    if (a.dim !== b.dim || a.basis.count !== b.basis.count) {
      fail('size-mismatch', 'curves have different control polygons');
    }
    h = a.dim + 1;
    n = a.basis.count;
  } else {
    return fail('size-mismatch', 'cannot compare a curve with a surface');
  }
  // A change of `rational` changes the evaluation path (quotient or not) of
  // every sample, so every control point counts as changed.
  if (a.rational !== b.rational) return Int32Array.from({ length: n }, (_, i) => i);
  let m = 0;
  const hit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < h; c++) {
      if (a.cw[i * h + c] !== b.cw[i * h + c]) {
        hit[i] = 1;
        m++;
        break;
      }
    }
  }
  const out = new Int32Array(m);
  for (let i = 0, k = 0; i < n; i++) if (hit[i] === 1) out[k++] = i;
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function checkLen(a: ArrayLike<number> | undefined, need: number, what: string): void {
  if (a !== undefined) checkOut(a, 0, need, what);
}

function checkSurfaceOutputs(plan: SurfaceSamplePlan, out: SampleOutputs): void {
  const n = plan.count;
  checkLen(out.position, n * 3, 'position');
  checkLen(out.derivatives, n * surfaceStride(plan.nDer), 'derivatives');
  checkLen(out.flags, n, 'flags');
  if (out.normal !== undefined) {
    if (plan.nDer < 1) fail('unsupported', 'normals need a plan with nDer ≥ 1');
    checkLen(out.normal, n * 3, 'normal');
  }
  if (out.curvature !== undefined) {
    if (plan.nDer < 2) fail('unsupported', 'curvatures need a plan with nDer = 2');
    checkLen(out.curvature, n * 2, 'curvature');
  }
}

function checkSurfacePlan(plan: SurfaceSamplePlan, s: NurbsSurface): void {
  checkSurfaceShape(s);
  if (plan.kind !== 'surface' || !planMatches(plan, s)) {
    fail(
      'size-mismatch',
      'the plan was built for other bases (planMatches is false); build a new one',
    );
  }
}

/** Whether a pass needs the measure kernel (normals, curvatures or flags). */
function wantsMeasure(plan: SurfaceSamplePlan, out: SampleOutputs): boolean {
  return (
    plan.nDer >= 1 &&
    (out.normal !== undefined || out.curvature !== undefined || out.flags !== undefined)
  );
}

/** Evaluates sample `k` of a surface plan and writes every requested output. */
function surfaceSample(
  plan: SurfaceSamplePlan,
  s: NurbsSurface,
  k: number,
  sc: ScratchImpl,
  measure: boolean,
  out: SampleOutputs,
): void {
  const p = plan.u.degree;
  const q = plan.v.degree;
  const nDer = plan.nDer;
  const f = sc.f;
  const rowOff = plan.rowOff as Int32Array;
  const colOff = plan.colOff as Int32Array;
  surfaceDerivsH(
    p,
    q,
    nDer,
    plan.basisU as Float64Array,
    k * (nDer + 1) * (p + 1),
    plan.basisV as Float64Array,
    k * (nDer + 1) * (q + 1),
    s.cw,
    rowOff,
    k * (p + 1),
    colOff,
    k * (q + 1),
    f,
    sc.oTmp,
    f,
    sc.oSw,
  );
  if (s.rational) ratSurfaceDerivs(f, sc.oSw, nDer, f, sc.oS);
  else polySurfaceDerivs(f, sc.oSw, nDer, f, sc.oS);
  const o = sc.oS;
  const pos = out.position;
  if (pos !== undefined) {
    pos[3 * k] = f[o]!;
    pos[3 * k + 1] = f[o + 1]!;
    pos[3 * k + 2] = f[o + 2]!;
  }
  const der = out.derivatives;
  if (der !== undefined) {
    const st = surfaceStride(nDer);
    for (let j = 0; j < st; j++) der[k * st + j] = f[o + j]!;
  }
  if (!measure) {
    if (out.flags !== undefined) out.flags[k] = 0;
    return;
  }
  const flags = surfaceMeasureAt(
    f,
    o,
    nDer,
    plan.tol.degenerateRel * localMagnitude(s.cw, p, q, rowOff, k * (p + 1), colOff, k * (q + 1)),
    s.u.domain[1] - s.u.domain[0],
    s.v.domain[1] - s.v.domain[0],
    plan.tol.degenerateRel,
    plan.tol.umbilicRel,
    sc.oM,
  );
  const nrm = out.normal;
  if (nrm !== undefined) {
    nrm[3 * k] = f[sc.oM + MEASURE_N]!;
    nrm[3 * k + 1] = f[sc.oM + MEASURE_N + 1]!;
    nrm[3 * k + 2] = f[sc.oM + MEASURE_N + 2]!;
  }
  const crv = out.curvature;
  if (crv !== undefined) {
    crv[2 * k] = f[sc.oM + MEASURE_K]!;
    crv[2 * k + 1] = f[sc.oM + MEASURE_K + 1]!;
  }
  if (out.flags !== undefined) out.flags[k] = flags;
}

/**
 * Evaluates every sample of `plan` on `s` (whose bases the plan was built for)
 * into the requested outputs. Allocates nothing.
 */
export function evalSurfacePlan(
  plan: SurfaceSamplePlan,
  s: NurbsSurface,
  out: SampleOutputs,
  sc: Scratch,
): void {
  checkSurfacePlan(plan, s);
  checkSurfaceOutputs(plan, out);
  const impl = surfaceScratch(s, sc, plan.nDer);
  const measure = wantsMeasure(plan, out);
  for (let k = 0; k < plan.count; k++) surfaceSample(plan, s, k, impl, measure, out);
}

/**
 * In-place heapsort of `a[0 … n)` (ascending). Allocation-free and O(n log n);
 * the touched ids of a dirty update are few, but their union is unordered.
 */
function heapSort(a: Int32Array, n: number): void {
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(a, i, n);
  for (let end = n - 1; end > 0; end--) {
    const t = a[0]!;
    a[0] = a[end]!;
    a[end] = t;
    siftDown(a, 0, end);
  }
}

/** Restores the max-heap property below `root` in `a[0 … end)`. */
function siftDown(a: Int32Array, root: number, end: number): void {
  for (;;) {
    let child = 2 * root + 1;
    if (child >= end) return;
    if (child + 1 < end && a[child + 1]! > a[child]!) child++;
    if (a[root]! >= a[child]!) return;
    const t = a[root]!;
    a[root] = a[child]!;
    a[child] = t;
    root = child;
  }
}

/**
 * Collects the samples of the changed control points, deduplicated by the
 * scratch's generation stamps, sorted ascending into `touched`; returns their
 * count.
 */
function collectTouched(
  cpStart: ReadonlyI32,
  cpSamples: ReadonlyI32,
  count: number,
  nCp: number,
  changed: ReadonlyI32,
  touched: Int32Array,
  sc: ScratchImpl,
): number {
  for (let k = 0; k < changed.length; k++) {
    const c = changed[k]!;
    if (!Number.isInteger(c) || c < 0 || c >= nCp) {
      fail('size-mismatch', `changed control point ${c} is outside [0, ${nCp})`, {
        index: k,
        value: c,
      });
    }
  }
  if (touched.length < count) {
    fail('size-mismatch', `touched needs room for ${count} sample ids; length ${touched.length}`);
  }
  const gen = nextStamp(sc, count);
  const stamp = sc.grow.stamp;
  let n = 0;
  for (let k = 0; k < changed.length; k++) {
    const c = changed[k]!;
    for (let e = cpStart[c]!; e < cpStart[c + 1]!; e++) {
      const id = cpSamples[e]!;
      if (stamp[id] !== gen) {
        stamp[id] = gen;
        touched[n++] = id;
      }
    }
  }
  heapSort(touched, n);
  return n;
}

/**
 * Recomputes only the samples influenced by the control points `changedCps`
 * (flat indices, e.g. from {@link changedControlPoints}); writes their ids,
 * ascending, to `touched` (length ≥ `plan.count`) and returns how many. The
 * outputs then equal a full {@link evalSurfacePlan} of `s` bit for bit,
 * provided they held a full evaluation of the previous surface with the same
 * bases and every control point that changed is listed.
 *
 * **A change of `rational` changes every sample.** Setting the last non-unit
 * weight to 1 (or the first weight away from 1) switches every sample between
 * the polynomial path and the quotient of A4.4, which differ by rounding even
 * where the local weights are all 1. The caller must then list every control
 * point (as {@link changedControlPoints} does) or run a full evaluation;
 * listing only the edited ones leaves the untouched samples on the old path.
 * The kernel cannot detect this: it does not know the previous surface.
 * Everything else a sample depends on (its values, its normal and its
 * degeneracy floors) comes from its own control points only.
 */
export function evalSurfacePlanDirty(
  plan: SurfaceSamplePlan,
  s: NurbsSurface,
  changedCps: ReadonlyI32,
  out: SampleOutputs,
  touched: Int32Array,
  sc: Scratch,
): number {
  checkSurfacePlan(plan, s);
  checkSurfaceOutputs(plan, out);
  const impl = surfaceScratch(s, sc, plan.nDer);
  const n = collectTouched(
    plan.cpStart,
    plan.cpSamples,
    plan.count,
    s.u.count * s.v.count,
    changedCps,
    touched,
    impl,
  );
  const measure = wantsMeasure(plan, out);
  for (let e = 0; e < n; e++) surfaceSample(plan, s, touched[e]!, impl, measure, out);
  return n;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

function checkCurvePlan(plan: CurveSamplePlan, c: NurbsCurve, out: SampleOutputs): void {
  checkCurveShape(c);
  if (plan.kind !== 'curve' || !planMatches(plan, c)) {
    fail(
      'size-mismatch',
      'the plan was built for another basis (planMatches is false); build a new one',
    );
  }
  const n = plan.count;
  checkLen(out.position, n * c.dim, 'position');
  checkLen(out.derivatives, n * (plan.nDer + 1) * c.dim, 'derivatives');
  checkLen(out.flags, n, 'flags');
  if (out.normal !== undefined) fail('unsupported', 'curve plans have no normal output');
  if (out.curvature !== undefined) {
    if (plan.nDer < 2) fail('unsupported', 'curvature needs a plan with nDer ≥ 2');
    if (c.dim === 1) fail('dimension-mismatch', 'curvature needs a curve of dimension 2 or 3');
    checkLen(out.curvature, n, 'curvature');
  }
}

function curveSample(
  plan: CurveSamplePlan,
  c: NurbsCurve,
  k: number,
  sc: ScratchImpl,
  out: SampleOutputs,
): void {
  const p = plan.basis.degree;
  const nDer = plan.nDer;
  const dim = c.dim;
  const h = dim + 1;
  const f = sc.f;
  const idx = plan.cpIndex;
  // Gather the p + 1 control points (the same values evalCurveSpan reads).
  for (let j = 0; j <= p; j++) {
    const src = idx[k * (p + 1) + j]! * h;
    const dst = sc.oPw + j * h;
    for (let d = 0; d < h; d++) f[dst + d] = c.cw[src + d]!;
  }
  const B = plan.basisT as Float64Array;
  const bo = k * (nDer + 1) * (p + 1);
  if (nDer === 0) curvePointH(p, B, bo, f, sc.oPw, h, f, sc.oH);
  else curveDerivsH(p, nDer, B, bo, f, sc.oPw, h, f, sc.oH);
  if (c.rational) ratCurveDerivs(f, sc.oH, dim, nDer, f, sc.oC);
  else polyCurveDerivs(f, sc.oH, dim, nDer, f, sc.oC);
  const o = sc.oC;
  // The sample's own floor (its span's control points), as curveTangent's.
  const floor =
    out.curvature !== undefined || out.flags !== undefined
      ? speedFloor(c, plan.span[k]!, plan.tol)
      : 0;
  const pos = out.position;
  if (pos !== undefined) for (let d = 0; d < dim; d++) pos[k * dim + d] = f[o + d]!;
  const der = out.derivatives;
  if (der !== undefined) {
    const st = (nDer + 1) * dim;
    for (let j = 0; j < st; j++) der[k * st + j] = f[o + j]!;
  }
  if (out.curvature !== undefined) out.curvature[k] = curvatureAt(f, o, dim, floor);
  if (out.flags !== undefined) {
    let degenerate = false;
    if (nDer >= 1) {
      let v = 0;
      for (let d = 0; d < dim; d++) v += f[o + dim + d]! * f[o + dim + d]!;
      degenerate = !(Math.sqrt(v) > floor);
    }
    out.flags[k] = degenerate ? SAMPLE_DEGENERATE : 0;
  }
}

/** Evaluates every sample of a curve plan on `c` into the requested outputs. Allocates nothing. */
export function evalCurvePlan(
  plan: CurveSamplePlan,
  c: NurbsCurve,
  out: SampleOutputs,
  sc: Scratch,
): void {
  checkCurvePlan(plan, c, out);
  const impl = scratchFor(sc, plan.basis.degree, plan.nDer);
  for (let k = 0; k < plan.count; k++) curveSample(plan, c, k, impl, out);
}

/**
 * The curve form of {@link evalSurfacePlanDirty}: flat indices are control
 * point indices. The same contract holds, including that a change of
 * `rational` needs every index (or a full evaluation); the degenerate-tangent
 * floor of a sample comes from its own span's control points (`speedFloor`),
 * so an edit elsewhere never changes it.
 */
export function evalCurvePlanDirty(
  plan: CurveSamplePlan,
  c: NurbsCurve,
  changedCps: ReadonlyI32,
  out: SampleOutputs,
  touched: Int32Array,
  sc: Scratch,
): number {
  checkCurvePlan(plan, c, out);
  const impl = scratchFor(sc, plan.basis.degree, plan.nDer);
  const n = collectTouched(
    plan.cpStart,
    plan.cpSamples,
    plan.count,
    c.basis.count,
    changedCps,
    touched,
    impl,
  );
  for (let e = 0; e < n; e++) curveSample(plan, c, touched[e]!, impl, out);
  return n;
}
