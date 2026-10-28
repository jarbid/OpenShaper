// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS viewer's compute, free of any worker plumbing (docs/design/m1-model.md §3).
 * `nurbs-worker.ts` runs it in a Web Worker; the synchronous fallback (tests, no
 * `Worker`) imports it directly.
 *
 * This and `nurbs-worker.ts` are the only modules of the app allowed to import
 * `@openshaper/board2` and `@openshaper/geom` (eslint.config.mjs), and the app reaches
 * them only through a dynamic `import()` or a `new Worker(new URL(...))`, so they stay
 * out of the main chunk.
 *
 * ## One job
 *
 * `convertClassic(classic)` → `buildBoard(doc, { check: false })` → `meshBoard(built, …)`,
 * then the typed arrays the 3D view draws: positions, exact normals, the view's three
 * curvature quantities from k1 / k2 (when asked), and the deviation from the classic
 * board (when asked). Every step is milliseconds, so a job runs for every edit.
 *
 * ## Identity
 *
 * The converter caches a normalised slice per classic slice (by the identity of its
 * spline) and `buildBoard` caches the section fit per `Section` object. A board that
 * crossed the worker boundary by structured clone has fresh objects every time, which
 * would refit every section on every edit (about 4 ms each). So {@link canonical}
 * hands the converter the previous job's slice objects for slices that are unchanged,
 * which keeps both caches warm. The document is never revived from JSON per edit.
 *
 * ## Ladders
 *
 * Deriving the row and column ladders is about 60 % of a fresh mesh. While an edit is
 * in progress ({@link JobOptions.reuseLadders}) the last job's ladders are reused; the
 * request that follows the edit derives them afresh.
 */
import {
  buildBoard,
  meshBoard,
  type Board2Issue,
  type BoardDoc,
  type BuiltBoard,
  type Ladders,
} from '@openshaper/board2';
import { convertClassic } from '@openshaper/board2/classic';
import {
  analyticBoard,
  asymmetricBoard,
  fishBoard,
  swallowBoard,
} from '@openshaper/board2/testing';
import type { BezierBoard, Spline } from '@openshaper/kernel';
import { curvatureArrays, curvatureScale, excludeUndefined, vertexAreas } from './nurbs-curvature';
import { classicDeviation } from './nurbs-deviation';
import type {
  JobOptions,
  NurbsConversion,
  NurbsIssue,
  NurbsMeshData,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
  TestBoardName,
} from './nurbs-protocol';

/** The progress callback of a job; the worker posts it, tests record it. */
export type Progress = (stage: NurbsStage) => void;

/** The outcome of a job: what the worker answers with, minus the request id. */
export type NurbsOutcome =
  | {
      readonly ok: true;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

const now = (): number => performance.now();

const issueOf = (i: Board2Issue): NurbsIssue => ({
  code: i.code,
  severity: i.severity,
  message: i.message,
});

/** The first error's message: the reason a board was refused. */
const refusal = (issues: readonly Board2Issue[], fallback: string): NurbsOutcome => ({
  ok: false,
  error: issues.find((i) => i.severity === 'error')?.message ?? fallback,
  issues: issues.map(issueOf),
});

// --- Identity of the classic slices ------------------------------------------

/** Slice splines of the previous jobs, by content; a handful more than a board has. */
const SPLINE_MEMORY = 96;
const splines = new Map<string, Spline>();

const splineKey = (s: Spline): string => {
  let key = '';
  for (const k of s.knots) {
    key += `${k.end.x},${k.end.y},${k.tangentToPrev.x},${k.tangentToPrev.y},${k.tangentToNext.x},${k.tangentToNext.y};`;
  }
  return key;
};

/**
 * `board` with every unchanged cross-section spline replaced by the object an earlier
 * job saw, so the converter's slice cache and the section-fit cache hit. Returns the
 * board itself when nothing is replaced (the usual case in the synchronous fallback,
 * which already has the live objects).
 */
export const canonical = (board: BezierBoard): BezierBoard => {
  let replaced = false;
  const crossSections = board.crossSections.map((cs) => {
    const key = splineKey(cs.spline);
    const known = splines.get(key);
    if (known === undefined) {
      splines.set(key, cs.spline);
      if (splines.size > SPLINE_MEMORY) splines.delete(splines.keys().next().value!);
      return cs;
    }
    // Refresh recency.
    splines.delete(key);
    splines.set(key, known);
    if (known === cs.spline) return cs;
    replaced = true;
    return { ...cs, spline: known };
  });
  return replaced ? { ...board, crossSections } : board;
};

// --- Ladders -----------------------------------------------------------------

let lastLadders: Ladders | null = null;

/** Ladders for `built`: the last job's when reuse is asked for and they fit this board. */
const laddersFor = (
  built: BuiltBoard,
  reuse: boolean,
): { ladders: Ladders | undefined; reused: boolean } => {
  const held = lastLadders;
  if (
    reuse &&
    held &&
    Math.abs(held.xi[0]! - built.xiMin) < 1e-9 &&
    Math.abs(held.xi[held.xi.length - 1]! - built.xiMax) < 1e-9
  ) {
    return { ladders: held, reused: true };
  }
  return { ladders: undefined, reused: false };
};

/** Forget the held ladders and slice splines (tests). */
export const resetCore = (): void => {
  lastLadders = null;
  splines.clear();
};

// --- The job -----------------------------------------------------------------

interface Built {
  readonly doc: BoardDoc;
  readonly built: BuiltBoard;
  readonly conversion: NurbsConversion | null;
  readonly issues: readonly Board2Issue[];
  readonly convertMs: number;
  readonly buildMs: number;
}

/** Mesh a built board and assemble everything the view draws. */
const meshBuilt = (
  b: Built,
  classic: BezierBoard | null,
  options: JobOptions,
  t0: number,
  progress?: Progress,
): NurbsOutcome => {
  progress?.('meshing');
  const t1 = now();
  const { ladders, reused } = laddersFor(b.built, options.reuseLadders);
  const m = meshBoard(b.built, {
    curvature: options.curvature,
    ...(ladders ? { ladders } : {}),
  });
  lastLadders = m.ladders;
  const meshMs = now() - t1;

  const t2 = now();
  let curvature: NurbsMeshData['curvature'] = null;
  if (m.k1 && m.k2) {
    const c = curvatureArrays(m.k1, m.k2);
    const area = excludeUndefined(
      vertexAreas(m.positions, m.indices, m.vertexCount),
      c.undefinedAt,
    );
    curvature = {
      mean: c.mean,
      gaussian: c.gaussian,
      minRadius: c.minRadius,
      scale: curvatureScale(c.mean, c.gaussian, c.minRadius, area),
    };
  }
  const curvatureMs = now() - t2;

  let deviation: Float32Array | null = null;
  let deviationRange: readonly [number, number] | null = null;
  let deviationNoData = 0;
  let deviationMs = 0;
  if (classic && options.deviation) {
    progress?.('deviation');
    const t3 = now();
    const d = classicDeviation(classic, m.positions, m.normals);
    deviation = d.deviation;
    deviationRange = d.range;
    deviationNoData = d.noData;
    deviationMs = now() - t3;
  }

  const r = b.built.report;
  return {
    ok: true,
    issues: b.issues.map(issueOf),
    summary: {
      source: classic ? 'classic' : 'test',
      conversion: b.conversion,
      stationFitError: r.stationFitError,
      clampedControls: r.clampedControls,
      blendOvershoot: r.blendOvershoot,
      volume: m.volume,
      planArea: m.planArea,
      surfaceArea: m.surfaceArea,
    },
    timings: {
      convertMs: b.convertMs,
      buildMs: b.buildMs,
      meshMs,
      curvatureMs,
      deviationMs,
      totalMs: now() - t0,
    },
    mesh: {
      positions: m.positions,
      normals: m.normals,
      indices: m.indices,
      curvature,
      deviation,
      deviationRange,
      deviationNoData,
      laddersReused: reused,
    },
  };
};

/** Build a document: the built board and its issues, or the refusal outcome. */
const build = (
  doc: BoardDoc,
  check: boolean,
  inherited: readonly Board2Issue[],
): { built: BuiltBoard; issues: Board2Issue[]; ms: number } | { refused: NurbsOutcome } => {
  const t = now();
  const r = buildBoard(doc, { check });
  if (!r.ok) {
    return {
      refused: refusal([...inherited, ...r.issues], 'The NURBS surface could not be built.'),
    };
  }
  return { built: r.value, issues: [...inherited, ...r.issues], ms: now() - t };
};

/**
 * Convert a classic board, build it and mesh it. Never throws: a refusal or a failure
 * is an outcome (the viewer keeps the classic mesh and shows the reason).
 */
export const convertAndMesh = (
  board: BezierBoard,
  options: JobOptions,
  progress?: Progress,
): NurbsOutcome => {
  const t0 = now();
  try {
    progress?.('converting');
    const live = canonical(board);
    const c = convertClassic(live);
    const convertMs = now() - t0;
    if (!c.ok) return refusal(c.issues, 'The board could not be converted.');
    progress?.('building');
    const b = build(c.value.doc, false, c.issues);
    if ('refused' in b) return b.refused;
    const rep = c.value.report;
    return meshBuilt(
      {
        doc: c.value.doc,
        built: b.built,
        conversion: {
          stations: rep.stations,
          tail: rep.tail,
          zone: rep.zone,
          lineAdjust: rep.lineAdjust,
          sectionAdjust: rep.sectionAdjust,
          addedKnots: rep.addedKnots,
        },
        issues: b.issues,
        convertMs,
        buildMs: b.ms,
      },
      live,
      options,
      t0,
      progress,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

const TEST_DOCS: { readonly [K in TestBoardName]: () => BoardDoc } = {
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
  analytic: analyticBoard,
};

/** Build and mesh one of board2's test boards (read-only display; no classic board). */
export const meshTestBoard = (
  name: TestBoardName,
  options: JobOptions,
  progress?: Progress,
): NurbsOutcome => {
  const t0 = now();
  try {
    progress?.('building');
    const doc = TEST_DOCS[name]();
    const b = build(doc, true, []);
    if ('refused' in b) return b.refused;
    return meshBuilt(
      { doc, built: b.built, conversion: null, issues: b.issues, convertMs: 0, buildMs: b.ms },
      null,
      options,
      t0,
      progress,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};
