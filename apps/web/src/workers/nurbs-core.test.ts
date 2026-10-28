// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's compute on the section model: a classic board in, a typed-array surface
 * out, with curvature, deviation, ladder reuse, identity-preserving conversion, the
 * refusals and the test boards.
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { moveKnotEnd } from '@openshaper/store';
import { beforeEach, describe, expect, it } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import vBottomS3dx from '../../../../packages/io/src/__fixtures__/synthetic-rocker-absolute-deck.s3dx?raw';
import pointedS3dx from '../../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import { canonical, convertAndMesh, meshTestBoard, resetCore } from './nurbs-core';
import { meshTransferables, TEST_BOARDS, type JobOptions } from './nurbs-protocol';

const classic = parseBrd(sampleBrd).board;
const NONE: JobOptions = { curvature: false, deviation: false, reuseLadders: false };

beforeEach(() => resetCore());

describe('convertAndMesh', () => {
  it('converts, builds and meshes a classic board into closed typed arrays', () => {
    const stages: string[] = [];
    const out = convertAndMesh(classic, NONE, (s) => stages.push(s));
    if (!out.ok) throw new Error(out.error);
    expect(stages).toEqual(['converting', 'building', 'meshing']);
    const { mesh, summary, timings } = out;
    const n = mesh.positions.length / 3;
    expect(n).toBeGreaterThan(2000);
    expect(mesh.normals.length).toBe(3 * n);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.curvature).toBeNull();
    expect(mesh.deviation).toBeNull();
    expect(mesh.laddersReused).toBe(false);
    expect(summary.source).toBe('classic');
    expect(summary.conversion?.stations).toBeGreaterThan(3);
    // A surfboard: tens of litres (cm³), a plan area of thousands of cm².
    expect(summary.volume).toBeGreaterThan(15_000);
    expect(summary.volume).toBeLessThan(60_000);
    expect(summary.planArea).toBeGreaterThan(5_000);
    expect(timings.convertMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThan(0);
  });

  it('adds the view’s curvature quantities with their display scales on request', () => {
    const out = convertAndMesh(classic, { ...NONE, curvature: true });
    if (!out.ok) throw new Error(out.error);
    const c = out.mesh.curvature!;
    const n = out.mesh.positions.length / 3;
    expect(c.mean.length).toBe(n);
    expect(c.gaussian.length).toBe(n);
    expect(c.minRadius.length).toBe(n);
    expect(c.scale.mean).toBeGreaterThan(0);
    expect(c.scale.radius[0]).toBeLessThan(c.scale.radius[1]);
    // The deck is convex across the board (mean curvature positive) at the middle.
    let positive = 0;
    for (let i = 0; i < n; i++) if (c.mean[i]! > 0) positive++;
    expect(positive).toBeGreaterThan(n / 2);
  });

  it('measures the deviation from the classic board when asked, with no data at the tips', () => {
    const out = convertAndMesh(classic, { ...NONE, deviation: true });
    if (!out.ok) throw new Error(out.error);
    const d = out.mesh.deviation!;
    expect(d.length).toBe(out.mesh.positions.length / 3);
    expect(out.mesh.deviationNoData).toBeGreaterThan(0);
    const [lo, hi] = out.mesh.deviationRange!;
    // Between the stations the two models differ by up to ~5 mm on goldens (divergences.md).
    expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThan(0.7);
    expect(d.some((v) => Number.isNaN(v))).toBe(true);
  });

  it('reuses the ladders while an edit is in progress, and derives them afresh when it settles', () => {
    const first = convertAndMesh(classic, NONE);
    if (!first.ok) throw new Error(first.error);
    expect(first.mesh.laddersReused).toBe(false);
    const dragging = convertAndMesh(classic, { ...NONE, reuseLadders: true });
    if (!dragging.ok) throw new Error(dragging.error);
    expect(dragging.mesh.laddersReused).toBe(true);
    // Same ladders, same board: the same mesh.
    expect(dragging.mesh.positions).toEqual(first.mesh.positions);
    const settled = convertAndMesh(classic, NONE);
    if (!settled.ok) throw new Error(settled.error);
    expect(settled.mesh.laddersReused).toBe(false);
  });

  it('does not reuse ladders that belong to another board length', () => {
    const swallow = meshTestBoard('analytic', NONE);
    expect(swallow.ok).toBe(true);
    const out = convertAndMesh(classic, { ...NONE, reuseLadders: true });
    if (!out.ok) throw new Error(out.error);
    expect(out.mesh.laddersReused).toBe(false);
  });

  it('follows an edit of the outline immediately', () => {
    const a = convertAndMesh(classic, NONE);
    const k = classic.outline.knots[3]!.end;
    const edited = {
      ...classic,
      outline: moveKnotEnd(classic.outline, 3, { x: k.x, y: k.y * 0.95 }),
    };
    const b = convertAndMesh(edited, { ...NONE, reuseLadders: true });
    if (!a.ok || !b.ok) throw new Error('did not convert');
    expect(b.mesh.positions.length).toBe(a.mesh.positions.length);
    expect(b.mesh.positions).not.toEqual(a.mesh.positions);
  });
});

describe('canonical', () => {
  it('hands back the earlier slice objects for unchanged slices (a structured clone would not)', () => {
    const first = canonical(classic);
    const clone = structuredClone(classic);
    expect(clone.crossSections[2]!.spline).not.toBe(classic.crossSections[2]!.spline);
    const again = canonical(clone);
    for (let i = 0; i < classic.crossSections.length; i++) {
      expect(again.crossSections[i]!.spline).toBe(first.crossSections[i]!.spline);
    }
    // Everything else is the clone's.
    expect(again.outline).toBe(clone.outline);
  });

  it('keeps a changed slice as it is', () => {
    const first = canonical(classic);
    const clone = structuredClone(classic);
    const cs = clone.crossSections[2]!;
    const e = cs.spline.knots[1]!.end;
    const changed = {
      ...clone,
      crossSections: clone.crossSections.map((c) =>
        c === cs ? { ...c, spline: moveKnotEnd(c.spline, 1, { x: e.x * 0.9, y: e.y }) } : c,
      ),
    };
    const out = canonical(changed);
    expect(out.crossSections[2]!.spline).toBe(changed.crossSections[2]!.spline);
    expect(out.crossSections[3]!.spline).toBe(first.crossSections[3]!.spline);
  });
});

describe('refusals', () => {
  it('converts a board with a V bottom and one with no thickness at its ends (step 4)', () => {
    for (const text of [vBottomS3dx, pointedS3dx]) {
      const out = convertAndMesh(parseS3dx(text).board, NONE);
      if (!out.ok) throw new Error(out.error);
      expect(out.mesh.positions.length / 3).toBeGreaterThan(1000);
      expect(out.summary.volume).toBeGreaterThan(0);
    }
  });

  it('refuses an outline that folds back on itself with a readable reason and no mesh', () => {
    // a handle of the outline far beyond the nose: x is no longer a function along the outline
    const from = pointedS3dx.indexOf('<Tangents_1>');
    const to = pointedS3dx.indexOf('</Tangents_1>', from);
    const folded =
      pointedS3dx.slice(0, from) +
      pointedS3dx.slice(from, to).replace('<x>91.44</x>', '<x>400</x>') +
      pointedS3dx.slice(to);
    const out = convertAndMesh(parseS3dx(folded).board, NONE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/keep x a function/);
    expect(out.issues.some((i) => i.severity === 'error' && i.code === 'convert-plan')).toBe(true);
  });

  it('never throws on a malformed board', () => {
    const out = convertAndMesh({} as typeof classic, NONE);
    expect(out.ok).toBe(false);
  });
});

describe('meshTestBoard', () => {
  it.each(TEST_BOARDS)('meshes the %s test board with curvature and no deviation', (name) => {
    const out = meshTestBoard(name, { ...NONE, curvature: true, deviation: true });
    if (!out.ok) throw new Error(out.error);
    expect(out.summary.source).toBe('test');
    expect(out.summary.conversion).toBeNull();
    expect(out.mesh.positions.length / 3).toBeGreaterThan(1000);
    expect(out.mesh.curvature).not.toBeNull();
    expect(out.mesh.deviation).toBeNull();
    expect(out.summary.volume).toBeGreaterThan(0);
  });
});

describe('meshTransferables', () => {
  it('lists every buffer once, curvature and deviation included when present', () => {
    const out = convertAndMesh(classic, { curvature: true, deviation: true, reuseLadders: false });
    if (!out.ok) throw new Error(out.error);
    const list = meshTransferables(out.mesh);
    expect(list).toHaveLength(7);
    expect(new Set(list).size).toBe(7);
    const bare = convertAndMesh(classic, NONE);
    if (!bare.ok) throw new Error(bare.error);
    expect(meshTransferables(bare.mesh)).toHaveLength(3);
  });
});
