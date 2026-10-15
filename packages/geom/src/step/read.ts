// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A reader for exactly the subset of Part 21 that `writeStep` emits (design §14),
 * for round-trip tests. Exported through `@openshaper/geom/testing` only: STEP
 * reading is not a product feature in Phase 1.
 *
 * It is independent of the writer's code (a tokenizer and a recursive-descent
 * value parser over the text), and strict: every instance's attribute count is
 * checked against `schema.ts` (OCCT only warns), every `#id` must resolve, and
 * anything outside the subset is an error rather than a guess.
 *
 * The B-rep it returns is in the order the writer emitted it (faces as in the
 * shell; vertices and edges by first use walking faces, loops and coedges in
 * order), in the file's length unit unless `unit` is given. A coedge's pcurve is
 * the one the writer attached to that use: the k-th use of an edge, in that same
 * traversal, takes the k-th `PCURVE` of its `SURFACE_CURVE` / `SEAM_CURVE`. Edges
 * written without pcurves (`pcurves: 'trimmedOnly'`) are not supported.
 */
import { makeBrep, unwrapBrep } from '../brep/brep';
import { clampedBasis } from '../basis';
import { makeCurve } from '../curve';
import { fail } from '../errors';
import { makeSurface } from '../surface';
import type {
  Brep,
  BrepCoedge,
  BrepEdge,
  BrepFace,
  BrepLoop,
  ClampedCurve,
  NurbsSurface,
  Point3,
} from '../types';
import { PARTIAL_ARITY, SIMPLE_ARITY } from './schema';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Value =
  | { readonly k: 'ref'; readonly id: number }
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'enum'; readonly v: string }
  | { readonly k: 'null' }
  | { readonly k: 'star' }
  | { readonly k: 'list'; readonly items: readonly Value[] }
  | { readonly k: 'typed'; readonly type: string; readonly value: Value };

interface Part {
  readonly type: string;
  readonly args: readonly Value[];
}
interface Instance {
  readonly id: number;
  readonly parts: readonly Part[];
}

class Scanner {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s.startsWith('/*', this.i)) {
        const e = this.s.indexOf('*/', this.i + 2);
        if (e < 0) fail('unsupported', 'unterminated comment');
        this.i = e + 2;
      } else return;
    }
  }
  eat(ch: string): void {
    this.ws();
    if (this.s[this.i] !== ch) {
      fail(
        'unsupported',
        `expected '${ch}' at offset ${this.i}, found '${this.s.slice(this.i, this.i + 12)}'`,
      );
    }
    this.i++;
  }
  peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }
  ident(): string {
    this.ws();
    const m = /^[A-Z][A-Z0-9_]*/.exec(this.s.slice(this.i, this.i + 80));
    if (m === null) fail('unsupported', `expected an entity name at offset ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  value(): Value {
    const c = this.peek();
    if (c === '#') {
      this.i++;
      const m = /^\d+/.exec(this.s.slice(this.i, this.i + 20));
      if (m === null) fail('unsupported', `bad reference at offset ${this.i}`);
      this.i += m[0].length;
      return { k: 'ref', id: Number(m[0]) };
    }
    if (c === "'") {
      let out = '';
      this.i++;
      for (;;) {
        const ch = this.s[this.i];
        if (ch === undefined) fail('unsupported', 'unterminated string');
        if (ch === "'") {
          if (this.s[this.i + 1] === "'") {
            out += "'";
            this.i += 2;
            continue;
          }
          this.i++;
          return { k: 'str', v: out };
        }
        out += ch;
        this.i++;
      }
    }
    if (c === '.') {
      const m = /^\.([A-Z0-9_]+)\./.exec(this.s.slice(this.i, this.i + 40));
      if (m !== null) {
        this.i += m[0].length;
        return { k: 'enum', v: m[1]! };
      }
    }
    if (c === '$') {
      this.i++;
      return { k: 'null' };
    }
    if (c === '*') {
      this.i++;
      return { k: 'star' };
    }
    if (c === '(') {
      this.i++;
      const items: Value[] = [];
      if (this.peek() === ')') {
        this.i++;
        return { k: 'list', items };
      }
      for (;;) {
        items.push(this.value());
        const d = this.peek();
        this.i++;
        if (d === ')') return { k: 'list', items };
        if (d !== ',') fail('unsupported', `expected ',' or ')' at offset ${this.i - 1}`);
      }
    }
    const num = /^[+-]?\d+(\.\d*)?([Ee][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (num !== null) {
      this.i += num[0].length;
      return { k: 'num', v: Number(num[0]) };
    }
    if (/[A-Z]/.test(c)) {
      const type = this.ident();
      this.eat('(');
      const value = this.value();
      this.eat(')');
      return { k: 'typed', type, value };
    }
    return fail('unsupported', `unexpected '${c}' at offset ${this.i}`);
  }
  /** `NAME(args)` with the arity checked against `arity`. */
  part(arity: Readonly<Record<string, number>>): Part {
    const type = this.ident();
    this.eat('(');
    const args: Value[] = [];
    if (this.peek() === ')') this.i++;
    else {
      for (;;) {
        args.push(this.value());
        const d = this.peek();
        this.i++;
        if (d === ')') break;
        if (d !== ',') fail('unsupported', `expected ',' or ')' at offset ${this.i - 1}`);
      }
    }
    const n = arity[type];
    if (n === undefined) fail('unsupported', `entity ${type} is not in the writer's subset`);
    if (args.length !== n) {
      fail('size-mismatch', `${type} has ${args.length} attributes; the schema says ${n}`, {
        value: args.length,
      });
    }
    return { type, args };
  }
}

/** The instances of the DATA section, by id. */
function parseData(text: string): Map<number, Instance> {
  if (!text.startsWith('ISO-10303-21;')) fail('unsupported', 'not a Part 21 file');
  const start = text.indexOf('DATA;');
  const end = text.lastIndexOf('ENDSEC;');
  if (start < 0 || end < start) fail('unsupported', 'no DATA section');
  if (!text.trimEnd().endsWith('END-ISO-10303-21;'))
    fail('unsupported', 'missing END-ISO-10303-21;');
  const sc = new Scanner(text.slice(start + 5, end));
  const out = new Map<number, Instance>();
  while (sc.peek() !== '') {
    sc.eat('#');
    const m = /^\d+/.exec(sc.s.slice(sc.i, sc.i + 20));
    if (m === null) fail('unsupported', `bad instance id at offset ${sc.i}`);
    sc.i += m[0].length;
    const id = Number(m[0]);
    sc.eat('=');
    const parts: Part[] = [];
    if (sc.peek() === '(') {
      sc.i++;
      while (sc.peek() !== ')') parts.push(sc.part(PARTIAL_ARITY));
      sc.i++;
    } else parts.push(sc.part(SIMPLE_ARITY));
    sc.eat(';');
    if (out.has(id)) fail('unsupported', `instance #${id} is defined twice`);
    out.set(id, { id, parts });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

class Model {
  constructor(readonly data: Map<number, Instance>) {}
  get(v: Value | undefined, what: string): Instance {
    if (v === undefined || v.k !== 'ref') fail('brep-reference', `${what}: expected a reference`);
    const e = this.data.get(v.id);
    if (e === undefined) fail('brep-reference', `${what}: #${v.id} is not defined`);
    return e;
  }
  /** The single (simple) part of type `type`. */
  simple(e: Instance, type: string): readonly Value[] {
    if (e.parts.length !== 1 || e.parts[0]!.type !== type) {
      fail('unsupported', `#${e.id} is ${e.parts.map((p) => p.type).join('+')}, expected ${type}`);
    }
    return e.parts[0]!.args;
  }
  part(e: Instance, type: string): readonly Value[] | undefined {
    return e.parts.find((p) => p.type === type)?.args;
  }
}

const num = (v: Value | undefined): number => {
  if (v === undefined || v.k !== 'num') return fail('unsupported', 'expected a number');
  return v.v;
};
const list = (v: Value | undefined): readonly Value[] => {
  if (v === undefined || v.k !== 'list') return fail('unsupported', 'expected a list');
  return v.items;
};
const nums = (v: Value | undefined): number[] => list(v).map(num);
const flag = (v: Value | undefined): boolean => {
  if (v === undefined || v.k !== 'enum' || (v.v !== 'T' && v.v !== 'F')) {
    return fail('unsupported', 'expected .T. or .F.');
  }
  return v.v === 'T';
};

function expandKnots(mults: readonly number[], values: readonly number[]): number[] {
  const out: number[] = [];
  mults.forEach((m, i) => {
    for (let k = 0; k < m; k++) out.push(values[i]!);
  });
  return out;
}

/** Length of the file unit in millimetres. */
function fileUnitMm(m: Model): number {
  for (const e of m.data.values()) {
    const ctx = m.part(e, 'GEOMETRIC_REPRESENTATION_CONTEXT');
    if (ctx === undefined) continue;
    const assigned = m.part(e, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    if (assigned === undefined) continue;
    for (const u of list(assigned[0])) {
      const unit = m.get(u, 'unit');
      if (m.part(unit, 'LENGTH_UNIT') === undefined) continue;
      const si = m.part(unit, 'SI_UNIT');
      if (si !== undefined) {
        const prefix = si[0]!.k === 'enum' ? si[0]!.v : '';
        if (prefix === 'MILLI') return 1;
        if (prefix === 'CENTI') return 10;
        return fail('unsupported', `SI length prefix ${prefix}`);
      }
      const conv = m.part(unit, 'CONVERSION_BASED_UNIT');
      if (conv !== undefined) {
        const measure = m.simple(m.get(conv[1], 'conversion factor'), 'LENGTH_MEASURE_WITH_UNIT');
        const typed = measure[0]!;
        if (typed.k !== 'typed')
          return fail('unsupported', 'conversion factor is not a typed value');
        return num(typed.value);
      }
    }
  }
  return fail('unsupported', 'no length unit in the file');
}

/**
 * Reads what `writeStep` emits back into a B-rep (module comment). With `unit`,
 * lengths are converted to it (`'mm'` or `'cm'`); without, they stay in the
 * file's unit. Throws on anything outside the subset.
 */
export function readStepSubset(text: string, opts?: { readonly unit?: 'mm' | 'cm' }): Brep {
  const m = new Model(parseData(text));
  const fileMm = fileUnitMm(m);
  const scale = opts?.unit === undefined ? 1 : fileMm / (opts.unit === 'mm' ? 1 : 10);

  const pointOf = (v: Value | undefined, dim: number): number[] => {
    const a = nums(m.simple(m.get(v, 'point'), 'CARTESIAN_POINT')[1]);
    if (a.length !== dim) fail('dimension-mismatch', `expected a ${dim}D point`);
    return a;
  };

  /** A B-spline curve instance (simple or rational complex) as a clamped curve. */
  const curveOf = (e: Instance, dim: 2 | 3): ClampedCurve<2> | ClampedCurve<3> => {
    const simple = m.part(e, 'B_SPLINE_CURVE_WITH_KNOTS');
    const base = m.part(e, 'B_SPLINE_CURVE');
    let degree: number;
    let ctrl: readonly Value[];
    let mults: number[];
    let knots: number[];
    let weights: number[] | undefined;
    if (e.parts.length === 1 && simple !== undefined && simple.length === 9) {
      degree = num(simple[1]);
      ctrl = list(simple[2]);
      mults = nums(simple[6]);
      knots = nums(simple[7]);
    } else if (base !== undefined && simple !== undefined) {
      degree = num(base[0]);
      ctrl = list(base[1]);
      mults = nums(simple[0]);
      knots = nums(simple[1]);
      weights = nums(m.part(e, 'RATIONAL_B_SPLINE_CURVE')?.[0]);
    } else return fail('unsupported', `#${e.id} is not a B-spline curve`);
    const pts: number[] = [];
    for (const c of ctrl) pts.push(...pointOf(c, dim).map((x) => (dim === 3 ? x * scale : x)));
    return makeCurve({
      dim,
      basis: clampedBasis(degree, expandKnots(mults, knots)),
      points: pts,
      weights,
    }) as ClampedCurve<2> | ClampedCurve<3>;
  };

  const surfaceCache = new Map<number, NurbsSurface>();
  const surfaceOf = (e: Instance): NurbsSurface => {
    const hit = surfaceCache.get(e.id);
    if (hit !== undefined) return hit;
    const simple = m.part(e, 'B_SPLINE_SURFACE_WITH_KNOTS');
    const base = m.part(e, 'B_SPLINE_SURFACE');
    let du: number;
    let dv: number;
    let rows: readonly Value[];
    let um: number[];
    let vm: number[];
    let uk: number[];
    let vk: number[];
    let weights: number[] | undefined;
    if (e.parts.length === 1 && simple !== undefined && simple.length === 13) {
      du = num(simple[1]);
      dv = num(simple[2]);
      rows = list(simple[3]);
      um = nums(simple[8]);
      vm = nums(simple[9]);
      uk = nums(simple[10]);
      vk = nums(simple[11]);
    } else if (base !== undefined && simple !== undefined) {
      du = num(base[0]);
      dv = num(base[1]);
      rows = list(base[2]);
      um = nums(simple[0]);
      vm = nums(simple[1]);
      uk = nums(simple[2]);
      vk = nums(simple[3]);
      weights = list(m.part(e, 'RATIONAL_B_SPLINE_SURFACE')?.[0]).flatMap((r) => nums(r));
    } else return fail('unsupported', `#${e.id} is not a B-spline surface`);
    const pts: number[] = [];
    for (const row of rows) {
      for (const c of list(row)) pts.push(...pointOf(c, 3).map((x) => x * scale));
    }
    const s = makeSurface({
      u: clampedBasis(du, expandKnots(um, uk)),
      v: clampedBasis(dv, expandKnots(vm, vk)),
      points: pts,
      weights,
    });
    surfaceCache.set(e.id, s);
    return s;
  };

  // The shell.
  let solid: Instance | undefined;
  for (const e of m.data.values()) if (e.parts[0]!.type === 'MANIFOLD_SOLID_BREP') solid = e;
  if (solid === undefined) fail('unsupported', 'no MANIFOLD_SOLID_BREP');
  const shellArgs = m.simple(
    m.get(m.simple(solid, 'MANIFOLD_SOLID_BREP')[1], 'shell'),
    'CLOSED_SHELL',
  );
  const faceInstances = list(shellArgs[1]).map((f) => m.get(f, 'face'));

  const vertices: { point: Point3 }[] = [];
  const vertexIndex = new Map<number, number>();
  const vertexOf = (v: Value | undefined): number => {
    const inst = m.get(v, 'vertex');
    let k = vertexIndex.get(inst.id);
    if (k === undefined) {
      const p = pointOf(m.simple(inst, 'VERTEX_POINT')[1], 3).map((x) => x * scale);
      k = vertices.length;
      vertices.push({ point: { x: p[0]!, y: p[1]!, z: p[2]! } });
      vertexIndex.set(inst.id, k);
    }
    return k;
  };
  const edges: BrepEdge[] = [];
  const edgeIndex = new Map<number, number>();
  const edgeInfo: { pcurves: readonly Instance[]; masters: readonly string[]; used: number }[] = [];
  const edgeOf = (inst: Instance): number => {
    let k = edgeIndex.get(inst.id);
    if (k !== undefined) return k;
    const a = m.simple(inst, 'EDGE_CURVE');
    const start = vertexOf(a[1]);
    const end = vertexOf(a[2]);
    if (!flag(a[4])) fail('unsupported', 'EDGE_CURVE same_sense .F. is not written by geom');
    const geom = m.get(a[3], 'edge geometry');
    let curve3d: Instance;
    let pcurves: Instance[] = [];
    let masters: string[] = [];
    const t = geom.parts[0]!.type;
    if (geom.parts.length === 1 && (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE')) {
      const g = geom.parts[0]!.args;
      curve3d = m.get(g[1], 'curve3d');
      pcurves = list(g[2]).map((p) => m.get(p, 'pcurve'));
      const mr = g[3]!;
      if (mr.k !== 'enum') fail('unsupported', 'master representation');
      masters =
        mr.v === 'CURVE_3D'
          ? ['curve3d', 'curve3d']
          : mr.v === 'PCURVE_S1'
            ? ['pcurve', 'curve3d']
            : ['curve3d', 'pcurve'];
    } else curve3d = geom;
    k = edges.length;
    edges.push({ curve: curveOf(curve3d, 3) as ClampedCurve<3>, start, end });
    edgeInfo.push({ pcurves, masters, used: 0 });
    edgeIndex.set(inst.id, k);
    return k;
  };

  const faces: BrepFace[] = [];
  for (const fi of faceInstances) {
    const a = m.simple(fi, 'ADVANCED_FACE');
    const surface = surfaceOf(m.get(a[2], 'face surface'));
    const sameSense = flag(a[3]);
    const labelArg = a[0];
    const label = labelArg !== undefined && labelArg.k === 'str' ? labelArg.v : '';
    const loops: BrepLoop[] = list(a[1]).map((bv) => {
      const bound = m.get(bv, 'bound');
      const bargs =
        bound.parts[0]!.type === 'FACE_OUTER_BOUND'
          ? m.simple(bound, 'FACE_OUTER_BOUND')
          : m.simple(bound, 'FACE_BOUND');
      if (!flag(bargs[2])) fail('unsupported', 'bound orientation .F. is not written by geom');
      const loop = m.simple(m.get(bargs[1], 'loop'), 'EDGE_LOOP');
      const coedges: BrepCoedge[] = list(loop[1]).map((ov) => {
        const oe = m.simple(m.get(ov, 'oriented edge'), 'ORIENTED_EDGE');
        const e = edgeOf(m.get(oe[3], 'edge'));
        const info = edgeInfo[e]!;
        if (info.pcurves.length === 0) {
          fail('unsupported', 'an edge without pcurves (pcurves: trimmedOnly) cannot be read back');
        }
        const use = info.used++;
        const pc = info.pcurves[use];
        if (pc === undefined)
          fail('size-mismatch', `edge #${e} is used more often than it has pcurves`);
        const pargs = m.simple(pc, 'PCURVE');
        const surf = surfaceOf(m.get(pargs[1], 'pcurve surface'));
        void surf;
        const rep = m.simple(
          m.get(pargs[2], 'definitional representation'),
          'DEFINITIONAL_REPRESENTATION',
        );
        const curve2d = curveOf(m.get(list(rep[1])[0], 'pcurve curve'), 2) as ClampedCurve<2>;
        return {
          edge: e,
          sense: flag(oe[4]),
          pcurve: curve2d,
          master: info.masters[use] === 'pcurve' ? 'pcurve' : 'curve3d',
        };
      });
      return { coedges };
    });
    faces.push({
      surface,
      sameSense,
      outer: loops[0]!,
      holes: loops.slice(1),
      ...(label === '' ? {} : { label }),
    });
  }
  return unwrapBrep(
    makeBrep({
      vertices,
      edges,
      faces,
      shells: [{ faces: faces.map((_, i) => i), closed: true }],
      solids: [{ outer: 0 }],
    }),
  );
}
