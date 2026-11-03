// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Messages between the app and the NURBS worker (the experimental engine's viewer;
 * docs/design/m1-model.md §3, docs/design/m2-editor.md §4). Type-only: the main chunk
 * imports this module, and `import type` of board2 costs it nothing at run time.
 *
 * A classic board or a section document crosses by structured clone (plain immutable
 * data). The result comes back as typed arrays, listed for transfer by
 * {@link meshTransferables}, so a 20,000-vertex surface costs no copy.
 */
import type { BoardDoc } from '@openshaper/board2';
import type { BoardPdf1to1Options, DxfCurveMode } from '@openshaper/export';
import type { BezierBoard, ResolvedFin } from '@openshaper/kernel';

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
  /** A converted classic board, an edited section document, or one of board2's test boards. */
  readonly source: 'classic' | 'doc' | 'test';
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

/**
 * The as-built section at a station coordinate, for the section pane's ghost and the scrub preview
 * (docs/design/m2-editor.md §3, §4): one polyline per side as `[x0, y0, x1, y1, …]` in the section
 * editor's frame (distance along the chord from the stringer, height above the rocker scaled to the
 * station's thickness), so it overlays the stored section of the station it was probed at.
 */
export interface SectionProbe {
  /** The station coordinate the section was taken at (cm). */
  readonly xi: number;
  readonly plus: readonly number[];
  /** The minus side of an asymmetric board; null on a mirror board. */
  readonly minus: readonly number[] | null;
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
    }
  | {
      /**
       * The section store's document: built and meshed with no converter in the loop (an edit
       * costs the worker its build and mesh only). Sections that crossed the clone are matched by
       * content to the earlier ones, so their fits stay warm.
       */
      readonly kind: 'doc';
      readonly id: number;
      readonly doc: BoardDoc;
      /** The classic board "Deviation from classic" measures against (only when that mode is shown). */
      readonly reference: BezierBoard | null;
      readonly options: JobOptions;
      /** Station coordinates whose as-built sections the answer carries (the selected station, the scrub). */
      readonly probes: readonly number[];
    }
  | {
      /**
       * Probes only: the sections at `probes` of an unchanged document, with no mesh. The scrub preview
       * asks this as the pointer moves, so a hover costs a build (warm, about a millisecond) and no
       * new surface for the 3D view to upload.
       */
      readonly kind: 'probe';
      readonly id: number;
      readonly doc: BoardDoc;
      readonly probes: readonly number[];
    }
  | {
      /** Convert a classic board to a section document (the engine switch, a file opened with it on). */
      readonly kind: 'convert';
      readonly id: number;
      readonly board: BezierBoard;
    }
  | {
      /**
       * The sidebar's specs of a settled document, from its mesh (docs/design/m2-editor.md §4, step 5):
       * build, mesh, measure; the answer carries four numbers and no surface.
       */
      readonly kind: 'measure';
      readonly id: number;
      readonly doc: BoardDoc;
    };

/** What the mesh of a document measures (cm, cm², cm³; `centreX` is the volume's centroid along x). */
export interface MeshMeasure {
  readonly volume: number;
  readonly planArea: number;
  readonly surfaceArea: number;
  readonly centreX: number;
}

/** The report of a conversion, as the app shows it. */
export interface ConvertedDoc {
  readonly doc: BoardDoc;
  readonly conversion: NurbsConversion;
  /** Warnings of the conversion (an adjusted handle, a reshaped notch). */
  readonly issues: readonly NurbsIssue[];
}

/** worker → main. */
export type NurbsResponse =
  | { readonly kind: 'progress'; readonly id: number; readonly stage: NurbsStage }
  | ({ readonly kind: 'converted'; readonly id: number; readonly ok: true } & ConvertedDoc)
  | {
      readonly kind: 'converted';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly issues: readonly NurbsIssue[];
    }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly ok: true;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
      /** The as-built sections asked for (a `doc` job; empty for the others). */
      readonly probes: readonly SectionProbe[];
    }
  | {
      readonly kind: 'probed';
      readonly id: number;
      readonly ok: true;
      readonly probes: readonly SectionProbe[];
    }
  | {
      readonly kind: 'probed';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    }
  | ({ readonly kind: 'measured'; readonly id: number; readonly ok: true } & MeshMeasure)
  | {
      readonly kind: 'measured';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
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

// --- Exports (docs/design/m3-exports.md) -----------------------------------------------------

/** The default STL face size (cm): the longest edge of the export mesh. The live mesh has no cap. */
export const DEFAULT_STL_FACE_SIZE = 0.5;

/**
 * What an export job writes. The document crosses by structured clone, so the export is of the board as
 * it was when asked, whatever is edited meanwhile.
 */
export type ExportJob =
  | {
      readonly format: 'stl';
      /** Longest edge of the mesh, cm. */
      readonly faceSize: number;
      /** File name stem. */
      readonly slug: string;
    }
  | {
      readonly format: 'dxf';
      readonly curveMode: DxfCurveMode;
      /** Stations drawn (evenly spaced along the stringer). */
      readonly crossSectionCount: number;
      /** The comparison board of the GHOST layer. */
      readonly ghost: BezierBoard | null;
      /** The fins to draw (the document's fin setup, resolved on the main thread). */
      readonly fins: readonly ResolvedFin[];
      readonly slug: string;
    }
  | {
      readonly format: 'pdf-1to1';
      readonly options: BoardPdf1to1Options;
      readonly fins: readonly ResolvedFin[];
      readonly slug: string;
    }
  | {
      readonly format: 'step';
      /** The unit the file declares and its coordinates are written in. The surfaces are held within 0.5 mm of the board. */
      readonly unit: 'mm' | 'cm' | 'in';
      readonly slug: string;
    };

export type ExportFormatName = ExportJob['format'];

export type ExportStage = 'building' | 'meshing' | 'sampling' | 'fitting' | 'drawing' | 'writing';

/** main → worker: one export of a document. */
export interface ExportRequest {
  readonly kind: 'export';
  readonly id: number;
  readonly doc: BoardDoc;
  readonly job: ExportJob;
}

/** One file an export produced. */
export interface ExportedFile {
  readonly name: string;
  /** Media type for the download. */
  readonly type: string;
  readonly bytes: Uint8Array;
}

/** worker → main. */
export type ExportResponse =
  | { readonly kind: 'export-progress'; readonly id: number; readonly stage: ExportStage }
  | {
      readonly kind: 'exported';
      readonly id: number;
      readonly ok: true;
      readonly files: readonly ExportedFile[];
      /** The whole job in the worker, ms. */
      readonly ms: number;
    }
  | {
      readonly kind: 'exported';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

/** Every buffer of an export's files, for the worker to transfer back. */
export const exportTransferables = (files: readonly ExportedFile[]): ArrayBuffer[] =>
  files.map((f) => f.bytes.buffer as ArrayBuffer);
