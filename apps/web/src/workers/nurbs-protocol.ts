// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Messages between the app and the NURBS worker (the experimental engine's read-only
 * viewer; docs/design/m1-model.md §3). Type-only, and free of board2 and geom types on
 * purpose: the main chunk imports this module, and must not pull either package in.
 *
 * The classic board crosses by structured clone (plain immutable data). The result
 * comes back as typed arrays, listed for transfer by {@link meshTransferables}, so a
 * 20,000-vertex surface costs no copy.
 */
import type { BezierBoard } from '@openshaper/kernel';

/** One finding of a conversion or build, as the popover lists it. */
export interface NurbsIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** Robust display scales of the exact modes (same meaning as `CurvatureScale`). */
export interface NurbsScale {
  readonly mean: number;
  readonly gaussian: number;
  readonly radius: readonly [number, number];
}

/** The three exact curvature quantities at every vertex, in the 3D view's signs and units. */
export interface NurbsCurvatureData {
  /** Mean curvature, 1/cm, positive where convex. */
  readonly mean: Float32Array;
  /** Gaussian curvature, 1/cm². */
  readonly gaussian: Float32Array;
  /** Minimum radius of curvature, cm (capped). */
  readonly minRadius: Float32Array;
  readonly scale: NurbsScale;
}

/** The surface mesh with exact normals, optional exact curvature and deviation from the classic one. */
export interface NurbsMeshData {
  /** Vertex positions, board cm (tail at x = 0), not centred; stride 3. */
  readonly positions: Float32Array;
  /** Exact outward unit normals, stride 3. */
  readonly normals: Float32Array;
  /** Outward counter-clockwise triangles. */
  readonly indices: Uint32Array;
  /** Exact curvature, when the job asked for it (an exact analysis mode, or a settled board). */
  readonly curvature: NurbsCurvatureData | null;
  /** Signed distance to the classic surface (cm, positive = more foam); NaN = no data. */
  readonly deviation: Float32Array | null;
  readonly deviationRange: readonly [number, number] | null;
  readonly deviationNoData: number;
  /** The row and column ladders were reused from the previous mesh (a drag), not derived. */
  readonly laddersReused: boolean;
}

/** What the converter did to a classic board (null for a test board). */
export interface NurbsConversion {
  readonly stations: number;
  readonly tail: 'standard' | 'notched';
  /** The notch zone length (cm); 0 on a standard tail. */
  readonly zone: number;
  /** Largest handle move (cm) of the outline, rocker or deck to keep x a function. */
  readonly lineAdjust: number;
  /** Largest control-point move (cm) of a section (centre handles made horizontal, bounds). */
  readonly sectionAdjust: number;
  /** Knots added by halving section segments to satisfy 0 <= u <= 1. */
  readonly addedKnots: number;
}

/** What the popover tells about the surface on screen (all lengths cm, areas cm², volume cm³). */
export interface NurbsSummary {
  /** A converted classic board, or one of board2's test boards. */
  readonly source: 'classic' | 'test';
  readonly conversion: NurbsConversion | null;
  /** Largest distance (cm) of a fitted station section from the stored one. */
  readonly stationFitError: number;
  /** Section controls pulled back into bounds by the fits. */
  readonly clampedControls: number;
  /** Largest blended control outside its bounds before clamping (cm). */
  readonly blendOvershoot: number;
  /** From the mesh: volume, plan area and surface area. */
  readonly volume: number;
  readonly planArea: number;
  readonly surfaceArea: number;
}

export interface NurbsTimings {
  /** `convertClassic` (0 for a test board). */
  readonly convertMs: number;
  readonly buildMs: number;
  /** `meshBoard`, including the normals and (when asked) the curvature of the grid. */
  readonly meshMs: number;
  /** k1 / k2 to the view's quantities and the display scales. */
  readonly curvatureMs: number;
  readonly deviationMs: number;
  /** The whole job in the worker, before the transfer. */
  readonly totalMs: number;
}

export type NurbsStage = 'converting' | 'building' | 'meshing' | 'deviation';

/** The board2 test boards the picker offers (docs/design/m1-model.md §6). */
export const TEST_BOARDS = ['swallow', 'fish', 'asymmetric', 'analytic'] as const;
export type TestBoardName = (typeof TEST_BOARDS)[number];

/** What a job computes besides the surface. */
export interface JobOptions {
  /** Principal curvatures with the mesh, and the view's three quantities from them. */
  readonly curvature: boolean;
  /** The deviation from the classic board (a classic job only). */
  readonly deviation: boolean;
  /**
   * An edit is in progress: reuse the last mesh's ladders instead of deriving them.
   * False once the edit settles, which derives them afresh.
   */
  readonly reuseLadders: boolean;
}

/** main → worker. `id` rises monotonically; the answer echoes it. */
export type NurbsRequest =
  | {
      readonly kind: 'classic';
      readonly id: number;
      /** The live classic board: converted, built and meshed in one go. */
      readonly board: BezierBoard;
      readonly options: JobOptions;
    }
  | {
      readonly kind: 'test';
      readonly id: number;
      readonly name: TestBoardName;
      readonly options: JobOptions;
    };

/** worker → main. */
export type NurbsResponse =
  | { readonly kind: 'progress'; readonly id: number; readonly stage: NurbsStage }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly ok: true;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
    }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly issues: readonly NurbsIssue[];
    };

/** Every buffer of a mesh, for the worker to transfer back. */
export const meshTransferables = (m: NurbsMeshData): ArrayBuffer[] =>
  [
    m.positions,
    m.normals,
    m.indices,
    m.curvature?.mean,
    m.curvature?.gaussian,
    m.curvature?.minRadius,
    m.deviation,
  ]
    .filter((a): a is NonNullable<typeof a> => a != null)
    .map((a) => a.buffer as ArrayBuffer);
