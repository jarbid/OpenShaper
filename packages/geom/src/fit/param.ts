// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Parameterisation and knot placement for fitting (design §6.12): the public
 * wrappers of `book/fit.ts` and the internal helpers the fitters share.
 *
 * Fitters produce the domain `[0, 1]` (clamped) or `[0, 1)` with period 1
 * (periodic), decision 10. Knots computed here snap to one another within
 * `knotRel × domain` (decision 9) before a basis is built from them.
 */
import { clampedBasis, mergeNearKnots, periodicBasis } from '../basis';
import { wrapParam } from '../book/periodic';
import {
  approxKnots,
  approxKnotsPeriodic,
  averageKnots,
  averageKnotsPeriodic,
  chordParams,
} from '../book/fit';
import { fail } from '../errors';
import type { Tolerances } from '../tolerance';
import type { ClampedBasis, Dim, PeriodicBasis } from '../types';

/**
 * How data parameters are spread (P&T §9.2.1): equally (`'uniform'`, eq. 9.3),
 * by chord length (`'chord'`, eq. 9.5), by the square root of chord length
 * (`'centripetal'`, eq. 9.6, the default), or by chord length to any power
 * `exponent ≥ 0` (0, ½ and 1 give the three named methods, bit for bit).
 */
export type Parameterization = 'uniform' | 'chord' | 'centripetal' | { readonly exponent: number };

/** The exponent of a {@link Parameterization} (validated). */
export function exponentOf(method: Parameterization): number {
  if (method === 'uniform') return 0;
  if (method === 'chord') return 1;
  if (method === 'centripetal') return 0.5;
  if (typeof method === 'object' && method !== null && typeof method.exponent === 'number') {
    const e = method.exponent;
    if (!Number.isFinite(e) || e < 0) {
      fail('unsupported', `parameterisation exponent must be finite and ≥ 0; got ${e}`, {
        value: e,
      });
    }
    return e;
  }
  return fail('unsupported', `unknown parameterisation ${JSON.stringify(method)}`);
}

/** True when `x` names a parameterisation rather than giving explicit parameters. */
export function isMethod(x: unknown): x is Parameterization {
  return (
    typeof x === 'string' ||
    (typeof x === 'object' && x !== null && !('length' in x) && 'exponent' in x)
  );
}

function checkDim(dim: unknown): asserts dim is Dim {
  if (dim !== 1 && dim !== 2 && dim !== 3) {
    fail('dimension-mismatch', `dimension must be 1, 2 or 3; got ${String(dim)}`, { value: dim });
  }
}

/** Validates a flat point array of stride `dim`; returns the point count. */
export function pointCount(points: ArrayLike<number>, dim: number, what = 'points'): number {
  checkDim(dim);
  const n = points.length / dim;
  if (!Number.isInteger(n)) {
    fail(
      'size-mismatch',
      `${points.length} ${what} values do not form points of dimension ${dim}`,
      {
        value: points.length,
      },
    );
  }
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i]!)) {
      fail('non-finite', `${what} value ${i} is not finite: ${points[i]}`, {
        index: Math.floor(i / dim),
        value: points[i],
      });
    }
  }
  return n;
}

/**
 * Parameters for `points` (stride `dim`) by `method` (P&T §9.2.1, eqs.
 * 9.3–9.6): `ū_0 = 0`, `ū_{n} = 1` exactly. `closed`: the chord back to the
 * first point counts too, so the `n` parameters lie in `[0, 1)` with period 1.
 * Repeated consecutive points give repeated parameters (harmless to least
 * squares; interpolation rejects them). Throws `too-few-points` for fewer than
 * 2 points, or when every point coincides and the method measures chords.
 */
export function parameterize(
  points: ArrayLike<number>,
  dim: Dim,
  method: Parameterization,
  closed = false,
): Float64Array {
  const n = pointCount(points, dim);
  const e = exponentOf(method);
  if (n < 2) fail('too-few-points', `parameterize needs ≥ 2 points; got ${n}`, { value: n });
  const ub = new Float64Array(n);
  if (chordParams(points, dim, n, e, closed, ub) === 0) {
    fail('too-few-points', 'every point coincides: chords have no length to parameterise by');
  }
  return ub;
}

function checkParams(params: ArrayLike<number>, what: string): Float64Array {
  const ub = new Float64Array(params.length);
  for (let i = 0; i < params.length; i++) {
    const x = params[i]!;
    if (!Number.isFinite(x)) fail('non-finite', `${what} ${i} is not finite: ${x}`, { index: i });
    if (i > 0 && x < ub[i - 1]!) {
      fail(
        'knots-decreasing',
        `${what} must be non-decreasing; ${what} ${i} = ${x} < ${ub[i - 1]}`,
        {
          index: i,
          value: x,
        },
      );
    }
    ub[i] = x;
  }
  return ub;
}

function checkDegree(p: number): void {
  if (!Number.isInteger(p) || p < 1) {
    fail('invalid-degree', `degree must be an integer ≥ 1; got ${p}`, { value: p });
  }
}

/**
 * Eq. 9.8, knots by averaging: the clamped knot vector (`params.length + p + 1`
 * knots) on `[params[0], params[last]]` whose interior knots average `p`
 * consecutive parameters. With it every interpolation system satisfies
 * Schoenberg–Whitney (P&T §9.2.1). Raw formula: no snapping.
 */
export function averagedKnots(params: ArrayLike<number>, degree: number): Float64Array {
  checkDegree(degree);
  const ub = checkParams(params, 'parameter');
  const n = ub.length - 1;
  if (n < degree) {
    fail('too-few-points', `degree ${degree} needs ≥ ${degree + 1} parameters; got ${n + 1}`, {
      value: n + 1,
    });
  }
  if (!(ub[n]! > ub[0]!)) fail('empty-domain', 'parameters span no interval', { value: 0 });
  const U = new Float64Array(n + degree + 2);
  averageKnots(ub, n, degree, U);
  return U;
}

/**
 * Knots for least squares with `count` control points
 * (`degree + 1 ≤ count ≤ params.length`): eqs. 9.68–9.69 with the knots
 * centred (`approxKnots` in `book/fit.ts` says why), so every knot span holds
 * at least one parameter and the basis stays well conditioned up to
 * `count = params.length`. Raw formula: no snapping.
 */
export function lsqKnots(params: ArrayLike<number>, degree: number, count: number): Float64Array {
  checkDegree(degree);
  const ub = checkParams(params, 'parameter');
  const m = ub.length - 1;
  if (!Number.isInteger(count) || count < degree + 1 || count > m + 1) {
    fail(
      'too-few-points',
      `least squares needs degree + 1 ≤ count ≤ parameters (${degree + 1} … ${m + 1}); got ${count}`,
      { value: count },
    );
  }
  if (!(ub[m]! > ub[0]!)) fail('empty-domain', 'parameters span no interval', { value: 0 });
  const U = new Float64Array(count + degree + 1);
  approxKnots(ub, m, count - 1, degree, U);
  return U;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A clamped basis on computed knots, snapped within `knotRel` first (decision 9). */
export function snappedClamped(p: number, U: Float64Array, tol: Tolerances): ClampedBasis {
  return clampedBasis(p, mergeNearKnots(U, tol).knots, tol);
}

/**
 * A periodic basis of period 1 on one period of computed knots
 * `0 = t_0 < … < t_{n−1} < 1`, snapped within `knotRel` (the period end
 * included, so a last knot within `knotRel` of 1 merges into it and the
 * basis then rejects it: the data are too clustered).
 */
export function snappedPeriodic(p: number, T: Float64Array, tol: Tolerances): PeriodicBasis {
  const ext = new Float64Array(T.length + 1);
  ext.set(T);
  ext[T.length] = 1;
  const merged = mergeNearKnots(ext, tol).knots;
  return periodicBasis(p, merged.subarray(0, T.length), 1, tol);
}

/**
 * Periodic knots by averaging ({@link averageKnotsPeriodic}) for increasing
 * parameters in `[0, 1)`, shifted by `τ_0` so the domain is `[0, 1)`
 * (decision 10). Returns the knots and the shift; parameters move by the same
 * shift (`wrapParam(0, 1, ū − shift)`).
 */
export function periodicAveraged(ub: Float64Array, p: number): { T: Float64Array; shift: number } {
  const n = ub.length;
  const T = new Float64Array(n);
  averageKnotsPeriodic(ub, n, p, T);
  const shift = T[0]!;
  for (let j = 0; j < n; j++) T[j] = T[j]! - shift;
  T[0] = 0;
  return { T, shift };
}

/**
 * Periodic least-squares knots ({@link approxKnotsPeriodic}) of degree `p` for
 * sorted parameters in `[0, 1)`, shifted by `τ_0` to start at 0. Returns the
 * knots and the shift; parameters move by the same shift
 * ({@link shiftParams}).
 */
export function periodicLsq(
  sorted: Float64Array,
  count: number,
  p: number,
): { T: Float64Array; shift: number } {
  const T = new Float64Array(count);
  approxKnotsPeriodic(sorted, sorted.length, count, p, T);
  const shift = T[0]!;
  for (let j = 0; j < count; j++) T[j] = T[j]! - shift;
  T[0] = 0;
  return { T, shift };
}

/** Moves parameters of period 1 by `−shift`, wrapped into `[0, 1)`. */
export function shiftParams(ub: Float64Array, shift: number): Float64Array {
  if (shift === 0) return ub;
  return ub.map((u) => wrapParam(0, 1, u - shift));
}
