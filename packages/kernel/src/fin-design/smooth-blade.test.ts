// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import { vec2 } from '../vec2';
import { prepareBlade, thicknessAt } from './blade';
import { defaultFinDesign, defaultKeel, defaultSingleFin, defaultTwinFin } from './fin-defaults';
import type { FinDesign, FinTwist } from './fin-design';
import { fairness } from './fairness';
import { finMesh, FIN_MESH_PREVIEW } from './fin-mesh';
import { foilWarp, smoothBlade, smoothSampler } from './smooth-blade';
import { sweepFrame } from './swept-loft';

const here = dirname(fileURLToPath(import.meta.url));
/** An owner's fin from docs/specs/fins (mm → cm), slices and twist included. */
const ownerFin = (name: string): FinDesign => {
  type Row = { e: [number, number]; p: [number, number]; n: [number, number]; c: boolean };
  type Section = { outside: Row[]; inside: Row[] | null };
  const file = JSON.parse(
    readFileSync(resolve(here, '../../../../docs/specs/fins', name), 'utf8'),
  ) as {
    hand: 'left' | 'right';
    cant?: number;
    outline: Row[];
    section: Section;
    slices?: { height: number; section: Section; twist?: FinTwist }[];
    taper: Row[];
    tipLine?: { start: number; end: number };
    tipSection?: Section;
    thicknessMid?: number;
  };
  const spline = (rows: Row[], fx: number, fy: number) =>
    splineFromKnots(
      rows.map((k) =>
        knot(
          vec2(k.e[0] * fx, k.e[1] * fy),
          vec2(k.p[0] * fx, k.p[1] * fy),
          vec2(k.n[0] * fx, k.n[1] * fy),
          k.c,
        ),
      ),
    );
  const section = (sec: Section) => ({
    outside: spline(sec.outside, 1, 1),
    inside: sec.inside ? spline(sec.inside, 1, 1) : null,
  });
  return {
    ...defaultFinDesign('side', file.hand),
    cant: file.cant ?? 0,
    outline: spline(file.outline, 0.1, 0.1),
    section: section(file.section),
    slices: (file.slices ?? []).map((sl) => ({
      height: sl.height,
      section: section(sl.section),
      ...(sl.twist ? { twist: sl.twist } : {}),
    })),
    taper: spline(file.taper, 1, 0.1),
    ...(file.tipLine ? { tipLine: file.tipLine } : {}),
    ...(file.tipSection ? { tipSection: section(file.tipSection) } : {}),
    ...(file.thicknessMid !== undefined ? { thicknessMid: file.thicknessMid } : {}),
  };
};

/** The fins the gate is held to: the starting fins and the owners', without control sections. */
const FINS: [string, () => FinDesign][] = [
  ['side', () => defaultFinDesign('side', 'left')],
  ['right side', () => defaultFinDesign('side', 'right')],
  ['centre', () => defaultFinDesign('centre')],
  ['keel', () => defaultKeel()],
  ['twin', () => defaultTwinFin()],
  ['single', () => defaultSingleFin()],
  ['TSN 800 single (hooked)', () => ownerFin('tsn_800_single.fin.json')],
  ['hatchet, tip crossing', () => ownerFin('hatchet_tip_crossing.fin.json')],
  ['steep tip line', () => ownerFin('steep_tip_line.fin.json')],
  ['swept-back tip', () => ownerFin('swept_back_tip.fin.json')],
];

describe('the smooth blade', () => {
  it.each(FINS)('passes the smoothness gate: %s', (_, make) => {
    // Every one of these creases on the sweep (docs/design/fin-designer.md, stage 1).
    const d = { ...make(), slices: [] };
    const f = fairness(smoothSampler(d));
    expect(f.creases.slice(0, 3)).toEqual([]);
  });

  it('runs edge to edge along the outline, the tip edge included', () => {
    const d = ownerFin('tsn_800_single.fin.json');
    const sb = smoothBlade(d);
    const f = sweepFrame(d);
    /** Distance from p to the polyline through `pts`. */
    const near = (p: { x: number; y: number }, pts: readonly { x: number; y: number }[]) => {
      let m = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
        );
        m = Math.min(m, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
      }
      return m;
    };
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      // Within 0.01 mm of the outline.
      expect(near(sb.point(t, 0), f.leading.pts)).toBeLessThan(0.001);
      expect(near(sb.point(t, 1), f.trailing.pts)).toBeLessThan(0.001);
      expect(near(sb.point(1, t), f.tipEdge.pts)).toBeLessThan(0.001);
      expect(sb.point(0, t).y).toBeCloseTo(0, 9);
    }
  });

  it('is as thick as the thickness curve at the base, and the minimum at every edge', () => {
    const d = defaultFinDesign('side', 'left');
    const sb = smoothBlade(d);
    const m = sb.blade.minThickness;
    let thickest = 0;
    for (let k = 0; k <= 400; k++) {
      const [o, n] = sb.offsets(0, k / 400);
      thickest = Math.max(thickest, o - n);
    }
    expect(thickest).toBeCloseTo(thicknessAt(prepareBlade(d), 0), 3);
    for (let k = 0; k <= 10; k++) {
      for (const [s, u] of [
        [k / 10, 0],
        [k / 10, 1],
        [1, k / 10],
      ] as const) {
        const [o, n] = sb.offsets(s, u);
        expect(o - n).toBeCloseTo(m, 9);
      }
    }
  });

  it('lays each foil with its thickest point on the path, its nose still round', () => {
    // The warp puts the foil's thickest fraction at the path's, and keeps the ends' slopes finite.
    expect(foilWarp(0.4, 0.4, 0.3)).toBeCloseTo(0.3, 12);
    expect(foilWarp(0, 0.4, 0.3)).toBe(0);
    expect(foilWarp(1, 0.4, 0.3)).toBe(1);
    const slope0 = foilWarp(1e-7, 0.4, 0.3) / 1e-7;
    expect(slope0).toBeGreaterThan(0.2);
    expect(slope0).toBeLessThan(5);
  });

  it('meshes as a closed shell, wound outward, either hand and round a hook', () => {
    for (const [d, lo, hi] of [
      [defaultFinDesign('side', 'left'), 25, 32],
      [defaultFinDesign('side', 'right'), 25, 32],
      [ownerFin('tsn_800_single.fin.json'), 100, 140],
    ] as const) {
      const m = finMesh(d, { ...FIN_MESH_PREVIEW, engine: 'smooth' }).blade;
      const edges = new Map<string, number>();
      // Wound one way throughout: each edge is run once each way by the two triangles on it.
      // (Round the hook's tip, where rows run up and down, quads judged one by one from the
      // ring's direction seen from above came out flipped.)
      const directed = new Set<string>();
      let flipped = 0;
      let volume = 0;
      const P = m.positions;
      for (let t = 0; t < m.indices.length; t += 3) {
        const v = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
        for (let e = 0; e < 3; e++) {
          const [a, b] = [v[e]!, v[(e + 1) % 3]!].sort((p, q) => p - q);
          edges.set(`${a}-${b}`, (edges.get(`${a}-${b}`) ?? 0) + 1);
          const key = `${v[e]}>${v[(e + 1) % 3]}`;
          if (directed.has(key)) flipped++;
          directed.add(key);
        }
        const [a, b, c] = v.map((i) => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]) as [
          number[],
          number[],
          number[],
        ];
        volume +=
          (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
            a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
            a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
          6;
      }
      expect([...edges.values()].every((n) => n === 2)).toBe(true);
      expect(flipped).toBe(0);
      // Wound outward, and about as big as the sweep's blade (28 cm³ for the side fin).
      expect(volume).toBeGreaterThan(lo);
      expect(volume).toBeLessThan(hi);
    }
  });
});
