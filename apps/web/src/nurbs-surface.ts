// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's typed arrays as the 3D view's `ExternalSurface`. The view's mesh types
 * are structural, so this only names the pieces; the arrays are shared, never copied.
 */
import type { CurvatureMesh, DeviationMesh, ExternalSurface } from '@openshaper/render3d';
import type { NurbsModel } from './nurbs-viewer';

const surfaces = new WeakMap<object, ExternalSurface>();

/** The surface of a converted model: one object per mesh, so it can key an effect. */
export function surfaceOf(model: NurbsModel): ExternalSurface {
  const mesh = model.mesh;
  const hit = surfaces.get(mesh);
  if (hit) return hit;
  const curvature: CurvatureMesh = {
    positions: mesh.positions,
    normals: mesh.normals,
    mean: mesh.mean,
    gaussian: mesh.gaussian,
    minRadius: mesh.minRadius,
    indices: mesh.indices,
    hullIndexCount: mesh.indices.length,
    scale: mesh.scale,
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
  const surface: ExternalSurface = { board: model.board, curvature, deviation };
  surfaces.set(mesh, surface);
  return surface;
}
