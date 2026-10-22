// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/geom/testing/occt`: the OCCT validation protocol of
 * docs/design/geom-core.md §15.3, as functions any package's
 * `*.occt.test.ts` can run on its own solids (board2 step S4 runs it on whole
 * boards). Extracted from `step/step.occt.test.ts`, which now runs on it.
 *
 * **Test-only, and the one place outside a test file that imports
 * `occt-wasm`.** The WASM kernel is a devDependency of `@openshaper/geom`
 * only; this subpath is not reachable from geom's `.` or `./testing` entries,
 * and only `*.occt.test.ts` files may import it (`occt-isolation.test.ts`
 * checks all three, ESLint forbids it in every package's `src`). A dependent
 * package resolves `occt-wasm` through this file's real path in geom, so its
 * own `package.json` never names the oracle.
 *
 * The functions measure and return plain data; the calling test asserts.
 * Every runner frees the OCCT handles it creates (`checkpoint` /
 * `releaseSince`) before it returns.
 *
 * - **Path B** ({@link pathB}): our STEP file through OCCT's STEP reader. B1
 *   shape type, B2 `isValid`, B3 counts against `StepStats`, B4 tolerance
 *   growth against the declared uncertainty, B5 edges and B6 surfaces equal
 *   ours parameter by parameter, B8 GProp's volume and the volume of OCCT's
 *   own fine mesh against an exact volume with its bound
 *   ({@link meshVolumeCheck}), and inside / outside probes.
 * - **Path A** ({@link pathA}): the same solid as OCCT's native BREP text
 *   (`toOcctBrepText`), read with no healing, so `BRepCheck_Analyzer` and the
 *   sign of the volume judge the orientation exactly as built; **B7**: GProp's
 *   volume through Path A against Path B in mm and in cm.
 * - **Orientation negative controls** ({@link orientationControls}): every
 *   face flipped in the shell, every edge use of the first wire flipped, the
 *   solid turned inside out (and what the STEP reader makes of it), and every
 *   geometry or orientation mutation `checkBrep` refuses, through Path A.
 */
import { OcctKernel } from 'occt-wasm';
import type { ShapeHandle } from 'occt-wasm';
import { flipBrep, unwrapBrep } from '../../brep/brep';
import { makeBrep } from '../../brep/brep';
import { checkBrep } from '../../brep/check';
import type { BrepReport } from '../../brep/check';
import { curvePoint } from '../../curve';
import { surfacePoint } from '../../surface';
import { writeStep, writeStepCore } from '../../step/write';
import type { StepStats } from '../../step/write';
import type { Brep } from '../../types';
import { MUTATIONS } from '../mutations';
import { toOcctBrepText, toOcctBrepTextUnchecked } from '../occt-brep';

export { OcctKernel };
export type { ShapeHandle };

// ---------------------------------------------------------------------------
// Named settings of the protocol (§15.3, §15.5)
// ---------------------------------------------------------------------------

/** Millimetres per file unit. */
export const MM_PER_FILE_UNIT = Object.freeze({ mm: 1, cm: 10, in: 25.4 } as const);

/** Deflection of the oracle mesh (mm): 0.01 mm, about a hundredth of a CNC pass. */
export const DEFLECTION_MM = 0.01;

/** Angular deflection of the oracle mesh (radians), OCCT's `BRepMesh` setting used throughout §15.5. */
export const ANGULAR_DEFLECTION = 0.05;

/** Relative rounding of a Float32 coordinate (2⁻²³ bounds the error with margin). */
export const FLOAT32_EPS = 2 ** -23;

/**
 * B7's bound. Both paths hand GProp the same poles, knots and weights (the
 * STEP reader's cm → mm conversion multiplies by 10, ≤ 1 ulp per coordinate),
 * and GProp's discretisation error (0.4 to 0.8 %, §15.2) is a function of that
 * geometry, so it cancels. 1e-9 relative is the design's bound (§15.3), six
 * orders above the rounding; measured, the volumes are equal to the last bit.
 */
export const B7_REL = 1e-9;

/** B5 and B6 point tolerance (mm): ≥ 10⁶ × the float64 rounding of coordinates ≤ 1000 mm. */
export const ENCODING_TOL_MM = 1e-6;

/** Parameter agreement of an OCCT edge's range with ours (B5) and of a face's uv bounds (B6). */
export const PARAM_MATCH_TOL = 1e-9;

/** Samples per edge for B5, and per direction of a face's uv bounds for B6 (§15.5). */
export const ENCODING_SAMPLES = Object.freeze({ edge: 9, face: 5 });

/** GProp's own volume is coarse on B-spline solids (§15.2): a 1 % sanity check only. */
export const GPROP_SANITY_REL = 0.01;

/** The largest bound-to-volume ratio for which the mesh-volume oracle still means something. */
export const MESH_BOUND_MAX_REL = 5e-3;

/** The outside probe's coordinates (mm): 10 m out along the diagonal, beyond any corpus solid or board. */
export const OUTSIDE_PROBE_MM = 1e4;

// ---------------------------------------------------------------------------
// A solid under test
// ---------------------------------------------------------------------------

/** A corpus solid with its exact (or independently computed) measures, in cm. */
export interface OcctSolid {
  readonly name: string;
  /** Exact volume (cm³), total area (cm²) and the area of its curved faces (cm²). */
  readonly volume: number;
  readonly area: number;
  readonly curved: number;
  /** A point strictly inside the solid (cm). */
  readonly inside: readonly [number, number, number];
  /**
   * A face with a fitted pcurve: its edge gap `g` (measured by `checkBrep`) leaks into the
   * integrals by at most `g · perimeter · reach / 3` (cm³; `reach` the largest distance from the
   * mass reference point, cm), and into the mesh by `g · area`.
   */
  readonly fitted?: { readonly perimeter: number; readonly reach: number };
  /** The largest |coordinate| of the solid (cm), for the Float32 term of the mesh bound. */
  readonly extent: number;
  /** Deflection of the oracle mesh (mm), default {@link DEFLECTION_MM}. */
  readonly deflectionMm?: number;
}

// ---------------------------------------------------------------------------
// Helpers over OCCT results
// ---------------------------------------------------------------------------

/** Largest vertex and edge tolerance in OCCT's BREP text (`Ve` / `Ed` entries: tolerance first). */
export function maxShapeTolerance(brep: string): number {
  const lines = brep.split('\n');
  let max = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i] === 'Ve' || lines[i] === 'Ed') {
      const tol = Number(lines[i + 1]!.trim().split(/\s+/)[0]);
      if (!Number.isFinite(tol)) {
        throw new Error(`tolerance line after ${lines[i]} is not a number: ${lines[i + 1]}`);
      }
      max = Math.max(max, tol);
    }
  }
  return max;
}

/** Signed volume of a triangle mesh (divergence theorem), relative to its first vertex. */
export function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  const ox = positions[0]!;
  const oy = positions[1]!;
  const oz = positions[2]!;
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = positions[a]! - ox,
      ay = positions[a + 1]! - oy,
      az = positions[a + 2]! - oz;
    const bx = positions[b]! - ox,
      by = positions[b + 1]! - oy,
      bz = positions[b + 2]! - oz;
    const cx = positions[c]! - ox,
      cy = positions[c + 1]! - oy,
      cz = positions[c + 2]! - oz;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/** The one solid of an imported shape (the shape itself, or the only solid of a compound); throws otherwise. */
export function solidOf(kernel: OcctKernel, shape: ShapeHandle): ShapeHandle {
  const type = kernel.getShapeType(shape);
  if (type === 'solid') return shape;
  if (type !== 'compound' || kernel.subShapeCount(shape, 'solid') !== 1) {
    throw new Error(`expected a solid or a compound of exactly one solid; got ${type}`);
  }
  return kernel.getSubShapes(shape, 'solid')[0]!;
}

/** `n` parameters across `[a, b]`, ends included. */
const grid = (a: number, b: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/**
 * B5: the indices of our edges that no OCCT edge equals parameter by parameter
 * (same range, same points at {@link ENCODING_SAMPLES}`.edge` parameters, in mm,
 * model cm). Empty when every edge arrived intact.
 */
export function unmatchedEdges(kernel: OcctKernel, shape: ShapeHandle, b: Brep): number[] {
  const occtEdges = kernel.getSubShapes(shape, 'edge');
  const out: number[] = [];
  b.edges.forEach((e, ei) => {
    const [a, z] = e.curve.basis.domain;
    const found = occtEdges.some((oe) => {
      const { first, last } = kernel.curveParameters(oe);
      if (Math.abs(first - a) > PARAM_MATCH_TOL || Math.abs(last - z) > PARAM_MATCH_TOL)
        return false;
      return grid(a, z, ENCODING_SAMPLES.edge).every((t) => {
        const p = curvePoint(e.curve, t);
        const q = kernel.curvePointAtParam(oe, t);
        return Math.hypot(q.x - 10 * p.x, q.y - 10 * p.y, q.z - 10 * p.z) <= ENCODING_TOL_MM;
      });
    });
    if (!found) out.push(ei);
  });
  return out;
}

/**
 * B6: the number of OCCT faces that equal none of our surfaces at a
 * {@link ENCODING_SAMPLES}`.face`² grid over the uv bounds OCCT reports (mm,
 * model cm). Zero when every surface arrived intact.
 */
export function unmatchedFaces(kernel: OcctKernel, shape: ShapeHandle, b: Brep): number {
  let missing = 0;
  const n = ENCODING_SAMPLES.face;
  for (const of of kernel.getSubShapes(shape, 'face')) {
    const bounds = kernel.uvBounds(of);
    const matched = b.faces.some((f) => {
      const uExt =
        f.surface.u.kind === 'periodic'
          ? [f.surface.u.domain[0], f.surface.u.domain[0] + f.surface.u.period]
          : f.surface.u.domain;
      const vExt =
        f.surface.v.kind === 'periodic'
          ? [f.surface.v.domain[0], f.surface.v.domain[0] + f.surface.v.period]
          : f.surface.v.domain;
      if (bounds.uMin < uExt[0]! - PARAM_MATCH_TOL || bounds.uMax > uExt[1]! + PARAM_MATCH_TOL)
        return false;
      if (bounds.vMin < vExt[0]! - PARAM_MATCH_TOL || bounds.vMax > vExt[1]! + PARAM_MATCH_TOL)
        return false;
      return grid(bounds.uMin, bounds.uMax, n).every((u) =>
        grid(bounds.vMin, bounds.vMax, n).every((v) => {
          const p = surfacePoint(f.surface, u, v);
          const q = kernel.pointOnSurface(of, u, v);
          return Math.hypot(q.x - 10 * p.x, q.y - 10 * p.y, q.z - 10 * p.z) <= ENCODING_TOL_MM;
        }),
      );
    });
    if (!matched) missing++;
  }
  return missing;
}

/** The mesh-volume oracle on one shape (mm³). */
export interface MeshVolumeCheck {
  /** Signed volume of OCCT's own triangulation. */
  readonly volume: number;
  /** The solid's exact volume. */
  readonly exact: number;
  /** The bound on `|volume − exact|` (module comment of {@link meshVolumeCheck}). */
  readonly bound: number;
  readonly deflectionMm: number;
}

/**
 * The accuracy oracle: the volume of OCCT's own fine mesh (mm³) against the
 * exact volume. |ΔV| ≤ (curved area) × deflection: every point of the mesh is
 * within the deflection of the surface, and planar faces are meshed exactly.
 * Plus the Float32 rounding of the returned positions (2⁻²³ per coordinate on
 * coordinates up to the solid's extent, over its whole area) and, for a fitted
 * pcurve, the gap times the area. Model cm, OCCT mm.
 */
export function meshVolumeCheck(
  kernel: OcctKernel,
  shape: ShapeHandle,
  solid: OcctSolid,
  gapMm: number,
): MeshVolumeCheck {
  const deflectionMm = solid.deflectionMm ?? DEFLECTION_MM;
  const mesh = kernel.tessellate(shape, {
    linearDeflection: deflectionMm,
    angularDeflection: ANGULAR_DEFLECTION,
  });
  const extentMm = 10 * solid.extent;
  const bound =
    solid.curved * 100 * deflectionMm +
    solid.area * 100 * extentMm * FLOAT32_EPS +
    (solid.fitted === undefined ? 0 : gapMm * solid.area * 100);
  return {
    volume: meshVolume(mesh.positions, mesh.indices),
    exact: solid.volume * 1000,
    bound,
    deflectionMm,
  };
}

/** Inside and far-outside probes (cm → mm): orientation as OCCT's classifier sees the solid. */
export function containsProbe(
  kernel: OcctKernel,
  body: ShapeHandle,
  solid: Pick<OcctSolid, 'inside'>,
): { readonly inside: boolean; readonly outside: boolean } {
  const [ix, iy, iz] = solid.inside;
  return {
    inside: kernel.containsPoint(body, { x: 10 * ix, y: 10 * iy, z: 10 * iz }),
    outside: kernel.containsPoint(body, {
      x: OUTSIDE_PROBE_MM,
      y: OUTSIDE_PROBE_MM,
      z: OUTSIDE_PROBE_MM,
    }),
  };
}

/** OCCT's verdict on a shape: `isValid` and GProp's signed volume (mm³). */
export interface OcctVerdict {
  readonly valid: boolean;
  readonly volume: number;
}

export function occtVerdict(kernel: OcctKernel, shape: ShapeHandle): OcctVerdict {
  return { valid: kernel.isValid(shape), volume: kernel.getVolume(shape) };
}

/** Refused by the unhealed path: invalid, or valid but not outward (an inside-out solid). */
export const refused = (v: OcctVerdict): boolean => !v.valid || !(v.volume > 0);

/** Runs `f` between a checkpoint and its release, so every handle it makes is freed. */
export function withCheckpoint<T>(kernel: OcctKernel, f: () => T): T {
  const mark = kernel.checkpoint();
  try {
    return f();
  } finally {
    kernel.releaseSince(mark);
  }
}

// ---------------------------------------------------------------------------
// Native BREP text edits (negative controls)
// ---------------------------------------------------------------------------

/** The sub-shape line of the first `record` (`Sh`, `Wi`, …) in BREP text, as a line index. */
export function subShapeLine(lines: readonly string[], record: string): number {
  const at = lines.indexOf(record);
  if (at < 0) throw new Error(`no ${record} record`);
  if (!/^[01]{7}$/.test(lines[at + 2] ?? '')) throw new Error(`${record}: no flags line`);
  if (!/^([+-]\d+ 0 )*\*$/.test(lines[at + 3] ?? '')) {
    throw new Error(`${record}: no sub-shapes line`);
  }
  return at + 3;
}

/** The text with the orientation of sub-shape `k` of the first `record` flipped. */
export function flipSubShape(text: string, record: string, k: number): string {
  const lines = text.split('\n');
  const at = subShapeLine(lines, record);
  const toks = lines[at]!.split(' ');
  if (!(2 * k + 1 < toks.length)) throw new Error(`${record} has no sub-shape ${k}`);
  const t = toks[2 * k]!;
  toks[2 * k] = `${t[0] === '+' ? '-' : '+'}${t.slice(1)}`;
  lines[at] = toks.join(' ');
  return lines.join('\n');
}

/** The number of sub-shapes of the first `record` in BREP text. */
export function subShapeCount(text: string, record: string): number {
  const lines = text.split('\n');
  return (lines[subShapeLine(lines, record)]!.split(' ').length - 1) / 2;
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/** What OCCT's import of a shape shows (both paths). */
export interface ImportFacts {
  /** B1: the type of the imported body, and of the shape itself. */
  readonly type: string;
  readonly shapeType: string;
  /** B2: `BRepCheck_Analyzer`. */
  readonly valid: boolean;
  /** B3: sub-shape counts. */
  readonly solids: number;
  readonly shells: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  /** B4: the largest vertex or edge tolerance in OCCT's own BREP text (mm). */
  readonly grownMm: number;
  /** B5, B6: our edges with no OCCT counterpart; OCCT faces with no counterpart of ours. */
  readonly unmatchedEdges: readonly number[];
  readonly unmatchedFaces: number;
  /** GProp's volume (mm³), coarse on B-splines. */
  readonly gpropVolume: number;
  /** B8: the mesh-volume oracle. */
  readonly mesh: MeshVolumeCheck;
  readonly contains: { readonly inside: boolean; readonly outside: boolean };
}

function importFacts(
  kernel: OcctKernel,
  shape: ShapeHandle,
  b: Brep,
  solid: OcctSolid,
  gapMm: number,
): ImportFacts {
  const shapeType = kernel.getShapeType(shape);
  const body = shapeType === 'solid' ? shape : solidOf(kernel, shape);
  return {
    type: kernel.getShapeType(body),
    shapeType,
    valid: kernel.isValid(shape),
    solids: kernel.subShapeCount(shape, 'solid'),
    shells: kernel.subShapeCount(shape, 'shell'),
    faces: kernel.subShapeCount(shape, 'face'),
    edges: kernel.subShapeCount(shape, 'edge'),
    vertices: kernel.subShapeCount(shape, 'vertex'),
    grownMm: maxShapeTolerance(kernel.toBREP(shape)),
    unmatchedEdges: unmatchedEdges(kernel, shape, b),
    unmatchedFaces: unmatchedFaces(kernel, shape, b),
    gpropVolume: kernel.getVolume(shape),
    mesh: meshVolumeCheck(kernel, shape, solid, gapMm),
    contains: containsProbe(kernel, body, solid),
  };
}

/** Path B of one solid in one file unit. */
export interface PathBReport extends ImportFacts {
  /** The STEP text written, and its stats (counts, declared uncertainty in file units). */
  readonly text: string;
  readonly stats: StepStats;
  /** The declared uncertainty in mm (B4 compares `grownMm` with twice it). */
  readonly declaredMm: number;
  /** `checkBrep` of the input (its gaps enter the mesh bound and the integrals' leak). */
  readonly check: BrepReport;
}

/**
 * Path B (§15.3): `checkBrep`, `writeStep` in `fileUnit`, OCCT's STEP import,
 * and the facts of B1–B6 and B8. Throws when `checkBrep` refuses the solid
 * (the writer would refuse it too).
 */
export function pathB(
  kernel: OcctKernel,
  b: Brep,
  solid: OcctSolid,
  fileUnit: keyof typeof MM_PER_FILE_UNIT,
  opts?: { readonly timestamp?: string },
): PathBReport {
  const check = checkBrep(b);
  if (!check.ok)
    throw new Error(`checkBrep refuses ${solid.name}: ${JSON.stringify(check.issues)}`);
  const out = writeStep(b, {
    fileUnit,
    name: solid.name,
    ...(opts?.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
  });
  const facts = withCheckpoint(kernel, () =>
    importFacts(kernel, kernel.importStep(out.text), b, solid, 10 * check.maxEdgeGap),
  );
  return {
    ...facts,
    text: out.text,
    stats: out.stats,
    declaredMm: out.stats.uncertainty * MM_PER_FILE_UNIT[fileUnit],
    check,
  };
}

/** Path A of one solid, with B7. */
export interface PathAReport extends ImportFacts {
  /** The native BREP text written and the tolerance it carries (mm). */
  readonly text: string;
  readonly tolerance: number;
  /** The uncertainty `writeStep` declares for the same solid (mm): Path A writes the same. */
  readonly stepUncertainty: number;
  /** B7: GProp's volume of our STEP file read in mm and in cm (mm³). */
  readonly b7: { readonly mm: number; readonly cm: number };
}

/**
 * Path A (§15.3, §15.6): `toOcctBrepText` (which runs `checkBrep` first and
 * throws on a refused solid), OCCT's unhealed `fromBREP`, the same facts as
 * Path B, and B7: GProp's volume of the same solid through Path B in mm and cm.
 */
export function pathA(kernel: OcctKernel, b: Brep, solid: OcctSolid): PathAReport {
  const a = toOcctBrepText(b);
  const gapMm = 10 * checkBrep(b).maxEdgeGap;
  const stepUncertainty = writeStep(b).stats.uncertainty;
  const mmText = writeStep(b, { fileUnit: 'mm' }).text;
  const cmText = writeStep(b, { fileUnit: 'cm' }).text;
  return withCheckpoint(kernel, () => {
    const facts = importFacts(kernel, kernel.fromBREP(a.text), b, solid, gapMm);
    return {
      ...facts,
      text: a.text,
      tolerance: a.tolerance,
      stepUncertainty,
      b7: {
        mm: kernel.getVolume(kernel.importStep(mmText)),
        cm: kernel.getVolume(kernel.importStep(cmText)),
      },
    };
  });
}

/** The orientation negative controls of one solid (§15.6). */
export interface OrientationControls {
  /** The intact solid through Path A. */
  readonly reference: OcctVerdict;
  /** The unchecked writer at the checked writer's tolerance writes the same text. */
  readonly uncheckedSameText: boolean;
  /** Faces in the shell record (equal to ours) and the verdict with each one flipped. */
  readonly faceFlips: readonly OcctVerdict[];
  /** Edge uses of the first wire, and the verdict with each one flipped. */
  readonly edgeFlips: readonly OcctVerdict[];
  /** `checkBrep` of the solid turned inside out (`flipBrep`): must refuse it. */
  readonly insideOutCheckOk: boolean;
  /** The inside-out solid through Path A (unchecked writer) and through the STEP reader. */
  readonly insideOut: OcctVerdict;
  readonly insideOutStep: OcctVerdict;
  /** Every `MUTATIONS` entry `checkBrep` refuses (bar the genus declaration), through Path A. */
  readonly mutations: readonly {
    readonly name: string;
    readonly checkBrepOk: boolean;
    readonly verdict: OcctVerdict;
  }[];
}

/**
 * The orientation negative controls (§15.6) on a valid solid: what the
 * unhealed path says of every face flipped in its shell, every edge use of the
 * first wire flipped, the solid turned inside out (and the STEP reader's
 * re-orientation of it), and every mutation `checkBrep` refuses. The caller
 * pins the verdicts (multi-face shells: every flip invalid; inside out: valid
 * with the volume negated; the STEP reader: healed to the reference volume).
 */
export function orientationControls(kernel: OcctKernel, b: Brep): OrientationControls {
  const good = toOcctBrepText(b);
  const inverted = flipBrep(b);
  const check = checkBrep(b);
  const insideOutText = toOcctBrepTextUnchecked(inverted, { tolerance: good.tolerance }).text;
  // Written without the gate but declaring the intact solid's measured gaps (an inversion
  // moves no geometry), so a fitted face's gap is not healed into a volume change of its own.
  const insideOutStepText = writeStepCore(inverted, undefined, check).text;
  const mutated: { name: string; checkBrepOk: boolean; text: string }[] = [];
  for (const m of MUTATIONS) {
    // A genus is our declaration (Euler–Poincaré); OCCT has no such notion to check.
    if (m.caughtBy(b) !== 'checkBrep' || m.name === 'declare a wrong genus') continue;
    const mb = unwrapBrep(makeBrep(m.apply(b)));
    mutated.push({
      name: m.name,
      checkBrepOk: checkBrep(mb).ok,
      text: toOcctBrepTextUnchecked(mb, { tolerance: good.tolerance }).text,
    });
  }
  const faces = subShapeCount(good.text, 'Sh');
  const uses = subShapeCount(good.text, 'Wi');
  return withCheckpoint(kernel, () => ({
    reference: occtVerdict(kernel, kernel.fromBREP(good.text)),
    uncheckedSameText: toOcctBrepTextUnchecked(b, { tolerance: good.tolerance }).text === good.text,
    faceFlips: Array.from({ length: faces }, (_, k) =>
      occtVerdict(kernel, kernel.fromBREP(flipSubShape(good.text, 'Sh', k))),
    ),
    edgeFlips: Array.from({ length: uses }, (_, k) =>
      occtVerdict(kernel, kernel.fromBREP(flipSubShape(good.text, 'Wi', k))),
    ),
    insideOutCheckOk: checkBrep(inverted).ok,
    insideOut: occtVerdict(kernel, kernel.fromBREP(insideOutText)),
    insideOutStep: occtVerdict(kernel, kernel.importStep(insideOutStepText)),
    mutations: mutated.map((m) => ({
      name: m.name,
      checkBrepOk: m.checkBrepOk,
      verdict: occtVerdict(kernel, kernel.fromBREP(m.text)),
    })),
  }));
}
