// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curves on surfaces (design §6.15): a 2D curve in a surface's parameter
 * domain (a pcurve) composed with the surface, `C(t) = S(u(t), v(t))`.
 *
 * - **Evaluation** composes the two evaluation cores. Derivatives follow the
 *   chain rule (second order: P&T eq. 6.10's composition, written out):
 *
 *       C′  = Su·u′ + Sv·v′
 *       C″  = Suu·u′² + 2·Suv·u′·v′ + Svv·v′² + Su·u″ + Sv·v″
 *
 *   They are right-hand limits in `t` (the pcurve's default side, §4.6). At a
 *   surface knot line the surface side is the one the pcurve moves into: left
 *   in u when `u′ < 0` (or `u′ = 0` and `u″ < 0`), likewise in v, so the
 *   derivatives are the curve's own right-hand derivatives also where the
 *   surface is only C⁰ across the line.
 * - **Domain.** A pcurve must stay inside the surface's domain in clamped
 *   directions (within `paramRel` of its length); in periodic directions it may
 *   run past one period, and evaluation wraps (§4.4). {@link curveOnSurface}
 *   checks this once; the `*Into` kernel then clamps or wraps and never
 *   throws.
 * - **Projection to pcurve samples.** {@link projectCurveSamplesToSurface}
 *   projects a 3D curve's points at given parameters onto a surface (warm
 *   started, globally seeded on failure: project.ts), unwraps periodic
 *   directions so the samples are continuous, and reports every distance. The
 *   samples are the input of the same-parameter pcurve fit
 *   (`projectCurveToSurface`), which needs Track A's least squares and lands
 *   at integration (geom-core.md §18).
 */
import { checkOut, makeScratch, scratchFor } from './array';
import type { Scratch, ScratchImpl } from './array';
import { checkParam, clampedBasis, sanitizeParam, spanOf } from './basis';
import { checkBasisShape, evalCurveSpan, makeCurve } from './curve';
import { fail } from './errors';
import {
  checkSeeding,
  directionCells,
  prepareSurface,
  projectSurfaceBatch,
  sampleAt,
} from './project';
import type { ProjectionSeeding } from './project';
import { checkSurfaceShape, evalSurfaceSpan } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Basis,
  ClampedCurve,
  CurveOnSurface,
  NurbsCurve,
  NurbsSurface,
  ParamDir,
  Point3,
  ReadonlyF64,
} from './types';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** O(1) structural check of a curve-on-surface record. */
function checkShape(cs: CurveOnSurface, what: string): void {
  if (typeof cs !== 'object' || cs === null) fail('size-mismatch', `${what}: expected a record`);
  checkSurfaceShape(cs.surface);
  const pc = cs.pcurve;
  if (typeof pc !== 'object' || pc === null) fail('size-mismatch', `${what}: expected a pcurve`);
  checkBasisShape(pc.basis);
  if (pc.dim !== 2) {
    fail('dimension-mismatch', `${what}: a pcurve is 2D (u, v); got dimension ${pc.dim}`, {
      value: pc.dim,
    });
  }
  if (!(pc.cw instanceof Float64Array) || pc.cw.length !== pc.basis.count * 3) {
    fail('size-mismatch', `${what}: pcurve net does not match its basis (use makeCurve)`);
  }
}

/** The largest degree among the pcurve and both surface directions (scratch capacity). */
function maxDegree(cs: CurveOnSurface): number {
  return Math.max(cs.pcurve.basis.degree, cs.surface.u.degree, cs.surface.v.degree);
}

/**
 * The largest value of `sign · x_k(t)` on one span `[a, b]` of the pcurve:
 * the best of `m` uniform samples, refined by Newton on `x_k′ = 0` inside the
 * span (a step is taken only where `sign · x_k″ < 0`, and kept only if it
 * increases the value; stop at a step `≤ paramRel ×` the domain length or
 * after `newtonMaxIter` steps).
 */
function spanExtreme(
  pc: NurbsCurve<2>,
  span: number,
  a: number,
  b: number,
  k: 0 | 1,
  sign: 1 | -1,
  m: number,
  tol: Tolerances,
  sc: ScratchImpl,
): { readonly value: number; readonly t: number } {
  const f = sc.f;
  const o = sc.oC;
  let bt = a;
  let bv = -Infinity;
  for (let i = 0; i < m; i++) {
    const t = sampleAt(a, b, i, m);
    evalCurveSpan(pc, t, span, 0, sc);
    const g = sign * f[o + k]!;
    if (g > bv) {
      bv = g;
      bt = t;
    }
  }
  const [d0, d1] = pc.basis.domain;
  const stepTol = tol.paramRel * (d1 - d0);
  for (let it = 0; it < tol.newtonMaxIter; it++) {
    evalCurveSpan(pc, bt, span, 2, sc);
    const g1 = sign * f[o + 2 + k]!;
    const g2 = sign * f[o + 4 + k]!;
    if (!(g2 < 0)) break;
    let tn = bt - g1 / g2;
    tn = tn < a ? a : tn > b ? b : tn;
    if (!(Math.abs(tn - bt) > stepTol)) break;
    evalCurveSpan(pc, tn, span, 0, sc);
    const gn = sign * f[o + k]!;
    if (!(gn > bv)) break;
    bv = gn;
    bt = tn;
  }
  return { value: bv, t: bt };
}

/**
 * Checks that `pc` stays in the clamped directions of `s`'s domain within
 * `paramRel ×` their length. The control hull test is exact (convex hull
 * property, positive weights) and decides almost every pcurve; a span whose
 * control hull pokes out is searched for its extreme coordinate (samples as
 * dense as projection seeding, then Newton), and a value beyond the slack
 * throws `param-out-of-domain` naming the parameter.
 */
function checkInDomain(
  pc: NurbsCurve<2>,
  s: NurbsSurface,
  tol: Tolerances,
  seeding: ProjectionSeeding,
): void {
  const dirs: readonly [Basis, 0 | 1, ParamDir][] = [
    [s.u, 0, 'u'],
    [s.v, 1, 'v'],
  ];
  const pb = pc.basis;
  const p = pb.degree;
  const cells = directionCells(pb);
  const m = seeding.oversample * p + 1;
  let sc: ScratchImpl | null = null;
  for (const [b, k, name] of dirs) {
    if (b.kind !== 'clamped') continue;
    const [d0, d1] = b.domain;
    const slack = tol.paramRel * (d1 - d0);
    for (let i = 0; i < cells.n; i++) {
      const span = cells.span[i]!;
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j <= p; j++) {
        let idx = span - p + j;
        if (idx < 0) idx += pb.count;
        const x = pc.cw[3 * idx + k]! / pc.cw[3 * idx + 2]!;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      for (const sign of [1, -1] as const) {
        const hullOk = sign === 1 ? hi <= d1 + slack : lo >= d0 - slack;
        if (hullOk) continue;
        sc ??= makeScratch(p, 2);
        const e = spanExtreme(pc, span, cells.a[i]!, cells.b[i]!, k, sign, m, tol, sc);
        const x = sign * e.value;
        if (sign === 1 ? x > d1 + slack : x < d0 - slack) {
          fail(
            'param-out-of-domain',
            `pcurve leaves the surface's ${name} domain [${d0}, ${d1}]: ${name} = ${x} at t = ${e.t}`,
            { t: e.t, value: x },
          );
        }
      }
    }
  }
}

/**
 * A curve on a surface: `surface` with a 2D `pcurve` in its parameter domain.
 * Validates the pair: the pcurve is 2D, and in each clamped direction of the
 * surface it stays inside the domain within `paramRel ×` its length (periodic
 * directions accept any value, wrapped at evaluation). Keeps both by
 * reference; the record is frozen.
 */
export function curveOnSurface(
  surface: NurbsSurface,
  pcurve: NurbsCurve<2>,
  tol?: Partial<Tolerances>,
): CurveOnSurface {
  const cs = Object.freeze({ surface, pcurve });
  checkShape(cs, 'curveOnSurface');
  checkInDomain(pcurve, surface, resolveTolerances(tol), checkSeeding(undefined));
  return cs;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Whether the left-hand limit exists at a sanitized parameter. */
const hasLeft = (b: Basis, x: number): boolean => b.kind === 'periodic' || x > b.domain[0];

/** The pcurve moves to smaller values: `d1 < 0`, or `d1 = 0` and `d2 < 0`. */
const movesBack = (d1: number, d2: number): boolean => d1 < 0 || (d1 === 0 && d2 < 0);

/**
 * The evaluation core: `[C, C′, C″]` to `nDer` at a sanitized pcurve
 * parameter `t` into `out[o …]` (stride 3). With `strict`, the surface
 * parameters are checked like an allocating evaluator's (throwing beyond
 * `paramRel`); otherwise they are clamped or wrapped.
 */
function evalAt(
  cs: CurveOnSurface,
  t: number,
  nDer: number,
  sc: ScratchImpl,
  out: Float64Array,
  o: number,
  strict: Tolerances | null,
): void {
  const { surface: s, pcurve: pc } = cs;
  const f = sc.f;
  evalCurveSpan(pc, t, spanOf(pc.basis, t, false), nDer, sc);
  const c = sc.oC;
  const u = strict ? checkParam(s.u, f[c]!, undefined, strict) : sanitizeParam(s.u, f[c]!);
  const v = strict ? checkParam(s.v, f[c + 1]!, undefined, strict) : sanitizeParam(s.v, f[c + 1]!);
  const du = nDer >= 1 ? f[c + 2]! : 0;
  const dv = nDer >= 1 ? f[c + 3]! : 0;
  const ddu = nDer >= 2 ? f[c + 4]! : 0;
  const ddv = nDer >= 2 ? f[c + 5]! : 0;
  const leftU = nDer >= 1 && movesBack(du, ddu) && hasLeft(s.u, u);
  const leftV = nDer >= 1 && movesBack(dv, ddv) && hasLeft(s.v, v);
  evalSurfaceSpan(s, u, v, spanOf(s.u, u, leftU), spanOf(s.v, v, leftV), nDer, sc);
  const q = sc.oS;
  for (let k = 0; k < 3; k++) {
    out[o + k] = f[q + k]!;
    if (nDer >= 1) {
      const su = f[q + 3 + k]!;
      const sv = f[q + 6 + k]!;
      out[o + 3 + k] = su * du + sv * dv;
      if (nDer >= 2) {
        out[o + 6 + k] =
          f[q + 9 + k]! * du * du +
          2 * f[q + 12 + k]! * du * dv +
          f[q + 15 + k]! * dv * dv +
          su * ddu +
          sv * ddv;
      }
    }
  }
}

function checkNDer(nDer: number): void {
  if (!(nDer === 0 || nDer === 1 || nDer === 2)) {
    fail('unsupported', `curve-on-surface derivative order must be 0, 1 or 2; got ${nDer}`, {
      value: nDer,
    });
  }
}

/**
 * Evaluates `[C, C′, C″]` to order `nDer` (3 values each) into `out[o …]`.
 * Clamps (clamped) or wraps (periodic) `t` and the surface parameters and never
 * throws on them; right-hand limits in `t`. Checks scratch and output sizes.
 */
export function curveOnSurfaceEvalInto(
  cs: CurveOnSurface,
  t: number,
  nDer: 0 | 1 | 2,
  out: Float64Array,
  o: number,
  sc: Scratch,
): void {
  checkNDer(nDer);
  checkShape(cs, 'curveOnSurfaceEvalInto');
  const impl = scratchFor(sc, maxDegree(cs), nDer);
  checkOut(out, o, 3 * (nDer + 1), 'curveOnSurfaceEvalInto');
  evalAt(cs, sanitizeParam(cs.pcurve.basis, t), nDer, impl, out, o, null);
}

const point3 = (a: Float64Array, o: number): Point3 =>
  Object.freeze({ x: a[o]!, y: a[o + 1]!, z: a[o + 2]! });

/**
 * `S(u(t), v(t))`. Throws for `t` outside a clamped pcurve domain (beyond
 * `paramRel`); wraps periodic.
 */
export function curveOnSurfacePoint(cs: CurveOnSurface, t: number): Point3 {
  checkShape(cs, 'curveOnSurfacePoint');
  const tol = resolveTolerances();
  const tt = checkParam(cs.pcurve.basis, t, undefined, tol);
  const out = new Float64Array(3);
  evalAt(cs, tt, 0, makeScratch(maxDegree(cs), 0), out, 0, tol);
  return point3(out, 0);
}

/**
 * `[C, C′]` or `[C, C′, C″]` at `t` by the chain rule (right-hand limits in
 * `t`; the surface side the pcurve moves into). Throws for `t` outside a
 * clamped pcurve domain.
 */
export function curveOnSurfaceDerivatives(
  cs: CurveOnSurface,
  t: number,
  order: 1 | 2,
): readonly Point3[] {
  if (!(order === 1 || order === 2)) {
    fail('unsupported', `derivative order must be 1 or 2; got ${String(order)}`, {
      value: order,
    });
  }
  checkShape(cs, 'curveOnSurfaceDerivatives');
  const tol = resolveTolerances();
  const tt = checkParam(cs.pcurve.basis, t, undefined, tol);
  const out = new Float64Array(3 * (order + 1));
  evalAt(cs, tt, order, makeScratch(maxDegree(cs), order), out, 0, tol);
  const pts: Point3[] = [];
  for (let k = 0; k <= order; k++) pts.push(point3(out, 3 * k));
  return Object.freeze(pts);
}

/**
 * The exact pcurve of an iso-line: for `fixed = 'u'` the degree-1 segment
 * `t ↦ (value, t)` over the surface's v domain (one period `[t_0, t_0 + T]` if
 * v is periodic), so it is the same-parameter pcurve of
 * `isoCurve(s, 'u', value)`; `'v'` likewise `t ↦ (t, value)` over the u
 * domain. Linear in `t` up to the rounding of the degree-1 basis (a few
 * ulps). `value` is validated as in `isoCurve` (wrapped in a periodic
 * direction).
 */
export function isoLinePcurve(s: NurbsSurface, fixed: ParamDir, value: number): ClampedCurve<2> {
  checkSurfaceShape(s);
  if (fixed !== 'u' && fixed !== 'v') {
    fail('unsupported', `fixed direction must be 'u' or 'v'; got ${String(fixed)}`);
  }
  const tol = resolveTolerances();
  const [fb, rb] = fixed === 'u' ? [s.u, s.v] : [s.v, s.u];
  const c = checkParam(fb, value, undefined, tol);
  const [a, b] = rb.domain;
  const e = rb.kind === 'periodic' ? a + rb.period : b;
  const points = fixed === 'u' ? [c, a, c, e] : [a, c, e, c];
  return makeCurve({ dim: 2, basis: clampedBasis(1, [a, a, e, e]), points });
}

// ---------------------------------------------------------------------------
// Projection of a 3D curve to pcurve samples
// ---------------------------------------------------------------------------

/** A 3D curve projected onto a surface at given parameters (input of a pcurve fit). */
export interface PcurveSamples {
  /** The curve parameters, as given (validated; periodic ones not wrapped). */
  readonly t: ReadonlyF64;
  /**
   * `(u, v)` of each sample's closest surface point, stride 2. Periodic
   * directions are unwrapped: each value is shifted by whole periods to lie
   * within half a period of the previous one, so consecutive samples are
   * continuous and a pcurve fitted through them may run past one period.
   */
  readonly uv: ReadonlyF64;
  /** `|C(t_i) − S(u_i, v_i)|` for each sample. */
  readonly distance: ReadonlyF64;
  /** The largest distance. */
  readonly maxDistance: number;
  /** Samples whose projection did not converge (they still hold the best point found). */
  readonly notConverged: number;
  /** Every projection converged and `maxDistance ≤ fit`: the curve lies on the surface at these samples. */
  readonly withinTolerance: boolean;
}

/**
 * Projects the points `C(ts[i])` of a 3D curve onto `s` (P&T §6.1 point
 * inversion; project.ts): each sample starts Newton from the previous one
 * and is seeded globally when that fails. `ts` must be finite and
 * non-decreasing, inside a clamped curve's domain (periodic ones may run past
 * a period); consecutive samples should be close enough that the closest
 * point moves less than half a period of a periodic surface direction, or the
 * unwrapping cannot tell the direction of travel. At a pole or on a seam the
 * parameter the projection returns is one valid choice, so a curve through a
 * pole gives a jump there.
 */
export function projectCurveSamplesToSurface(
  c: NurbsCurve<3>,
  s: NurbsSurface,
  ts: ArrayLike<number>,
  opts?: { readonly tol?: Partial<Tolerances>; readonly seeding?: Partial<ProjectionSeeding> },
): PcurveSamples {
  if (typeof c !== 'object' || c === null) fail('size-mismatch', 'expected a curve');
  checkBasisShape(c.basis);
  if (c.dim !== 3) {
    fail('dimension-mismatch', `projectCurveSamplesToSurface needs a 3D curve; got ${c.dim}`, {
      value: c.dim,
    });
  }
  if (!(c.cw instanceof Float64Array) || c.cw.length !== c.basis.count * 4) {
    fail('size-mismatch', 'curve net does not match its basis (use makeCurve)');
  }
  checkSurfaceShape(s);
  const tol = resolveTolerances(opts?.tol);
  const seeding = checkSeeding(opts?.seeding);
  const n = ts.length;
  const tv = new Float64Array(n);
  const pts = new Float64Array(3 * n);
  const sc = makeScratch(c.basis.degree, 0);
  for (let i = 0; i < n; i++) {
    const t = ts[i]!;
    const u = checkParam(c.basis, t, undefined, tol);
    if (i > 0 && !(t >= tv[i - 1]!)) {
      fail('size-mismatch', `parameters must be non-decreasing; t[${i}] = ${t} < t[${i - 1}]`, {
        index: i,
        value: t,
      });
    }
    tv[i] = t;
    evalCurveSpan(c, u, spanOf(c.basis, u, false), 0, sc);
    for (let k = 0; k < 3; k++) pts[3 * i + k] = sc.f[sc.oC + k]!;
  }
  const uv = new Float64Array(2 * n);
  const distance = new Float64Array(n);
  const pr = prepareSurface(s, tol, seeding);
  const notConverged = projectSurfaceBatch(pr, pts, n, uv, distance, true, undefined);
  unwrap(uv, 0, s.u);
  unwrap(uv, 1, s.v);
  let maxDistance = 0;
  for (let i = 0; i < n; i++) if (distance[i]! > maxDistance) maxDistance = distance[i]!;
  return Object.freeze({
    t: tv,
    uv,
    distance,
    maxDistance,
    notConverged,
    withinTolerance: notConverged === 0 && maxDistance <= tol.fit,
  });
}

/** Shifts coordinate `k` of each sample by whole periods to within half a period of the previous one. */
function unwrap(uv: Float64Array, k: 0 | 1, b: Basis): void {
  if (b.kind !== 'periodic') return;
  const T = b.period;
  for (let i = 1; 2 * i + k < uv.length; i++) {
    const prev = uv[2 * (i - 1) + k]!;
    const x = uv[2 * i + k]!;
    const shift = Math.round((prev - x) / T);
    if (shift !== 0) uv[2 * i + k] = x + shift * T;
  }
}
