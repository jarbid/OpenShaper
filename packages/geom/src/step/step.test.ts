// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP writer and its subset reader (design §14, §16 `step` row), without
 * OCCT (the importer-side checks are in `step.occt.test.ts`). Oracles:
 *
 * - **Lexical rules.** `real` always contains a `.`, reads back exactly, and
 *   obeys `precision`; `str` doubles quotes and backslashes and escapes
 *   everything outside printable ASCII.
 * - **File integrity.** Ids are contiguous, none dangling, none unused (but
 *   the roots); complex entities list their partial entities in alphabetical
 *   order; the schema arity table matches what is written (the reader enforces
 *   it, and the tests show it rejecting a wrong count); output is
 *   byte-identical for the same input.
 * - **Round trip.** `readStepSubset(writeStep(b))` is `b`: topology identical,
 *   knots bitwise, polynomial control nets bitwise, rational ones within
 *   `4 ε` relative (writing `x = cw / w` and reading `w · x` rounds twice).
 * - **Units.** Coordinates scale by the unit ratio, parameters, weights and
 *   pcurve coordinates never do.
 * - **Orientation re-derived from the emitted text.** The file is read back
 *   and every face's outward normal, as the file states it (surface normal
 *   times `same_sense`), is tested against the *analytic* inside/outside
 *   function of the solid: a step along it leaves the solid, a step against it
 *   enters. Mirrored copies need opposite `same_sense` flags, which the test
 *   sees by construction. The oracle is shown to fail on a flipped flag.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBrep,
  classifyUV,
  faceTrimmedSurface,
  isGeomError,
  makeBrep,
  surfaceNormal,
  surfacePoint,
  transformBrep,
  transformCurve,
  writeStep,
} from '../index';
import type { Affine3, Brep, GeomErrorCode, Point3 } from '../index';
import {
  boxSolid,
  cylinderSolid,
  MUTATIONS,
  readStepSubset,
  sphericalZoneSolid,
  torusSolid,
  writeStepUnchecked,
} from '../testing';
import { mulberry32 } from '../testing';
import { clampSurface } from '../brep/clamp';
import { real, str } from './part21';
import { formatKnots, writeStepCore } from './write';
import { PARTIAL_ARITY, SIMPLE_ARITY } from './schema';

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

const SOLIDS: readonly (readonly [string, () => Brep])[] = [
  ['box', () => boxSolid(2, 3, 5)],
  ['trimmed box', () => boxSolid(2, 3, 5, { trimmed: true })],
  ['cylinder', () => cylinderSolid(1.5, 4)],
  ['zone', () => sphericalZoneSolid(2, 1)],
  ['split zone', () => sphericalZoneSolid(2, 1, { split: true })],
  ['torus', () => torusSolid(3, 1)],
];

// ---------------------------------------------------------------------------
// Part 21 lexical rules
// ---------------------------------------------------------------------------

describe('real: Part 21 REAL', () => {
  const REAL = /^-?\d+\.\d*(E[+-]?\d+)?$/;
  it('always contains a ".", with E for the exponent', () => {
    for (const [x, s] of [
      [3, '3.'],
      [0, '0.'],
      [-0, '0.'],
      [0.5, '0.5'],
      [-2.25, '-2.25'],
      [1e-7, '1.E-7'],
      [1.5e-7, '1.5E-7'],
      [1e21, '1.E+21'],
      [123456789012, '123456789012.'],
    ] as const) {
      expect(real(x), String(x)).toBe(s);
      expect(real(x)).toMatch(REAL);
    }
  });

  it('round trip: the shortest decimal that reads back exactly (random doubles of all sizes)', () => {
    const rng = mulberry32(2024);
    for (let i = 0; i < 2000; i++) {
      const x = (rng() * 2 - 1) * 10 ** Math.floor(rng() * 40 - 20);
      const s = real(x);
      expect(s).toMatch(REAL);
      expect(Number(s)).toBe(x);
    }
  });

  it('precision d writes the double nearest the d-digit decimal', () => {
    const rng = mulberry32(7);
    for (const d of [1, 3, 9, 15, 17]) {
      for (let i = 0; i < 200; i++) {
        const x = (rng() * 2 - 1) * 10 ** Math.floor(rng() * 10 - 5);
        const s = real(x, d);
        expect(s).toMatch(REAL);
        expect(Number(s)).toBe(Number(x.toPrecision(d)));
        const digits = s
          .replace(/E.*$/, '')
          .replace(/[-.]/g, '')
          .replace(/^0+/, '')
          .replace(/0+$/, '');
        expect(digits.length).toBeLessThanOrEqual(d);
      }
    }
  });

  it('rejects a non-finite number', () => {
    expectCode(() => real(NaN), 'non-finite');
    expectCode(() => real(Infinity), 'non-finite');
  });
});

describe('str: Part 21 string', () => {
  it('doubles quotes and backslashes; escapes everything outside printable ASCII', () => {
    expect(str("it's")).toBe("'it''s'");
    expect(str('a\\b')).toBe("'a\\\\b'");
    expect(str('OpenShaper · CAD')).toBe("'OpenShaper \\X2\\00B7\\X0\\ CAD'");
    expect(str('\u{1F3C4}')).toBe("'\\X2\\D83CDFC4\\X0\\'");
    expect(str('')).toBe("''");
    // Everything written is printable ASCII.
    expect(str('café – \u{1F3C4}')).toMatch(/^[\x20-\x7e]*$/);
  });
});

// ---------------------------------------------------------------------------
// File integrity
// ---------------------------------------------------------------------------

/** The DATA section's instances as `[id, body]`. */
function instances(text: string): [number, string][] {
  const data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  const out: [number, string][] = [];
  for (const m of data.matchAll(/#(\d+)=([\s\S]*?);\n/g)) out.push([Number(m[1]), m[2]!]);
  return out;
}

/** Top-level partial entity names of a complex instance body `(A()B(…)…)`. */
function partialNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let inStr = false;
  let word = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) {
      if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") inStr = true;
    else if (c === '(') {
      if (depth === 1 && word !== '') names.push(word);
      word = '';
      depth++;
    } else if (c === ')') depth--;
    else if (depth === 1 && /[A-Z_0-9]/.test(c)) word += c;
    else if (depth === 1) word = '';
  }
  return names;
}

const ROOTS = new Set([
  'SHAPE_DEFINITION_REPRESENTATION',
  'APPLICATION_PROTOCOL_DEFINITION',
  'PRODUCT_RELATED_PRODUCT_CATEGORY',
]);

describe('file integrity', () => {
  for (const [name, build] of SOLIDS) {
    const { text, stats } = writeStep(build(), { timestamp: '2026-01-01T00:00:00' });
    const inst = instances(text);

    it(`${name}: header, trailer, contiguous ids, stats.entities`, () => {
      expect(text.startsWith('ISO-10303-21;\nHEADER;\n')).toBe(true);
      expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
      expect(text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n')).toBe(true);
      expect(inst.map(([id]) => id)).toEqual(inst.map((_, i) => i + 1));
      expect(stats.entities).toBe(inst.length);
    });

    it(`${name}: no dangling reference, and no unused instance except the roots`, () => {
      const defined = new Set(inst.map(([id]) => id));
      const used = new Set<number>();
      for (const [, body] of inst) for (const m of body.matchAll(/#(\d+)/g)) used.add(Number(m[1]));
      for (const u of used) expect(defined.has(u), `#${u} is used but not defined`).toBe(true);
      for (const [id, body] of inst) {
        const type = body.startsWith('(') ? '(complex)' : body.slice(0, body.indexOf('('));
        if (!used.has(id)) expect(ROOTS.has(type), `#${id} ${type} is never referenced`).toBe(true);
      }
    });

    it(`${name}: complex instances list their partial entities in alphabetical order`, () => {
      let complex = 0;
      for (const [id, body] of inst) {
        if (!body.startsWith('(')) continue;
        complex++;
        const names = partialNames(body);
        expect(names.length, `#${id}`).toBeGreaterThan(1);
        expect(names, `#${id}`).toEqual(names.slice().sort());
        for (const n of names) {
          expect(n in PARTIAL_ARITY, `#${id}: ${n} is not in the partial-entity table`).toBe(true);
        }
      }
      expect(complex).toBeGreaterThan(0);
    });

    it(`${name}: every simple entity type is in the arity table, and the reader accepts the file`, () => {
      for (const [id, body] of inst) {
        if (body.startsWith('(')) continue;
        const type = body.slice(0, body.indexOf('('));
        expect(type in SIMPLE_ARITY, `#${id}: ${type}`).toBe(true);
      }
      expect(() => readStepSubset(text)).not.toThrow();
    });

    it(`${name}: no real without a decimal point, no exponent without one`, () => {
      // Only strings (header names, enums) and references contain letters next to digits otherwise.
      const data = text.slice(text.indexOf('DATA;'));
      expect(data).not.toMatch(/(?<![\d.#A-Z_])\d+[Ee][+-]?\d/);
      for (const [, body] of inst) {
        if (!body.startsWith('CARTESIAN_POINT') && !body.startsWith('DIRECTION')) continue;
        const coords = /\(([^()]*)\)\)$/.exec(body)![1]!.split(',');
        for (const c of coords) expect(c).toMatch(/^-?\d+\.\d*(E[+-]?\d+)?$/);
      }
    });
  }

  it('the reader enforces the arity table: a dropped attribute is rejected', () => {
    const { text } = writeStep(boxSolid(2, 3, 5));
    const broken = text.replace(/(#\d+=EDGE_CURVE\('',#\d+,#\d+,#\d+),\.T\.\);/, '$1);');
    expect(broken).not.toBe(text);
    expectCode(() => readStepSubset(broken), 'size-mismatch');
  });

  it('the reader rejects an entity outside the subset and a dangling reference', () => {
    const { text } = writeStep(boxSolid(2, 3, 5));
    expectCode(() => readStepSubset(text.replace('CLOSED_SHELL', 'OPEN_SHELL')), 'unsupported');
    expectCode(
      () => readStepSubset(text.replace(/(ADVANCED_FACE\('',\(#\d+\),)#\d+/, '$1#99999')),
      'brep-reference',
    );
    expectCode(() => readStepSubset('not step'), 'unsupported');
  });
});

describe('determinism', () => {
  it('the same B-rep, options and timestamp give identical bytes (and every solid is stable)', () => {
    for (const [name, build] of SOLIDS) {
      const a = writeStep(build(), { timestamp: '2026-03-04T05:06:07', name: 'p' });
      const b = writeStep(build(), { timestamp: '2026-03-04T05:06:07', name: 'p' });
      expect(a.text, name).toBe(b.text);
    }
  });

  it('only the FILE_NAME line depends on the timestamp; a default exists (no clock)', () => {
    const b = cylinderSolid(1.5, 4);
    const a = writeStep(b, { timestamp: '2026-01-01T00:00:00' }).text.split('\n');
    const c = writeStep(b, { timestamp: '2027-01-01T00:00:00' }).text.split('\n');
    const diff = a.map((_, i) => i).filter((i) => a[i] !== c[i]);
    expect(diff).toHaveLength(1);
    expect(a[diff[0]!]).toMatch(/^FILE_NAME/);
    expect(writeStep(b).text).toBe(writeStep(b).text);
  });
});

// ---------------------------------------------------------------------------
// Structure counts
// ---------------------------------------------------------------------------

const count = (text: string, type: string): number =>
  instances(text).filter(([, body]) => body.startsWith(`${type}(`)).length;

describe('entity structure', () => {
  const EXPECT: Record<
    string,
    { seam: number; surfaceCurve: number; pcurve: number; faces: number; bounds: number }
  > = {
    box: { seam: 0, surfaceCurve: 12, pcurve: 24, faces: 6, bounds: 6 },
    'trimmed box': { seam: 0, surfaceCurve: 12, pcurve: 24, faces: 6, bounds: 6 },
    cylinder: { seam: 1, surfaceCurve: 2, pcurve: 6, faces: 3, bounds: 3 },
    zone: { seam: 1, surfaceCurve: 2, pcurve: 6, faces: 3, bounds: 3 },
    'split zone': { seam: 2, surfaceCurve: 3, pcurve: 10, faces: 4, bounds: 4 },
    torus: { seam: 2, surfaceCurve: 0, pcurve: 4, faces: 1, bounds: 1 },
  };
  for (const [name, build] of SOLIDS) {
    it(`${name}: a seam is a SEAM_CURVE with two pcurves, every other edge a SURFACE_CURVE with two`, () => {
      const b = build();
      const { text, stats } = writeStep(b);
      const e = EXPECT[name]!;
      expect(count(text, 'SEAM_CURVE')).toBe(e.seam);
      expect(count(text, 'SURFACE_CURVE')).toBe(e.surfaceCurve);
      expect(count(text, 'PCURVE')).toBe(e.pcurve);
      expect(count(text, 'DEFINITIONAL_REPRESENTATION')).toBe(e.pcurve);
      expect(count(text, 'ADVANCED_FACE')).toBe(e.faces);
      expect(count(text, 'FACE_OUTER_BOUND')).toBe(e.bounds);
      expect(count(text, 'FACE_BOUND')).toBe(0);
      expect(count(text, 'EDGE_CURVE')).toBe(stats.edges);
      expect(count(text, 'VERTEX_POINT')).toBe(stats.vertices);
      expect(count(text, 'CLOSED_SHELL')).toBe(1);
      expect(count(text, 'MANIFOLD_SOLID_BREP')).toBe(1);
      expect(count(text, 'ORIENTED_EDGE')).toBe(
        b.faces.reduce((n, f) => n + f.outer.coedges.length, 0),
      );
    });
  }

  it('the 2D parametric context is declared once, with the 3D context separate', () => {
    const { text } = writeStep(cylinderSolid(1.5, 4));
    expect(text.match(/PARAMETRIC_REPRESENTATION_CONTEXT\(\)/g)).toHaveLength(1);
    expect(text.match(/GEOMETRIC_REPRESENTATION_CONTEXT\(3\)/g)).toHaveLength(1);
  });

  it('periodic surfaces are written clamped, with u_closed / v_closed stating the truth', () => {
    const flags = (text: string): string[] =>
      [
        ...text.matchAll(
          /\.UNSPECIFIED\.,(\.[TF]\.),(\.[TF]\.),\.F\.\)B_SPLINE_SURFACE_WITH_KNOTS/g,
        ),
      ].map((m) => `${m[1]}${m[2]}`);
    // Complex (rational) surfaces only: the polynomial planes are simple entities.
    expect(flags(writeStep(cylinderSolid(1.5, 4)).text)).toEqual(['.T..F.']);
    expect(flags(writeStep(sphericalZoneSolid(2, 1)).text)).toEqual(['.T..F.']);
    expect(flags(writeStep(sphericalZoneSolid(2, 1, { split: true })).text)).toEqual([
      '.T..F.',
      '.T..F.',
    ]);
    expect(flags(writeStep(torusSolid(3, 1)).text)).toEqual(['.T..T.']);
    expect(flags(writeStep(boxSolid(2, 3, 5)).text)).toEqual([]);
    // A plane is not closed.
    const plane =
      /B_SPLINE_SURFACE_WITH_KNOTS\('',1,1,[\s\S]*?\.UNSPECIFIED\.,(\.[TF]\.),(\.[TF]\.),/.exec(
        writeStep(boxSolid(2, 3, 5)).text,
      )!;
    expect([plane[1], plane[2]]).toEqual(['.F.', '.F.']);
  });

  it("pcurves: 'trimmedOnly' drops them from edges between untrimmed faces, never from a seam", () => {
    const opts = { pcurves: 'trimmedOnly' } as const;
    const box = writeStep(boxSolid(2, 3, 5), opts).text;
    expect(count(box, 'PCURVE')).toBe(0);
    expect(count(box, 'SURFACE_CURVE')).toBe(0);
    // Top and bottom trimmed: their 8 ring edges keep pcurves (2 each); the 4 verticals do not.
    const trimmed = writeStep(boxSolid(2, 3, 5, { trimmed: true }), opts).text;
    expect(count(trimmed, 'SURFACE_CURVE')).toBe(8);
    expect(count(trimmed, 'PCURVE')).toBe(16);
    const cyl = writeStep(cylinderSolid(1.5, 4), opts).text;
    expect(count(cyl, 'SEAM_CURVE')).toBe(1);
    expect(count(cyl, 'PCURVE')).toBe(6);
    const torus = writeStep(torusSolid(3, 1), opts).text;
    expect(count(torus, 'SEAM_CURVE')).toBe(2);
    expect(count(torus, 'PCURVE')).toBe(4);
  });

  it('a file without some pcurves cannot be read back (the reader says so)', () => {
    const { text } = writeStep(boxSolid(2, 3, 5), { pcurves: 'trimmedOnly' });
    expectCode(() => readStepSubset(text), 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

/** The B-rep with vertices and edges numbered by first use, as the writer emits them. */
function canonical(b: Brep): {
  edges: number[];
  vertexOrder: number[];
  coedges: [number, boolean][][];
  flags: boolean[];
} {
  const edgeNew = new Map<number, number>();
  const vertexNew = new Map<number, number>();
  const vertexOrder: number[] = [];
  const coedges: [number, boolean][][] = [];
  const edges: number[] = [];
  const vertex = (v: number): void => {
    if (!vertexNew.has(v)) {
      vertexNew.set(v, vertexNew.size);
      vertexOrder.push(v);
    }
  };
  for (const f of b.faces) {
    const row: [number, boolean][] = [];
    for (const l of [f.outer, ...f.holes]) {
      for (const c of l.coedges) {
        if (!edgeNew.has(c.edge)) {
          edgeNew.set(c.edge, edgeNew.size);
          edges.push(c.edge);
          vertex(b.edges[c.edge]!.start);
          vertex(b.edges[c.edge]!.end);
        }
        row.push([edgeNew.get(c.edge)!, c.sense]);
      }
    }
    coedges.push(row);
  }
  return { edges, vertexOrder, coedges, flags: b.faces.map((f) => f.sameSense) };
}

describe('round trip: readStepSubset(writeStep(b)) is b', () => {
  const EPS = Number.EPSILON;
  // Euclidean coordinate x = cw / w is written and w · x read back: two roundings of one value,
  // ≤ 1 ε relative each at worst; the stated bound is 4 ε × (|value| + 1).
  const near = (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    rational: boolean,
    what: string,
  ): void => {
    expect(a.length, what).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (!rational) expect(a[i], `${what}[${i}]`).toBe(b[i]);
      else
        expect(Math.abs(a[i]! - b[i]!), `${what}[${i}]`).toBeLessThanOrEqual(
          4 * EPS * (Math.abs(b[i]!) + 1),
        );
    }
  };

  const copies: readonly (readonly [string, () => Brep])[] = [
    ...SOLIDS,
    [
      'mirrored cylinder',
      () => transformBrep(cylinderSolid(1.5, 4), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
    ],
  ];
  for (const [name, build] of copies) {
    it(`${name}: topology, flags, knots and control nets (file unit = model unit = cm)`, () => {
      const b = build();
      const back = readStepSubset(writeStep(b, { fileUnit: 'cm' }).text);
      const a = canonical(b);
      const z = canonical(back);
      // `back` is numbered in first-use order already: its canonical form is the identity.
      expect(z.coedges).toEqual(a.coedges);
      expect(z.flags).toEqual(a.flags);
      expect(back.faces.length).toBe(b.faces.length);
      // Vertices.
      a.vertexOrder.forEach((v, k) => {
        expect(back.vertices[k]!.point).toEqual(b.vertices[v]!.point);
      });
      // Edge curves and pcurves.
      a.edges.forEach((e, k) => {
        const x = b.edges[e]!.curve;
        const y = back.edges[k]!.curve;
        expect(Array.from(y.basis.knots)).toEqual(Array.from(x.basis.knots));
        expect(y.basis.degree).toBe(x.basis.degree);
        near(y.cw, x.cw, x.rational, `edge ${e} net`);
      });
      b.faces.forEach((f, fi) => {
        const g = back.faces[fi]!;
        const s = clampSurface(f.surface);
        expect(Array.from(g.surface.u.knots)).toEqual(Array.from(s.u.knots));
        expect(Array.from(g.surface.v.knots)).toEqual(Array.from(s.v.knots));
        near(g.surface.cw, s.cw, s.rational, `face ${fi} net`);
        f.outer.coedges.forEach((c, ci) => {
          const q = g.outer.coedges[ci]!.pcurve;
          expect(Array.from(q.basis.knots)).toEqual(Array.from(c.pcurve.basis.knots));
          // Pcurves are parameters: never scaled, so even the rational ones agree to rounding.
          near(q.cw, c.pcurve.cw, c.pcurve.rational, `face ${fi} pcurve ${ci}`);
          expect(g.outer.coedges[ci]!.master).toBe(c.master);
        });
      });
      // The read-back B-rep is itself a valid solid.
      expect(checkBrep(back).issues).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe('units', () => {
  const box = boxSolid(2, 3, 5);
  it('mm from cm scales lengths by 10 and declares MILLI; cm declares CENTI', () => {
    const mm = writeStep(box).text;
    expect(mm).toContain('SI_UNIT(.MILLI.,.METRE.)');
    const cm = writeStep(box, { fileUnit: 'cm' }).text;
    expect(cm).toContain('SI_UNIT(.CENTI.,.METRE.)');
    const inMm = readStepSubset(mm);
    const inCm = readStepSubset(cm);
    inCm.vertices.forEach((v, i) => {
      expect(inMm.vertices[i]!.point.x).toBe(v.point.x * 10);
      expect(inMm.vertices[i]!.point.y).toBe(v.point.y * 10);
      expect(inMm.vertices[i]!.point.z).toBe(v.point.z * 10);
    });
  });

  it('inches are a conversion-based unit of 25.4 mm; reading back converts exactly enough', () => {
    const text = writeStep(box, { fileUnit: 'in' }).text;
    expect(text).toContain("CONVERSION_BASED_UNIT('INCH'");
    expect(text).toContain('LENGTH_MEASURE(25.4)');
    const back = readStepSubset(text, { unit: 'cm' });
    // Two multiplications by 10/25.4 and its inverse: ≤ 4 ε relative.
    const order = canonical(box).vertexOrder;
    back.vertices.forEach((v, k) => {
      const o = box.vertices[order[k]!]!.point;
      expect(Math.abs(v.point.x - o.x)).toBeLessThan(4 * Number.EPSILON * 5);
      expect(Math.abs(v.point.y - o.y)).toBeLessThan(4 * Number.EPSILON * 5);
      expect(Math.abs(v.point.z - o.z)).toBeLessThan(4 * Number.EPSILON * 5);
    });
  });

  it('parameters, weights and pcurve coordinates never scale', () => {
    const c = cylinderSolid(1.5, 4);
    const mm = readStepSubset(writeStep(c).text);
    const cm = readStepSubset(writeStep(c, { fileUnit: 'cm' }).text);
    for (let f = 0; f < c.faces.length; f++) {
      const a = mm.faces[f]!.surface;
      const b = cm.faces[f]!.surface;
      expect(Array.from(a.u.knots)).toEqual(Array.from(b.u.knots));
      for (let i = 3; i < a.cw.length; i += 4) expect(a.cw[i]).toBe(b.cw[i]); // homogeneous weights
      mm.faces[f]!.outer.coedges.forEach((co, k) => {
        expect(Array.from(co.pcurve.cw)).toEqual(
          Array.from(cm.faces[f]!.outer.coedges[k]!.pcurve.cw),
        );
      });
    }
  });

  it('a mm model unit is respected (no scaling to mm)', () => {
    const text = writeStep(box, { modelUnit: 'mm' }).text;
    const back = readStepSubset(text);
    canonical(box).vertexOrder.forEach((v, k) =>
      expect(back.vertices[k]!.point).toEqual(box.vertices[v]!.point),
    );
  });

  it('the declared uncertainty is the measured gap, doubled, or the floor', () => {
    const good = writeStep(box);
    // Floor: Tolerances.point (1e-6 cm) in file units.
    expect(Math.abs(good.stats.uncertainty - 1e-5)).toBeLessThan(1e-18);
    const declared = /UNCERTAINTY_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(([^)]*)\)/.exec(
      good.text,
    )![1]!;
    expect(Number(declared)).toBe(good.stats.uncertainty);
    const D = 5e-5;
    const shifted = makeBrep({
      vertices: box.vertices,
      edges: box.edges.map((e, i) =>
        i === 0
          ? {
              ...e,
              curve: transformCurve(e.curve, [1, 0, 0, 0, 0, 1, 0, D, 0, 0, 1, 0] as Affine3),
            }
          : e,
      ),
      faces: box.faces,
      shells: box.shells,
      solids: box.solids,
    });
    expect(shifted.ok).toBe(true);
    if (!shifted.ok) return;
    const r = writeStep(shifted.value);
    // 2 × gap (D = 5e-5 cm) in mm: 1e-3 mm.
    expect(Math.abs(r.stats.uncertainty - 2 * D * 10)).toBeLessThan(1e-12);
    expect(Math.abs(r.stats.maxEdgeGap - D * 10)).toBeLessThan(1e-12);
  });

  it('options are validated', () => {
    expectCode(() => writeStep(box, { fileUnit: 'ft' as never }), 'unsupported');
    expectCode(() => writeStep(box, { modelUnit: 'in' as never }), 'unsupported');
    expectCode(() => writeStep(box, { precision: 0 }), 'unsupported');
    expectCode(() => writeStep(box, { precision: 18 }), 'unsupported');
    expectCode(() => writeStep(box, { pcurves: 'never' as never }), 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// Precision and knots
// ---------------------------------------------------------------------------

describe('precision', () => {
  it('9 significant digits: every coordinate has at most 9 digits, and reads back within 1e-9', () => {
    const b = cylinderSolid(1.5, 4);
    const { text } = writeStep(b, { precision: 9, fileUnit: 'cm' });
    for (const [, body] of instances(text)) {
      if (!body.startsWith('CARTESIAN_POINT')) continue;
      for (const c of /\(([^()]*)\)\)$/.exec(body)![1]!.split(',')) {
        const digits = c
          .replace(/E.*$/, '')
          .replace(/[-.]/g, '')
          .replace(/^0+/, '')
          .replace(/0+$/, '');
        expect(digits.length).toBeLessThanOrEqual(9);
      }
    }
    const back = readStepSubset(text);
    // |error| ≤ 0.5e-8 relative per coordinate (half a unit in the 9th digit), coordinates ≤ 4.
    back.vertices.forEach((v, i) => {
      expect(Math.abs(v.point.z - b.vertices[i]!.point.z)).toBeLessThan(4 * 5e-9);
    });
  });

  it('knot multiplicities come from the formatted text: knots that print alike merge', () => {
    const k = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];
    expect(formatKnots(k, 2, 'roundTrip', 'c')).toEqual({
      values: '(0.,0.25,0.5,0.75,1.)',
      mults: '(3,2,2,2,3)',
    });
    // 0.5 and 0.5000004 print alike at 6 digits and merge into one knot of multiplicity 2.
    const near = [0, 0, 0, 0.5, 0.5000004, 1, 1, 1];
    expect(formatKnots(near, 2, 'roundTrip', 'c').mults).toBe('(3,1,1,3)');
    expect(formatKnots(near, 2, 6, 'c')).toEqual({ values: '(0.,0.5,1.)', mults: '(3,2,3)' });
  });

  it('a precision that merges knots past the degree is refused, not written wrong', () => {
    const near = [0, 0, 0, 0.5, 0.5000004, 0.5000005, 1, 1, 1];
    expectCode(() => formatKnots(near, 2, 6, 'curve'), 'step-unsupported');
    // Ends must keep exactly degree + 1 copies: 0.9999999 prints as 1 at 6 digits.
    expectCode(() => formatKnots([0, 0, 0, 0.9999999, 1, 1, 1], 2, 6, 'curve'), 'step-unsupported');
  });
});

// ---------------------------------------------------------------------------
// Orientation, re-derived from the emitted text
// ---------------------------------------------------------------------------

type Inside = (p: Point3) => boolean;
const insideBox =
  (x: number, y: number, z: number): Inside =>
  (p) =>
    p.x > 0 && p.x < x && p.y > 0 && p.y < y && p.z > 0 && p.z < z;
const insideCylinder =
  (r: number, h: number): Inside =>
  (p) =>
    p.x * p.x + p.y * p.y < r * r && p.z > 0 && p.z < h;
const insideZone =
  (r: number, phi: number): Inside =>
  (p) =>
    p.x * p.x + p.y * p.y + p.z * p.z < r * r && Math.abs(p.z) < r * Math.sin(phi);
const insideTorus =
  (R: number, r: number): Inside =>
  (p) =>
    (Math.hypot(p.x, p.y) - R) ** 2 + p.z * p.z < r * r;

/** `M` as a function on points, and its inverse. */
const apply = (m: Affine3, p: Point3): Point3 => ({
  x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
  y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
  z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
});
/** Inverse of a rotation-plus-translation or a mirror (orthogonal linear part). */
const inverseOrthogonal = (m: Affine3): Affine3 => {
  const t = [m[3], m[7], m[11]] as const;
  return [
    m[0],
    m[4],
    m[8],
    -(m[0] * t[0] + m[4] * t[1] + m[8] * t[2]),
    m[1],
    m[5],
    m[9],
    -(m[1] * t[0] + m[5] * t[1] + m[9] * t[2]),
    m[2],
    m[6],
    m[10],
    -(m[2] * t[0] + m[6] * t[1] + m[10] * t[2]),
  ];
};
const MIRROR_X: Affine3 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const c = Math.cos(0.7);
const s = Math.sin(0.7);
const ROT: Affine3 = [c, -s, 0, 5, s, c, 0, -3, 0, 0, 1, 2];
/** `ROT` after `MIRROR_X`: linear part [[−c, −s], [−s, c]], determinant −1. */
const MIRROR_ROT: Affine3 = [-c, -s, 0, 5, -s, c, 0, -3, 0, 0, 1, 2];

describe('orientation re-derived from the emitted text', () => {
  interface Oracle {
    readonly name: string;
    readonly brep: () => Brep;
    readonly inside: Inside;
  }
  const through = (inside: Inside, m: Affine3): Inside => {
    const inv = inverseOrthogonal(m);
    return (p) => inside(apply(inv, p));
  };
  const ORACLES: readonly Oracle[] = [
    { name: 'box', brep: () => boxSolid(2, 3, 5), inside: insideBox(2, 3, 5) },
    {
      name: 'trimmed box',
      brep: () => boxSolid(2, 3, 5, { trimmed: true }),
      inside: insideBox(2, 3, 5),
    },
    { name: 'cylinder', brep: () => cylinderSolid(1.5, 4), inside: insideCylinder(1.5, 4) },
    { name: 'zone', brep: () => sphericalZoneSolid(2, 1), inside: insideZone(2, 1) },
    {
      name: 'split zone',
      brep: () => sphericalZoneSolid(2, 1, { split: true }),
      inside: insideZone(2, 1),
    },
    { name: 'torus', brep: () => torusSolid(3, 1), inside: insideTorus(3, 1) },
    {
      name: 'mirrored cylinder',
      brep: () => transformBrep(cylinderSolid(1.5, 4), MIRROR_X),
      inside: through(insideCylinder(1.5, 4), MIRROR_X),
    },
    {
      name: 'mirrored zone',
      brep: () => transformBrep(sphericalZoneSolid(2, 1), MIRROR_X),
      inside: through(insideZone(2, 1), MIRROR_X),
    },
    {
      name: 'mirrored trimmed box',
      brep: () => transformBrep(boxSolid(2, 3, 5, { trimmed: true }), MIRROR_X),
      inside: through(insideBox(2, 3, 5), MIRROR_X),
    },
    {
      name: 'rotated cylinder',
      brep: () => transformBrep(cylinderSolid(1.5, 4), ROT),
      inside: through(insideCylinder(1.5, 4), ROT),
    },
    {
      name: 'rotated mirrored torus',
      brep: () => transformBrep(torusSolid(3, 1), MIRROR_ROT),
      inside: through(insideTorus(3, 1), MIRROR_ROT),
    },
  ];

  /**
   * For every face of `back`: a point strictly inside the face and its outward
   * normal as the file states it (`±Su × Sv` by `same_sense`); returns whether a
   * small step along it leaves the solid and a step against it enters.
   */
  function outwardFaces(back: Brep, flags: readonly boolean[], inside: Inside): boolean[] {
    return back.faces.map((f, i) => {
      const ts = faceTrimmedSurface(back, i);
      // The first grid point inside the face, scanning from the middle outwards.
      const order = Array.from(
        { length: 21 * 21 },
        (_, k) => [k % 21, Math.floor(k / 21)] as const,
      ).sort((a, b) => Math.hypot(a[0] - 10, a[1] - 10) - Math.hypot(b[0] - 10, b[1] - 10));
      // Read-back surfaces are clamped, so the domain is the whole extent.
      const [u0, u1] = f.surface.u.domain;
      const [v0, v1] = f.surface.v.domain;
      for (const [a, b] of order) {
        const u = u0 + ((u1 - u0) * (a + 0.5)) / 21;
        const v = v0 + ((v1 - v0) * (b + 0.5)) / 21;
        if (classifyUV(ts, { u, v }) !== 'inside') continue;
        const n = surfaceNormal(f.surface, u, v);
        if (n.kind !== 'regular') continue;
        const sign = flags[i] ? 1 : -1;
        const p = surfacePoint(f.surface, u, v);
        const eps = 1e-3;
        const out = {
          x: p.x + sign * eps * n.n.x,
          y: p.y + sign * eps * n.n.y,
          z: p.z + sign * eps * n.n.z,
        };
        const inn = {
          x: p.x - sign * eps * n.n.x,
          y: p.y - sign * eps * n.n.y,
          z: p.z - sign * eps * n.n.z,
        };
        return !inside(out) && inside(inn);
      }
      throw new Error(`no interior point found on face ${i}`);
    });
  }

  for (const o of ORACLES) {
    it(`${o.name}: every face's stated outward normal leaves the solid (analytic inside test)`, () => {
      const b = o.brep();
      const { text } = writeStep(b, { fileUnit: 'cm' });
      const back = readStepSubset(text);
      // The flags as the file states them.
      const flags = back.faces.map((f) => f.sameSense);
      expect(outwardFaces(back, flags, o.inside)).toEqual(back.faces.map(() => true));
    });
  }

  it('a mirror needs opposite same_sense flags: the flags of a solid and its mirror differ everywhere', () => {
    const a = readStepSubset(writeStep(cylinderSolid(1.5, 4), { fileUnit: 'cm' }).text);
    const m = readStepSubset(
      writeStep(transformBrep(cylinderSolid(1.5, 4), MIRROR_X), { fileUnit: 'cm' }).text,
    );
    expect(m.faces.map((f) => f.sameSense)).toEqual(a.faces.map((f) => !f.sameSense));
  });

  it('the oracle can fail: a flipped flag is seen as an inward normal', () => {
    const b = cylinderSolid(1.5, 4);
    const back = readStepSubset(writeStep(b, { fileUnit: 'cm' }).text);
    const flags = back.faces.map((f, i) => (i === 1 ? !f.sameSense : f.sameSense));
    const verdict = outwardFaces(back, flags, insideCylinder(1.5, 4));
    expect(verdict).toEqual([true, false, true]);
  });

  it('the mirror-rotation used above really mirrors (determinant −1)', () => {
    const m = MIRROR_ROT;
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) -
      m[1] * (m[4] * m[10] - m[6] * m[8]) +
      m[2] * (m[4] * m[9] - m[5] * m[8]);
    expect(det).toBeCloseTo(-1, 14);
  });
});

// ---------------------------------------------------------------------------
// The gate and the mutation suite
// ---------------------------------------------------------------------------

describe('the writer refuses what is not a valid solid', () => {
  it('every geometric mutation of the catalogue: writeStep throws brep-invalid with the report', () => {
    const b = cylinderSolid(1.5, 4);
    for (const m of MUTATIONS.filter((x) => x.caughtBy(b) === 'checkBrep')) {
      const made = makeBrep(m.apply(b));
      expect(made.ok, m.name).toBe(true);
      if (!made.ok) continue;
      try {
        writeStep(made.value);
        expect.unreachable(`${m.name}: writeStep must refuse`);
      } catch (e) {
        expect(isGeomError(e, 'brep-invalid'), `${m.name}: ${String(e)}`).toBe(true);
        const report = (e as { details: { report: { ok: boolean } } }).details.report;
        expect(report.ok).toBe(false);
      }
    }
  });

  it('the unchecked writer writes them anyway (for the mutation suite), and we reject the files', () => {
    const b = cylinderSolid(1.5, 4);
    const weReject = (text: string): boolean => {
      try {
        return !checkBrep(readStepSubset(text)).ok;
      } catch {
        return true;
      }
    };
    for (const m of MUTATIONS.filter((x) => x.caughtBy(b) === 'checkBrep')) {
      const made = makeBrep(m.apply(b));
      if (!made.ok) continue;
      const text = writeStepUnchecked(made.value);
      expect(text.length).toBeGreaterThan(1000);
      // A wrong genus is topology metadata (not in the file), so the file is a valid solid.
      if (m.name === 'declare a wrong genus') continue;
      expect(weReject(text), `${m.name}: the written file must be rejected on read-back`).toBe(
        true,
      );
    }
  });

  it('text-level mutations (orientation, a flipped oriented edge, a moved vertex, a wrong weight) are rejected on read-back', () => {
    const weReject = (text: string): boolean => {
      try {
        return !checkBrep(readStepSubset(text)).ok;
      } catch {
        return true;
      }
    };
    const edit = (text: string, re: RegExp, f: (l: string) => string): string => {
      const lines = text.split('\n');
      const i = lines.findIndex((l) => re.test(l));
      expect(i).toBeGreaterThanOrEqual(0);
      lines[i] = f(lines[i]!);
      return lines.join('\n');
    };
    const flip = (l: string): string =>
      l.endsWith('.T.);') ? `${l.slice(0, -5)}.F.);` : `${l.slice(0, -5)}.T.);`;
    const box = writeStep(boxSolid(2, 3, 5)).text;
    expect(weReject(box)).toBe(false);
    expect(weReject(edit(box, /ADVANCED_FACE/, flip))).toBe(true);
    expect(weReject(edit(box, /ORIENTED_EDGE/, flip))).toBe(true);
    const cyl = writeStep(cylinderSolid(1.5, 4)).text;
    expect(
      weReject(
        edit(cyl, /RATIONAL_B_SPLINE_CURVE\(\(1\.,0\.7071/, (l) =>
          l.replace('0.7071067811865476', '0.6'),
        ),
      ),
    ).toBe(true);
  });

  it('collapsed edges are outside the scope: step-unsupported', () => {
    const b = boxSolid(2, 3, 5);
    const p = b.vertices[0]!.point;
    // Replace edge 0's curve by a zero-length line (a degenerate edge); geometry is not
    // checked by the unchecked path, so the writer's own scope check is what fires.
    const collapsed = makeBrep({
      vertices: b.vertices,
      edges: b.edges.map((e, i) =>
        i === 0
          ? {
              ...e,
              curve: transformCurve(e.curve, [0, 0, 0, p.x, 0, 0, 0, p.y, 0, 0, 0, p.z] as Affine3),
            }
          : e,
      ),
      faces: b.faces,
      shells: b.shells,
      solids: b.solids,
    });
    expect(collapsed.ok).toBe(true);
    if (!collapsed.ok) return;
    expectCode(() => writeStepUnchecked(collapsed.value), 'step-unsupported');
  });

  it('writeStepCore exposes the same text as writeStep for a valid B-rep', () => {
    const b = boxSolid(2, 3, 5);
    const r = writeStep(b);
    expect(writeStepCore(b, undefined, r.report).text).toBe(r.text);
  });
});
