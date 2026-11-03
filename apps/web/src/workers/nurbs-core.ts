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
 * The section store's document (`meshDocument`, an edit in the NURBS engine) or a classic
 * board (`convertAndMesh`: `convertClassic` first): `buildBoard(doc)` → `meshBoard(built, …)`,
 * then the typed arrays the 3D view draws: positions, exact normals, the view's three
 * curvature quantities from k1 / k2 (when asked), and the deviation from the classic
 * board (when asked). Every step is milliseconds, so a job runs for every edit. `convertToDoc`
 * is the conversion alone, for the engine switch.
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
 * A document sent by the section store (`meshDocument`) crosses the same boundary, and its
 * untouched `Section`s are fresh objects too: {@link canonicalDoc} gives each the earlier object
 * of the same content (coordinates rounded to 1e-9), so `buildBoard`'s fit cache stays warm
 * and an outline, rocker or deck edit refits nothing.
 *
 * ## Ladders
 *
 * Deriving the row and column ladders is about 60 % of a fresh mesh. While an edit is
 * in progress ({@link JobOptions.reuseLadders}) the last job's ladders are reused; the
 * request that follows the edit derives them afresh.
 */
import {
  boardDocToJson,
  buildBoard,
  boardStep,
  StepFitError,
  createChordFn,
  createEvaluator,
  meshBoard,
  probeSection,
  reviveBoardDoc,
  type Board2Issue,
  type BoardDoc,
  type BuiltBoard,
  type Chain,
  type ChordFn,
  type Ladders,
  type Section,
} from '@openshaper/board2';
import { convertClassic } from '@openshaper/board2/classic';
import {
  analyticBoard,
  asymmetricBoard,
  fishBoard,
  swallowBoard,
} from '@openshaper/board2/testing';
import {
  exportBoardPdf1to1FilesFromCurves,
  exportDxfCurves,
  stlFromMesh,
  type BoardCurves,
  type CurveSection,
  type CurveSeg,
  type Pt,
} from '@openshaper/export';
import type { BezierBoard, Spline } from '@openshaper/kernel';
import { curvatureArrays, curvatureScale, excludeUndefined, vertexAreas } from './nurbs-curvature';
import { classicDeviation } from './nurbs-deviation';
import type {
  ConvertedDoc,
  ExportedFile,
  ExportJob,
  ExportStage,
  JobOptions,
  MeshMeasure,
  NurbsConversion,
  NurbsIssue,
  NurbsMeshData,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
  SectionProbe,
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
      readonly probes: readonly SectionProbe[];
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

// --- Identity of the sections of a document ------------------------------------

/** Sections of the previous jobs, by content; a few more than two boards' worth. */
const SECTION_MEMORY = 192;
const sections = new Map<string, Section>();
const CONTENT_SCALE = 1e9;

const sectionKey = (s: Section): string => {
  const parts: string[] = [String(s.apex)];
  for (const k of s.chain.knots) {
    for (const q of [k.p, k.in, k.out]) {
      parts.push(
        String(Math.round(q[0] * CONTENT_SCALE)),
        String(Math.round(q[1] * CONTENT_SCALE)),
      );
    }
    parts.push(k.smooth ? 's' : 'c');
  }
  return parts.join(',');
};

const knownSection = (s: Section): Section => {
  const key = sectionKey(s);
  const known = sections.get(key);
  if (known === undefined) {
    sections.set(key, s);
    if (sections.size > SECTION_MEMORY) sections.delete(sections.keys().next().value!);
    return s;
  }
  // Refresh recency.
  sections.delete(key);
  sections.set(key, known);
  return known;
};

/**
 * `doc` with every section replaced by the object an earlier job saw with the same content. The
 * document itself when nothing is replaced (the synchronous fallback, which has the live objects).
 */
export const canonicalDoc = (doc: BoardDoc): BoardDoc => {
  let replaced = false;
  const stations = doc.stations.map((st) => {
    const plus = knownSection(st.plus);
    const minus = st.minus === undefined ? undefined : knownSection(st.minus);
    if (plus === st.plus && minus === st.minus) return st;
    replaced = true;
    return { ...st, plus, ...(minus === undefined ? {} : { minus }) };
  });
  return replaced ? { ...doc, stations } : doc;
};

// --- Ladders -----------------------------------------------------------------

let lastLadders: Ladders | null = null;
/**
 * The span of the section ladder the last build chose. While an edit is in progress it is offered to the next
 * build (`buildBoard`'s `spanHint`), so the section being dragged is fitted once instead of climbed to.
 */
let lastSpan: number | undefined;

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
  lastSpan = undefined;
  splines.clear();
  sections.clear();
};

// --- Probes ------------------------------------------------------------------

/** Points per probed section half: the section is a smooth cubic spline, 64 is a polyline to a few microns. */
const PROBE_SAMPLES = 64;

/** The as-built sections of `built` at the station coordinates `xis` (both sides on an asymmetric board). */
const probesOf = (built: BuiltBoard, xis: readonly number[]): SectionProbe[] => {
  if (xis.length === 0) return [];
  const ev = createEvaluator(built);
  const asymmetric = built.doc.symmetry === 'asymmetric';
  return xis.map((xi) => {
    const x = Math.min(built.xiMax, Math.max(built.xiMin, xi));
    return {
      xi,
      plus: probeSection(built, ev, 0, x, PROBE_SAMPLES),
      minus: asymmetric ? probeSection(built, ev, 1, x, PROBE_SAMPLES) : null,
    };
  });
};

// --- The notch-zone chord, for the section store ------------------------------

/** What a chord depends on: the outline(s), the tail and the lines (the zone is picked by the validator). */
interface ChordKey {
  readonly outline: BoardDoc['outline']['plus'];
  readonly other: BoardDoc['outline']['minus'];
  readonly tail: BoardDoc['tail'];
  readonly rocker: BoardDoc['rocker'];
  readonly deck: BoardDoc['deck'];
}
let chordMemory: { key: ChordKey; fn: ChordFn } | null = null;
let minusChordMemory: { key: ChordKey; fn: ChordFn } | null = null;

/**
 * The chord-length function of a document, cached on what it depends on, so a section edit on a
 * swallow board does not re-resolve the notch zone. The section store takes this by injection
 * (`setNotchChords`): the main chunk may not import board2.
 */
export const notchChords = (doc: BoardDoc, side?: 'minus'): ChordFn => {
  const memory = side === 'minus' ? minusChordMemory : chordMemory;
  const k = memory?.key;
  const outline = side === 'minus' ? (doc.outline.minus ?? doc.outline.plus) : doc.outline.plus;
  if (
    memory !== null &&
    k !== undefined &&
    k.outline === outline &&
    k.other === (side === 'minus' ? doc.outline.plus : doc.outline.minus) &&
    k.tail === doc.tail &&
    k.rocker === doc.rocker &&
    k.deck === doc.deck
  ) {
    return memory.fn;
  }
  const fn = createChordFn(doc, side);
  const entry = {
    key: {
      outline,
      other: side === 'minus' ? doc.outline.plus : doc.outline.minus,
      tail: doc.tail,
      rocker: doc.rocker,
      deck: doc.deck,
    },
    fn,
  };
  if (side === 'minus') minusChordMemory = entry;
  else chordMemory = entry;
  return fn;
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
  source: NurbsSummary['source'],
  classic: BezierBoard | null,
  options: JobOptions,
  t0: number,
  progress?: Progress,
  probes: readonly number[] = [],
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
      source,
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
    probes: probesOf(b.built, probes),
  };
};

/** Build a document: the built board and its issues, or the refusal outcome. */
const build = (
  doc: BoardDoc,
  check: boolean,
  inherited: readonly Board2Issue[],
  spanHint?: number,
): { built: BuiltBoard; issues: Board2Issue[]; ms: number } | { refused: NurbsOutcome } => {
  const t = now();
  const r = buildBoard(doc, { check, ...(spanHint === undefined ? {} : { spanHint }) });
  if (!r.ok) {
    return {
      refused: refusal([...inherited, ...r.issues], 'The NURBS surface could not be built.'),
    };
  }
  lastSpan = r.value.report.sectionSpans[0];
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
      'classic',
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
      'test',
      null,
      options,
      t0,
      progress,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

/**
 * Build and mesh the section store's document: no converter in the loop. The document is validated
 * (a plan an edit made impossible is a refusal, and the viewer keeps the last good surface) and then
 * built, with its sections matched to the earlier jobs' by content so their fits are reused.
 * `reference` is the classic board "Deviation from classic" measures against, when that mode is shown.
 */
export const meshDocument = (
  docIn: BoardDoc,
  reference: BezierBoard | null,
  options: JobOptions,
  progress?: Progress,
  probes: readonly number[] = [],
): NurbsOutcome => {
  const t0 = now();
  try {
    progress?.('building');
    const doc = canonicalDoc(docIn);
    const b = build(doc, true, [], options.reuseLadders ? lastSpan : undefined);
    if ('refused' in b) return b.refused;
    return meshBuilt(
      { doc, built: b.built, conversion: null, issues: b.issues, convertMs: 0, buildMs: b.ms },
      'doc',
      reference ? canonical(reference) : null,
      options,
      t0,
      progress,
      probes,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

/** What a probe job answers with: the sections, or the reason the document would not build. */
export type ProbeOutcome =
  | { readonly ok: true; readonly probes: readonly SectionProbe[] }
  | { readonly ok: false; readonly error: string };

/**
 * The as-built sections of a document at `probes`, with no validation and no mesh: the scrub preview.
 * The build is warm (the sections are matched by content), about a millisecond.
 */
export const probeDocument = (docIn: BoardDoc, probes: readonly number[]): ProbeOutcome => {
  try {
    const r = buildBoard(canonicalDoc(docIn), { check: false });
    if (!r.ok) {
      return {
        ok: false,
        error: r.issues.find((i) => i.severity === 'error')?.message ?? 'The board did not build.',
      };
    }
    return { ok: true, probes: probesOf(r.value, probes) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** The STEP fit failure, worded in the unit the file is written in (the editor's display unit). */
const stepFitMessage = (err: StepFitError, unit: 'mm' | 'cm' | 'in'): string => {
  const per = unit === 'mm' ? 10 : unit === 'cm' ? 1 : 1 / 2.54;
  const digits = unit === 'mm' ? 2 : 3;
  const f = (cm: number): string => `${(cm * per).toFixed(digits)} ${unit}`;
  if (err.kind === 'budget') return `${err.message}`;
  return `The surface could not be fitted within ${f(err.tolerance)} (it reached ${f(err.deviation)}). Try fewer stations near the tail or a smaller feature.`;
};

/** What a conversion answers with: the document, or the reasons it was refused. */
export type ConvertOutcome =
  | ({ readonly ok: true } & ConvertedDoc)
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/**
 * Convert a classic board to a section document (the engine switch, a file opened with the engine
 * on). Never throws; a refusal carries the converter's reasons.
 */
export const convertToDoc = (board: BezierBoard): ConvertOutcome => {
  try {
    const c = convertClassic(canonical(board), {});
    if (!c.ok) {
      return {
        ok: false,
        error:
          c.issues.find((i) => i.severity === 'error')?.message ??
          'The board could not be converted.',
        issues: c.issues.map(issueOf),
      };
    }
    const rep = c.value.report;
    return {
      ok: true,
      doc: c.value.doc,
      conversion: {
        stations: rep.stations,
        tail: rep.tail,
        zone: rep.zone,
        lineAdjust: rep.lineAdjust,
        sectionAdjust: rep.sectionAdjust,
        addedKnots: rep.addedKnots,
      },
      issues: c.issues.map(issueOf),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

// --- The mesh's specs --------------------------------------------------------

/**
 * The centroid along x of a closed mesh's volume (signed tetrahedra about the bounding-box centre, as
 * `meshProperties` does for the volume). The classic specs' "centre of mass" is this number for the
 * classic loft; the mesh gives it for the surface the document describes, features and all.
 */
export const meshCentreX = (positions: Float32Array, indices: Uint32Array): number => {
  if (positions.length === 0) return 0;
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    x0 = Math.min(x0, positions[i]!);
    x1 = Math.max(x1, positions[i]!);
    y0 = Math.min(y0, positions[i + 1]!);
    y1 = Math.max(y1, positions[i + 1]!);
    z0 = Math.min(z0, positions[i + 2]!);
    z1 = Math.max(z1, positions[i + 2]!);
  }
  const cx = 0.5 * (x0 + x1);
  const cy = 0.5 * (y0 + y1);
  const cz = 0.5 * (z0 + z1);
  let vol = 0;
  let moment = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = 3 * indices[k]!;
    const b = 3 * indices[k + 1]!;
    const c = 3 * indices[k + 2]!;
    const ax = positions[a]! - cx;
    const ay = positions[a + 1]! - cy;
    const az = positions[a + 2]! - cz;
    const bx = positions[b]! - cx;
    const by = positions[b + 1]! - cy;
    const bz = positions[b + 2]! - cz;
    const px = positions[c]! - cx;
    const py = positions[c + 1]! - cy;
    const pz = positions[c + 2]! - cz;
    const dv = (ax * (by * pz - bz * py) + ay * (bz * px - bx * pz) + az * (bx * py - by * px)) / 6;
    vol += dv;
    moment += (dv * (ax + bx + px)) / 4;
  }
  return vol === 0 ? cx : cx + moment / vol;
};

/** What a measure job answers with: the mesh's numbers, or the reason the document would not build. */
export type MeasureOutcome =
  | ({ readonly ok: true } & MeshMeasure)
  | { readonly ok: false; readonly error: string };

/**
 * The specs of a settled document from its mesh (docs/design/m2-editor.md §4): validate, build and mesh at
 * the document's tolerance, then volume, plan area, surface area and the volume's centroid along x. The
 * surface is not sent back. A document the model refuses is an outcome, not an exception.
 */
export const measureDocument = (docIn: BoardDoc): MeasureOutcome => {
  try {
    const b = build(canonicalDoc(docIn), true, []);
    if ('refused' in b) {
      const r = b.refused;
      return { ok: false, error: r.ok ? 'The NURBS surface could not be built.' : r.error };
    }
    const m = meshBoard(b.built, { curvature: false });
    return {
      ok: true,
      volume: m.volume,
      planArea: m.planArea,
      surfaceArea: m.surfaceArea,
      centreX: meshCentreX(m.positions, m.indices),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// --- Files: the saved document ---------------------------------------------------

/** The canonical text of a document: what a `.board` file of the NURBS engine holds, and a share link carries. */
export const docToText = (doc: BoardDoc): string => boardDocToJson(doc);

/** What reading a saved document answers with: the document, or the reasons it is not one. */
export type ReviveOutcome =
  | { readonly ok: true; readonly doc: BoardDoc }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/**
 * Revive a parsed section document (an opened file, a share link, a session). Never throws. Only the
 * document's shape is checked here, not the board's design: a document that is shaped right and designed
 * badly opens, and the viewer reports the refusal (`validateBoard`), so it can be repaired.
 */
export const docFromJson = (json: unknown): ReviveOutcome => {
  try {
    const r = reviveBoardDoc(json);
    if (r.ok) return { ok: true, doc: r.value };
    return {
      ok: false,
      error: r.issues.find((i) => i.severity === 'error')?.message ?? 'Not a NURBS board document.',
      issues: r.issues.map(issueOf),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
};

// --- Exports ---------------------------------------------------------------------------------

/** A chain's Bézier segments (the document's own curve; exact). */
const chainSegments = (chain: Chain): CurveSeg[] => {
  const segs: CurveSeg[] = [];
  const pt = (p: readonly [number, number]): Pt => ({ x: p[0], y: p[1] });
  for (let i = 0; i + 1 < chain.knots.length; i++) {
    const a = chain.knots[i]!;
    const b = chain.knots[i + 1]!;
    segs.push({ p0: pt(a.p), c1: pt(a.out), c2: pt(b.in), p3: pt(b.p) });
  }
  return segs;
};

/**
 * A section half is probed at this many points (uniform in the section parameter), then thinned: dense
 * enough for the steep walls of a channel, never the file size.
 */
const EXPORT_SECTION_SAMPLES = 400;

/** How far (cm) the thinned section may stray from the probed one: 0.05 mm, a tenth of the 0.5 mm tolerance. */
const EXPORT_SECTION_TOL = 0.005;

/** Douglas-Peucker: the points of `pts` that keep every dropped one within `tol` of the polyline. */
const thin = (pts: readonly Pt[], tol: number): Pt[] => {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const pa = pts[a]!;
    const pb = pts[b]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i]!;
      const d =
        len === 0
          ? Math.hypot(p.x - pa.x, p.y - pa.y)
          : Math.abs(dx * (p.y - pa.y) - dy * (p.x - pa.x)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
};

/** The apex line is sampled at this many steps along the stringer. */
const EXPORT_APEX_STEPS = 200;

/**
 * Everything the DXF and 1:1 PDF drawings read from a built board ({@link BoardCurves}): the
 * document's chains, and the as-built section at each of `count` stations (`probeSection`, bottom
 * features included). Plain data; the drawing code in `@openshaper/export` imports no board model.
 */
export const curvesOfBuilt = (
  built: BuiltBoard,
  count: number,
  fins: BoardCurves['fins'],
  progress?: (done: number) => void,
): BoardCurves => {
  const doc = built.doc;
  const asymmetric = doc.symmetry === 'asymmetric';
  const ev = createEvaluator(built);
  const { xiMin, xiMax } = built;
  const notch = doc.tail.kind === 'notched' ? xiMin + doc.tail.zone : -Infinity;
  const out = new Float64Array(3);
  const pairs = (flat: readonly number[]): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i]!, y: flat[i + 1]! });
    return thin(pts, EXPORT_SECTION_TOL);
  };
  /** The outline end of the station's chord (the section's apex), plan view. */
  const chordEnd = (side: 0 | 1, xi: number): Pt => {
    ev.row(side, xi, 0);
    ev.eval(0.5, 0, out);
    return { x: out[0]!, y: out[1]! };
  };

  const sections: CurveSection[] = [];
  const n = Math.max(0, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const xi = xiMin + ((xiMax - xiMin) * (i + 0.5)) / n;
    const plus = pairs(probeSection(built, ev, 0, xi, EXPORT_SECTION_SAMPLES));
    const minus = asymmetric ? pairs(probeSection(built, ev, 1, xi, EXPORT_SECTION_SAMPLES)) : null;
    const cp = chordEnd(0, xi);
    const cm = asymmetric ? chordEnd(1, xi) : { x: cp.x, y: -cp.y };
    sections.push({ pos: xi, plus, minus, chordPlus: cp, chordMinus: cm, rail: xi < notch });
    progress?.((i + 1) / n);
  }

  const apex: Pt[] = [];
  for (let k = 0; k <= EXPORT_APEX_STEPS; k++) {
    const xi = xiMin + ((xiMax - xiMin) * k) / EXPORT_APEX_STEPS;
    ev.row(0, xi, 0);
    ev.eval(0.5, 0, out);
    apex.push({ x: out[0]!, y: out[2]! });
  }

  const plusSegs = chainSegments(doc.outline.plus);
  return {
    length: doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0],
    stringer: { from: xiMin, to: xiMax },
    outlinePlus: plusSegs,
    outlineMinus: asymmetric ? chainSegments(doc.outline.minus ?? doc.outline.plus) : null,
    bottom: chainSegments(doc.rocker),
    deck: chainSegments(doc.deck),
    apex,
    sections,
    ...(fins ? { fins } : {}),
  };
};

/** What an export job answers with: the files, or the reason it could not be made. */
export type ExportOutcome =
  | { readonly ok: true; readonly files: readonly ExportedFile[]; readonly ms: number }
  | { readonly ok: false; readonly error: string };

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * One export of a document, from the document itself (docs/design/m3-exports.md): STL from the grid mesh at
 * the export face size, welded; DXF and PDF 1:1 from the document's chains and the as-built sections.
 * Validates and builds first, so a document the model refuses is an outcome, not an exception. Runs for
 * as long as it takes (the one place a multi-second wait is accepted); `progress` names the stage.
 */
export const exportDocument = (
  docIn: BoardDoc,
  job: ExportJob,
  progress?: (stage: ExportStage, pass?: number) => void,
): ExportOutcome => {
  const t0 = now();
  try {
    progress?.('building');
    const doc = canonicalDoc(docIn);
    const b = build(doc, true, []);
    if ('refused' in b) {
      return { ok: false, error: b.refused.ok ? 'The NURBS surface could not be built.' : b.refused.error }; // prettier-ignore
    }
    const built = b.built;
    let files: ExportedFile[];
    if (job.format === 'stl') {
      progress?.('meshing');
      const m = meshBoard(built, { maxEdge: job.faceSize });
      progress?.('writing');
      files = [
        {
          name: `${job.slug}.stl`,
          type: 'model/stl',
          bytes: stlFromMesh(m, { name: job.slug }),
        },
      ];
    } else if (job.format === 'dxf') {
      progress?.('sampling');
      const curves = curvesOfBuilt(built, job.crossSectionCount, job.fins);
      progress?.('drawing');
      const text = exportDxfCurves(curves, {
        curveMode: job.curveMode,
        ...(job.ghost ? { ghostBoard: job.ghost } : {}),
      });
      progress?.('writing');
      files = [
        {
          name: job.curveMode === 'spline' ? `${job.slug}-spline.dxf` : `${job.slug}.dxf`,
          type: 'application/dxf',
          bytes: utf8(text),
        },
      ];
    } else if (job.format === 'step') {
      progress?.('fitting');
      const out = boardStep(built, {
        name: job.slug,
        unit: job.unit,
        timestamp: new Date().toISOString().slice(0, 19),
        onPass: (pass) => progress?.('fitting', pass),
        onWrite: () => progress?.('writing'),
      });
      files = [{ name: `${job.slug}.step`, type: 'model/step', bytes: utf8(out.text) }];
    } else {
      progress?.('sampling');
      const curves = curvesOfBuilt(built, job.options.crossSectionCount ?? 7, job.fins);
      progress?.('drawing');
      const res = exportBoardPdf1to1FilesFromCurves(curves, job.options);
      progress?.('writing');
      files = res.files.map((f) => ({
        name: f.name.replace(/^board/, job.slug),
        type: 'application/pdf',
        bytes: f.bytes,
      }));
    }
    return { ok: true, files, ms: now() - t0 };
  } catch (err) {
    if (err instanceof StepFitError && job.format === 'step') {
      return { ok: false, error: stepFitMessage(err, job.unit) };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
