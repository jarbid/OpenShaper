// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP writer (design §14, §6.20): a B-rep as an ISO 10303-21 file,
 * `AUTOMOTIVE_DESIGN` (AP214), `MANIFOLD_SOLID_BREP` over a `CLOSED_SHELL` of
 * `ADVANCED_FACE`s. Why AP214 and why a manifold solid rather than a surface
 * model are in `docs/design/step-export.md`.
 *
 * ## Entities
 *
 * - Geometry. Surfaces and curves are B-splines with the Euclidean control
 *   points and, when rational, the weights as a **complex entity** whose
 *   partial entities are in alphabetical order:
 *   `(BOUNDED_CURVE() B_SPLINE_CURVE(…) B_SPLINE_CURVE_WITH_KNOTS(…) CURVE()
 *   GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE((w…)) REPRESENTATION_ITEM(''))`
 *   and the surface analogue. A polynomial one is the simple
 *   `B_SPLINE_CURVE_WITH_KNOTS` / `B_SPLINE_SURFACE_WITH_KNOTS`. Knots are
 *   written as stored (never normalised); lengths are scaled to the file unit,
 *   parameters, weights and pcurve coordinates never are.
 * - Edges. An `EDGE_CURVE` whose geometry is a `SURFACE_CURVE` carrying the
 *   3D curve and one `PCURVE` per adjacent face (`DEFINITIONAL_REPRESENTATION`
 *   of the 2D B-spline in the parametric context); an edge whose two uses are in
 *   one face is a `SEAM_CURVE` with its two pcurves. `pcurves: 'trimmedOnly'`
 *   leaves a plain 3D curve on edges that are not seams and whose faces are all
 *   untrimmed (their natural boundary).
 * - Periodic surfaces are written clamped through the exact conversion in
 *   `brep/clamp.ts`, on the same parameter domain, so pcurves are unchanged;
 *   `u_closed` / `v_closed` state the geometric truth, measured.
 *
 * ## Measured, not assumed
 *
 * `writeStep` runs `checkBrep` and refuses an invalid B-rep (decision 34): the
 * B-rep's `same_sense` flags and loop directions were settled by the sign of the
 * enclosed volume, and importers heal silently (design §15.2), so the writer is
 * the gate. The declared uncertainty is `2 × max(maxEdgeGap, maxVertexGap)`,
 * floored at `Tolerances.point`, in file units: OCCT then has no undeclared gap
 * to heal, and a validator can tell real tolerance growth from declared
 * uncertainty.
 *
 * ## Determinism
 *
 * Same B-rep, options and timestamp give byte-identical output: ids follow
 * emission order, points are deduplicated by their emitted text, nothing is
 * keyed by hash order or time. The timestamp defaults to a constant (geom has no
 * clock); callers pass the real one.
 *
 * ## Numbers
 *
 * `'roundTrip'` (default) writes the shortest decimal that reads back exactly;
 * a number `d` writes `d` significant digits. Knot multiplicities are computed
 * from the *formatted* knots, so knots that print alike merge, and what is
 * checked is exactly what was written.
 */
import { clampSurface } from '../brep/clamp';
import { isNaturalFace } from '../brep/faces';
import { checkBrep } from '../brep/check';
import type { BrepReport } from '../brep/check';
import { fail } from '../errors';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type { Brep, ClampedCurve, NurbsSurface, Point3 } from '../types';
import { bool, createEmitter, real, ref, refs, str } from './part21';
import type { Emitter, StepPrecision } from './part21';

export interface StepWriteOptions {
  /** Unit declared in the file (default `'mm'`, the STEP norm). */
  readonly fileUnit?: 'mm' | 'cm' | 'in';
  /** Unit of the B-rep's coordinates (default `'cm'`, the kernel's unit). */
  readonly modelUnit?: 'mm' | 'cm';
  /** `PRODUCT` and file name (default `'part'`). */
  readonly name?: string;
  /** `FILE_NAME` timestamp, ISO 8601 (default a constant, for reproducible bytes). */
  readonly timestamp?: string;
  readonly originatingSystem?: string;
  /** `'roundTrip'` (default) or the number of significant digits (1 to 17). */
  readonly precision?: StepPrecision;
  /** `'always'` (default): a pcurve on every edge use. `'trimmedOnly'`: see the module comment. */
  readonly pcurves?: 'always' | 'trimmedOnly';
  /** Overrides for the tolerances used by the check (`point`, `fit`, `paramRel`). */
  readonly tol?: Partial<Tolerances>;
}

/** Counts and measured accuracy of a written file (lengths in file units). */
export interface StepStats {
  readonly entities: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly uncertainty: number;
  readonly maxEdgeGap: number;
}

/** What {@link writeStep} returns. */
export interface StepResult {
  readonly text: string;
  readonly stats: StepStats;
  readonly report: BrepReport;
}

/** Millimetres per unit. */
const MM: Readonly<Record<'mm' | 'cm' | 'in', number>> = { mm: 1, cm: 10, in: 25.4 };

/** The `FILE_NAME` time stamp when none is given: a fixed instant, so output is reproducible. */
const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00';

interface Ctx {
  readonly em: Emitter;
  readonly precision: StepPrecision;
  /** Model length → file length. */
  readonly factor: number;
  readonly tol: Tolerances;
  /** CARTESIAN_POINT ids by emitted text (dimension included). */
  readonly points: Map<string, number>;
  context2d: number | null;
}

function point(ctx: Ctx, coords: readonly string[]): number {
  const key = `${coords.length}|${coords.join(',')}`;
  const hit = ctx.points.get(key);
  if (hit !== undefined) return hit;
  const id = ctx.em.emit(`CARTESIAN_POINT('',(${coords.join(',')}))`);
  ctx.points.set(key, id);
  return id;
}

/**
 * Knot values and multiplicities from the *formatted* knots (module comment):
 * knots that print alike merge. Throws `step-unsupported` when merging (a
 * reduced `precision`) leaves an invalid multiplicity: not `degree + 1` at
 * the ends, above `degree` inside. Internal; exported for the tests.
 */
export function formatKnots(
  knots: ArrayLike<number>,
  degree: number,
  precision: StepPrecision,
  what: string,
): { readonly values: string; readonly mults: string } {
  const values: string[] = [];
  const mults: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const s = real(knots[i]!, precision);
    if (values.length > 0 && values[values.length - 1] === s) mults[mults.length - 1]!++;
    else {
      values.push(s);
      mults.push(1);
    }
  }
  const last = mults.length - 1;
  const bad = mults.some((m, i) => (i === 0 || i === last ? m !== degree + 1 : m > degree));
  if (bad) {
    fail(
      'step-unsupported',
      `${what}: at this precision the knots merge into multiplicities [${mults.join(',')}], not valid for degree ${degree}`,
    );
  }
  return { values: `(${values.join(',')})`, mults: `(${mults.join(',')})` };
}

const knotList = (ctx: Ctx, knots: ArrayLike<number>, degree: number, what: string) =>
  formatKnots(knots, degree, ctx.precision, what);

/** Euclidean control point `i` of a homogeneous net of stride `h`, scaled. */
function coordTexts(
  ctx: Ctx,
  cw: ArrayLike<number>,
  i: number,
  dim: number,
  scale: number,
): string[] {
  const h = dim + 1;
  const w = cw[i * h + dim]!;
  const out: string[] = [];
  for (let k = 0; k < dim; k++) out.push(real((cw[i * h + k]! / w) * scale, ctx.precision));
  return out;
}

/** Emits a clamped curve (3D lengths scaled by `ctx.factor`, 2D pcurves not). */
function emitCurve(ctx: Ctx, c: ClampedCurve<2> | ClampedCurve<3>): number {
  const dim = c.dim;
  const n = c.basis.count;
  const scale = dim === 3 ? ctx.factor : 1;
  const pts: number[] = [];
  const coords: string[][] = [];
  for (let i = 0; i < n; i++) {
    const t = coordTexts(ctx, c.cw, i, dim, scale);
    coords.push(t);
    pts.push(point(ctx, t));
  }
  const closed = coords[0]!.every((x, k) => x === coords[n - 1]![k]);
  const k = knotList(ctx, c.basis.knots, c.basis.degree, 'curve');
  if (!c.rational) {
    return ctx.em.emit(
      `B_SPLINE_CURVE_WITH_KNOTS('',${c.basis.degree},${refs(pts)},.UNSPECIFIED.,${bool(closed)},.F.,${k.mults},${k.values},.UNSPECIFIED.)`,
    );
  }
  const h = dim + 1;
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(real(c.cw[i * h + dim]!, ctx.precision));
  return ctx.em.emit(
    `(BOUNDED_CURVE()B_SPLINE_CURVE(${c.basis.degree},${refs(pts)},.UNSPECIFIED.,${bool(closed)},.F.)` +
      `B_SPLINE_CURVE_WITH_KNOTS(${k.mults},${k.values},.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
      `RATIONAL_B_SPLINE_CURVE((${w.join(',')}))REPRESENTATION_ITEM(''))`,
  );
}

/** Emits a surface (clamped in both directions) as a B-spline surface. */
function emitSurface(ctx: Ctx, s: NurbsSurface): number {
  const nu = s.u.count;
  const nv = s.v.count;
  const rows: string[] = [];
  const wrows: string[] = [];
  const texts: string[][] = [];
  for (let i = 0; i < nu; i++) {
    const ids: number[] = [];
    const ws: string[] = [];
    for (let j = 0; j < nv; j++) {
      const t = coordTexts(ctx, s.cw, i * nv + j, 3, ctx.factor);
      texts.push(t);
      ids.push(point(ctx, t));
      ws.push(real(s.cw[(i * nv + j) * 4 + 3]!, ctx.precision));
    }
    rows.push(refs(ids));
    wrows.push(`(${ws.join(',')})`);
  }
  // Closed in a direction iff its two end rows of control points coincide.
  const same = (a: number, b: number): boolean => texts[a]!.every((x, k) => x === texts[b]![k]);
  let uClosed = true;
  for (let j = 0; j < nv && uClosed; j++) uClosed = same(j, (nu - 1) * nv + j);
  let vClosed = true;
  for (let i = 0; i < nu && vClosed; i++) vClosed = same(i * nv, i * nv + nv - 1);
  const ku = knotList(ctx, s.u.knots, s.u.degree, 'surface u');
  const kv = knotList(ctx, s.v.knots, s.v.degree, 'surface v');
  const net = `(${rows.join(',\n')})`;
  if (!s.rational) {
    return ctx.em.emit(
      `B_SPLINE_SURFACE_WITH_KNOTS('',${s.u.degree},${s.v.degree},\n${net},\n.UNSPECIFIED.,${bool(uClosed)},${bool(vClosed)},.F.,${ku.mults},${kv.mults},${ku.values},${kv.values},.UNSPECIFIED.)`,
    );
  }
  return ctx.em.emit(
    `(BOUNDED_SURFACE()B_SPLINE_SURFACE(${s.u.degree},${s.v.degree},\n${net},\n.UNSPECIFIED.,${bool(uClosed)},${bool(vClosed)},.F.)` +
      `B_SPLINE_SURFACE_WITH_KNOTS(${ku.mults},${kv.mults},${ku.values},${kv.values},.UNSPECIFIED.)` +
      `GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE((${wrows.join(',\n')}))REPRESENTATION_ITEM('')SURFACE())`,
  );
}

const MM_UNIT: Readonly<Record<'mm' | 'cm', string>> = { mm: '.MILLI.', cm: '.CENTI.' };

/** Units, uncertainty and the 3D geometric context; returns the context id. */
function unitContext(ctx: Ctx, unit: 'mm' | 'cm' | 'in', uncertainty: number): number {
  const em = ctx.em;
  let lengthUnit: number;
  if (unit !== 'in') {
    lengthUnit = em.emit(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${MM_UNIT[unit]},.METRE.))`);
  } else {
    const mm = em.emit('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
    const exps = em.emit('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)');
    const measure = em.emit(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(MM.in)}),${ref(mm)})`);
    lengthUnit = em.emit(
      `(CONVERSION_BASED_UNIT('INCH',${ref(measure)})LENGTH_UNIT()NAMED_UNIT(${ref(exps)}))`,
    );
  }
  const angle = em.emit('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solid = em.emit('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = em.emit(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(uncertainty)}),${ref(lengthUnit)},` +
      `${str('distance_accuracy_value')},${str('confusion accuracy')})`,
  );
  return em.emit(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${ref(unc)}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${ref(lengthUnit)},${ref(angle)},${ref(solid)}))` +
      `REPRESENTATION_CONTEXT('',''))`,
  );
}

function checkOptions(opts: StepWriteOptions | undefined): {
  fileUnit: 'mm' | 'cm' | 'in';
  modelUnit: 'mm' | 'cm';
  precision: StepPrecision;
  pcurves: 'always' | 'trimmedOnly';
} {
  const fileUnit = opts?.fileUnit ?? 'mm';
  const modelUnit = opts?.modelUnit ?? 'cm';
  const precision = opts?.precision ?? 'roundTrip';
  const pcurves = opts?.pcurves ?? 'always';
  if (fileUnit !== 'mm' && fileUnit !== 'cm' && fileUnit !== 'in') {
    fail('unsupported', `fileUnit must be 'mm', 'cm' or 'in'; got ${String(fileUnit)}`);
  }
  if (modelUnit !== 'mm' && modelUnit !== 'cm') {
    fail('unsupported', `modelUnit must be 'mm' or 'cm'; got ${String(modelUnit)}`);
  }
  if (
    precision !== 'roundTrip' &&
    !(Number.isInteger(precision) && precision >= 1 && precision <= 17)
  ) {
    fail(
      'unsupported',
      `precision must be 'roundTrip' or an integer 1…17; got ${String(precision)}`,
    );
  }
  if (pcurves !== 'always' && pcurves !== 'trimmedOnly') {
    fail('unsupported', `pcurves must be 'always' or 'trimmedOnly'; got ${String(pcurves)}`);
  }
  return { fileUnit, modelUnit, precision, pcurves };
}

/** True when every control point of the curve lies within `tol` of the first: a collapsed edge. */
function isCollapsed(c: ClampedCurve<3>, tol: number): boolean {
  const o = controlOf(c, 0);
  for (let i = 1; i < c.basis.count; i++) {
    const p = controlOf(c, i);
    if (Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) > tol) return false;
  }
  return true;
}

function controlOf(c: ClampedCurve<3>, i: number): Point3 {
  const w = c.cw[4 * i + 3]!;
  return { x: c.cw[4 * i]! / w, y: c.cw[4 * i + 1]! / w, z: c.cw[4 * i + 2]! / w };
}

/** The writer without the validity gate. `testing` exports it for the mutation suite; not public. */
export function writeStepCore(
  b: Brep,
  opts: StepWriteOptions | undefined,
  report: BrepReport,
): StepResult {
  const { fileUnit, modelUnit, precision, pcurves } = checkOptions(opts);
  const tol = resolveTolerances(opts?.tol);
  const factor = MM[modelUnit] / MM[fileUnit];
  const name = opts?.name ?? 'part';
  const timestamp = opts?.timestamp ?? DEFAULT_TIMESTAMP;

  b.edges.forEach((e, i) => {
    if (isCollapsed(e.curve, tol.point)) {
      fail(
        'step-unsupported',
        `edge ${i} is collapsed (a pole or apex): outside the writer's scope`,
        {
          edge: i,
        },
      );
    }
  });

  const em = createEmitter();
  const ctx: Ctx = { em, precision, factor, tol, points: new Map(), context2d: null };

  // --- product and context chain (AP214, as export/src/step.ts) ---
  const appContext = em.emit(`APPLICATION_CONTEXT(${str('automotive design')})`);
  em.emit(
    `APPLICATION_PROTOCOL_DEFINITION(${str('international standard')},${str('automotive_design')},2000,${ref(appContext)})`,
  );
  const productContext = em.emit(`PRODUCT_CONTEXT('',${ref(appContext)},${str('mechanical')})`);
  const product = em.emit(`PRODUCT(${str(name)},${str(name)},'',(${ref(productContext)}))`);
  const formation = em.emit(`PRODUCT_DEFINITION_FORMATION('','',${ref(product)})`);
  const defContext = em.emit(
    `PRODUCT_DEFINITION_CONTEXT(${str('part definition')},${ref(appContext)},${str('design')})`,
  );
  const definition = em.emit(
    `PRODUCT_DEFINITION(${str('design')},'',${ref(formation)},${ref(defContext)})`,
  );
  const defShape = em.emit(`PRODUCT_DEFINITION_SHAPE('','',${ref(definition)})`);
  em.emit(`PRODUCT_RELATED_PRODUCT_CATEGORY(${str('part')},'',(${ref(product)}))`);

  // Declared uncertainty: measured, floored (module comment), in file units.
  const uncertainty =
    Math.max(2 * Math.max(report.maxEdgeGap, report.maxVertexGap), tol.point) * factor;
  const context = unitContext(ctx, fileUnit, uncertainty);

  // --- topology bookkeeping ---
  const uses: { face: number; loop: number; index: number }[][] = b.edges.map(() => []);
  b.faces.forEach((f, fi) => {
    [f.outer, ...f.holes].forEach((l, li) =>
      l.coedges.forEach((c, ci) => uses[c.edge]!.push({ face: fi, loop: li, index: ci })),
    );
  });
  const natural = b.faces.map((f) => isNaturalFace(f, tol));

  const surfaceIds = new Map<NurbsSurface, number>();
  const surfaceEntity = (s: NurbsSurface): number => {
    let id = surfaceIds.get(s);
    if (id === undefined) {
      id = emitSurface(ctx, clampSurface(s));
      surfaceIds.set(s, id);
    }
    return id;
  };
  const vertexIds = new Map<number, number>();
  const vertexEntity = (v: number): number => {
    let id = vertexIds.get(v);
    if (id === undefined) {
      const p = b.vertices[v]!.point;
      const pt = point(ctx, [
        real(p.x * factor, precision),
        real(p.y * factor, precision),
        real(p.z * factor, precision),
      ]);
      id = em.emit(`VERTEX_POINT('',${ref(pt)})`);
      vertexIds.set(v, id);
    }
    return id;
  };
  const pcurveEntity = (use: { face: number; loop: number; index: number }): number => {
    const f = b.faces[use.face]!;
    const c = (use.loop === 0 ? f.outer : f.holes[use.loop - 1]!).coedges[use.index]!;
    if (ctx.context2d === null) {
      ctx.context2d = em.emit(
        "(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('2D SPACE',''))",
      );
    }
    const surface = surfaceEntity(f.surface);
    const curve = emitCurve(ctx, c.pcurve);
    const rep = em.emit(`DEFINITIONAL_REPRESENTATION('',(${ref(curve)}),${ref(ctx.context2d)})`);
    return em.emit(`PCURVE('',${ref(surface)},${ref(rep)})`);
  };
  const edgeIds = new Map<number, number>();
  const edgeEntity = (ei: number): number => {
    let id = edgeIds.get(ei);
    if (id !== undefined) return id;
    const e = b.edges[ei]!;
    const start = vertexEntity(e.start);
    const end = vertexEntity(e.end);
    const curve = emitCurve(ctx, e.curve);
    const u = uses[ei]!;
    const seam = u.length === 2 && u[0]!.face === u[1]!.face;
    const bare = pcurves === 'trimmedOnly' && !seam && u.every((x) => natural[x.face]);
    let geometry = curve;
    if (!bare) {
      const pcs = u.map(pcurveEntity);
      const masters = u.map((x) => {
        const f = b.faces[x.face]!;
        return (x.loop === 0 ? f.outer : f.holes[x.loop - 1]!).coedges[x.index]!.master;
      });
      const master =
        masters[0] === 'pcurve'
          ? '.PCURVE_S1.'
          : masters[1] === 'pcurve'
            ? '.PCURVE_S2.'
            : '.CURVE_3D.';
      geometry = em.emit(
        `${seam ? 'SEAM_CURVE' : 'SURFACE_CURVE'}('',${ref(curve)},${refs(pcs)},${master})`,
      );
    }
    id = em.emit(`EDGE_CURVE('',${ref(start)},${ref(end)},${ref(geometry)},.T.)`);
    edgeIds.set(ei, id);
    return id;
  };

  // --- faces ---
  const faceIds: number[] = [];
  b.faces.forEach((f) => {
    const surface = surfaceEntity(f.surface);
    const bounds = [f.outer, ...f.holes].map((l, li) => {
      const oriented = l.coedges.map((c) =>
        em.emit(`ORIENTED_EDGE('',*,*,${ref(edgeEntity(c.edge))},${bool(c.sense)})`),
      );
      const loop = em.emit(`EDGE_LOOP('',${refs(oriented)})`);
      return em.emit(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${ref(loop)},.T.)`);
    });
    faceIds.push(
      em.emit(
        `ADVANCED_FACE(${str(f.label ?? '')},${refs(bounds)},${ref(surface)},${bool(f.sameSense)})`,
      ),
    );
  });

  // --- shell, solid, representation ---
  const shell = em.emit(`CLOSED_SHELL('',${refs(faceIds)})`);
  const solid = em.emit(`MANIFOLD_SOLID_BREP(${str(name)},${ref(shell)})`);
  const origin = point(ctx, [real(0), real(0), real(0)]);
  const zAxis = em.emit(`DIRECTION('',(${real(0)},${real(0)},${real(1)}))`);
  const xAxis = em.emit(`DIRECTION('',(${real(1)},${real(0)},${real(0)}))`);
  const placement = em.emit(`AXIS2_PLACEMENT_3D('',${ref(origin)},${ref(zAxis)},${ref(xAxis)})`);
  const shape = em.emit(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',${refs([placement, solid])},${ref(context)})`,
  );
  em.emit(`SHAPE_DEFINITION_REPRESENTATION(${ref(defShape)},${ref(shape)})`);

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${str('B-rep solid with B-spline surfaces')}),'2;1');`,
    `FILE_NAME(${str(`${name}.step`)},${str(timestamp)},(${str('')}),(${str('')}),` +
      `${str('OpenShaper geom')},${str(opts?.originatingSystem ?? 'OpenShaper')},${str('')});`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
  ];
  const text = `${[...header, ...em.lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')}\n`;
  return Object.freeze({
    text,
    stats: Object.freeze({
      entities: em.lines.length,
      faces: b.faces.length,
      edges: b.edges.length,
      vertices: b.vertices.length,
      uncertainty,
      maxEdgeGap: report.maxEdgeGap * factor,
    }),
    report,
  });
}

/**
 * The B-rep as a STEP file (module comment). Throws `brep-invalid` (with the
 * `BrepReport` in `details.report`) when `checkBrep` finds a problem, and
 * `step-unsupported` for collapsed edges or when a reduced `precision` merges
 * knots into an invalid multiplicity.
 */
export function writeStep(b: Brep, opts?: StepWriteOptions): StepResult {
  const tol = resolveTolerances(opts?.tol);
  const report = checkBrep(b, tol);
  if (!report.ok) {
    const first = report.issues[0]!;
    fail('brep-invalid', `refusing to write an invalid B-rep: ${first.message}`, {
      report,
      value: first.value,
    });
  }
  return writeStepCore(b, opts, report);
}
