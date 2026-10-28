// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS viewer's compute, free of any worker plumbing: classic board in, tessellated
 * surface out (docs/design/board2.md, "V1 viewer"). `nurbs-worker.ts` runs it in a
 * Web Worker; the synchronous fallback (tests, no `Worker`) imports it directly.
 *
 * This and `nurbs-worker.ts` are the only modules of the app allowed to import
 * `@openshaper/board2` and `@openshaper/geom` (eslint.config.mjs), and the app reaches
 * them only through a dynamic `import()` or a `new Worker(new URL(...))`, so they stay
 * out of the main chunk.
 *
 * ## What it does
 *
 * 1. `convertClassic` fits a board2 document to the classic board and builds it.
 * 2. `tessellateBrep` meshes the three faces (deck, band, bottom) watertight, with
 *    exact normals and exact principal curvatures at every vertex, from geom's
 *    surface derivatives, not from the mesh.
 * 3. The curvatures become the view's mean / Gaussian / rail-radius quantities
 *    (`nurbs-curvature.ts`), and the vertices are measured against the classic surface
 *    (`nurbs-deviation.ts`).
 */
import { boardDocToJson, buildBoard, reviveBoardDoc, type BuiltBoard } from '@openshaper/board2';
import { convertClassic, type Conversion } from '@openshaper/board2/classic';
import { SAMPLE_DEGENERATE, tessellateBrep, type TessellationOptions } from '@openshaper/geom';
import type { BezierBoard } from '@openshaper/kernel';
import { MAX_RADIUS } from '@openshaper/render3d/curvature-mesh';
import { convexCurvatures, curvatureScale, repairNormals, vertexAreas } from './nurbs-curvature';
import { classicDeviation } from './nurbs-deviation';
import type {
  NurbsIssue,
  NurbsMeshData,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
} from './nurbs-protocol';

/**
 * geom's tessellation targets for a viewport face size (cm), the setting the classic
 * mesh uses. The classic mesh is a regular grid of about `faceSize` cells; geom's is
 * adaptive, so it is sized by the error it may make instead: a chord error of 5 % of
 * the face size, normals turning no more than `angleTol` between neighbours, and
 * edges no longer than six faces.
 *
 * Measured on the shortboard (docs/design/board2.md, "V1 viewer"): the standard 0.9 cm
 * gives about 32,000 vertices, the fine 0.5 cm about 90,000 and the draft 1.5 cm about
 * 12,000. geom's own defaults (chord 0.1 mm) would give 160,000 to 400,000.
 */
export const tessellationFor = (faceSize: number): TessellationOptions => ({
  chordTol: Math.min(0.1, Math.max(0.01, 0.05 * faceSize)),
  angleTol: Math.min(0.55, Math.max(0.2, 0.4 * Math.sqrt(faceSize / 0.9))),
  maxEdge: 6 * faceSize,
});

/** Models the worker keeps for cheap re-meshing (a change of mesh quality). */
export const HELD_MODELS = 2;

interface Held {
  readonly modelId: number;
  readonly built: BuiltBoard;
}
const held: Held[] = [];

/** Keep `built` for cheap re-meshing under `modelId`; the oldest beyond {@link HELD_MODELS} go. */
export const holdModel = (modelId: number, built: BuiltBoard): void => {
  const i = held.findIndex((h) => h.modelId === modelId);
  if (i !== -1) held.splice(i, 1);
  held.push({ modelId, built });
  while (held.length > HELD_MODELS) held.shift();
};

/** Drop everything held (tests). */
export const releaseHeldModels = (): void => {
  held.length = 0;
};

const issueOf = (i: {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}): NurbsIssue => ({ code: i.code, severity: i.severity, message: i.message });

/** The progress callback of a job; the worker posts it, tests record it. */
export type Progress = (stage: NurbsStage) => void;

const now = (): number => performance.now();

/**
 * Tessellate a built board and assemble everything the view draws: surface, exact
 * curvature, and (when `classic` is given) the deviation from the classic surface.
 */
export const meshBuiltBoard = (
  built: BuiltBoard,
  classic: BezierBoard | null,
  faceSize: number,
  progress?: Progress,
): { mesh: NurbsMeshData; tessellateMs: number; deviationMs: number } => {
  progress?.('meshing');
  const t0 = now();
  const r = tessellateBrep(built.brep, tessellationFor(faceSize));
  if (!r.ok) {
    throw new Error(
      `tessellation failed: ${r.issues.map((i) => i.message).join('; ') || 'unknown error'}`,
    );
  }
  const b = r.value;
  const vertexCount = b.positions.length / 3;
  const positions = Float32Array.from(b.positions);
  const normals = Float32Array.from(b.normals);
  const indices = b.indices;
  const mean = new Float32Array(vertexCount);
  const gaussian = new Float32Array(vertexCount);
  const minRadius = new Float32Array(vertexCount).fill(MAX_RADIUS);
  for (let f = 0; f < b.faces.length; f++) {
    const face = built.brep.faces[f]!;
    const m = b.faces[f]!;
    const base = b.vertexRanges[f]!;
    const count = b.vertexRanges[f + 1]! - base;
    for (let i = 0; i < count; i++) {
      if ((m.flags[i]! & SAMPLE_DEGENERATE) !== 0) continue;
      const c = convexCurvatures(m.curvature[2 * i]!, m.curvature[2 * i + 1]!, face.sameSense);
      mean[base + i] = c.mean;
      gaussian[base + i] = c.gaussian;
      minRadius[base + i] = c.radius;
    }
  }
  repairNormals(positions, normals, indices);
  const area = vertexAreas(positions, indices, vertexCount);
  const scale = curvatureScale(mean, gaussian, minRadius, area);
  const tessellateMs = now() - t0;

  let deviation: Float32Array | null = null;
  let deviationRange: readonly [number, number] | null = null;
  let deviationNoData = 0;
  let deviationMs = 0;
  if (classic) {
    progress?.('deviation');
    const t1 = now();
    const d = classicDeviation(classic, positions, normals);
    deviation = d.deviation;
    deviationRange = d.range;
    deviationNoData = d.noData;
    deviationMs = now() - t1;
  }
  return {
    mesh: {
      faceSize,
      positions,
      normals,
      indices,
      mean,
      gaussian,
      minRadius,
      scale,
      deviation,
      deviationRange,
      deviationNoData,
      maxChordError: b.maxChordError,
    },
    tessellateMs,
    deviationMs,
  };
};

const summaryOf = (c: Conversion): NurbsSummary => ({
  planError: c.report.planError,
  rockerError: c.report.rockerError,
  deckSurfaceError: c.report.deckSurfaceError,
  bottomSurfaceError: c.report.bottomSurfaceError,
  bandError: c.report.bandError,
  bandColumns: c.report.builtColumns,
});

/** The outcome of a job: what the worker answers with, minus the request id. */
export type NurbsOutcome =
  | {
      readonly ok: true;
      readonly docJson: string;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary | null;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** Convert a classic board, build it, and mesh it. Never throws: failures are outcomes. */
export const convertAndMesh = (
  modelId: number,
  board: BezierBoard,
  faceSize: number,
  progress?: Progress,
): NurbsOutcome => {
  const t0 = now();
  try {
    progress?.('converting');
    const r = convertClassic(board);
    const convertMs = now() - t0;
    if (!r.ok) {
      const errors = r.issues.filter((i) => i.severity === 'error');
      return {
        ok: false,
        error: errors[0]?.message ?? 'The board could not be converted.',
        issues: r.issues.map(issueOf),
      };
    }
    const { built, doc } = r.value;
    holdModel(modelId, built);
    const docJson = boardDocToJson(doc);
    const m = meshBuiltBoard(built, board, faceSize, progress);
    return {
      ok: true,
      docJson,
      issues: r.issues.map(issueOf),
      summary: summaryOf(r.value),
      mesh: m.mesh,
      timings: {
        convertMs,
        buildMs: 0,
        tessellateMs: m.tessellateMs,
        deviationMs: m.deviationMs,
        totalMs: now() - t0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

/**
 * Mesh an already converted board at another face size. Uses the model the worker
 * still holds, or rebuilds it from the stored document (a few seconds) when it does
 * not (the worker was restarted).
 */
export const remesh = (
  modelId: number,
  docJson: string,
  board: BezierBoard,
  faceSize: number,
  progress?: Progress,
): NurbsOutcome => {
  const t0 = now();
  try {
    let built = held.find((h) => h.modelId === modelId)?.built;
    let buildMs = 0;
    let issues: readonly NurbsIssue[] = [];
    if (!built) {
      progress?.('building');
      const t1 = now();
      const doc = reviveBoardDoc(JSON.parse(docJson));
      if (!doc.ok) {
        return {
          ok: false,
          error: 'The stored NURBS document is invalid.',
          issues: doc.issues.map(issueOf),
        };
      }
      const b = buildBoard(doc.value);
      if (!b.ok) {
        return {
          ok: false,
          error: b.issues.find((i) => i.severity === 'error')?.message ?? 'The build failed.',
          issues: b.issues.map(issueOf),
        };
      }
      built = b.value;
      issues = b.issues.map(issueOf);
      buildMs = now() - t1;
      holdModel(modelId, built);
    }
    const m = meshBuiltBoard(built, board, faceSize, progress);
    return {
      ok: true,
      docJson,
      issues,
      summary: null,
      mesh: m.mesh,
      timings: {
        convertMs: 0,
        buildMs,
        tessellateMs: m.tessellateMs,
        deviationMs: m.deviationMs,
        totalMs: now() - t0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};
