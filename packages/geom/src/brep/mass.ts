// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mass properties of a B-rep (design §6.19): volume, surface area and centroid
 * by the divergence theorem over the faces' trimmed domains
 * (`integrate.ts`, Green's theorem over the loops).
 *
 * With `F` a vector field and `n dA = ±(S_u × S_v) du dv` the outward area
 * element (`−` when `sameSense` is false), `∮ F · n dA = ∫ div F dV`:
 *
 * - volume: `F = (S − c)/3`, `div F = 1`;
 * - first moments about `c`: `F = ((x − c_x)²/2, 0, 0)` gives `∫ (x − c_x) dV`,
 *   likewise `y` and `z`; the centroid is `c + moment / volume`.
 *
 * The volume's `c` is the centre of the faces' control-point bounding box (any `c`
 * is exact for a closed shell; a central one keeps the cancellation small); the
 * moments' `c` is the bounding box's minimum corner (see `referencePoint`).
 */
import { fail } from '../errors';
import { enclosedVolume, integrateTrimmed, surfaceArea } from '../integrate';
import type { SurfaceIntegrand } from '../integrate';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type { Brep, Point3, QuadratureResult, TrimmedSurface } from '../types';
import { trimFace } from './faces';

/** The trimmed surface of every face, or the first face's problem as a thrown `brep-invalid`. */
export function trimmedFaces(b: Brep, tol?: Partial<Tolerances>): TrimmedSurface[] {
  return b.faces.map((f, i) => {
    const { ts, issues } = trimFace(f, tol);
    if (ts === null) {
      const first = issues.find((x) => x.severity === 'error');
      fail('brep-invalid', `face ${i} is not a valid trimmed surface: ${first?.message}`, {
        face: i,
      });
    }
    return ts;
  });
}

/**
 * The signed volume enclosed by the faces' outward normals (positive for an
 * outward-oriented B-rep, negative for an inside-out one).
 */
export function signedVolume(b: Brep, tol?: Partial<Tolerances>): QuadratureResult {
  const tss = trimmedFaces(b, tol);
  return enclosedVolume(
    tss.map((ts, i) => ({ face: ts, sameSense: b.faces[i]!.sameSense })),
    tol,
  );
}

/**
 * The faces' control-point bounding box. Its minimum corner is the reference point
 * `c` of the first moments. Not the centre: for a solid symmetric about the centre a
 * moment integral over a symmetric face is zero, its inner integral is rounding noise,
 * and the adaptive integrators (whose stopping rule is relative to `∫|f|`) never
 * converge on noise. From the minimum corner `x − c_x ≥ 0` on the whole solid, so
 * no symmetry puts a face's integral at zero. A face can still contribute nothing
 * to a component (a wall whose normal has no `z` component), so the moments also
 * carry an absolute target on the solid's scale (see {@link massProperties}).
 */
function controlBox(tss: readonly TrimmedSurface[]): { lo: Point3; hi: Point3 } {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const ts of tss) {
    const s = ts.surface;
    for (let i = 0; i < s.cw.length; i += 4) {
      const w = s.cw[i + 3]!;
      const X = s.cw[i]! / w;
      const Y = s.cw[i + 1]! / w;
      const Z = s.cw[i + 2]! / w;
      if (X < x0) x0 = X;
      if (Y < y0) y0 = Y;
      if (Z < z0) z0 = Z;
      if (X > x1) x1 = X;
      if (Y > y1) y1 = Y;
      if (Z > z1) z1 = Z;
    }
  }
  return { lo: { x: x0, y: y0, z: z0 }, hi: { x: x1, y: y1, z: z1 } };
}

/**
 * Volume, surface area and centroid of the solid. Throws `brep-invalid` if a
 * face's loops do not form a valid trimmed surface. The volume is the signed
 * one: negative for an inside-out B-rep (use `orientBrep`). `QuadratureResult`s
 * carry the integrators' error estimates and convergence flags; the centroid
 * is exact when both moments and volume are (polynomial faces). Adaptive
 * moments meet `quadRel` relative to each face's integral, or absolutely
 * `quadRel · |V| · extent` shared among the faces (`extent` the control box's
 * along that axis, the scale of the moment `∫ (x − c_x) dV ≤ V · extent`), so a
 * face that contributes nothing (rounding noise) to a component converges, and
 * each centroid coordinate is within about `quadRel · extent`.
 *
 * `centroidError` bounds each coordinate's error from the integrators'
 * estimates (`(δM_k + |M_k| · δV / |V|) / |V|`, `M_k` the first moment about the
 * reference corner); `centroidConverged` is true only if the volume and every
 * moment integral converged.
 */
export function massProperties(
  b: Brep,
  tol?: Partial<Tolerances>,
): {
  readonly volume: QuadratureResult;
  readonly area: QuadratureResult;
  readonly centroid: Point3;
  readonly centroidError: Point3;
  readonly centroidConverged: boolean;
} {
  const t = resolveTolerances(tol);
  const tss = trimmedFaces(b, t);
  const volume = enclosedVolume(
    tss.map((ts, i) => ({ face: ts, sameSense: b.faces[i]!.sameSense })),
    t,
  );
  let area = 0;
  let areaErr = 0;
  let areaEvals = 0;
  let areaConverged = true;
  const box = controlBox(tss);
  const c = box.lo;
  const extent = [box.hi.x - c.x, box.hi.y - c.y, box.hi.z - c.z];
  const momentAbs = extent.map((e) => (t.quadRel * Math.abs(volume.value) * e) / tss.length);
  const moment = [0, 0, 0];
  const momentErr = [0, 0, 0];
  let momentsConverged = true;
  tss.forEach((ts, i) => {
    const a = surfaceArea(ts, t);
    area += a.value;
    areaErr += a.errorEstimate;
    areaEvals += a.evaluations;
    areaConverged &&= a.converged;
    const sigma = b.faces[i]!.sameSense ? 1 : -1;
    const s = ts.surface;
    const deg: readonly [number, number] | undefined = s.rational
      ? undefined
      : [4 * s.u.degree - 1, 4 * s.v.degree - 1];
    for (let axis = 0; axis < 3; axis++) {
      const c0 = axis === 0 ? c.x : axis === 1 ? c.y : c.z;
      const integrand: SurfaceIntegrand = (_u, _v, d) => {
        // Component `axis` of S_u × S_v, times (S_axis − c_axis)² / 2.
        const a1 = (axis + 1) % 3;
        const a2 = (axis + 2) % 3;
        const n = d[3 + a1]! * d[6 + a2]! - d[3 + a2]! * d[6 + a1]!;
        const r = d[axis]! - c0;
        return 0.5 * r * r * n;
      };
      const r = integrateTrimmed(ts, integrand, {
        polynomialDegree: deg,
        tol: t,
        absTol: momentAbs[axis]!,
      });
      moment[axis]! += sigma * r.value;
      momentErr[axis]! += r.errorEstimate;
      momentsConverged &&= r.converged;
    }
  });
  const v = volume.value;
  const av = Math.abs(v);
  const coordErr = (k: number): number =>
    (momentErr[k]! + (Math.abs(moment[k]!) * volume.errorEstimate) / av) / av;
  return Object.freeze({
    volume,
    area: Object.freeze({
      value: area,
      errorEstimate: areaErr,
      evaluations: areaEvals,
      converged: areaConverged,
    }),
    centroid: Object.freeze({
      x: c.x + moment[0]! / v,
      y: c.y + moment[1]! / v,
      z: c.z + moment[2]! / v,
    }),
    centroidError: Object.freeze({ x: coordErr(0), y: coordErr(1), z: coordErr(2) }),
    centroidConverged: volume.converged && momentsConverged,
  });
}
