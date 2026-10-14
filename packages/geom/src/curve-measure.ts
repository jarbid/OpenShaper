// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curve measures: unit tangent, curvature, Frenet frame, arc length and its
 * inverse, control-hull bounds (design §6.4).
 *
 * Degenerate points: where `|C′| ≤ degenerateRel · M / L` (`M` the largest
 * absolute Euclidean control coordinate, `L` the domain length or period; see
 * `Tolerances.degenerateRel`) the tangent is `null` and the curvature, which is
 * undefined there, is reported as 0, so batch outputs stay finite (design §8:
 * never NaN). Check `curveTangent(…) === null` to tell the two apart.
 *
 * Arc length integrates `|C′|` with adaptive Gauss–Kronrod 7–15, split first at
 * every knot (the integrand is smooth inside a span), to `quadRel` relative.
 */
import { checkOut, makeScratch, scratchFor } from './array';
import type { Scratch, ScratchImpl } from './array';
import { checkParam, sanitizeParam, spanOf } from './basis';
import { wrapParam } from './book/periodic';
import { evalCurveSpan, spanFromHint } from './curve';
import { fail } from './errors';
import { adaptivePartition, gk15, integrate1d } from './quadrature';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Box3,
  Interval,
  NurbsCurve,
  Point3,
  PointOf,
  QuadratureResult,
  ReadonlyF64,
  Side,
} from './types';

/**
 * Cumulative arc length at breakpoints from the adaptive integration (design
 * §6.4). A table belongs to the one curve it was built from: `lengthAtParam`
 * and `paramAtLength` reject any other curve, even one with the same domain or
 * an equal copy (a structured clone or a revived curve), because the domain
 * alone cannot tell two curves apart and a wrong table gives plausible but
 * wrong lengths.
 */
export interface ArcLengthTable {
  /** The curve the table was built from (curves are immutable, so identity is ownership). */
  readonly curve: NurbsCurve;
  /** Parameters `t[0] = domain start < … < t[last] = domain end` (periodic: `t_0 + T`). */
  readonly t: ReadonlyF64;
  /** Arc length from the domain start to `t[i]`. */
  readonly s: ReadonlyF64;
  /** Length of the whole domain (one period). */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Local differential geometry
// ---------------------------------------------------------------------------

/** `degenerateRel · M / L`: below this speed `C′` is rounding noise (see the module comment). */
function speedFloor(c: NurbsCurve, t: Tolerances): number {
  const h = c.dim + 1;
  let M = 0;
  for (let i = 0; i < c.basis.count; i++) {
    const w = c.cw[i * h + c.dim]!;
    for (let k = 0; k < c.dim; k++) {
      const x = Math.abs(c.cw[i * h + k]! / w);
      if (x > M) M = x;
    }
  }
  const [a, b] = c.basis.domain;
  return (t.degenerateRel * M) / (b - a);
}

/** `|C′|` from evaluated derivatives at `f[o …]` (stride `dim`). */
function speedAt(f: Float64Array, o: number, dim: number): number {
  let s = 0;
  for (let k = 0; k < dim; k++) s += f[o + dim + k]! * f[o + dim + k]!;
  return Math.sqrt(s);
}

/**
 * Curvature from `[C, C′, C″]` at `f[o …]`: signed `(x′y″ − y′x″)/|C′|³` in 2D,
 * `|C′ × C″|/|C′|³` in 3D, 0 at a degenerate point. Shared by the single and
 * batch entry points so they agree bit for bit.
 */
function curvatureAt(f: Float64Array, o: number, dim: number, floor: number): number {
  const v = speedAt(f, o, dim);
  if (!(v > floor)) return 0;
  const v3 = v * v * v;
  if (dim === 2) {
    return (f[o + 2]! * f[o + 5]! - f[o + 3]! * f[o + 4]!) / v3;
  }
  const [x1, y1, z1] = [f[o + 3]!, f[o + 4]!, f[o + 5]!];
  const [x2, y2, z2] = [f[o + 6]!, f[o + 7]!, f[o + 8]!];
  const cx = y1 * z2 - z1 * y2;
  const cy = z1 * x2 - x1 * z2;
  const cz = x1 * y2 - y1 * x2;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / v3;
}

function checkDimIs(c: NurbsCurve, dims: readonly number[], what: string): void {
  if (!dims.includes(c.dim)) {
    fail(
      'dimension-mismatch',
      `${what} needs a curve of dimension ${dims.join(' or ')}; got ${c.dim}`,
      {
        value: c.dim,
      },
    );
  }
}

/** Evaluates to order `nDer` at a validated parameter (allocating; one scratch). */
function evalAt(c: NurbsCurve, t: number, nDer: number, side: Side | undefined): ScratchImpl {
  const u = checkParam(c.basis, t, side, resolveTolerances());
  const s = makeScratch(c.basis.degree, nDer);
  evalCurveSpan(c, u, spanOf(c.basis, u, side === 'left'), nDer, s);
  return s;
}

/**
 * The unit tangent `C′/|C′|` at `t` (from the given side of a knot), or `null`
 * where the curve is degenerate (`|C′|` at rounding level: a cusp or collapsed
 * control points).
 */
export function curveTangent<D extends 2 | 3>(
  c: NurbsCurve<D>,
  t: number,
  side?: Side,
): PointOf<D> | null {
  checkDimIs(c, [2, 3], 'curveTangent');
  const s = evalAt(c, t, 1, side);
  const f = s.f;
  const o = s.oC;
  const v = speedAt(f, o, c.dim);
  if (!(v > speedFloor(c, resolveTolerances()))) return null;
  const d = o + c.dim;
  if (c.dim === 2) return { x: f[d]! / v, y: f[d + 1]! / v } as PointOf<D>;
  return { x: f[d]! / v, y: f[d + 1]! / v, z: f[d + 2]! / v } as PointOf<D>;
}

/** Unsigned curvature `|C′ × C″| / |C′|³` of a 3D curve; 0 where the tangent is degenerate. */
export function curveCurvature(c: NurbsCurve<3>, t: number, side?: Side): number {
  checkDimIs(c, [3], 'curveCurvature');
  const s = evalAt(c, t, 2, side);
  return curvatureAt(s.f, s.oC, 3, speedFloor(c, resolveTolerances()));
}

/**
 * Signed curvature `(x′y″ − y′x″) / |C′|³` of a planar curve: positive where it
 * turns counter-clockwise (design §4.7); 0 where the tangent is degenerate.
 */
export function curveSignedCurvature(c: NurbsCurve<2>, t: number, side?: Side): number {
  checkDimIs(c, [2], 'curveSignedCurvature');
  const s = evalAt(c, t, 2, side);
  return curvatureAt(s.f, s.oC, 2, speedFloor(c, resolveTolerances()));
}

/**
 * Curvature at every parameter of `ts` into `out[i]`: signed for a 2D curve,
 * unsigned for 3D. Same values as the single-point functions, bit for bit
 * (right-hand limits). Ascending `ts` is amortised O(1) per span search.
 */
export function curveCurvatureBatchInto(
  c: NurbsCurve<2> | NurbsCurve<3>,
  ts: ReadonlyF64,
  out: Float64Array,
  s: Scratch,
): void {
  checkDimIs(c, [2, 3], 'curveCurvatureBatchInto');
  const sc = scratchFor(s, c.basis.degree, 2);
  checkOut(out, 0, ts.length, 'curveCurvatureBatchInto');
  const floor = speedFloor(c, resolveTolerances());
  const b = c.basis;
  let span = -1;
  for (let i = 0; i < ts.length; i++) {
    const u = sanitizeParam(b, ts[i]!);
    span = spanFromHint(b, u, span);
    evalCurveSpan(c, u, span, 2, sc);
    out[i] = curvatureAt(sc.f, sc.oC, c.dim, floor);
  }
}

/**
 * The Frenet frame of a 3D curve at `t`: unit tangent `t`, principal normal `n`
 * (towards the centre of curvature) and binormal `b = t × n`. `null` where the
 * tangent is degenerate or the curve is straight there (`|C′ × C″| ≤
 * sin(angle) · |C′| · |C″|`, so the normal is undefined).
 */
export function curveFrame(
  c: NurbsCurve<3>,
  t: number,
  tol?: Partial<Tolerances>,
): { readonly t: Point3; readonly n: Point3; readonly b: Point3 } | null {
  checkDimIs(c, [3], 'curveFrame');
  const T = resolveTolerances(tol);
  const s = evalAt(c, t, 2, undefined);
  const f = s.f;
  const o = s.oC;
  const v = speedAt(f, o, 3);
  if (!(v > speedFloor(c, T))) return null;
  const [x1, y1, z1] = [f[o + 3]!, f[o + 4]!, f[o + 5]!];
  const [x2, y2, z2] = [f[o + 6]!, f[o + 7]!, f[o + 8]!];
  const bx = y1 * z2 - z1 * y2;
  const by = z1 * x2 - x1 * z2;
  const bz = x1 * y2 - y1 * x2;
  const bl = Math.sqrt(bx * bx + by * by + bz * bz);
  const a2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2);
  if (!(bl > Math.sin(T.angle) * v * a2)) return null;
  const tt = { x: x1 / v, y: y1 / v, z: z1 / v };
  const bb = { x: bx / bl, y: by / bl, z: bz / bl };
  const nn = {
    x: bb.y * tt.z - bb.z * tt.y,
    y: bb.z * tt.x - bb.x * tt.z,
    z: bb.x * tt.y - bb.y * tt.x,
  };
  return Object.freeze({ t: tt, n: nn, b: bb });
}

// ---------------------------------------------------------------------------
// Arc length
// ---------------------------------------------------------------------------

/** `|C′(x)|` as a closure over one scratch (the integrand; never sampled at a knot). */
function speedFunction(c: NurbsCurve): (x: number) => number {
  const s = makeScratch(c.basis.degree, 1);
  const b = c.basis;
  return (x: number): number => {
    const u = sanitizeParam(b, x);
    evalCurveSpan(c, u, spanOf(b, u, false), 1, s);
    return speedAt(s.f, s.oC, c.dim);
  };
}

/** Knot values strictly inside `(a, b)`, periodic knots unrolled; at most `cap` of them. */
function knotsInside(c: NurbsCurve, a: number, b: number, cap: number): number[] {
  const B = c.basis;
  const U = B.knots;
  const out: number[] = [];
  if (B.kind === 'clamped') {
    for (let i = B.degree + 1; i < B.count; i++)
      if (U[i]! > a && U[i]! < b && U[i] !== U[i - 1]) out.push(U[i]!);
    return out;
  }
  const T = B.period;
  const t0 = B.domain[0];
  for (let k = Math.floor((a - t0) / T) - 1; out.length <= cap; k++) {
    const shift = k * T;
    if (U[0]! + shift >= b) break;
    for (let i = 0; i < U.length; i++) {
      const x = U[i]! + shift;
      if (x > a && x < b && (out.length === 0 || x > out[out.length - 1]!)) out.push(x);
    }
  }
  return out;
}

/** The full range of a curve: `[a, b]`, or one period `[t_0, t_0 + T]`. */
function fullRange(c: NurbsCurve): Interval {
  return c.basis.domain;
}

/** Validates a length range: finite; clamped ends inside the domain (paramRel slack, then clamped). */
function checkRange(c: NurbsCurve, range: Interval, t: Tolerances): Interval {
  const [r0, r1] = range;
  if (!Number.isFinite(r0) || !Number.isFinite(r1))
    fail('non-finite', `range [${r0}, ${r1}] is not finite`);
  if (c.basis.kind === 'periodic') return [r0, r1];
  return [checkParam(c.basis, r0, undefined, t), checkParam(c.basis, r1, undefined, t)];
}

/**
 * Arc length over `range` (default: the domain, or one period), by adaptive
 * Gauss–Kronrod 7–15 split at the knots, to `quadRel` relative. Signed: a
 * reversed range gives the negated length. A periodic range may span several
 * periods. `converged: false` reports a cap or rounding limit honestly.
 */
export function curveLength(
  c: NurbsCurve,
  range?: Interval,
  tol?: Partial<Tolerances>,
): QuadratureResult {
  const t = resolveTolerances(tol);
  const [a, b] = range === undefined ? fullRange(c) : checkRange(c, range, t);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return integrate1d(speedFunction(c), a, b, {
    breaks: knotsInside(c, lo, hi, t.quadMaxSplits),
    tol: t,
  });
}

/**
 * The cumulative arc length at the breakpoints of the adaptive integration of
 * the whole domain (one period): every knot plus the subdivisions the error
 * control needed. `total` equals `curveLength(c, undefined, tol).value` bit for bit.
 */
export function arcLengthTable(c: NurbsCurve, tol?: Partial<Tolerances>): ArcLengthTable {
  const t = resolveTolerances(tol);
  const [a, b] = fullRange(c);
  const part = adaptivePartition(speedFunction(c), a, b, knotsInside(c, a, b, t.quadMaxSplits), t);
  const s = new Float64Array(part.x.length);
  // Running Neumaier sum, the same arithmetic as the integrator's total.
  let sum = 0;
  let comp = 0;
  for (let i = 0; i < part.values.length; i++) {
    const v = part.values[i]!;
    const n = sum + v;
    comp += Math.abs(sum) >= Math.abs(v) ? sum - n + v : v - n + sum;
    sum = n;
    s[i + 1] = sum + comp;
  }
  return Object.freeze({ curve: c, t: part.x, s, total: s[s.length - 1]! });
}

/**
 * Ownership by identity: the table must have been built from this very curve
 * object. The shape checks after it guard a hand-made record.
 */
function checkTable(c: NurbsCurve, table: ArcLengthTable): void {
  if (table.curve !== c) {
    fail(
      'size-mismatch',
      'arc-length table was built from a different curve (rebuild it with arcLengthTable(curve))',
    );
  }
  const [a, b] = fullRange(c);
  const n = table.t.length;
  if (n < 2 || table.s.length !== n || table.t[0] !== a || table.t[n - 1] !== b) {
    fail('size-mismatch', 'arc-length table is malformed (rebuild it with arcLengthTable)');
  }
}

/** Largest `k ≤ last` with `xs[k] ≤ x` (xs ascending, `xs[0] ≤ x`). */
function lastAtMost(xs: ReadonlyF64, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Arc length from the domain start to `t`, from a table of this curve: the
 * table's cumulative value plus a K15 panel on the remainder of one
 * already-converged subinterval. A periodic `t` is wrapped into one period.
 */
export function lengthAtParam(c: NurbsCurve, table: ArcLengthTable, t: number): number {
  checkTable(c, table);
  const u = checkParam(c.basis, t, undefined, resolveTolerances());
  const k = lastAtMost(table.t, u);
  if (k === table.t.length - 1 || u === table.t[k]) return table.s[k]!;
  return table.s[k]! + gk15(speedFunction(c), table.t[k]!, u);
}

/**
 * The parameter at arc length `s` from the domain start (inverse of
 * {@link lengthAtParam}): bracketed Newton on one table subinterval, falling
 * back to bisection when a step leaves the bracket; stops when the step is at
 * most `paramRel × domain` or after `newtonMaxIter` steps. A periodic `s` is
 * wrapped into `[0, total)`; a clamped one must lie in `[0, total]` (with
 * `paramRel` relative slack).
 */
export function paramAtLength(
  c: NurbsCurve,
  table: ArcLengthTable,
  s: number,
  tol?: Partial<Tolerances>,
): number {
  checkTable(c, table);
  const T = resolveTolerances(tol);
  if (!Number.isFinite(s)) fail('non-finite', `arc length is not finite: ${s}`, { value: s });
  const total = table.total;
  let target: number;
  if (c.basis.kind === 'periodic') target = total > 0 ? wrapParam(0, total, s) : 0;
  else {
    const slack = T.paramRel * total;
    if (s < -slack || s > total + slack) {
      fail('param-out-of-domain', `arc length ${s} is outside [0, ${total}]`, { value: s });
    }
    target = s < 0 ? 0 : s > total ? total : s;
  }
  const k = lastAtMost(table.s, target);
  const last = table.t.length - 1;
  if (k === last || target === table.s[k]) return table.t[k]!;
  const t0 = table.t[k]!;
  const s0 = table.s[k]!;
  let lo = t0;
  let hi = table.t[k + 1]!;
  const [a, b] = fullRange(c);
  const stop = T.paramRel * (b - a);
  const speed = speedFunction(c);
  const ds = table.s[k + 1]! - s0;
  let x = ds > 0 ? lo + ((hi - lo) * (target - s0)) / ds : lo;
  for (let iter = 0; iter < T.newtonMaxIter; iter++) {
    const g = s0 + gk15(speed, t0, x) - target;
    if (g === 0) return x;
    if (g < 0) lo = x;
    else hi = x;
    const d = speed(x);
    let next = d > 0 ? x - g / d : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const step = Math.abs(next - x);
    x = next;
    if (step <= stop) break;
  }
  return x;
}

/** Axis-aligned bound of the Euclidean control points (contains the curve: convex hull property). */
export function curveBounds(c: NurbsCurve): Box3 {
  const h = c.dim + 1;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.basis.count; i++) {
    const w = c.cw[i * h + c.dim]!;
    for (let k = 0; k < 3; k++) {
      const x = k < c.dim ? c.cw[i * h + k]! / w : 0;
      if (x < min[k]!) min[k] = x;
      if (x > max[k]!) max[k] = x;
    }
  }
  return Object.freeze({
    min: { x: min[0]!, y: min[1]!, z: min[2]! },
    max: { x: max[0]!, y: max[1]!, z: max[2]! },
  });
}
