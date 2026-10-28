// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Messages between the app and the NURBS worker (the experimental engine's read-only
 * viewer; docs/design/board2.md, "V1 viewer"). Type-only, and free of board2 and geom
 * types on purpose: the main chunk imports this module, and must not pull either
 * package in.
 *
 * The classic board crosses by structured clone (plain immutable data). The result
 * comes back as typed arrays, listed for transfer by {@link meshTransferables}, so a
 * 40,000-vertex surface costs no copy.
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

/** The tessellated surface with exact curvature and the deviation from the classic one. */
export interface NurbsMeshData {
  /** The viewport face size (cm) the tessellation was sized for. */
  readonly faceSize: number;
  /** Vertex positions, board cm (tail at x = 0), not centred; stride 3. */
  readonly positions: Float32Array;
  /** Exact outward unit normals, stride 3. */
  readonly normals: Float32Array;
  /** Outward counter-clockwise triangles. */
  readonly indices: Uint32Array;
  /** Mean curvature, 1/cm, positive where convex. */
  readonly mean: Float32Array;
  /** Gaussian curvature, 1/cm². */
  readonly gaussian: Float32Array;
  /** Minimum radius of curvature, cm (capped). */
  readonly minRadius: Float32Array;
  readonly scale: NurbsScale;
  /** Signed distance to the classic surface (cm, positive = more foam); NaN = no data. */
  readonly deviation: Float32Array | null;
  readonly deviationRange: readonly [number, number] | null;
  readonly deviationNoData: number;
  /** The tessellator's largest chord error (cm). */
  readonly maxChordError: number;
}

/** What the popover tells about the conversion (all lengths cm, times ms). */
export interface NurbsSummary {
  readonly planError: number;
  readonly rockerError: number;
  readonly deckSurfaceError: number;
  readonly bottomSurfaceError: number;
  readonly bandError: number;
  readonly bandColumns: number;
}

export interface NurbsTimings {
  /** `convertClassic` (its own build included); 0 for a re-mesh. */
  readonly convertMs: number;
  /** `buildBoard` of a stored document (a re-mesh after the worker lost its cache); else 0. */
  readonly buildMs: number;
  readonly tessellateMs: number;
  readonly deviationMs: number;
  readonly totalMs: number;
}

export type NurbsStage = 'converting' | 'building' | 'meshing' | 'deviation';

/** main → worker. `id` rises monotonically; the answer echoes it. */
export type NurbsRequest =
  | {
      readonly kind: 'convert';
      readonly id: number;
      /** Names the conversion, so a later `mesh` request can reuse it. */
      readonly modelId: number;
      readonly board: BezierBoard;
      readonly faceSize: number;
    }
  | {
      readonly kind: 'mesh';
      readonly id: number;
      readonly modelId: number;
      /** The stored document, to rebuild from when the worker no longer holds the model. */
      readonly docJson: string;
      readonly board: BezierBoard;
      readonly faceSize: number;
    };

/** worker → main. */
export type NurbsResponse =
  | { readonly kind: 'progress'; readonly id: number; readonly stage: NurbsStage }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly ok: true;
      readonly modelId: number;
      /** The converted board2 document as canonical JSON (the master copy, ~100 KB). */
      readonly docJson: string;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary | null;
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
  [m.positions, m.normals, m.indices, m.mean, m.gaussian, m.minRadius, m.deviation]
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map((a) => a.buffer as ArrayBuffer);
