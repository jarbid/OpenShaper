// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin STEP file, read back with the schema-free reader and checked against the
 * design: structure, closed and consistently oriented shells, outward faces, units,
 * and geometry. What it cannot check is that CAD packages open it usefully; that is
 * the manual pass recorded in docs/design/fin-designer.md.
 */
import { describe, expect, it } from 'vitest';
import {
  BLADE_CI_TOLERANCE,
  BLADE_DEFAULTS,
  bladeSection,
  bladeTop,
  bladeSurfaceDeviation,
  cosineStations,
  defaultFinDesign,
  defaultSingleFin,
  finTabOutline,
  evalCurve,
  evalSurface,
  fitBladeSurface,
  knot,
  splineFromKnots,
  vec2,
  futuresTabOutline,
  finTabKind,
  placeOnBase,
  prepareBlade,
  sectionLoop,
  tabCentreY,
  type FinDesign,
  type Vert3,
  type TabSegment,
} from '@openshaper/kernel';
import { exportFinStep } from './fin-step';
import {
  asList,
  decodeSurface,
  isNum,
  isRef,
  nums,
  parse,
  pointIn,
  type Entity,
} from './step-reader.test-helper';

const FIXED = '2026-10-15T12:00:00';
const MM = 10; // kernel cm → file mm

/** A long-based fin with a raised rear (as in the kernel's raised-rear.test.ts). */
const raisedRear = (): FinDesign => {
  const d = defaultFinDesign('side', 'right');
  const [k0, k1, k2, k3] = d.outline.knots;
  return {
    ...d,
    outline: splineFromKnots([
      k0!,
      k1!,
      k2!,
      knot(k3!.end, k3!.tangentToPrev, vec2(-0.236, 4.857), true),
      knot(vec2(-1.8, 0.5), vec2(-1.9, 1.8), vec2(-1.2, 0.4), false),
      knot(vec2(0.5, 0), vec2(-0.2, 0.08), vec2(0.5, 0), false),
    ]),
  };
};

const designs: [string, FinDesign][] = [
  ['side', defaultFinDesign('side', 'right')],
  ['side with a raised rear', raisedRear()],
  ['left side, 20° cant', { ...defaultFinDesign('side', 'left'), cant: 20 }],
  ['quad rear', defaultFinDesign('quad-rear', 'right')],
  ['centre', defaultFinDesign('centre')],
];

type Map3 = Map<number, Entity>;
const refOf = (v: unknown): number => (v as { ref: number }).ref;
const raw = (v: unknown): string => (v as { raw: string }).raw;
const toCm = (p: Vert3): Vert3 => ({ x: p.x / MM, y: p.y / MM, z: p.z / MM });

/** Vertex coordinates (cm) of a VERTEX_POINT. */
const vertexAt = (m: Map3, id: number): Vert3 => toCm(pointIn(m, refOf(m.get(id)!.args[1])));

const sub = (a: Vert3, b: Vert3): Vert3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const crossV = (a: Vert3, b: Vert3): Vert3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dotV = (a: Vert3, b: Vert3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const unitV = (a: Vert3): Vert3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Direction (unit) of a DIRECTION entity. */
const dirAt = (m: Map3, id: number): Vert3 => {
  const [x, y, z] = nums(m.get(id)!.args[1]);
  return { x: x!, y: y!, z: z! };
};

/** origin (cm), axis, refDir of an AXIS2_PLACEMENT_3D. */
const placementAt = (m: Map3, id: number) => {
  const e = m.get(id)!;
  return {
    origin: toCm(pointIn(m, refOf(e.args[1]))),
    axis: dirAt(m, refOf(e.args[2])),
    refDir: dirAt(m, refOf(e.args[3])),
  };
};

/** Points along an EDGE_CURVE from its start vertex to its end vertex (cm). */
const sampleEdge = (m: Map3, edgeId: number, n = 24): Vert3[] => {
  const e = m.get(edgeId)!;
  const a = vertexAt(m, refOf(e.args[1]));
  const b = vertexAt(m, refOf(e.args[2]));
  const curve = m.get(refOf(e.args[3]))!;
  if (curve.name === 'LINE') return [a, b];
  if (curve.name === 'CIRCLE') {
    const { origin, axis, refDir } = placementAt(m, refOf(curve.args[1]));
    const yDir = crossV(axis, refDir);
    const ang = (p: Vert3) => {
      const d = sub(p, origin);
      return Math.atan2(dotV(d, yDir), dotV(d, refDir));
    };
    const r = (curve.args[2] as { num: number }).num / MM;
    const a0 = ang(a);
    let sweep = ang(b) - a0;
    if (sweep <= 0) sweep += 2 * Math.PI; // a circle runs counter-clockwise about its axis
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = a0 + (sweep * i) / n;
      return {
        x: origin.x + r * (Math.cos(t) * refDir.x + Math.sin(t) * yDir.x),
        y: origin.y + r * (Math.cos(t) * refDir.y + Math.sin(t) * yDir.y),
        z: origin.z + r * (Math.cos(t) * refDir.z + Math.sin(t) * yDir.z),
      };
    });
  }
  // B_SPLINE_CURVE_WITH_KNOTS('', degree, (pts), form, closed, self, (mults), (knots), spec)
  const degree = (curve.args[1] as { num: number }).num;
  const ctrl = asList(curve.args[2])
    .filter(isRef)
    .map((r) => toCm(pointIn(m, r.ref)));
  const mults = nums(curve.args[6]);
  const values = nums(curve.args[7]);
  const knots = mults.flatMap((k, i) => Array.from({ length: k }, () => values[i]!));
  const c = { degree, ctrl, knots };
  return Array.from({ length: n * 8 + 1 }, (_, i) => evalCurve(c, i / (n * 8)));
};

interface Solid {
  readonly name: string;
  readonly faces: Entity[];
}

const solidsOf = (m: Map3): Solid[] =>
  [...m.values()]
    .filter((e) => e.name === 'MANIFOLD_SOLID_BREP')
    .map((b) => ({
      name: (b.args[0] as { str: string }).str,
      faces: asList(m.get(refOf(b.args[1]))!.args[1]).map((f) => m.get(refOf(f))!),
    }));

/** A face's outer loop as [edge id, sense] pairs. */
/** One bound's oriented edges: the outer bound (k = 0) or a hole's. */
const boundOf = (m: Map3, f: Entity, k: number): [number, boolean][] => {
  const bound = m.get(refOf(asList(f.args[1])[k]))!;
  const loop = m.get(refOf(bound.args[1]))!;
  return asList(loop.args[1]).map((oe) => {
    const o = m.get(refOf(oe))!;
    return [refOf(o.args[3]), raw(o.args[4]) === '.T.'];
  });
};

/** The face's outer loop. */
const loopOf = (m: Map3, f: Entity): [number, boolean][] => boundOf(m, f, 0);

/** Every edge of the face, the holes' included. */
const allEdgesOf = (m: Map3, f: Entity): [number, boolean][] =>
  asList(f.args[1]).flatMap((_, k) => boundOf(m, f, k));

/** The loop as a polyline, each edge walked in its oriented direction. */
const loopPolyline = (m: Map3, f: Entity): Vert3[] =>
  loopOf(m, f).flatMap(([edge, sense]) => {
    const pts = sampleEdge(m, edge);
    return (sense ? pts : [...pts].reverse()).slice(0, -1);
  });

/** Newell (area-weighted) normal of a closed polyline. */
const newell = (pts: readonly Vert3[]): Vert3 => {
  const n = { x: 0, y: 0, z: 0 };
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length]!;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  });
  return n;
};

/** The face's outward normal and a point on it, per its surface and same_sense. */
const faceNormal = (m: Map3, f: Entity): { at: Vert3; normal: Vert3 } => {
  const surf = m.get(refOf(f.args[2]))!;
  const sense = raw(f.args[3]) === '.T.' ? 1 : -1;
  const flip = (v: Vert3) => ({ x: sense * v.x, y: sense * v.y, z: sense * v.z });
  if (surf.name === 'PLANE') {
    const { axis } = placementAt(m, refOf(surf.args[1]));
    // A point inside the face: the centre of its loop (every flat face here is
    // convex enough for that, the tab sides included).
    const pts = loopPolyline(m, f);
    const at = pts.reduce(
      (c, p) => ({
        x: c.x + p.x / pts.length,
        y: c.y + p.y / pts.length,
        z: c.z + p.z / pts.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
    return { at, normal: flip(axis) };
  }
  if (surf.name === 'CYLINDRICAL_SURFACE') {
    const { origin, axis } = placementAt(m, refOf(surf.args[1]));
    // Mid-arc, half-way across the tab: average the two arc edges' middles.
    const arcs = loopOf(m, f)
      .map(([e]) => e)
      .filter((e) => m.get(refOf(m.get(e)!.args[3]))!.name === 'CIRCLE')
      .map((e) => {
        const pts = sampleEdge(m, e);
        return pts[Math.floor(pts.length / 2)]!;
      });
    const at = {
      x: (arcs[0]!.x + arcs[1]!.x) / 2,
      y: (arcs[0]!.y + arcs[1]!.y) / 2,
      z: (arcs[0]!.z + arcs[1]!.z) / 2,
    };
    const d = sub(at, origin);
    const radial = sub(d, {
      x: axis.x * dotV(d, axis),
      y: axis.y * dotV(d, axis),
      z: axis.z * dotV(d, axis),
    });
    return { at, normal: flip(unitV(radial)) };
  }
  // B-spline: S_u × S_v at a point on the outside face, half-way up.
  const s = decodeSurface(surf, m, 1 / MM);
  const h = 1e-5;
  const u = 0.2;
  const at = evalSurface(s, u, 0.5);
  const du = sub(evalSurface(s, u + h, 0.5), at);
  const dv = sub(evalSurface(s, u, 0.5 + h), at);
  return { at, normal: flip(unitV(crossV(du, dv))) };
};

/** Point-in-polygon in (x, y), even-odd. */
const insidePoly = (p: { x: number; y: number }, poly: readonly { x: number; y: number }[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

describe.each(designs)('exportFinStep(%s)', (_, d) => {
  const step = exportFinStep(d, { timestamp: FIXED });
  const m = parse(step);
  const solids = solidsOf(m);

  describe('structure', () => {
    it('is a well-formed AP214 exchange file', () => {
      expect(step.startsWith('ISO-10303-21;')).toBe(true);
      expect(step.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
      expect(step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
      expect(step).not.toMatch(/NaN|Infinity/);
      expect([...step].every((ch) => ch === '\n' || (ch >= ' ' && ch <= '~'))).toBe(true);
    });

    it('defines every id it references, exactly once', () => {
      const defined = [...step.matchAll(/^#(\d+)=/gm)].map((x) => Number(x[1]));
      expect(new Set(defined).size).toBe(defined.length);
      const ids = new Set(defined);
      for (const x of step.matchAll(/#(\d+)/g)) expect(ids.has(Number(x[1]))).toBe(true);
    });

    it('is byte-identical for the same inputs', () => {
      expect(exportFinStep(d, { timestamp: FIXED })).toBe(step);
    });

    // A fin file credits OpenFinShaper, not the board editor it was forked from.
    it('names OpenFinShaper as the originating system', () => {
      expect(step).toMatch(/FILE_NAME\(.*'OpenFinShaper','Made with OpenFinShaper/);
      expect(step).not.toMatch(/openshaper\.com|'OpenShaper'/);
    });

    it('holds two solids, blade and tab, in one shape', () => {
      expect(solids.map((s) => s.name)).toEqual(['blade', 'tab']);
      expect(solids[0]!.faces).toHaveLength(3);
      // The tab: 2 sides, 12 round its profile and 16 through its four holes.
      expect(solids[1]!.faces).toHaveLength(30);
      const shape = [...m.values()].find((e) => e.name === 'ADVANCED_BREP_SHAPE_REPRESENTATION')!;
      expect(asList(shape.args[1]).filter(isRef)).toHaveLength(3); // placement + 2 solids
    });
  });

  describe.each([0, 1])('solid %i', (k) => {
    const solid = solids[k]!;

    it('is closed and consistently oriented: each edge used once each way', () => {
      const uses = new Map<number, boolean[]>();
      for (const f of solid.faces) {
        for (const [edge, sense] of allEdgesOf(m, f))
          uses.set(edge, [...(uses.get(edge) ?? []), sense]);
      }
      for (const senses of uses.values()) expect(senses.sort()).toEqual([false, true]);
    });

    it('winds every flat face counter-clockwise about its outward normal', () => {
      for (const f of solid.faces) {
        if (m.get(refOf(f.args[2]))!.name !== 'PLANE') continue;
        const { normal } = faceNormal(m, f);
        expect(dotV(newell(loopPolyline(m, f)), normal)).toBeGreaterThan(0);
      }
    });

    it('points every face out of the solid', () => {
      const b = prepareBlade(d);
      const tab = futuresTabOutline(finTabKind(d.position));
      const yc = tabCentreY(d);
      // The profile and holes as polygons, arcs sampled finely (a chord would fill the slot).
      const polygon = (segs: readonly TabSegment[]) =>
        segs.flatMap((s) => {
          if (s.kind === 'line') return [s.from];
          const a = Math.atan2(s.from.y - s.center.y, s.from.x - s.center.x);
          let sweep = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x) - a;
          if (s.ccw && sweep <= 0) sweep += 2 * Math.PI;
          if (!s.ccw && sweep >= 0) sweep -= 2 * Math.PI;
          return Array.from({ length: 64 }, (_, i) => ({
            x: s.center.x + s.radius * Math.cos(a + (sweep * i) / 64),
            y: s.center.y + s.radius * Math.sin(a + (sweep * i) / 64),
          }));
        });
      const profile = polygon(tab.segments);
      const holes = tab.holes.map(polygon);
      const inBlade = (p: Vert3) => {
        if (p.z <= 0 || p.z >= bladeTop(b, BLADE_DEFAULTS.tipGap)) return false;
        return insidePoly(p, sectionLoop(bladeSection(b, p.z, cosineStations(400))));
      };
      const inTab = (p: Vert3) =>
        Math.abs(p.y - yc) < tab.spec.thickness / 2 &&
        insidePoly({ x: p.x, y: p.z + tab.spec.height }, profile) &&
        !holes.some((h) => insidePoly({ x: p.x, y: p.z + tab.spec.height }, h));
      const inside = k === 0 ? inBlade : inTab;
      const eps = 0.002; // cm
      for (const f of solid.faces) {
        const { at, normal } = faceNormal(m, f);
        const step = (s: number) => ({
          x: at.x + s * normal.x,
          y: at.y + s * normal.y,
          z: at.z + s * normal.z,
        });
        expect(inside(step(eps))).toBe(false);
        expect(inside(step(-eps))).toBe(true);
      }
    });
  });

  describe('geometry', () => {
    it('writes the blade surface within tolerance of the design, in mm', () => {
      const surf = [...m.values()].find((e) => e.name === 'B_SPLINE_SURFACE_WITH_KNOTS')!;
      const s = decodeSurface(surf, m, 1 / MM);
      const model = fitBladeSurface(d);
      expect(bladeSurfaceDeviation(prepareBlade(d), s, model.topZ)).toBeLessThanOrEqual(
        BLADE_CI_TOLERANCE,
      );
    });

    it('puts the tab corners where the Futures spec does, on both sides', () => {
      const tab = futuresTabOutline(finTabKind(d.position));
      const yc = tabCentreY(d);
      const verts = [...m.values()]
        .filter((e) => e.name === 'VERTEX_POINT')
        .map((e) => vertexAt(m, e.id));
      for (const p of Object.values(tab.front)) {
        for (const y of [yc - tab.spec.thickness / 2, yc + tab.spec.thickness / 2]) {
          const want = { x: p.x, y, z: p.y - tab.spec.height };
          expect(
            verts.some((v) => Math.hypot(v.x - want.x, v.y - want.y, v.z - want.z) < 1e-6),
          ).toBe(true);
        }
      }
    });

    it('sits the blade root and the tab top on one plane', () => {
      const zs = [...m.values()]
        .filter((e) => e.name === 'VERTEX_POINT')
        .map((e) => vertexAt(m, e.id).z);
      expect(Math.max(...zs.filter((z) => z <= 1e-9))).toBeCloseTo(0, 9);
    });
  });
});

describe('exportFinStep: units', () => {
  const d = defaultFinDesign('side', 'right');
  const extent = (text: string) => {
    const xs = [...parse(text).values()]
      .filter((e) => e.name === 'CARTESIAN_POINT')
      .map((e) => nums(e.args[1])[0]!);
    return Math.max(...xs) - Math.min(...xs);
  };

  it('writes mm by default, and scales to cm or inches', () => {
    const mm = extent(exportFinStep(d, { timestamp: FIXED }));
    expect(mm).toBeGreaterThan(100); // the tab alone is 113 mm
    expect(extent(exportFinStep(d, { timestamp: FIXED, unit: 'cm' }))).toBeCloseTo(mm / 10, 4);
    expect(extent(exportFinStep(d, { timestamp: FIXED, unit: 'in' }))).toBeCloseTo(mm / 25.4, 4);
  });

  it('scales lengths in the tab entities too', () => {
    // VECTOR magnitudes and radii are lengths; directions are not.
    const text = exportFinStep(d, { timestamp: FIXED, unit: 'cm' });
    const radii = [...parse(text).values()]
      .filter((e) => e.name === 'CIRCLE')
      .map((e) => (isNum(e.args[2]) ? e.args[2].num : NaN));
    // The rear fillet and slot, then the holes' round ends (4 mm): one circle per side.
    expect(radii.sort()).toEqual([0.1, 0.1, 0.22, 0.22, ...Array(16).fill(0.4)]);
  });
});

describe('exportFinStep: hand', () => {
  it('writes a left fin as the mirror of a right fin', () => {
    const points = (text: string) =>
      [...parse(text).values()]
        .filter((e) => e.name === 'CARTESIAN_POINT')
        .map((e) =>
          nums(e.args[1])
            .map((v) => v.toFixed(4))
            .join(','),
        );
    const right = exportFinStep(defaultFinDesign('side', 'right'), { timestamp: FIXED });
    const left = exportFinStep(defaultFinDesign('side', 'left'), { timestamp: FIXED });
    const mirrored = new Set(
      points(right).map((p) => {
        const [x, y, z] = p.split(',').map(Number);
        return [x, -y!, z].map((v) => (Object.is(v, -0) ? 0 : v!).toFixed(4)).join(',');
      }),
    );
    const l = points(left).map((p) =>
      p
        .split(',')
        .map(Number)
        .map((v) => (Object.is(v, -0) ? 0 : v).toFixed(4))
        .join(','),
    );
    expect(l.every((p) => mirrored.has(p))).toBe(true);
  });
});

describe('exportFinStep: laminate core', () => {
  const d = defaultFinDesign('side', 'left');
  const laminate = { outside: 0.02, inside: 0.02 };
  const step = exportFinStep(d, { timestamp: FIXED, laminate });
  const m = parse(step);

  it('still holds the blade and the tab as two solids', () => {
    expect(solidsOf(m).map((s) => s.name)).toEqual(['blade', 'tab']);
  });

  it('writes the core, not the finished blade, within tolerance', () => {
    const surf = [...m.values()].find((e) => e.name === 'B_SPLINE_SURFACE_WITH_KNOTS')!;
    const s = decodeSurface(surf, m, 1 / MM);
    const model = fitBladeSurface(d, { laminate });
    expect(bladeSurfaceDeviation(prepareBlade(d, laminate), s, model.topZ)).toBeLessThanOrEqual(
      BLADE_CI_TOLERANCE,
    );
    // The finished blade is a laminate's thickness away, well over the tolerance.
    expect(bladeSurfaceDeviation(prepareBlade(d), s, model.topZ)).toBeGreaterThan(
      BLADE_CI_TOLERANCE,
    );
  });

  it('thins the tab too when the laminate wraps it', () => {
    const ys = (text: string) => {
      const tabPart = text.slice(text.indexOf("MANIFOLD_SOLID_BREP('blade'"));
      return [...tabPart.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map(
        (x) => x[1]!.split(',').map(Number)[1]!,
      );
    };
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const wrapped = exportFinStep(d, { timestamp: FIXED, laminate: { ...laminate, tab: true } });
    expect(spread(ys(step)) - spread(ys(wrapped))).toBeCloseTo(2 * laminate.outside * MM, 6);
  });
});

describe('exportFinStep: FCS 1 base', () => {
  const d = placeOnBase(defaultFinDesign('side', 'left'), 'fcs-1');
  const step = exportFinStep(d, { timestamp: FIXED });
  const m = parse(step);
  const solids = solidsOf(m);

  it('writes the blade and each tab as its own solid', () => {
    expect(solids.map((s) => s.name)).toEqual(['blade', 'tab-rear', 'tab-front']);
    // Each tab: two sides, then one face per profile segment (four lines, two corners).
    expect(solids[1]!.faces).toHaveLength(8);
    expect(solids[2]!.faces).toHaveLength(8);
  });

  it.each([1, 2])('closes tab solid %i, each edge used once each way', (k) => {
    const uses = new Map<number, boolean[]>();
    for (const f of solids[k]!.faces) {
      for (const [edge, sense] of allEdgesOf(m, f))
        uses.set(edge, [...(uses.get(edge) ?? []), sense]);
    }
    for (const senses of uses.values()) expect(senses.sort()).toEqual([false, true]);
  });

  it('winds every flat tab face counter-clockwise about its outward normal', () => {
    for (const solid of solids.slice(1)) {
      for (const f of solid.faces) {
        if (m.get(refOf(f.args[2]))!.name !== 'PLANE') continue;
        const { normal } = faceNormal(m, f);
        expect(dotV(newell(loopPolyline(m, f)), normal)).toBeGreaterThan(0);
      }
    }
  });

  it('puts the tabs 33 mm apart, 74 mm overall, in mm', () => {
    const xs = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map((x) =>
      Number(x[1]!.split(',')[0]),
    );
    // Tab corners are on the tab-top plane and below; the blade is above it.
    expect(xs.some((x) => Math.abs(x - 20.5) < 1e-6)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 53.5) < 1e-6)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 74) < 1e-6)).toBe(true);
  });
});

describe('exportFinStep: Gbox base', () => {
  const d = placeOnBase(defaultFinDesign('side', 'left'), 'gbox');
  const step = exportFinStep(d, { timestamp: FIXED });
  const m = parse(step);
  const solids = solidsOf(m);
  const tab = solids[1]!;

  it('writes the blade and the tab as two solids', () => {
    expect(solids.map((s) => s.name)).toEqual(['blade', 'tab']);
    // Two sides, then one face per profile segment: five lines and the notch.
    expect(tab.faces).toHaveLength(8);
    const surfaces = tab.faces.map((f) => m.get(refOf(f.args[2]))!.name);
    expect(surfaces.filter((n) => n === 'CYLINDRICAL_SURFACE')).toHaveLength(1);
  });

  it('closes the tab, notch and all: each edge used once each way', () => {
    const uses = new Map<number, boolean[]>();
    for (const f of tab.faces) {
      for (const [edge, sense] of allEdgesOf(m, f))
        uses.set(edge, [...(uses.get(edge) ?? []), sense]);
    }
    for (const senses of uses.values()) expect(senses.sort()).toEqual([false, true]);
  });

  it('winds every flat face counter-clockwise about its outward normal', () => {
    for (const f of tab.faces) {
      if (m.get(refOf(f.args[2]))!.name !== 'PLANE') continue;
      const { normal } = faceNormal(m, f);
      expect(dotV(newell(loopPolyline(m, f)), normal)).toBeGreaterThan(0);
    }
  });

  it('is 2 7/8" long, in mm', () => {
    const xs = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map((x) =>
      Number(x[1]!.split(',')[0]),
    );
    expect(xs.some((x) => Math.abs(x - 73.025) < 1e-6)).toBe(true);
  });
});

describe('exportFinStep: US box head', () => {
  const d = defaultSingleFin();
  const step = exportFinStep(d, { timestamp: FIXED });
  const m = parse(step);
  const solids = solidsOf(m);
  const head = solids[1]!;

  it('writes the blade and the head as two solids', () => {
    expect(solids.map((s) => s.name)).toEqual(['blade', 'tab']);
  });

  it('closes the head, screw hole and all: each edge used once each way', () => {
    const uses = new Map<number, boolean[]>();
    for (const f of head.faces) {
      for (const [edge, sense] of allEdgesOf(m, f))
        uses.set(edge, [...(uses.get(edge) ?? []), sense]);
    }
    for (const senses of uses.values()) expect(senses.sort()).toEqual([false, true]);
  });

  it('winds every flat face counter-clockwise about its outward normal', () => {
    for (const f of head.faces) {
      if (m.get(refOf(f.args[2]))!.name !== 'PLANE') continue;
      const { normal } = faceNormal(m, f);
      expect(dotV(newell(loopPolyline(m, f)), normal)).toBeGreaterThan(0);
    }
  });

  it('has the screw hole as a 4.5 mm cylinder, in four faces, with the scoop and rear corner', () => {
    const cyl = head.faces.filter((f) => m.get(refOf(f.args[2]))!.name === 'CYLINDRICAL_SURFACE');
    // Four quarters of the hole, the scoop, and the rounded rear corner.
    expect(cyl).toHaveLength(6);
    const radii = cyl.map((f) => {
      const v = m.get(refOf(f.args[2]))!.args[2];
      return isNum(v) ? v.num : NaN;
    });
    expect(radii.filter((r) => Math.abs(r - 2.25) < 1e-6)).toHaveLength(4);
    // Two flat faces carry the hole: the head's top and the nose's underside.
    const holed = head.faces.filter((f) => asList(f.args[1]).length > 1);
    expect(holed).toHaveLength(2);
  });

  it('is in mm, as long as the head', () => {
    const t = finTabOutline(d.base, d.outline);
    const xs = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map((x) =>
      Number(x[1]!.split(',')[0]),
    );
    expect(Math.max(...xs)).toBeCloseTo((t.rear + t.length) * MM, 6);
  });
});

describe('exportFinStep: export minimum thickness', () => {
  const d = defaultFinDesign('side', 'left');

  it('writes the blade with the edges thickened to the export minimum', () => {
    const step = exportFinStep(d, { timestamp: FIXED, minThickness: 0.1 });
    const m = parse(step);
    const surf = [...m.values()].find((e) => e.name === 'B_SPLINE_SURFACE_WITH_KNOTS')!;
    const s = decodeSurface(surf, m, 1 / MM);
    const model = fitBladeSurface(d, { minThickness: 0.1 });
    // It is the thickened blade, not the design's.
    expect(
      bladeSurfaceDeviation(prepareBlade(d, undefined, 0.1), s, model.topZ),
    ).toBeLessThanOrEqual(BLADE_CI_TOLERANCE);
    expect(step).not.toBe(exportFinStep(d, { timestamp: FIXED }));
  });
});
