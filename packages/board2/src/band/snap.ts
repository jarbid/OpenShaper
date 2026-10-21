// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Boundary rows onto the surfaces (docs/design/board2.md §5.5, stage 9 of §6.3).
 *
 * Rows 0 (deck edge) and 6 (tuck) are built with exact plan curves: their x, y
 * control points are the Schoenberg samples of the profile construction on the
 * band basis, so their plan curves, and the pcurves on the height fields (the
 * affine image, §3.4), are exact and never refitted. Only z is fitted: the
 * edge's height over the parameter, `z(u) = F(x(u), y(u))` with F the deck or
 * the bottom, is a smooth function of the **same** parameter, approximated by
 * least squares on the band basis itself (geom's `approximateCurve`, periodic,
 * fixed knots, no parameter correction: x and y are exact, so the foot of each
 * sample is known). Because x and y are reproduced exactly, the 3D distance
 * from the edge curve to the surface is at most this vertical error (the
 * surface is a graph), and the B-rep's edge gap is the fit's.
 *
 * The fit is verified, not trusted: `verifyFactor ×` denser samples than it
 * used, between its own (geom's `EdgeFitSampling` record, `build.edgeFit`).
 * Where a span's verified error is above `safety · fit` and the whole row is
 * above `Tolerances.fit`, that span is reported so the band loop (§5.4) refines
 * it: the band basis grows by knot insertion like every other refinement, so
 * the rows are rebuilt on it and stay one spline space (§5.5 item 4).
 *
 * Deviation from §5.5 items 3–4 (recorded in board2.md, S3 as built): geom's
 * `curveOnSurfaceTo3d` fits a **clamped** curve over one period, whose
 * full-multiplicity end knots cannot join a periodic band basis without a C⁰
 * seam, so the z-fit is this periodic least squares on the band basis, with the
 * same verification and refinement rules.
 */
import {
  approximateCurve,
  controlPointsInto,
  createScratch,
  curveEvalInto,
} from '@openshaper/geom';
import type {
  EdgeFitSampling,
  GeomIssue,
  PeriodicBasis,
  PeriodicCurve,
  Tolerances,
} from '@openshaper/geom';
import type { HeightSample } from '../height-field';
import type { Span } from './stations';

/** The z-fit of one boundary row. */
export interface SnapFit {
  /** The fitted control heights, one per band column. */
  readonly z: Float64Array;
  /** Largest verified vertical error per span of the band basis (cm). */
  readonly spanError: Float64Array;
  readonly maxError: number;
}

/** A snap that geom could not fit (its issues). */
export interface SnapFailure {
  readonly issues: readonly GeomIssue[];
}

/**
 * Fits the height of the plan curve `xy` (a row on the band basis) over the
 * surface sampled by `height` (module comment).
 */
export function snapRow(
  basis: PeriodicBasis,
  spans: readonly Span[],
  xy: PeriodicCurve<2>,
  height: (x: number, y: number) => HeightSample,
  sampling: EdgeFitSampling,
  tol: Tolerances,
): SnapFit | SnapFailure {
  const per = sampling.samplesPerSpan;
  const sc = createScratch({ maxDegree: basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  const zAt = (u: number): number => {
    curveEvalInto(xy, u, 0, q, 0, sc);
    return height(q[0]!, q[1]!).z;
  };
  const params = new Float64Array(spans.length * per);
  const data = new Float64Array(spans.length * per);
  let k = 0;
  for (const s of spans) {
    for (let j = 0; j < per; j++) {
      const u = s.a + ((s.b - s.a) * j) / per;
      params[k] = u;
      data[k++] = zAt(u);
    }
  }
  const fit = approximateCurve(data, 1, {
    degree: basis.degree,
    periodic: true,
    knots: basis.knots,
    params,
    tol,
  });
  if (!fit.ok) return { issues: fit.issues };
  const curve = fit.value.curve;
  const z = new Float64Array(basis.count);
  controlPointsInto(curve, z, 0);
  // Verification between the fit's samples.
  const nv = per * sampling.verifyFactor;
  const spanError = new Float64Array(spans.length);
  const out = new Float64Array(1);
  let maxError = 0;
  spans.forEach((s, i) => {
    let e = 0;
    for (let j = 0; j < nv; j++) {
      const u = s.a + ((s.b - s.a) * (j + 0.5)) / nv;
      curveEvalInto(curve, u, 0, out, 0, sc);
      e = Math.max(e, Math.abs(out[0]! - zAt(u)));
    }
    spanError[i] = e;
    maxError = Math.max(maxError, e);
  });
  return Object.freeze({ z, spanError, maxError });
}
