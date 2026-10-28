// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 step 4 (docs/design/m1-model.md §11): every classic file converts, none is refused.
 *
 * - the four files that step 2 refused: a deck that meets the rocker at an end (zero
 *   thickness), a V bottom (the bottom centre handle leaves the stringer), and a blunt tail
 *   (a squash tail: the outline starts at x = 0 with a half-width);
 * - every classic board file in the repository (found by listing the directories) converts,
 *   builds, meshes closed without a NaN, and matches the classic at its interior stations.
 */
import { board, knotFromArray, loftRing, splineFromKnots } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { meshBoard } from '../mesh';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import { GOLDENS, SAMPLES, classicFilesInRepo } from '../test-support/classic-samples';
import { nurbsRing, polylineHausdorff, topology, weldMap } from '../test-support/mesh-checks';
import type { V3 } from '../test-support/mesh-checks';
import { convertClassic } from './index';

const sample = (name: string): BezierBoard => SAMPLES.find((s) => s.name.endsWith(name))!.load();

function build(b: BezierBoard): BuiltBoard {
  const r = convertClassic(b);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  const built = buildBoard(r.value.doc);
  if (!built.ok) throw new Error(built.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  return built.value;
}

const finite = (a: Float32Array): boolean => a.every(Number.isFinite);

describe('every classic file converts', () => {
  const names = SAMPLES.map((s) => s.name);

  it('covers every board file of the repository (io fixtures, goldens, templates)', () => {
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect([...names].sort()).toEqual(classicFilesInRepo());
  });

  it.each(SAMPLES.map((s) => [s.name.replace(/^.*\//, ''), s] as const))(
    '%s converts, builds, meshes closed and matches the classic at its interior stations',
    (_name, s) => {
      const classic = s.load();
      const t0 = performance.now();
      const conv = convertClassic(classic);
      const ms = performance.now() - t0;
      expect(conv.ok, conv.ok ? '' : conv.issues.map((i) => i.message).join('; ')).toBe(true);
      if (!conv.ok) return;
      expect(ms).toBeLessThan(50);
      const built = buildBoard(conv.value.doc);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const mesh = meshBoard(built.value, { curvature: true });
      expect(topology(mesh.indices, mesh.vertexCount, weldMap(mesh)).badEdges).toBe(0);
      expect(mesh.volume).toBeGreaterThan(0);
      for (const a of [mesh.positions, mesh.normals, mesh.k1!, mesh.k2!])
        expect(finite(a)).toBe(true);
      // stations within 1.5 mm of the classic's slices (a 0.5 mm tolerance for the smooth boards;
      // the synthetic polygons have rail corners that the cubic fit rounds by about 1 mm). The
      // stations 0.2 cm from the tips are not compared: the classic floors its tips at 5 mm.
      const ev = createEvaluator(built.value);
      const L = classic.outline.knots[classic.outline.knots.length - 1]!.end.x;
      for (const cs of classic.crossSections.slice(1, -1)) {
        if (cs.position < 1 || cs.position > L - 1) continue;
        const plus = nurbsRing(ev, cs.position, 200);
        const minus = plus.slice(1, -1).map((p): V3 => [p[0], -p[1], p[2]]);
        const mine = [...plus, ...minus.reverse()];
        const theirs = loftRing(classic, cs.position, 400)!.map((v): V3 => [v.x, v.y, v.z]);
        const d = Math.max(
          polylineHausdorff(theirs, mine, true),
          polylineHausdorff(mine, theirs, true),
        );
        expect(d, `${s.name} at x = ${cs.position}`).toBeLessThan(
          GOLDENS.includes(s) ? 0.05 : 0.15,
        );
      }
    },
  );
});

describe('zero thickness at an end', () => {
  it.each(['synthetic-clean-6x22x2-75.s3dx', 'synthetic-fallback-outline-5x10.s3dx'])(
    '%s closes to a point at the tail and the nose, without a NaN',
    (name) => {
      const classic = sample(name);
      const b = build(classic);
      const L = b.xiMax;
      const ev = createEvaluator(b);
      const o = new Float64Array(18);
      for (const x of [0, L]) {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          ev.at(0, x, t, 0, o);
          expect(Math.hypot(o[0]! - x, o[1]!, o[2]!)).toBeLessThan(1e-9);
        }
      }
      const mesh = meshBoard(b, { curvature: true });
      expect(mesh.layout.weldFirst).toBe(true);
      expect(mesh.layout.weldLast).toBe(true);
      expect(finite(mesh.positions) && finite(mesh.normals)).toBe(true);
      // close to the tail the board is a thin lens: its height tends to 0
      let zMax = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (mesh.positions[3 * i]! < 1) zMax = Math.max(zMax, mesh.positions[3 * i + 2]!);
      }
      expect(zMax).toBeLessThan(0.1);
    },
  );
});

describe('a V bottom', () => {
  it.each(['synthetic-rocker-absolute-deck.s3dx', 'synthetic-rocker-thickness-deck.s3dx'])(
    '%s keeps the straight vee from the stringer to the rail',
    (name) => {
      const classic = sample(name);
      const conv = convertClassic(classic);
      expect(conv.ok).toBe(true);
      if (!conv.ok) return;
      // the bottom centre handle of the stored section leaves the stringer at an angle
      const k0 = conv.value.doc.stations[1]!.plus.chain.knots[0]!;
      expect(k0.out[1]).toBeGreaterThan(0.1);
      const b = build(classic);
      const ev = createEvaluator(b);
      const o = new Float64Array(18);
      // the section at x = 100 (the 2nd station): the classic slice rises 0.975 cm over 25 cm
      // of half-width, in a straight line; the rocker is at z = 0 there
      for (const f of [0.25, 0.5, 0.75, 1]) {
        ev.at(0, 100, f * 0.5, 0, o);
        // (the bottom half of the section is the first half of t; its arc fraction is not u)
        const u = o[1]! / 25;
        expect(o[2]!, `y = ${o[1]}`).toBeCloseTo(0.975 * u, 1);
      }
      const mesh = meshBoard(b);
      expect(topology(mesh.indices, mesh.vertexCount, weldMap(mesh)).badEdges).toBe(0);
      // the normal on the stringer has no sideways part (the keel is shaded as a ridge)
      for (let i = 0; i < mesh.vertexCount; i++) {
        const x = mesh.positions[3 * i]!;
        if (mesh.positions[3 * i + 1] === 0 && x > 5 && x < b.xiMax - 5) {
          expect(mesh.normals[3 * i + 1]).toBe(0);
        }
      }
    },
  );
});

describe('a blunt tail', () => {
  const base = GOLDENS[0]!.load();
  /** The shortboard with a squash tail: the outline starts at (0, 3) and runs out to its first knot. */
  const squash = (): BezierBoard =>
    board(
      splineFromKnots([
        knotFromArray([0, 3, 0, 3, 0.05, 4.2], false, false),
        ...base.outline.knots.slice(1),
      ]),
      base.bottom,
      base.deck,
      base.crossSections,
      base.interpolationType,
      base.fins,
    );

  it('becomes a straight tail edge closing to the stringer, with the tail at x = 0', () => {
    const conv = convertClassic(squash());
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    const k = conv.value.doc.outline.plus.knots;
    expect(conv.value.report.bluntEnds).toEqual([true, false]);
    expect(conv.value.doc.tail).toEqual({ kind: 'standard' });
    expect(k[0]!.p).toEqual([0, 0]);
    expect(k[1]!.p).toEqual([0, 3]);
    expect(k[1]!.smooth).toBe(false);
    expect(k.length).toBe(base.outline.knots.length + 1);
  });

  it('meshes closed with a planar transom 6 cm wide at x = 0', () => {
    const b = build(squash());
    const mesh = meshBoard(b);
    expect(mesh.layout.weldFirst).toBe(false);
    expect(topology(mesh.indices, mesh.vertexCount, weldMap(mesh)).badEdges).toBe(0);
    let yMax = 0;
    let xMin = Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      xMin = Math.min(xMin, mesh.positions[3 * i]!);
      if (mesh.positions[3 * i]! < 1e-6) yMax = Math.max(yMax, mesh.positions[3 * i + 1]!);
    }
    expect(xMin).toBe(0);
    expect(yMax).toBeCloseTo(3, 5);
  });

  it('closes a blunt nose the same way', () => {
    const ks = base.outline.knots;
    const n = ks.length;
    const last = ks[n - 1]!;
    const nose = splineFromKnots([
      ...ks.slice(0, n - 1),
      knotFromArray([last.end.x, 2, last.end.x, 4, last.end.x, 2], false, false),
    ]);
    const conv = convertClassic(
      board(nose, base.bottom, base.deck, base.crossSections, base.interpolationType, base.fins),
    );
    expect(conv.ok, conv.ok ? '' : conv.issues.map((i) => i.message).join('; ')).toBe(true);
    if (!conv.ok) return;
    expect(conv.value.report.bluntEnds).toEqual([false, true]);
  });
});
