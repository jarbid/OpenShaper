// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's compute on a small analytic board (the board2 stadium: a crowned slab
 * with round rails), with the heavy conversion out of the picture: tessellation,
 * exact curvature, the deviation hook, re-meshing from a stored document, and the
 * refusal of a board the converter does not take.
 */
import { boardDocToJson, buildBoard, type BuiltBoard } from '@openshaper/board2';
import { stadiumBoard } from '@openshaper/board2/testing';
import { parseBrd } from '@openshaper/io';
import { knotFromArray, splineFromKnots } from '@openshaper/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import {
  convertAndMesh,
  HELD_MODELS,
  meshBuiltBoard,
  releaseHeldModels,
  remesh,
  tessellationFor,
} from './nurbs-core';

const doc = stadiumBoard();
let built: BuiltBoard;
beforeAll(() => {
  const r = buildBoard(doc);
  if (!r.ok) throw new Error('stadium did not build');
  built = r.value;
}, 60_000);

describe('tessellationFor', () => {
  it('is finer for a finer viewport quality and coarser for a draft', () => {
    const draft = tessellationFor(1.5);
    const standard = tessellationFor(0.9);
    const fine = tessellationFor(0.5);
    expect(fine.chordTol).toBeLessThan(standard.chordTol);
    expect(standard.chordTol).toBeLessThan(draft.chordTol);
    expect(fine.angleTol!).toBeLessThan(standard.angleTol!);
    expect(fine.maxEdge!).toBeLessThan(standard.maxEdge!);
    // Standard: a 0.45 mm chord error, edges up to 5.4 cm.
    expect(standard.chordTol).toBeCloseTo(0.045, 9);
    expect(standard.maxEdge).toBeCloseTo(5.4, 9);
  });

  it('stays within sane bounds at the extremes', () => {
    for (const f of [0.01, 0.2, 5, 100]) {
      const t = tessellationFor(f);
      expect(t.chordTol).toBeGreaterThanOrEqual(0.01);
      expect(t.chordTol).toBeLessThanOrEqual(0.1);
      expect(t.angleTol!).toBeGreaterThanOrEqual(0.2);
      expect(t.angleTol!).toBeLessThanOrEqual(0.55);
    }
  });
});

describe('meshBuiltBoard', () => {
  it('tessellates the whole board with exact normals and curvature at every vertex', () => {
    const { mesh } = meshBuiltBoard(built, null, 1.5);
    const n = mesh.positions.length / 3;
    expect(n).toBeGreaterThan(500);
    expect(mesh.normals.length).toBe(3 * n);
    expect(mesh.mean.length).toBe(n);
    expect(mesh.gaussian.length).toBe(n);
    expect(mesh.minRadius.length).toBe(n);
    expect(mesh.indices.length % 3).toBe(0);
    for (const i of mesh.indices) expect(i).toBeLessThan(n);
    expect(mesh.deviation).toBeNull();
    expect(mesh.deviationRange).toBeNull();
    // Unit normals everywhere (none left undefined).
    for (let i = 0; i < n; i++) {
      expect(
        Math.hypot(mesh.normals[3 * i]!, mesh.normals[3 * i + 1]!, mesh.normals[3 * i + 2]!),
      ).toBeGreaterThan(0.999);
    }
    expect(mesh.scale.mean).toBeGreaterThan(0);
    expect(mesh.scale.radius[0]).toBeLessThan(mesh.scale.radius[1]);
  });

  it('encloses the board’s volume with outward triangles (normals agree with winding)', () => {
    const { mesh } = meshBuiltBoard(built, null, 1.5);
    let volume = 0;
    let agree = 0;
    let total = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!;
      const b = mesh.indices[t + 1]!;
      const c = mesh.indices[t + 2]!;
      const p = (i: number) => [
        mesh.positions[3 * i]!,
        mesh.positions[3 * i + 1]!,
        mesh.positions[3 * i + 2]!,
      ];
      const [pa, pb, pc] = [p(a), p(b), p(c)] as [number[], number[], number[]];
      const cross = [
        pa[1]! * pb[2]! - pa[2]! * pb[1]!,
        pa[2]! * pb[0]! - pa[0]! * pb[2]!,
        pa[0]! * pb[1]! - pa[1]! * pb[0]!,
      ];
      volume += (cross[0]! * pc[0]! + cross[1]! * pc[1]! + cross[2]! * pc[2]!) / 6;
      // Winding normal vs the vertex normal.
      const e1 = pb.map((v, k) => v - pa[k]!);
      const e2 = pc.map((v, k) => v - pa[k]!);
      const wn = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const vn = [0, 1, 2].map((k) => mesh.normals[3 * a + k]!);
      if (wn[0]! * vn[0]! + wn[1]! * vn[1]! + wn[2]! * vn[2]! > 0) agree++;
      total++;
    }
    expect(volume).toBeGreaterThan(0);
    expect(agree / total).toBeGreaterThan(0.99);
  });

  it('reads the rails convex (positive mean curvature) and the broad deck nearly flat', () => {
    const { mesh } = meshBuiltBoard(built, null, 1.5);
    const n = mesh.positions.length / 3;
    let railMax = 0;
    let broad = 0;
    let broadCount = 0;
    for (let i = 0; i < n; i++) {
      const nz = Math.abs(mesh.normals[3 * i + 2]!);
      if (nz < 0.3) railMax = Math.max(railMax, mesh.mean[i]!);
      if (nz > 0.99) {
        broad += Math.abs(mesh.mean[i]!);
        broadCount++;
      }
    }
    expect(railMax).toBeGreaterThan(0.05); // a rail a few cm in radius: ~1/(2r)
    expect(broadCount).toBeGreaterThan(50);
    expect(broad / broadCount).toBeLessThan(railMax / 5);
  });

  it('no mean curvature is concave on a convex stadium except numerically', () => {
    const { mesh } = meshBuiltBoard(built, null, 1.5);
    let worst = 0;
    for (const m of mesh.mean) worst = Math.min(worst, m);
    expect(worst).toBeGreaterThan(-0.01);
  });

  it('measures against the classic board when given one', () => {
    const { board } = parseBrd(sampleBrd);
    // The stadium is not the sample board, but the plumbing must deliver a deviation
    // array of the mesh's size and a range that matches it.
    const { mesh } = meshBuiltBoard(built, board, 1.5);
    expect(mesh.deviation).not.toBeNull();
    expect(mesh.deviation!.length).toBe(mesh.positions.length / 3);
    const finite = [...mesh.deviation!].filter(Number.isFinite);
    expect(mesh.deviationNoData).toBe(mesh.deviation!.length - finite.length);
    if (finite.length) {
      expect(mesh.deviationRange![0]).toBeCloseTo(Math.min(...finite), 5);
      expect(mesh.deviationRange![1]).toBeCloseTo(Math.max(...finite), 5);
    }
  });
});

describe('remesh', () => {
  const docJson = boardDocToJson(doc);
  const { board } = parseBrd(sampleBrd);

  it('rebuilds from the stored document when the worker holds no model, then keeps it', () => {
    releaseHeldModels();
    const stages: string[] = [];
    const a = remesh(1, docJson, board, 1.5, (s) => stages.push(s));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(stages).toEqual(['building', 'meshing', 'deviation']);
    expect(a.timings.buildMs).toBeGreaterThan(0);
    expect(a.timings.convertMs).toBe(0);
    expect(a.docJson).toBe(docJson);

    stages.length = 0;
    const b = remesh(1, docJson, board, 3, (s) => stages.push(s));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(stages).toEqual(['meshing', 'deviation']); // held: no rebuild
    expect(b.timings.buildMs).toBe(0);
    // A coarser face size gives fewer vertices.
    expect(b.mesh.positions.length).toBeLessThan(a.mesh.positions.length);
  });

  it('holds only a few models', () => {
    releaseHeldModels();
    for (let id = 1; id <= HELD_MODELS + 1; id++) remesh(id, docJson, board, 3);
    const stages: string[] = [];
    remesh(1, docJson, board, 3, (s) => stages.push(s)); // evicted: rebuilt
    expect(stages[0]).toBe('building');
    stages.length = 0;
    remesh(HELD_MODELS + 1, docJson, board, 3, (s) => stages.push(s)); // the newest: still held
    expect(stages[0]).toBe('meshing');
  });

  it('refuses a document that is not a board2 document', () => {
    const r = remesh(99, '{"format":"nope"}', board, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid/);
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('convertAndMesh', () => {
  it('refuses a swallow tail with the converter’s reason, as an outcome and not a throw', () => {
    const { board } = parseBrd(sampleBrd);
    const third = (x0: number, y0: number, x1: number, y1: number): number[] => [
      x0 + (x1 - x0) / 3,
      y0 + (y1 - y0) / 3,
    ];
    const swallow = splineFromKnots([
      knotFromArray([15, 0, 15, 0, ...third(15, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 15, 0), ...third(0, 9, 100, 25)], false, false),
      knotFromArray([100, 25, ...third(100, 25, 0, 9), ...third(100, 25, 200, 0)], false, false),
      knotFromArray([200, 0, ...third(200, 0, 100, 25), 200, 0], false, false),
    ]);
    const stages: string[] = [];
    const r = convertAndMesh(1, { ...board, outline: swallow }, 0.9, (s) => stages.push(s));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toContain('unsupported-tail');
      expect(r.error.length).toBeGreaterThan(0);
    }
    expect(stages).toEqual(['converting']);
  });

  it('turns an exception into a failed outcome', () => {
    const r = convertAndMesh(1, null as never, 0.9);
    expect(r.ok).toBe(false);
  });
});
