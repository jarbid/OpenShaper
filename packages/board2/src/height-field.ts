// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deck and bottom height fields (docs/design/board2.md §3.4, decision 5).
 *
 * A {@link HeightFieldJSON} stores only z. A control point's x and y are the
 * Greville abscissae of its knots mapped affinely onto the stored extent:
 * `x_ij = x0 + ū_i (x1 − x0)`, `y_ij = y0 + v̄_j (y1 − y0)`. By the linear
 * precision of B-splines (`Σ_i ū_i N_i(u) = u` on a clamped basis), x(u, v) and
 * y(u, v) are then exactly affine, so the surface is the graph z = F(x, y), the
 * (u, v) of a plan point is its affine image, and the pcurve of any plan curve is
 * that curve mapped by the same affine map: exact, no fit.
 *
 * The stringer lines (rocker, deck line) are the exact iso-curves `v = v_s` of the
 * two surfaces, `v_s` the parameter of y = 0 (½ on a symmetric board). They are
 * never stored. A fit or an edit that must reproduce a given line imposes it as
 * `n_u` point conditions at the Greville sites of the stringer
 * ({@link stringerConstraints}): two splines of the same `n_u`-dimensional space
 * that agree at `n_u` Schoenberg–Whitney sites are identical, so the fitted line
 * *is* the target to the solver's `constraint` tolerance (times the collocation
 * condition, which is small for Greville sites).
 */
import {
  clampedBasis,
  curvePoint,
  isoCurve,
  makeSurface,
  surfaceControlPoint,
  transformCurve2,
} from '@openshaper/geom';
import type {
  Affine2,
  Basis,
  ClampedBasis,
  NurbsCurve,
  NurbsSurface,
  SurfaceConstraint,
  Tolerances,
  UV,
} from '@openshaper/geom';
import type { BuiltBoard, HeightFieldJSON, StringerLines, Symmetry } from './types';

/**
 * The Greville abscissae `ū_i = (t_{i+1} + … + t_{i+p}) / p` of every basis
 * function (de Boor's nodes: the abscissae of linear precision,
 * `Σ ū_i N_i(u) = u`). Clamped: from the stored knot vector, so the first is
 * the domain start and the last the domain end exactly. Periodic: from the
 * bi-infinite sequence `t_{k + n} = t_k + T`, so `ū_i` may lie up to one period
 * past the domain start (it is not wrapped: pairing compares values modulo the
 * period).
 */
export function grevilleAbscissae(b: Basis): Float64Array {
  const p = b.degree;
  const n = b.count;
  const out = new Float64Array(n);
  const U = b.knots;
  if (b.kind === 'clamped') {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 1; k <= p; k++) s += U[i + k]!;
      out[i] = s / p;
    }
    return out;
  }
  const T = b.period;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 1; k <= p; k++) {
      const j = i + k;
      // j < 2n always (k ≤ p < n), so one wrap suffices.
      s += j < n ? U[j]! : U[j - n]! + T;
    }
    out[i] = s / p;
  }
  return out;
}

/** The u and v bases of a height field (clamped, validated by geom under `tol`). */
export function heightFieldBases(
  hf: HeightFieldJSON,
  tol?: Partial<Tolerances>,
): { readonly u: ClampedBasis; readonly v: ClampedBasis } {
  return {
    u: clampedBasis(hf.degreeU, hf.knotsU, tol),
    v: clampedBasis(hf.degreeV, hf.knotsV, tol),
  };
}

/**
 * The control points' y in v order: `y0 + v̄_j (y1 − y0)`. With `symmetry`
 * `'mirror-y'` the upper half is the exact negation of the lower half and a
 * middle row is exactly 0 (the build's mirror overwrite, §3.7): on a valid
 * symmetric field (`y0 = −y1`, symmetric knots) this changes each value by
 * rounding only, and makes partner rows mirror images bit for bit.
 */
function rowYs(hf: HeightFieldJSON, v: ClampedBasis, symmetry: Symmetry): Float64Array {
  const g = grevilleAbscissae(v);
  const m = v.count;
  const [y0, y1] = hf.y;
  const ys = new Float64Array(m);
  for (let j = 0; j < m; j++) ys[j] = y0 + g[j]! * (y1 - y0);
  if (symmetry === 'mirror-y') {
    for (let j = 0; j < m; j++) {
      const partner = m - 1 - j;
      if (partner === j) ys[j] = 0;
      else if (partner < j) ys[j] = -ys[partner]!;
    }
  }
  return ys;
}

/**
 * The height field as a geom surface: clamped bases from the stored knots,
 * control points `(x0 + ū_i (x1 − x0), y_j, z_ij)` with `y_j` from
 * {@link rowYs}. Throws geom's error on a basis geom refuses (a revived document
 * never has one).
 */
export function heightFieldSurface(
  hf: HeightFieldJSON,
  symmetry: Symmetry,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const { u, v } = heightFieldBases(hf, tol);
  const gu = grevilleAbscissae(u);
  const ys = rowYs(hf, v, symmetry);
  const [x0, x1] = hf.x;
  const nu = u.count;
  const nv = v.count;
  const points = new Float64Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) {
    const x = x0 + gu[i]! * (x1 - x0);
    for (let j = 0; j < nv; j++) {
      const o = (i * nv + j) * 3;
      points[o] = x;
      points[o + 1] = ys[j]!;
      points[o + 2] = hf.z[i * nv + j]!;
    }
  }
  return makeSurface({ u, v, points });
}

/**
 * The affine map from plan (x, y) to the height field's (u, v), row-major 2×3
 * (geom's `Affine2`): `u = (x − x0)/(x1 − x0)`, `v = (y − y0)/(y1 − y0)`.
 */
export function planToUV(hf: Pick<HeightFieldJSON, 'x' | 'y'>): Affine2 {
  const [x0, x1] = hf.x;
  const [y0, y1] = hf.y;
  const sx = 1 / (x1 - x0);
  const sy = 1 / (y1 - y0);
  return [sx, 0, -x0 * sx, 0, sy, -y0 * sy];
}

/** The (u, v) of a plan point on the height field (the affine map of {@link planToUV}). */
export function uvOfPlanPoint(hf: Pick<HeightFieldJSON, 'x' | 'y'>, x: number, y: number): UV {
  const m = planToUV(hf);
  return { u: m[0] * x + m[2], v: m[4] * y + m[5] };
}

/**
 * The exact pcurve of a plan curve on a height field: the curve mapped by
 * {@link planToUV} (same basis, same weights). The surface evaluated along it
 * has the plan curve's x and y up to rounding (the affine exactness of §3.4).
 */
export function planCurvePcurve<C extends NurbsCurve<2>>(
  curve: C,
  hf: Pick<HeightFieldJSON, 'x' | 'y'>,
): C {
  return transformCurve2(curve, planToUV(hf));
}

/**
 * The v of y = 0 on a height field: `−y0 / (y1 − y0)`, exactly ½ when
 * `y0 = −y1` (the quotient `a / 2a` is exact).
 */
export function stringerParam(hf: Pick<HeightFieldJSON, 'y'>): number {
  const [y0, y1] = hf.y;
  return -y0 / (y1 - y0);
}

/**
 * The v of y = 0 read off a surface built by {@link heightFieldSurface}: its
 * first and last control rows hold y0 and y1 exactly (the Greville abscissae of
 * a clamped basis are exactly 0 and 1 at the ends; a symmetric build stores
 * `y1 = −y0` bitwise).
 */
function surfaceStringerParam(s: NurbsSurface): number {
  const y0 = surfaceControlPoint(s, 0, 0).y;
  const y1 = surfaceControlPoint(s, 0, s.v.count - 1).y;
  return -y0 / (y1 - y0);
}

/**
 * The rocker and deck line (§3.4): the exact iso-curves of the bottom and deck
 * at y = 0, as 3D curves in the height fields' u parameter (x affine in it).
 * Derived, never stored. Takes the two surfaces of a built board, or of anything
 * built by {@link heightFieldSurface}.
 */
export function stringerLines(b: Pick<BuiltBoard, 'deck' | 'bottom'>): StringerLines {
  return Object.freeze({
    rocker: isoCurve(b.bottom, 'v', surfaceStringerParam(b.bottom)),
    deck: isoCurve(b.deck, 'v', surfaceStringerParam(b.deck)),
  });
}

/**
 * The exact stringer identity as fit or edit constraints (§3.4): z at the
 * `n_u` Greville sites `(ū_i, v_s)` equals the target line there. `line` is a
 * 1D spline in the height field's u parameter on the **same** u basis (knots
 * and degree); then the constrained surface's stringer iso-curve and `line`
 * agree at `n_u` Schoenberg–Whitney sites of one `n_u`-dimensional space and are
 * the same spline. Throws (`Error`) when the bases differ: the identity would not
 * hold and a caller must refit the line on the field's basis first.
 */
export function stringerConstraints(
  hf: HeightFieldJSON,
  line: NurbsCurve<1>,
  tol?: Partial<Tolerances>,
): readonly SurfaceConstraint[] {
  const { u } = heightFieldBases(hf, tol);
  if (!sameBasis(u, line.basis)) {
    throw new Error(
      'stringerConstraints: the line must be a spline on the height field’s own u basis',
    );
  }
  const vs = stringerParam(hf);
  const g = grevilleAbscissae(u);
  const out: SurfaceConstraint[] = [];
  for (let i = 0; i < u.count; i++) {
    out.push({
      kind: 'point',
      uv: { u: g[i]!, v: vs },
      value: { x: 0, y: 0, z: curvePoint(line, g[i]!) },
      axes: 4,
    });
  }
  return Object.freeze(out);
}

/** Same kind, degree and knots (exact equality; knots are data, not measurements). */
function sameBasis(a: Basis, b: Basis): boolean {
  if (a.kind !== b.kind || a.degree !== b.degree || a.count !== b.count) return false;
  if (a.knots.length !== b.knots.length) return false;
  for (let k = 0; k < a.knots.length; k++) if (a.knots[k] !== b.knots[k]) return false;
  return true;
}
