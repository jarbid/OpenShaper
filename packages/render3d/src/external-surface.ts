// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A surface the app computed outside this package and wants drawn in place of the
 * classic hull: the experimental NURBS engine's tessellation (docs/design/board2.md,
 * "V1 viewer"). Pure types and helpers, no three.js, so the app's worker and the tests
 * can use them.
 *
 * The view never computes one itself and never learns where it came from. It takes
 * the meshes as given, in board coordinates (tail at x = 0, cm), and places them the
 * way it places the hull, so fins, guides and overlays still line up.
 */
import type { BezierBoard } from '@openshaper/kernel';
import type { CurvatureMesh } from './curvature-mesh';
import type { DeviationMesh } from './deviation-mesh';

export interface ExternalSurface {
  /**
   * The classic board this surface was built from. The view shows the surface only
   * while the board in the store has the same hull shape ({@link sameHull}); after an
   * edit the classic hull is drawn until the app supplies a new surface.
   */
  readonly board: BezierBoard;
  /**
   * The surface itself (positions, exact outward normals, triangles) with the exact
   * curvature at every vertex, in the units and signs of {@link CurvatureMesh}: the
   * mean curvature is positive where convex. `hullIndexCount` is the whole index
   * list (an external surface is closed and has no end caps).
   */
  readonly curvature: CurvatureMesh;
  /**
   * The same vertices with their signed distance to a reference surface (cm,
   * positive = this surface has more foam), or null when none was computed.
   */
  readonly deviation: DeviationMesh | null;
}

/**
 * Whether two boards have the same hull: the same outline, rocker curves, cross-sections
 * and interpolation. The kernel is immutable and an edit replaces only what it
 * changes, so identity of these parts is "no geometry edit" (a fin or metadata edit
 * leaves them alone and does not invalidate a surface).
 */
export const sameHull = (a: BezierBoard, b: BezierBoard): boolean =>
  a === b ||
  (a.outline === b.outline &&
    a.bottom === b.bottom &&
    a.deck === b.deck &&
    a.crossSections === b.crossSections &&
    a.interpolationType === b.interpolationType);
