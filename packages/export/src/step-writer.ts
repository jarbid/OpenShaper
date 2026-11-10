// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The ISO 10303-21 (Part 21) encoding shared by the STEP exporters: lexical rules,
 * a writer that numbers entities and shares identical points, B-spline and topology
 * entities, units, and the AP214 product chain.
 *
 * Extracted from `step.ts` unchanged, so the board's STEP output is byte-identical;
 * the design notes (schema choice, watertightness, orientation) are there and in
 * docs/design/step-export.md. The fin exporter (`fin-step.ts`) is the second user.
 */
import {
  knotMultiplicities,
  type BSplineCurve,
  type BSplineSurface,
  type Vert3,
} from '@openshaper/kernel';
import type { Brand } from './brand';
import { SHEET_UNIT, type SheetUnit } from './construction/units';

// --- Part 21 lexical rules ---

/**
 * A STEP real. Must contain a `.`, so `3` and `1e-7` are both illegal.
 *
 * `toPrecision(9)` first: it bounds a coordinate to about ten characters — 3 nm on
 * a 3 m board, five orders below any tolerance that matters — and takes roughly a
 * third off the file size. `String` then gives the shortest round-tripping form.
 */
export const real = (n: number, factor: number): string => {
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
export const p21 = (s: string): string => {
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
export const STEP_UNIT: Record<SheetUnit, { si: string | null; name: string }> = {
  mm: { si: '.MILLI.', name: 'MILLIMETRE' },
  cm: { si: '.CENTI.', name: 'CENTIMETRE' },
  in: { si: null, name: 'INCH' },
};

// --- writer ---

export interface Writer {
  emit: (body: string) => number;
  point: (p: Vert3) => number;
  lines: string[];
}

export const createWriter = (factor: number): Writer => {
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

export const ref = (id: number): string => `#${id}`;
export const refs = (ids: readonly number[]): string => `(${ids.map(ref).join(',')})`;

/** `(1.,0.,0.)`-style direction literal. Directions are unitless — never scaled. */
export const direction = (w: Writer, x: number, y: number, z: number): number =>
  w.emit(`DIRECTION('',(${real(x, 1)},${real(y, 1)},${real(z, 1)}))`);

export const knotList = (
  knots: readonly number[],
): { values: string; mults: string; count: number } => {
  const { values, mults } = knotMultiplicities(knots);
  return {
    // Knot values are parameters, not lengths: never unit-scaled.
    values: `(${values.map((v) => real(v, 1)).join(',')})`,
    mults: `(${mults.join(',')})`,
    count: values.length,
  };
};

export const emitCurve = (w: Writer, c: BSplineCurve, label: string): number => {
  const pts = c.ctrl.map((p) => w.point(p));
  const k = knotList(c.knots);
  return w.emit(
    `B_SPLINE_CURVE_WITH_KNOTS(${p21(label)},${c.degree},${refs(pts)},` +
      `.UNSPECIFIED.,.F.,.F.,${k.mults},${k.values},.UNSPECIFIED.)`,
  );
};

export const emitSurface = (w: Writer, s: BSplineSurface, label: string): number => {
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
export const oriented = (w: Writer, edge: number, sense: boolean): number =>
  w.emit(`ORIENTED_EDGE('',*,*,${ref(edge)},${sense ? '.T.' : '.F.'})`);

/**
 * A face bounded by `orientedEdges`, with any `holes` (each its own oriented edges,
 * running the other way round). Without holes the output is exactly as before.
 */
export const face = (
  w: Writer,
  surface: number,
  orientedEdges: readonly number[],
  sameSense: boolean,
  holes: readonly (readonly number[])[] = [],
): number => {
  const loop = w.emit(`EDGE_LOOP('',${refs(orientedEdges)})`);
  const bound = w.emit(`FACE_OUTER_BOUND('',${ref(loop)},.T.)`);
  const inner = holes.map((h) => {
    const l = w.emit(`EDGE_LOOP('',${refs(h)})`);
    return w.emit(`FACE_BOUND('',${ref(l)},.T.)`);
  });
  return w.emit(
    `ADVANCED_FACE('',(${refs([bound, ...inner]).slice(1, -1)}),${ref(surface)},${sameSense ? '.T.' : '.F.'})`,
  );
};

// --- geometry helpers ---

export const cross = (a: Vert3, b: Vert3): Vert3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

// --- the document ---

export const header = (
  w: Writer,
  description: string,
  name: string,
  timestamp: string,
  brand: Brand,
): void => {
  w.lines.push(
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${p21(description)}),'2;1');`,
    `FILE_NAME(${p21(name)},${p21(timestamp)},(${p21('')}),(${p21('')}),` +
      `${p21(brand.product)},${p21(brand.line)},${p21('')});`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    // Part 21 comments have no escape syntax, so this one is transliterated to
    // ASCII. The exact brand string still goes out verbatim, escaped, as
    // FILE_NAME's originating_system above.
    `/* ${brand.line.replace(/[^\x20-\x7e]/g, '-')} */`,
    'DATA;',
  );
};

/** Units, and the geometric context every representation hangs off. */
export const unitContext = (w: Writer, unit: SheetUnit): number => {
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
 * The AP214 product chain every STEP file needs, named `name`. Returns the
 * `PRODUCT_DEFINITION_SHAPE` the shape representation attaches to.
 */
export const productDefinition = (w: Writer, name: string): number => {
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
  return defShape;
};

/**
 * Attach solids to the product, at the world origin, and close the file. Returns
 * the finished document.
 */
export const finishShape = (
  w: Writer,
  defShape: number,
  context: number,
  solids: readonly number[],
): string => {
  const originPt = w.point({ x: 0, y: 0, z: 0 });
  const zAxis = direction(w, 0, 0, 1);
  const xAxis = direction(w, 1, 0, 0);
  const worldPlacement = w.emit(
    `AXIS2_PLACEMENT_3D('',${ref(originPt)},${ref(zAxis)},${ref(xAxis)})`,
  );
  const shape = w.emit(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',${refs([worldPlacement, ...solids])},${ref(context)})`,
  );
  w.emit(`SHAPE_DEFINITION_REPRESENTATION(${ref(defShape)},${ref(shape)})`);

  w.lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return `${w.lines.join('\n')}\n`;
};

/** The writer for a file in `unit`: coordinates are kernel cm, scaled on output. */
export const writerFor = (unit: SheetUnit): Writer => createWriter(SHEET_UNIT[unit].factor);
