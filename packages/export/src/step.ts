// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * STEP (ISO 10303-21) export — the board as a solid with true B-spline surfaces.
 *
 * This module is encoding only. All the geometry comes from
 * `fitBoardSurface` in `@openshaper/kernel`; nothing here computes a point.
 *
 * ## Why surfaces and not facets
 *
 * A faceted STEP is legal and easy — wrap the existing mesh in planar faces — and
 * worth nothing: it imports as a dumb mesh body that cannot be offset, shelled or
 * finish-machined, which is what STL already gives us. The point of the format is
 * that a shaper can open the file in Fusion, Rhino, SolidWorks or FreeCAD, get ONE
 * SOLID BODY, and cut it. So the hull goes out as two `B_SPLINE_SURFACE_WITH_KNOTS`
 * patches, which is also why the file is a few hundred KB where the equivalent STL
 * is tens of MB.
 *
 * ## The shape
 *
 * ```
 * ADVANCED_BREP_SHAPE_REPRESENTATION -> MANIFOLD_SOLID_BREP -> CLOSED_SHELL
 *   ADVANCED_FACE  hull +Y   <- B_SPLINE_SURFACE_WITH_KNOTS
 *   ADVANCED_FACE  hull -Y   <- the same net mirrored
 *   ADVANCED_FACE  end cap   <- PLANE
 *   ADVANCED_FACE  end cap   <- PLANE
 * ```
 *
 * Six `EDGE_CURVE`s and four `VERTEX_POINT`s hold it together. Two properties make
 * the shell watertight by construction rather than by tolerance:
 *
 *  - the two hull patches' seam control columns are exactly y = 0 (the kernel
 *    snaps them), so a coordinate-keyed point cache resolves them to the SAME
 *    `#id`s and the stringer edges are one entity referenced twice;
 *  - a boundary of a clamped B-spline surface IS the B-spline curve over its
 *    boundary control row with the same knot vector, so each `EDGE_CURVE`
 *    references the surface's own points. No approximation, and no `PCURVE`:
 *    `EDGE_CURVE` takes a plain 3D curve and every target importer rebuilds
 *    parameter-space curves itself. (If one ever complains, the fix is to wrap the
 *    edge geometry in `SURFACE_CURVE` with a 2-D `B_SPLINE_CURVE_WITH_KNOTS`
 *    pcurve — the parameter-space edges are trivially the rectangle's sides.)
 *
 * ## Orientation is measured, not assumed
 *
 * Getting `same_sense` or a loop direction backwards yields a file that looks fine
 * and imports inside-out, and the rules are easy to reason about wrongly (mirroring
 * flips handedness, so the two hull patches do NOT take the same flag). So rather
 * than hard-coding the answer, this samples the actual surface normal and the
 * actual loop winding and derives both. `step.test.ts` then re-derives them from
 * the emitted text and checks every face points away from the solid.
 *
 * ## Schema
 *
 * AP214 (`AUTOMOTIVE_DESIGN`) rather than AP203: strict AP203 wants a
 * config-control chain — `SECURITY_CLASSIFICATION`, `APPROVAL`, person and date
 * entities — that is pure ceremony here and easy to get subtly wrong, while AP214
 * is what OCC and FreeCAD emit by default and therefore the best-tested import
 * path. It also leaves room for per-face colour later, which AP203 has no place
 * for.
 */
import {
  evalCurve,
  evalSurfaceDeriv,
  fitBoardSurface,
  hasTailCutout,
  knotMultiplicities,
  surfaceBoundaryCurve,
  type BSplineCurve,
  type BSplineSurface,
  type BezierBoard,
  type BoardCap,
  type BoardSurfaceModel,
  type Vert3,
} from '@openshaper/kernel';
import { BRAND_LINE } from './brand';
import { SHEET_UNIT, type SheetUnit } from './construction/units';

export interface StepOptions {
  /** Output unit written into the file's unit block. Default 'mm', the STEP norm. */
  unit?: SheetUnit;
  /** Stations sampled along the length before refinement. */
  lengthRows?: number;
  /** Profile samples per half-section. */
  ringCols?: number;
  /**
   * How closely the fitted surfaces track the lofted hull, in centimetres.
   * Defaults to the kernel's `DEFAULT_TOLERANCE`. Smaller means more control
   * points, a bigger file and a longer fit.
   */
  tolerance?: number;
  /** `PRODUCT` name written into the file. Default 'board'. */
  name?: string;
  /**
   * `FILE_NAME` timestamp, ISO 8601 to the second. Defaults to now; set it to make
   * the output byte-for-byte reproducible.
   */
  timestamp?: string;
}

/** Whether {@link exportStep} can describe this board faithfully. */
export interface StepSupport {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Concave tails are a different topology — two pods joined by a notch wall, nine
 * faces rather than four — and are not modelled yet. The UI disables the menu item
 * and shows the reason rather than quietly emitting a solid with the notch filled
 * in; a wrong board that imports cleanly is worse than no file.
 */
export const stepExportSupport = (board: BezierBoard): StepSupport =>
  hasTailCutout(board.outline)
    ? {
        ok: false,
        reason:
          'STEP export does not yet support concave (swallow / fish) tails — the notch needs its own surfaces. Use STL or DXF for this board.',
      }
    : { ok: true };

// --- Part 21 lexical rules ---

/**
 * A STEP real. Must contain a `.`, so `3` and `1e-7` are both illegal.
 *
 * `toPrecision(9)` first: it bounds a coordinate to about ten characters — 3 nm on
 * a 3 m board, five orders below any tolerance that matters — and takes roughly a
 * third off the file size. `String` then gives the shortest round-tripping form.
 */
const real = (n: number, factor: number): string => {
  const scaled = (Number.isFinite(n) ? n : 0) * factor;
  const v = Number(scaled.toPrecision(9));
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.`;
  const s = String(v);
  if (s.includes('e') || s.includes('E')) {
    const [mantissa, exponent] = s.toUpperCase().split('E');
    return `${mantissa!.includes('.') ? mantissa : `${mantissa}.`}E${exponent}`;
  }
  return s;
};

/**
 * A Part 21 string: single quotes doubled, backslashes doubled, everything outside
 * printable ASCII escaped as `\X2\XXXX\X0\`.
 *
 * Not optional. `BRAND_LINE` contains a `·` (U+00B7), and model and designer names
 * are arbitrary user text; a raw UTF-8 byte here breaks strict parsers.
 */
const p21 = (s: string): string => {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else {
      const units =
        c <= 0xffff ? [c] : [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)];
      out += `\\X2\\${units.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join('')}\\X0\\`;
    }
  }
  return `${out}'`;
};

/** STEP unit declarations per output unit. `si` is null where a conversion is needed. */
const STEP_UNIT: Record<SheetUnit, { si: string | null; name: string }> = {
  mm: { si: '.MILLI.', name: 'MILLIMETRE' },
  cm: { si: '.CENTI.', name: 'CENTIMETRE' },
  in: { si: null, name: 'INCH' },
};

// --- writer ---

interface Writer {
  emit: (body: string) => number;
  point: (p: Vert3) => number;
  lines: string[];
}

const createWriter = (factor: number): Writer => {
  const lines: string[] = [];
  let next = 0;
  const emit = (body: string): number => {
    next += 1;
    lines.push(`#${next}=${body};`);
    return next;
  };
  // Keyed by the text actually emitted, so equality is exactly what the file says.
  // This is what collapses the stringer seam and the cap edges to shared entities.
  const cache = new Map<string, number>();
  const point = (p: Vert3): number => {
    const key = `${real(p.x, factor)},${real(p.y, factor)},${real(p.z, factor)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const id = emit(`CARTESIAN_POINT('',(${key}))`);
    cache.set(key, id);
    return id;
  };
  return { emit, point, lines };
};

const ref = (id: number): string => `#${id}`;
const refs = (ids: readonly number[]): string => `(${ids.map(ref).join(',')})`;

/** `(1.,0.,0.)`-style direction literal. Directions are unitless — never scaled. */
const direction = (w: Writer, x: number, y: number, z: number): number =>
  w.emit(`DIRECTION('',(${real(x, 1)},${real(y, 1)},${real(z, 1)}))`);

const knotList = (knots: readonly number[]): { values: string; mults: string; count: number } => {
  const { values, mults } = knotMultiplicities(knots);
  return {
    // Knot values are parameters, not lengths: never unit-scaled.
    values: `(${values.map((v) => real(v, 1)).join(',')})`,
    mults: `(${mults.join(',')})`,
    count: values.length,
  };
};

const emitCurve = (w: Writer, c: BSplineCurve, label: string): number => {
  const pts = c.ctrl.map((p) => w.point(p));
  const k = knotList(c.knots);
  return w.emit(
    `B_SPLINE_CURVE_WITH_KNOTS(${p21(label)},${c.degree},${refs(pts)},` +
      `.UNSPECIFIED.,.F.,.F.,${k.mults},${k.values},.UNSPECIFIED.)`,
  );
};

const emitSurface = (w: Writer, s: BSplineSurface, label: string): number => {
  // U-major, one line per u-row: a 120x64 net is a 90 KB entity, and some parsers
  // are unhappy with multi-megabyte single lines. Part 21 allows the whitespace.
  const rows = s.ctrl.map((row) => refs(row.map((p) => w.point(p))));
  const u = knotList(s.uKnots);
  const v = knotList(s.vKnots);
  return w.emit(
    `B_SPLINE_SURFACE_WITH_KNOTS(${p21(label)},${s.uDegree},${s.vDegree},\n(${rows.join(',\n')}),\n` +
      `.UNSPECIFIED.,.F.,.F.,.F.,${u.mults},${v.mults},${u.values},${v.values},.UNSPECIFIED.)`,
  );
};

/** An oriented edge over an existing `EDGE_CURVE`. */
const oriented = (w: Writer, edge: number, sense: boolean): number =>
  w.emit(`ORIENTED_EDGE('',*,*,${ref(edge)},${sense ? '.T.' : '.F.'})`);

const face = (
  w: Writer,
  surface: number,
  orientedEdges: readonly number[],
  sameSense: boolean,
): number => {
  const loop = w.emit(`EDGE_LOOP('',${refs(orientedEdges)})`);
  const bound = w.emit(`FACE_OUTER_BOUND('',${ref(loop)},.T.)`);
  return w.emit(`ADVANCED_FACE('',(${ref(bound)}),${ref(surface)},${sameSense ? '.T.' : '.F.'})`);
};

// --- orientation, derived from the geometry rather than assumed ---

const cross = (a: Vert3, b: Vert3): Vert3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * Whether a hull patch's own normal (`S_u x S_v`) already points out of the solid.
 *
 * Sampled at the middle of the patch, where the surface is on the rail and "away
 * from the stringer plane" is unambiguously outward. Mirroring flips handedness, so
 * the two patches genuinely differ here and neither answer can be hard-coded.
 */
const normalPointsOut = (s: BSplineSurface): boolean => {
  const { point, du, dv } = evalSurfaceDeriv(s, 0.5, 0.5);
  const n = cross(du, dv);
  return n.y * point.y > 0;
};

/**
 * Whether the loop `plusFirst` traverses a cap counter-clockwise about `axis`.
 *
 * Shoelace in the cap plane. Cheaper to measure than to reason about, and it stays
 * right if the patch parameterization is ever reversed.
 */
const capLoopIsCcw = (model: BoardSurfaceModel, cap: BoardCap, atU: 0 | 1): boolean => {
  const plus = surfaceBoundaryCurve(model.plus, atU === 0 ? 'u0' : 'u1');
  const n = 48;
  const loop: Vert3[] = [];
  for (let i = 0; i <= n; i++) loop.push(evalCurve(plus, i / n));
  for (let i = n - 1; i >= 1; i--) {
    const p = loop[i]!;
    loop.push({ x: p.x, y: -p.y, z: p.z });
  }
  // Project onto (y, z) and take the signed area. The outward axis is +/-x, so a
  // positive area means counter-clockwise about +x.
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a.y * b.z - b.y * a.z;
  }
  return area * cap.dir > 0;
};

// --- the document ---

const header = (w: Writer, name: string, timestamp: string): void => {
  w.lines.push(
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${p21('Surfboard hull as B-spline surfaces')}),'2;1');`,
    `FILE_NAME(${p21(name)},${p21(timestamp)},(${p21('')}),(${p21('')}),` +
      `${p21('OpenShaper')},${p21(BRAND_LINE)},${p21('')});`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    // Part 21 comments have no escape syntax, so this one is transliterated to
    // ASCII. The exact brand string still goes out verbatim, escaped, as
    // FILE_NAME's originating_system above.
    `/* ${BRAND_LINE.replace(/[^\x20-\x7e]/g, '-')} */`,
    'DATA;',
  );
};

/** Units, and the geometric context every representation hangs off. */
const unitContext = (w: Writer, unit: SheetUnit): number => {
  const spec = STEP_UNIT[unit];
  let lengthUnit: number;
  if (spec.si !== null) {
    lengthUnit = w.emit(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${spec.si},.METRE.))`);
  } else {
    const mm = w.emit('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
    const exps = w.emit('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)');
    const measure = w.emit(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${ref(mm)})`);
    lengthUnit = w.emit(
      `(CONVERSION_BASED_UNIT(${p21(spec.name)},${ref(measure)})LENGTH_UNIT()NAMED_UNIT(${ref(exps)}))`,
    );
  }
  const angle = w.emit('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solid = w.emit('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  // The shell is watertight by construction (shared points, exact boundary
  // curves), so the accuracy value is not covering a gap.
  const uncertainty = w.emit(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${ref(lengthUnit)},` +
      `${p21('distance_accuracy_value')},${p21('confusion accuracy')})`,
  );
  return w.emit(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)` +
      `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${ref(uncertainty)}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${ref(lengthUnit)},${ref(angle)},${ref(solid)}))` +
      `REPRESENTATION_CONTEXT('',''))`,
  );
};

/**
 * Encode a fitted board as a STEP part-21 file.
 *
 * Pure: same inputs (including `timestamp`) give byte-identical output.
 *
 * Boards with a concave tail are outside what this models — see
 * {@link stepExportSupport}. Rather than throw, it emits the outer hull, so a
 * caller that ignores the predicate still gets a readable file; the UI checks
 * first and disables the option.
 */
export const exportStep = (board: BezierBoard, opts: StepOptions = {}): string => {
  const unit: SheetUnit = opts.unit ?? 'mm';
  const factor = SHEET_UNIT[unit].factor;
  const name = opts.name ?? 'board';
  const timestamp = opts.timestamp ?? new Date().toISOString().slice(0, 19);

  const model = fitBoardSurface(board, {
    lengthRows: opts.lengthRows,
    ringCols: opts.ringCols,
    tolerance: opts.tolerance,
  });

  const w = createWriter(factor);
  header(w, `${name}.step`, timestamp);

  // --- product / context chain ---
  const appContext = w.emit(`APPLICATION_CONTEXT(${p21('automotive design')})`);
  w.emit(
    `APPLICATION_PROTOCOL_DEFINITION(${p21('international standard')},` +
      `${p21('automotive_design')},2000,${ref(appContext)})`,
  );
  const productContext = w.emit(`PRODUCT_CONTEXT('',${ref(appContext)},${p21('mechanical')})`);
  const product = w.emit(`PRODUCT(${p21(name)},${p21(name)},'',(${ref(productContext)}))`);
  const formation = w.emit(`PRODUCT_DEFINITION_FORMATION('','',${ref(product)})`);
  const defContext = w.emit(
    `PRODUCT_DEFINITION_CONTEXT(${p21('part definition')},${ref(appContext)},${p21('design')})`,
  );
  const definition = w.emit(
    `PRODUCT_DEFINITION(${p21('design')},'',${ref(formation)},${ref(defContext)})`,
  );
  const defShape = w.emit(`PRODUCT_DEFINITION_SHAPE('','',${ref(definition)})`);
  w.emit(`PRODUCT_RELATED_PRODUCT_CATEGORY(${p21('part')},'',(${ref(product)}))`);

  const context = unitContext(w, unit);

  // --- surfaces ---
  const plusSurface = emitSurface(w, model.plus, 'hull +Y');
  const minusSurface = emitSurface(w, model.minus, 'hull -Y');

  // --- boundary curves, sharing the surfaces' own control points ---
  const bottomSeam = surfaceBoundaryCurve(model.plus, 'v0');
  const deckSeam = surfaceBoundaryCurve(model.plus, 'v1');
  const cBottom = emitCurve(w, bottomSeam, 'stringer bottom');
  const cDeck = emitCurve(w, deckSeam, 'stringer deck');
  const cPlus0 = emitCurve(w, surfaceBoundaryCurve(model.plus, 'u0'), 'end0 +Y');
  const cPlus1 = emitCurve(w, surfaceBoundaryCurve(model.plus, 'u1'), 'end1 +Y');
  const cMinus0 = emitCurve(w, surfaceBoundaryCurve(model.minus, 'u0'), 'end0 -Y');
  const cMinus1 = emitCurve(w, surfaceBoundaryCurve(model.minus, 'u1'), 'end1 -Y');

  // --- vertices, at the four stringer corners ---
  const corner = (c: BSplineCurve, last: boolean): Vert3 =>
    (last ? c.ctrl[c.ctrl.length - 1] : c.ctrl[0])!;
  const v00 = w.emit(`VERTEX_POINT('',${ref(w.point(corner(bottomSeam, false)))})`);
  const v10 = w.emit(`VERTEX_POINT('',${ref(w.point(corner(bottomSeam, true)))})`);
  const v01 = w.emit(`VERTEX_POINT('',${ref(w.point(corner(deckSeam, false)))})`);
  const v11 = w.emit(`VERTEX_POINT('',${ref(w.point(corner(deckSeam, true)))})`);

  const edge = (a: number, b: number, curve: number): number =>
    w.emit(`EDGE_CURVE('',${ref(a)},${ref(b)},${ref(curve)},.T.)`);
  const eBottom = edge(v00, v10, cBottom);
  const eDeck = edge(v01, v11, cDeck);
  const ePlus0 = edge(v00, v01, cPlus0);
  const ePlus1 = edge(v10, v11, cPlus1);
  const eMinus0 = edge(v00, v01, cMinus0);
  const eMinus1 = edge(v10, v11, cMinus1);

  // --- hull faces ---
  //
  // A loop traversed counter-clockwise in (u,v) is counter-clockwise about the
  // surface's own normal; a face whose normal is the REVERSE of that (same_sense
  // false) therefore needs the loop the other way round. Both facts are settled
  // per patch by `normalPointsOut`, because mirroring flips handedness and the two
  // patches do not agree.
  const hullFace = (surface: number, s: BSplineSurface, e0: number, e1: number): number => {
    const sameSense = normalPointsOut(s);
    const walk: readonly [number, boolean][] = sameSense
      ? [
          [e0, true], // u=0, v rising
          [eDeck, true], // v=1, u rising
          [e1, false], // u=1, v falling
          [eBottom, false], // v=0, u falling
        ]
      : [
          [eBottom, true],
          [e1, true],
          [eDeck, false],
          [e0, false],
        ];
    return face(
      w,
      surface,
      walk.map(([e, sense]) => oriented(w, e, sense)),
      sameSense,
    );
  };
  const facePlus = hullFace(plusSurface, model.plus, ePlus0, ePlus1);
  const faceMinus = hullFace(minusSurface, model.minus, eMinus0, eMinus1);

  // --- end caps ---
  const capFace = (cap: BoardCap, atU: 0 | 1, ePlus: number, eMinus: number): number => {
    const origin = w.point({ x: cap.x, y: 0, z: corner(bottomSeam, atU === 1).z });
    const axis = direction(w, cap.dir, 0, 0);
    const refDir = direction(w, 0, 0, 1);
    const placement = w.emit(`AXIS2_PLACEMENT_3D('',${ref(origin)},${ref(axis)},${ref(refDir)})`);
    const plane = w.emit(`PLANE('',${ref(placement)})`);
    // Two edges: up the +Y rail and back down the -Y one. A two-edge loop is legal
    // and is exactly right here — the cap has no other boundary.
    const walk: readonly [number, boolean][] = capLoopIsCcw(model, cap, atU)
      ? [
          [ePlus, true],
          [eMinus, false],
        ]
      : [
          [eMinus, true],
          [ePlus, false],
        ];
    return face(
      w,
      plane,
      walk.map(([e, sense]) => oriented(w, e, sense)),
      true,
    );
  };
  const faceEnd0 = capFace(model.end0, 0, ePlus0, eMinus0);
  const faceEnd1 = capFace(model.end1, 1, ePlus1, eMinus1);

  // --- shell, solid, representation ---
  const shell = w.emit(`CLOSED_SHELL('',${refs([facePlus, faceMinus, faceEnd0, faceEnd1])})`);
  const brep = w.emit(`MANIFOLD_SOLID_BREP(${p21(name)},${ref(shell)})`);

  const originPt = w.point({ x: 0, y: 0, z: 0 });
  const zAxis = direction(w, 0, 0, 1);
  const xAxis = direction(w, 1, 0, 0);
  const worldPlacement = w.emit(
    `AXIS2_PLACEMENT_3D('',${ref(originPt)},${ref(zAxis)},${ref(xAxis)})`,
  );
  const shape = w.emit(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',${refs([worldPlacement, brep])},${ref(context)})`,
  );
  w.emit(`SHAPE_DEFINITION_REPRESENTATION(${ref(defShape)},${ref(shape)})`);

  w.lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return `${w.lines.join('\n')}\n`;
};
