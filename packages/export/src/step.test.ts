// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP writer, checked two ways.
 *
 * Structural assertions (below) catch the lexical mistakes that make a Part 21
 * file unreadable — an illegal real, a dangling `#id`, a knot count that does not
 * match its control net.
 *
 * Then a decoder reads the emitted file back with no schema knowledge, rebuilds
 * the surface from the entities alone and compares it to the loft. That is the
 * part that matters: everything upstream is tested against the kernel's own data
 * structures, so a U/V transposition, a mis-nested control list, a botched
 * multiplicity expansion or a wrong unit scale would sail through all of it and
 * show up only when a shaper opens the file. Testing our file against our intent
 * is worth more here than validating it with a third-party reader, and costs no
 * dependency.
 */
import { describe, expect, it } from 'vitest';
import {
  evalSurface,
  getLength,
  loftPoint,
  loftSection,
  type BSplineSurface,
  type BezierBoard,
} from '@openshaper/kernel';
import { BRAND_LINE } from './brand';
import { exportStep, stepExportSupport } from './step';
import { makeTestBoard } from './fixture.test-helper';

const board = makeTestBoard();
const FIXED = '2026-08-14T12:00:00';
const step = exportStep(board, { timestamp: FIXED });

// --- a schema-free Part 21 reader ---

type Value = { ref: number } | { num: number } | { str: string } | { raw: string } | Value[];

interface Entity {
  readonly id: number;
  readonly name: string;
  readonly args: Value[];
}

/** Split a DATA section into `#id=BODY;` instances, respecting strings and nesting. */
const instances = (text: string): { id: number; body: string }[] => {
  const data = text.slice(text.indexOf('\nDATA;') + 6, text.lastIndexOf('ENDSEC;'));
  const out: { id: number; body: string }[] = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (inStr) {
      buf += ch;
      if (ch === "'") inStr = data[i + 1] === "'" ? ((buf += data[++i]!), true) : false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      const m = /^\s*#(\d+)\s*=\s*([\s\S]*)$/.exec(buf);
      if (m) out.push({ id: Number(m[1]), body: m[2]!.trim() });
      buf = '';
      continue;
    }
    buf += ch;
  }
  return out;
};

/** Parse a comma-separated argument list (the text inside the outermost parens). */
const parseArgs = (src: string): Value[] => {
  let i = 0;

  const skip = (): void => {
    while (i < src.length && /[\s,]/.test(src[i]!)) i++;
  };

  const parseList = (): Value[] => {
    const items: Value[] = [];
    i++; // consume '('
    for (;;) {
      skip();
      if (i >= src.length) return items;
      if (src[i] === ')') {
        i++;
        return items;
      }
      items.push(parseValue());
    }
  };

  const parseValue = (): Value => {
    const ch = src[i]!;
    if (ch === '(') return parseList();
    if (ch === "'") {
      let s = '';
      i++;
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++]!;
      }
      return { str: s };
    }
    if (ch === '#') {
      let n = '';
      i++;
      while (i < src.length && /\d/.test(src[i]!)) n += src[i++]!;
      return { ref: Number(n) };
    }
    // A typed parameter, e.g. LENGTH_MEASURE(25.4): keep the name and step over
    // its balanced parens. Nothing here needs to look inside one.
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) name += src[i++]!;
      skipSpace();
      if (src[i] === '(') {
        let depth = 0;
        do {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        } while (i < src.length && depth > 0);
      }
      return { raw: name };
    }
    let tok = '';
    while (i < src.length && !/[,)]/.test(src[i]!)) tok += src[i++]!;
    // Never return without consuming something, or the scanner spins forever.
    if (tok === '') {
      i++;
      return { raw: ch };
    }
    tok = tok.trim();
    return /^-?[\d.]/.test(tok) && !Number.isNaN(Number(tok)) ? { num: Number(tok) } : { raw: tok };
  };

  const skipSpace = (): void => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  const items: Value[] = [];
  while (i < src.length) {
    skip();
    if (i >= src.length) break;
    items.push(parseValue());
  }
  return items;
};

const parse = (text: string): Map<number, Entity> => {
  const map = new Map<number, Entity>();
  for (const { id, body } of instances(text)) {
    // Simple entity `NAME(...)`; complex entities `(A(..)B(..))` keep their whole
    // body as the name, which is all these tests need of them.
    const m = /^([A-Z0-9_]+)\s*\(([\s\S]*)\)$/.exec(body);
    if (m) map.set(id, { id, name: m[1]!, args: parseArgs(m[2]!) });
    else map.set(id, { id, name: body, args: [] });
  }
  return map;
};

const entities = parse(step);
const byName = (n: string): Entity[] => [...entities.values()].filter((e) => e.name === n);
const isRef = (v: Value | undefined): v is { ref: number } =>
  typeof v === 'object' && v !== null && 'ref' in v;
const isNum = (v: Value | undefined): v is { num: number } =>
  typeof v === 'object' && v !== null && 'num' in v;
const asList = (v: Value | undefined): Value[] => (Array.isArray(v) ? v : []);
const nums = (v: Value | undefined): number[] =>
  asList(v)
    .filter(isNum)
    .map((n) => n.num);

/** Coordinates of a CARTESIAN_POINT, resolved in the map it came from. */
const pointIn = (map: Map<number, Entity>, id: number) => {
  const [x, y, z] = nums(map.get(id)!.args[1]);
  return { x: x!, y: y!, z: z! };
};
const pointAt = (id: number) => pointIn(entities, id);

/**
 * Rebuild a kernel surface from an emitted B_SPLINE_SURFACE_WITH_KNOTS.
 *
 * Takes the map explicitly: the refs inside an entity only mean anything relative
 * to the file it came from, and resolving them against a different one silently
 * yields a plausible surface at the wrong scale.
 */
const decodeSurface = (
  e: Entity,
  map: Map<number, Entity> = entities,
  scale = 1,
): BSplineSurface => {
  const uDegree = isNum(e.args[1]) ? e.args[1].num : 0;
  const vDegree = isNum(e.args[2]) ? e.args[2].num : 0;
  const ctrl = asList(e.args[3]).map((row) =>
    asList(row)
      .filter(isRef)
      .map((r) => {
        const p = pointIn(map, r.ref);
        return { x: p.x * scale, y: p.y * scale, z: p.z * scale };
      }),
  );
  const expand = (mults: number[], values: number[]): number[] =>
    mults.flatMap((m, i) => Array.from({ length: m }, () => values[i]!));
  return {
    uDegree,
    vDegree,
    ctrl,
    uKnots: expand(nums(e.args[8]), nums(e.args[10])),
    vKnots: expand(nums(e.args[9]), nums(e.args[11])),
  };
};

// --- structure ---

describe('exportStep: Part 21 structure', () => {
  it('is a well-formed exchange file', () => {
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    expect(step.split('\n').filter((l) => l === 'ENDSEC;')).toHaveLength(2);
    expect(step.indexOf('HEADER;')).toBeLessThan(step.indexOf('\nDATA;'));
  });

  it('declares AP214', () => {
    expect(step).toContain('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }');
  });

  it('contains no NaN or Infinity', () => {
    expect(step).not.toMatch(/NaN/);
    expect(step).not.toMatch(/Infinity/);
  });

  it('brands the file without putting it in the geometry', () => {
    // Verbatim (escaped) as FILE_NAME's originating_system, and transliterated in
    // the comment beside it. Never as geometry — same rule as the other exporters.
    const ascii = BRAND_LINE.replace(/[^\x20-\x7e]/g, '-');
    expect(step).toContain(ascii);
    expect(step.indexOf(ascii)).toBeLessThan(step.indexOf('\nDATA;'));
  });

  it('keeps the whole file inside printable ASCII', () => {
    // Part 21 has no escape syntax inside a comment and is an ASCII-oriented
    // format throughout; a raw UTF-8 byte anywhere can upset a strict reader.
    // BRAND_LINE's U+00B7 is escaped in FILE_NAME and transliterated in the
    // comment, so nothing non-ASCII should survive.
    // eslint-disable-next-line no-control-regex
    const offending = step.match(/[^\x09\x0a\x0d\x20-\x7e]/g);
    expect(offending).toBeNull();
  });

  it('escapes non-ASCII in strings', () => {
    // BRAND_LINE carries a U+00B7, and model names are arbitrary user text.
    expect(step).toMatch(/\\X2\\[0-9A-F]{4}\\X0\\/);
    expect(exportStep(board, { timestamp: FIXED, name: 'Café \u2014 6\'2"' })).toContain(
      '\\X2\\00E9\\X0\\',
    );
  });

  it('is byte-identical for the same inputs', () => {
    expect(exportStep(board, { timestamp: FIXED })).toBe(step);
  });
});

describe('exportStep: reference integrity', () => {
  // The likeliest class of bug in a hand-written entity graph, and invisible to
  // any assertion about content.
  it('defines every id it references, exactly once, densely', () => {
    const defined = [...entities.keys()].sort((a, b) => a - b);
    expect(defined[0]).toBe(1);
    expect(defined[defined.length - 1]).toBe(defined.length);

    const referenced = new Set<number>();
    for (const m of step.slice(step.indexOf('\nDATA;')).matchAll(/#(\d+)/g)) {
      referenced.add(Number(m[1]));
    }
    const dangling = [...referenced].filter((r) => !entities.has(r));
    expect(dangling).toEqual([]);
  });

  it('leaves no orphan entities behind the shape', () => {
    // Every entity should be reachable; an unreferenced one usually means a loop
    // was built and then discarded.
    const reachable = new Set<number>();
    const root = byName('SHAPE_DEFINITION_REPRESENTATION')[0]!;
    const walk = (id: number) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const e = entities.get(id);
      if (!e) return;
      const scan = (v: Value): void => {
        if (Array.isArray(v)) v.forEach(scan);
        else if (isRef(v)) walk(v.ref);
      };
      e.args.forEach(scan);
    };
    walk(root.id);
    // The product/context chain hangs off other roots, so only assert the
    // geometry is fully reachable: every face, curve and point.
    for (const name of [
      'ADVANCED_FACE',
      'EDGE_CURVE',
      'VERTEX_POINT',
      'B_SPLINE_SURFACE_WITH_KNOTS',
    ]) {
      for (const e of byName(name)) expect(reachable.has(e.id)).toBe(true);
    }
  });

  it('writes every real with a decimal point', () => {
    // `3` and `1e-7` are both illegal Part 21 reals — the rule most hand-rolled
    // writers break, and one many readers reject outright.
    const bad: string[] = [];
    for (const e of byName('CARTESIAN_POINT')) {
      for (const v of asList(e.args[1])) {
        if (!isNum(v)) bad.push(String(v));
      }
    }
    expect(bad).toEqual([]);
    for (const m of step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)) {
      for (const tok of m[1]!.split(',')) {
        expect(tok.trim()).toMatch(/^-?\d+\.\d*(E[-+]?\d+)?$/);
      }
    }
  });
});

describe('exportStep: topology', () => {
  it('is one closed solid of four faces', () => {
    expect(byName('MANIFOLD_SOLID_BREP')).toHaveLength(1);
    expect(byName('CLOSED_SHELL')).toHaveLength(1);
    expect(byName('ADVANCED_FACE')).toHaveLength(4);
    expect(byName('B_SPLINE_SURFACE_WITH_KNOTS')).toHaveLength(2);
    expect(byName('PLANE')).toHaveLength(2);
    expect(byName('EDGE_CURVE')).toHaveLength(6);
    expect(byName('VERTEX_POINT')).toHaveLength(4);
  });

  it('shares the stringer seam rather than duplicating it', () => {
    // The two hull patches meet on y = 0. If the seam points were emitted twice
    // the shell would be watertight only to tolerance, so the entity count is the
    // assertion: 6 edges for 4 faces only works if the seams are shared.
    const shell = byName('CLOSED_SHELL')[0]!;
    expect(asList(shell.args[1]).filter(isRef)).toHaveLength(4);
  });

  it('gives each hull face a four-edge loop and each cap a two-edge loop', () => {
    const sizes = byName('EDGE_LOOP')
      .map((e) => asList(e.args[1]).filter(isRef).length)
      .sort();
    expect(sizes).toEqual([2, 2, 4, 4]);
  });

  it('knot multiplicities match the control net in both directions', () => {
    for (const e of byName('B_SPLINE_SURFACE_WITH_KNOTS')) {
      const s = decodeSurface(e);
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      expect(sum(nums(e.args[8]))).toBe(s.ctrl.length + s.uDegree + 1);
      expect(sum(nums(e.args[9]))).toBe(s.ctrl[0]!.length + s.vDegree + 1);
      for (const dir of [10, 11]) {
        const values = nums(e.args[dir]);
        for (let i = 1; i < values.length; i++) {
          expect(values[i]!).toBeGreaterThan(values[i - 1]!);
        }
      }
    }
  });

  it('carries an interior knot per cross-section crease', () => {
    // The C0 breaks the loft has at every station must survive into the file, or
    // the STEP solid is a different board than the STL.
    const e = byName('B_SPLINE_SURFACE_WITH_KNOTS')[0]!;
    const mults = nums(e.args[8]);
    expect(mults[0]).toBe(4);
    expect(mults[mults.length - 1]).toBe(4);
    expect(mults.slice(1, -1).some((m) => m === 3)).toBe(true);
  });
});

describe('exportStep: units', () => {
  it('declares the unit it wrote', () => {
    expect(exportStep(board, { timestamp: FIXED, unit: 'mm' })).toContain(
      'SI_UNIT(.MILLI.,.METRE.)',
    );
    expect(exportStep(board, { timestamp: FIXED, unit: 'cm' })).toContain(
      'SI_UNIT(.CENTI.,.METRE.)',
    );
    const inches = exportStep(board, { timestamp: FIXED, unit: 'in' });
    expect(inches).toContain('CONVERSION_BASED_UNIT');
    expect(inches).toContain('LENGTH_MEASURE(25.4)');
  });

  it('scales the geometry to match', () => {
    const cm = parse(exportStep(board, { timestamp: FIXED, unit: 'cm' }));
    const mm = parse(exportStep(board, { timestamp: FIXED, unit: 'mm' }));
    const span = (m: Map<number, Entity>) => {
      const xs = [...m.values()]
        .filter((e) => e.name === 'CARTESIAN_POINT')
        .map((e) => nums(e.args[1])[0]!);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(mm) / span(cm)).toBeCloseTo(10, 6);
  });
});

describe('exportStep: the file decodes back to the board', () => {
  // The encoding gap: U/V order, list nesting, multiplicity expansion and unit
  // scaling are all invisible upstream of the text.
  const cmFile = exportStep(board, { timestamp: FIXED, unit: 'cm' });
  const cmEntities = parse(cmFile);
  const surfaces = [...cmEntities.values()].filter((e) => e.name === 'B_SPLINE_SURFACE_WITH_KNOTS');

  const deviation = (b: BezierBoard, s: BSplineSurface): number => {
    let worst = 0;
    for (let i = 0; i < 25; i++) {
      const u = (i + 0.5) / 25;
      const probe = evalSurface(s, u, 0.5);
      const section = loftSection(b, probe.x);
      if (!section) continue;
      for (let j = 0; j < 25; j++) {
        const v = (j + 0.5) / 25;
        const p = evalSurface(s, u, v);
        let best = Infinity;
        let prev = loftPoint(section, 0);
        for (let k = 1; k <= 400; k++) {
          const cur = loftPoint(section, k / 400);
          const ax = prev.x;
          const az = prev.y + section.rocker;
          const dx = cur.x - ax;
          const dz = cur.y + section.rocker - az;
          const len2 = dx * dx + dz * dz;
          const t =
            len2 > 0
              ? Math.max(0, Math.min(1, ((Math.abs(p.y) - ax) * dx + (p.z - az) * dz) / len2))
              : 0;
          best = Math.min(best, Math.hypot(Math.abs(p.y) - (ax + t * dx), p.z - (az + t * dz)));
          prev = cur;
        }
        worst = Math.max(worst, best);
      }
    }
    return worst;
  };

  it('parses into a surface of the right shape', () => {
    expect(surfaces).toHaveLength(2);
    for (const e of surfaces) {
      const s = decodeSurface(e, cmEntities);
      expect(s.uDegree).toBe(3);
      expect(s.vDegree).toBe(3);
      expect(s.ctrl.length).toBeGreaterThan(4);
      expect(new Set(s.ctrl.map((r) => r.length)).size).toBe(1); // rectangular
      expect(s.uKnots).toHaveLength(s.ctrl.length + 4);
      expect(s.vKnots).toHaveLength(s.ctrl[0]!.length + 4);
    }
  });

  it('spans the board it was made from', () => {
    // Short of the full length by the sliver at each tip where the board is
    // thinner than MIN_DIM and `loftSection` stops telling the truth. This
    // synthetic fixture tapers bluntly and loses 1.7 mm; the golden boards, with
    // realistic outlines, lose 30 µm.
    const s = decodeSurface(surfaces[0]!, cmEntities);
    const xs = s.ctrl.flat().map((p) => p.x);
    const length = getLength(board);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(length);
    expect(length - (Math.max(...xs) - Math.min(...xs))).toBeLessThan(0.5);
  });

  it('describes the same hull as the loft', () => {
    // Same 0.015 cm bound the kernel fit is held to; if the encoding were wrong
    // this would be off by centimetres, not microns.
    for (const e of surfaces) {
      expect(deviation(board, decodeSurface(e, cmEntities))).toBeLessThan(0.015);
    }
  });

  it('mirrors the two patches about the stringer', () => {
    const a = decodeSurface(surfaces[0]!, cmEntities);
    const b = decodeSurface(surfaces[1]!, cmEntities);
    a.ctrl.forEach((row, i) =>
      row.forEach((p, j) => {
        const q = b.ctrl[i]![j]!;
        expect(q.x).toBeCloseTo(p.x, 9);
        expect(q.y).toBeCloseTo(-p.y, 9);
        expect(q.z).toBeCloseTo(p.z, 9);
      }),
    );
  });
});

describe('exportStep: every face points out of the solid', () => {
  /**
   * Re-derives orientation from the emitted file alone.
   *
   * This is the assertion that a wrong `same_sense` cannot survive. Getting it
   * backwards produces a file that parses, imports and looks plausible while being
   * inside-out, and the rule is genuinely easy to reason about wrongly — mirroring
   * flips handedness, so the two hull patches take OPPOSITE flags.
   */
  const centroid = { x: getLength(board) / 2, y: 0, z: 3 };

  it('has an outward normal on all four faces', () => {
    const faces = byName('ADVANCED_FACE');
    expect(faces).toHaveLength(4);
    for (const f of faces) {
      const sameSense =
        f.args[3] && !Array.isArray(f.args[3]) && 'raw' in f.args[3]
          ? f.args[3].raw === '.T.'
          : true;
      const surfRef = f.args[2];
      expect(isRef(surfRef)).toBe(true);
      const surf = entities.get((surfRef as { ref: number }).ref)!;

      let normal: { x: number; y: number; z: number };
      let at: { x: number; y: number; z: number };
      if (surf.name === 'B_SPLINE_SURFACE_WITH_KNOTS') {
        const s = decodeSurface(surf);
        const h = 1e-4;
        at = evalSurface(s, 0.5, 0.5);
        const du = evalSurface(s, 0.5 + h, 0.5);
        const dv = evalSurface(s, 0.5, 0.5 + h);
        const a = { x: du.x - at.x, y: du.y - at.y, z: du.z - at.z };
        const b = { x: dv.x - at.x, y: dv.y - at.y, z: dv.z - at.z };
        normal = {
          x: a.y * b.z - a.z * b.y,
          y: a.z * b.x - a.x * b.z,
          z: a.x * b.y - a.y * b.x,
        };
      } else {
        // PLANE: the normal is its placement's axis direction.
        const placement = entities.get((surf.args[1] as { ref: number }).ref)!;
        const origin = pointAt((placement.args[1] as { ref: number }).ref);
        const axis = entities.get((placement.args[2] as { ref: number }).ref)!;
        const [x, y, z] = nums(axis.args[1]);
        normal = { x: x!, y: y!, z: z! };
        at = origin;
      }
      if (!sameSense) {
        normal = { x: -normal.x, y: -normal.y, z: -normal.z };
      }
      const away = { x: at.x - centroid.x, y: at.y - centroid.y, z: at.z - centroid.z };
      const dot = normal.x * away.x + normal.y * away.y + normal.z * away.z;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('gives the two hull patches opposite same_sense', () => {
    const hullFlags = byName('ADVANCED_FACE')
      .filter((f) => {
        const s = entities.get((f.args[2] as { ref: number }).ref)!;
        return s.name === 'B_SPLINE_SURFACE_WITH_KNOTS';
      })
      .map((f) => (f.args[3] as { raw: string }).raw);
    expect(new Set(hullFlags).size).toBe(2);
  });
});

describe('stepExportSupport', () => {
  it('accepts a normal board', () => {
    expect(stepExportSupport(board).ok).toBe(true);
  });
});
