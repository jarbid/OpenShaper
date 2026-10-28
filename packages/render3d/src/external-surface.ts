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
   * The classic board this surface was built from; null for a standalone surface.
   * Unless {@link tracking} says otherwise, the view shows the surface only while the
   * board in the store has the same hull shape ({@link sameHull}); after an edit the
   * classic hull is drawn until the app supplies a new surface.
   */
  readonly board: BezierBoard | null;
  /**
   * When the surface counts (default `'hull'`):
   *
   * - `'hull'`: only for the hull it was built from ({@link board}).
   * - `'live'`: the app replaces it on every edit within a frame or two, so it is
   *   drawn whatever the store's hull is now (a drag never flashes the classic hull
   *   between answers).
   * - `'standalone'`: not the store's board at all (a test board shown on its own). It
   *   is placed by its own centre, and the classic board's fins and guides are hidden.
   */
  readonly tracking?: 'hull' | 'live' | 'standalone';
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

/** Whether `surface` is drawn while the store holds `board` (see {@link ExternalSurface.tracking}). */
export const surfaceApplies = (surface: ExternalSurface, board: BezierBoard): boolean =>
  surface.tracking === 'live' ||
  surface.tracking === 'standalone' ||
  (surface.board !== null && sameHull(surface.board, board));
