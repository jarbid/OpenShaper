// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's typed arrays as the 3D view's `ExternalSurface`. The view's mesh types
 * are structural, so this only names the pieces; the arrays are shared, never copied.
 */
import type { CurvatureMesh, DeviationMesh, ExternalSurface } from '@openshaper/render3d';
import type { NurbsModel } from './nurbs-viewer';

const surfaces = new WeakMap<object, ExternalSurface>();

/** The scale shown by an exact mode before its curvature has arrived (one update). */
const NO_CURVATURE = { mean: 1, gaussian: 1, radius: [1, 100] as const };

/**
 * The surface of a model: one object per mesh, so it can key an effect. A classic board's
 * surface is `live` (the viewer replaces it on every edit, so a drag never shows the classic
 * hull between answers); a test board is `standalone`.
 *
 * A job that skipped the curvature (a drag, with no exact mode shown) gives zero curvature
 * arrays: the view reads them only in an exact mode, and that mode asks the viewer for
 * curvature, which arrives with the next update.
 */
export function surfaceOf(model: NurbsModel): ExternalSurface {
  const mesh = model.mesh;
  const hit = surfaces.get(mesh);
  if (hit) return hit;
  const n = mesh.positions.length / 3;
  const c = mesh.curvature;
  const curvature: CurvatureMesh = {
    positions: mesh.positions,
    normals: mesh.normals,
    mean: c?.mean ?? new Float32Array(n),
    gaussian: c?.gaussian ?? new Float32Array(n),
    minRadius: c?.minRadius ?? new Float32Array(n).fill(NO_CURVATURE.radius[1]),
    indices: mesh.indices,
    hullIndexCount: mesh.indices.length,
    scale: c?.scale ?? NO_CURVATURE,
    rows: 0,
    cols: 0,
    creases: 0,
  };
  const deviation: DeviationMesh | null = mesh.deviation
    ? {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        deviation: mesh.deviation,
        range: mesh.deviationRange,
        noData: mesh.deviationNoData,
      }
    : null;
  const surface: ExternalSurface = {
    board: model.board,
    tracking: model.board ? 'live' : 'standalone',
    curvature,
    deviation,
  };
  surfaces.set(mesh, surface);
  return surface;
}
