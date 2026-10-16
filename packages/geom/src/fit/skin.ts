// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Skinning (design §6.12; P&T §10.3): a surface through a sequence of section
 * curves. The sections are made compatible (one degree, one knot vector:
 * `makeCompatible`, A5.9 + A5.4), then each column of homogeneous control
 * points is interpolated across the sections (the A9.1 system, one factor
 * for every column and coordinate). Interpolating `Pw` rather than `P` keeps
 * rational sections (circles, conics) exact: the iso-curve at a section's
 * parameter has the section's homogeneous control points.
 *
 * Orientation follows the book: `u` runs along the sections (their common
 * basis), `v` across them.
 */
import { surfMeshParams } from '../book/fit';
import { makeCompatible } from '../curve-ops';
import { checkCurveShape } from '../curve';
import { fail } from '../errors';
import { surfaceFromHomogeneous } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type { NurbsCurve, NurbsSurface, ReadonlyF64 } from '../types';
import { collocate } from './assemble';
import {
  checkDegree,
  factorSquare,
  interpolationBasis,
  interpParams,
  solveSquare,
} from './interpolate';
import { exponentOf, isMethod } from './param';
import type { Parameterization } from './param';

/** A skinned surface, the `v` parameter of each section, and the measured error. */
export interface SkinResult {
  readonly surface: NurbsSurface;
  /** `v` of section `k`: `isoCurve(surface, 'v', params[k])` reproduces it. */
  readonly params: ReadonlyF64;
  /**
   * The largest distance between a (compatible) section's control point and
   * the matching control point of the surface's iso-curve at its parameter,
   * plus `makeCompatible`'s `maxDeviation`. For polynomial sections this bounds
   * the distance between each section and its iso-curve (the curves share
   * their basis, which is a partition of unity).
   */
  readonly maxError: number;
}

/**
 * Skins `sections` (all clamped or all periodic, one dimension, equal
 * domains): a surface of `degree` across the sections (default
 * `min(3, sections − 1)`), interpolating them at `params` (default
 * `'centripetal'`: A9.3's averaging over the compatible control points, as
 * P&T eq. 10.8 does with chord length). `periodic` closes the surface across
 * the sections (list each section once); its `v` parameters are shifted with
 * the knots so the domain is `[0, 1)`.
 *
 * Rational sections whose weights differ a lot can make an interpolated
 * weight overshoot to ≤ 0 between them (P&T §10.3); the surface factory then
 * throws `weight-not-positive`. Sections with equal weight vectors (circles,
 * conics from one construction) never do: their weights interpolate to
 * themselves.
 */
export function skinCurves(
  sections: readonly NurbsCurve<3>[],
  opts?: {
    readonly degree?: number;
    readonly params?: ArrayLike<number> | Parameterization;
    readonly periodic?: boolean;
    readonly tol?: Partial<Tolerances>;
  },
): SkinResult {
  const tol = resolveTolerances(opts?.tol);
  const K = sections.length;
  for (const c of sections) checkCurveShape(c);
  if (K < 2) fail('too-few-points', `skinning needs ≥ 2 sections; got ${K}`, { value: K });
  for (let k = 0; k < K; k++) {
    if (sections[k]!.dim !== 3) {
      fail(
        'dimension-mismatch',
        `section ${k} has dimension ${sections[k]!.dim}; skinning needs 3`,
        {
          index: k,
        },
      );
    }
  }
  const q = opts?.degree ?? Math.min(3, K - 1);
  checkDegree(q);
  const periodic = opts?.periodic ?? false;
  if (K < q + 1) {
    fail('too-few-points', `degree ${q} across the sections needs ≥ ${q + 1} sections; got ${K}`, {
      value: K,
    });
  }
  const compat = makeCompatible(sections, tol);
  const curves = compat.curves;
  const uBasis = curves[0]!.basis;
  const n = uBasis.count;

  // Grids: homogeneous (n × K, stride 4) to interpolate, Euclidean (stride 3) to parameterise.
  const G = new Float64Array(n * K * 4);
  const E = new Float64Array(n * K * 3);
  for (let k = 0; k < K; k++) {
    const cw = curves[k]!.cw;
    for (let i = 0; i < n; i++) {
      const w = cw[i * 4 + 3]!;
      for (let c = 0; c < 4; c++) G[(i * K + k) * 4 + c] = cw[i * 4 + c]!;
      for (let c = 0; c < 3; c++) E[(i * K + k) * 3 + c] = cw[i * 4 + c]! / w;
    }
  }
  const spec = opts?.params;
  let raw: Float64Array;
  if (spec === undefined || isMethod(spec)) {
    raw = new Float64Array(K);
    if (surfMeshParams(E, n, K, 'v', exponentOf(spec ?? 'centripetal'), periodic, raw) === 0) {
      fail('too-few-points', 'every section control point coincides with its neighbours');
    }
    // Validated as interpolation parameters (strictly increasing, closed below 1).
    raw = interpParams(raw, 1, K, raw, periodic);
  } else {
    raw = interpParams(spec, 1, K, spec, periodic);
  }
  const { ub, basis: vBasis } = interpolationBasis(raw, q, periodic, tol);

  // Centre each homogeneous coordinate (rows sum to 1), solve every column, restore.
  const centre = new Float64Array(4);
  for (let c = 0; c < 4; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < n * K; j++) {
      lo = Math.min(lo, G[j * 4 + c]!);
      hi = Math.max(hi, G[j * 4 + c]!);
    }
    centre[c] = 0.5 * (lo + hi);
  }
  for (let j = 0; j < n * K; j++)
    for (let c = 0; c < 4; c++) G[j * 4 + c] = G[j * 4 + c]! - centre[c]!;
  const col = collocate(vBasis, ub, 0);
  const sq = factorSquare(K, col.p1, col.cols, col.vals, tol);
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) solveSquare(sq, G, i * K * 4 + c, 4);
  for (let j = 0; j < n * K; j++)
    for (let c = 0; c < 4; c++) G[j * 4 + c] = G[j * 4 + c]! + centre[c]!;
  const surface = surfaceFromHomogeneous({ u: uBasis, v: vBasis, cw: G });

  // Iso-curve control points at each section's parameter, against the section's.
  let maxError = 0;
  const h = new Float64Array(4);
  for (let k = 0; k < K; k++) {
    const cw = curves[k]!.cw;
    for (let i = 0; i < n; i++) {
      h.fill(0);
      for (let j = 0; j < col.p1; j++) {
        const m = col.vals[k * col.p1 + j]!;
        const o = (i * K + col.cols[k * col.p1 + j]!) * 4;
        for (let c = 0; c < 4; c++) h[c] = h[c]! + m * G[o + c]!;
      }
      let e2 = 0;
      for (let c = 0; c < 3; c++) {
        const d = h[c]! / h[3]! - cw[i * 4 + c]! / cw[i * 4 + 3]!;
        e2 += d * d;
      }
      maxError = Math.max(maxError, Math.sqrt(e2));
    }
  }
  return Object.freeze({ surface, params: ub, maxError: maxError + compat.maxDeviation });
}
