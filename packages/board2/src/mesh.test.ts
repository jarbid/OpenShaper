// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The grid mesh (docs/design/m1-model.md §3) on the analytic board and the swallow, fish
 * and asymmetric test boards: topology, orientation and normals, plan area and volume,
 * the ladders, curvature arrays, and the options. The acceptance checks on the golden
 * boards are in `mesh.accept.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { deriveLadders, meshBoard, meshProperties, meshVertex } from './mesh';
import { buildBoard, createEvaluator, MEASURE } from './surface';
import type { BuiltBoard } from './surface';
import { topology } from './test-support/mesh-checks';
import { analyticBoard, asymmetricBoard, chainPoint, fishBoard, swallowBoard } from './testing';
import type { BoardDoc } from './types';

const BOARDS: readonly [string, () => BoardDoc][] = [
  ['analytic', analyticBoard],
  ['swallow', swallowBoard],
  ['fish', fishBoard],
  ['asymmetric', asymmetricBoard],
];

function built(doc: BoardDoc): BuiltBoard {
  const r = buildBoard(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

/** Plan area of the closed outline polygon (plus half out, minus half back), by the shoelace formula. */
function outlineArea(doc: BoardDoc): number {
  const pts: [number, number][] = [];
  const sample = (chain: BoardDoc['outline']['plus'], sign: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 0; k < chain.knots.length - 1; k++) {
      for (let i = 0; i < 2000; i++) {
        const q = chainPoint(chain, k, i / 2000);
        out.push([q[0], sign * q[1]]);
      }
    }
    const last = chain.knots[chain.knots.length - 1]!.p;
    out.push([last[0], sign * last[1]]);
    return out;
  };
  pts.push(...sample(doc.outline.plus, 1));
  pts.push(...sample(doc.outline.minus ?? doc.outline.plus, -1).reverse());
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

describe.each(BOARDS)('%s board: the mesh', (_name, make) => {
  const doc = make();
  const board = built(doc);
  const mesh = meshBoard(board);

  it('is closed and consistently oriented: every edge is used once each way, no vertex is unused', () => {
    const t = topology(mesh.indices, mesh.vertexCount);
    expect(t.badEdges).toBe(0);
    expect(t.unused).toBe(0);
    // a closed surface of genus 0
    expect(t.vertices - t.edges + t.triangles).toBe(2);
    expect(mesh.triangleCount).toBe(t.triangles);
  });

  it('has positive volume (outward winding) and a plan area equal to the outline polygon', () => {
    expect(mesh.volume).toBeGreaterThan(0);
    const area = outlineArea(doc);
    expect(Math.abs(mesh.planArea - area) / area).toBeLessThan(0.005);
    expect(mesh.surfaceArea).toBeGreaterThan(2 * mesh.planArea * 0.9);
    const again = meshProperties(mesh.positions, mesh.indices);
    expect(again.volume).toBe(mesh.volume);
  });

  it('has unit normals that agree with the triangles winding', () => {
    const P = mesh.positions;
    const N = mesh.normals;
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(Math.hypot(N[3 * v]!, N[3 * v + 1]!, N[3 * v + 2]!)).toBeCloseTo(1, 5);
    }
    let disagree = 0;
    let counted = 0;
    const lo = board.xiMin;
    const hi = board.xiMax;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const a = 3 * mesh.indices[k]!;
      const b = 3 * mesh.indices[k + 1]!;
      const c = 3 * mesh.indices[k + 2]!;
      const ux = P[b]! - P[a]!;
      const uy = P[b + 1]! - P[a + 1]!;
      const uz = P[b + 2]! - P[a + 2]!;
      const wx = P[c]! - P[a]!;
      const wy = P[c + 1]! - P[a + 1]!;
      const wz = P[c + 2]! - P[a + 2]!;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      if (Math.hypot(nx, ny, nz) < 1e-9) continue;
      // the fans at a pointed end span the whole first interval: normals there are limits, not face averages
      const xs = [P[a]!, P[b]!, P[c]!];
      if (xs.some((x) => x < lo + 0.03 * (hi - lo) || x > hi - 0.03 * (hi - lo))) continue;
      const dot =
        nx * (N[a]! + N[b]! + N[c]!) +
        ny * (N[a + 1]! + N[b + 1]! + N[c + 1]!) +
        nz * (N[a + 2]! + N[b + 2]! + N[c + 2]!);
      counted++;
      if (dot <= 0) disagree++;
    }
    expect(counted).toBeGreaterThan(mesh.triangleCount * 0.5);
    expect(disagree).toBe(0);
  });

  it('puts the vertices on the surface, shares the stringer vertices and mirrors a symmetric board', () => {
    const ev = createEvaluator(board);
    const o = new Float64Array(18);
    const { rows, cols } = mesh.layout;
    const { xi, t } = mesh.ladders;
    const P = mesh.positions;
    for (const side of [0, 1] as const) {
      // (a welded end row of an asymmetric board takes the plus side's positions)
      for (let i = 0; i < rows; i += 7) {
        if (
          side === 1 &&
          ((mesh.layout.weldFirst && i === 0) || (mesh.layout.weldLast && i === rows - 1))
        ) {
          continue;
        }
        for (let j = 0; j < cols; j += 3) {
          const v = meshVertex(mesh.layout, side, i, j);
          ev.at(side, xi[i]!, t[j]!, 0, o);
          expect(
            Math.hypot(P[3 * v]! - o[0]!, P[3 * v + 1]! - o[1]!, P[3 * v + 2]! - o[2]!),
          ).toBeLessThan(2e-4);
        }
      }
    }
    for (let i = 0; i < rows; i++) {
      for (const j of [0, cols - 1]) {
        expect(meshVertex(mesh.layout, 1, i, j)).toBe(meshVertex(mesh.layout, 0, i, j));
      }
    }
    expect(mesh.layout.weldFirst || doc.tail.kind === 'standard').toBe(true);
    // a mirror board: the two sides are mirror images
    if (doc.symmetry === 'mirror') {
      for (let i = 0; i < rows; i += 5) {
        for (let j = 1; j < cols - 1; j += 4) {
          const a = meshVertex(mesh.layout, 0, i, j);
          const b = meshVertex(mesh.layout, 1, i, j);
          if (a === b) continue;
          expect(P[3 * b + 1]).toBeCloseTo(-P[3 * a + 1]!, 6);
          expect(P[3 * b]).toBe(P[3 * a]);
          expect(P[3 * b + 2]).toBe(P[3 * a + 2]);
        }
      }
    }
  });

  it('has ladders that start and end at the board, contain the apex and are strictly increasing', () => {
    const { xi, t } = mesh.ladders;
    expect(xi[0]).toBe(board.xiMin);
    expect(xi[xi.length - 1]).toBe(board.xiMax);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBe(1);
    expect(Array.from(t)).toContain(0.5);
    for (let i = 1; i < xi.length; i++) expect(xi[i]!).toBeGreaterThan(xi[i - 1]!);
    for (let j = 1; j < t.length; j++) expect(t[j]!).toBeGreaterThan(t[j - 1]!);
    for (const s of doc.stations) expect(Array.from(xi)).toContain(s.x);
  });

  it('reuses given ladders exactly, and a finer tolerance gives more vertices than a coarser one', () => {
    const again = meshBoard(board, { ladders: mesh.ladders });
    expect(again.vertexCount).toBe(mesh.vertexCount);
    expect(Array.from(again.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(again.indices)).toEqual(Array.from(mesh.indices));
    const coarse = meshBoard(board, { tolerance: 0.2 });
    expect(coarse.vertexCount).toBeLessThan(mesh.vertexCount);
    expect(topology(coarse.indices, coarse.vertexCount).badEdges).toBe(0);
  });
});

describe('the options', () => {
  const board = built(swallowBoard());

  it('maxEdge caps the edge length (the tolerance still holds)', () => {
    const free = meshBoard(board);
    const capped = meshBoard(board, { maxEdge: 6 });
    expect(capped.vertexCount).toBeGreaterThan(free.vertexCount);
    let longest = 0;
    const P = capped.positions;
    for (let k = 0; k < capped.indices.length; k += 3) {
      for (let e = 0; e < 3; e++) {
        const a = 3 * capped.indices[k + e]!;
        const b = 3 * capped.indices[k + ((e + 1) % 3)]!;
        longest = Math.max(
          longest,
          Math.hypot(P[a]! - P[b]!, P[a + 1]! - P[b + 1]!, P[a + 2]! - P[b + 2]!),
        );
      }
    }
    // the rows and columns are tested on a subset of probes, so allow some slack on the diagonals
    expect(longest).toBeLessThan(6 * 1.6);
    expect(topology(capped.indices, capped.vertexCount).badEdges).toBe(0);
  });

  it('curvature arrays: finite, k1 >= k2, equal to the evaluator and convex at the rail', () => {
    const mesh = meshBoard(board, { curvature: true });
    expect(mesh.k1).toBeDefined();
    const k1 = mesh.k1!;
    const k2 = mesh.k2!;
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(Number.isFinite(k1[v])).toBe(true);
      expect(Number.isFinite(k2[v])).toBe(true);
      expect(k1[v]!).toBeGreaterThanOrEqual(k2[v]! - 1e-6);
    }
    const ev = createEvaluator(board);
    const m = new Float64Array(MEASURE.size);
    const { rows, cols } = mesh.layout;
    const i = Math.floor(rows / 2);
    for (let j = 1; j < cols - 1; j += 5) {
      ev.row(0, mesh.ladders.xi[i]!, 2);
      ev.measure(mesh.ladders.t[j]!, m);
      const v = meshVertex(mesh.layout, 0, i, j);
      expect(k1[v]).toBeCloseTo(m[MEASURE.k1]!, 3);
      expect(k2[v]).toBeCloseTo(m[MEASURE.k2]!, 3);
    }
    // the mesh without curvature has none, and the same geometry
    const plain = meshBoard(board, { ladders: mesh.ladders });
    expect(plain.k1).toBeUndefined();
    expect(Array.from(plain.positions)).toEqual(Array.from(mesh.positions));
    // the apex line, mid board, is convex across (positive k1)
    const rail = meshVertex(mesh.layout, 0, i, mesh.ladders.t.indexOf(0.5));
    expect(k1[rail]!).toBeGreaterThan(0);
  });

  it('deriveLadders is the first half of meshBoard', () => {
    const l = deriveLadders(board);
    const mesh = meshBoard(board);
    expect(Array.from(l.xi)).toEqual(Array.from(mesh.ladders.xi));
    expect(Array.from(l.t)).toEqual(Array.from(mesh.ladders.t));
  });
});

describe('the analytic board', () => {
  it('has the exact plan area and a closed, blunt-free hull', () => {
    const board = built(analyticBoard());
    const mesh = meshBoard(board);
    // half-width 80 t (1 - t), t = x / 100: the plan area is 2 * 80 * 100 / 6
    expect(Math.abs(mesh.planArea - 2666.667) / 2666.667).toBeLessThan(0.002);
    expect(mesh.layout.weldFirst).toBe(true);
    expect(mesh.layout.weldLast).toBe(true);
  });
});

describe('a blunt end', () => {
  it('is closed by a planar cap', () => {
    const doc = analyticBoard();
    // end the plan with a vertical segment of half-width 1 at the nose, as the classic does
    const k = doc.outline.plus.knots;
    const blunt: BoardDoc = {
      ...doc,
      outline: {
        plus: {
          knots: [
            k[0]!,
            { ...k[1]!, p: [100, 1], in: [k[1]!.in[0], 1], out: [100, 1] },
            { p: [100, 0], in: [100, 0.3], out: [100, 0], smooth: false },
          ],
        },
      },
    };
    const board = built(blunt);
    const mesh = meshBoard(board);
    expect(mesh.layout.weldFirst).toBe(true);
    expect(mesh.layout.weldLast).toBe(false);
    expect(topology(mesh.indices, mesh.vertexCount).badEdges).toBe(0);
    expect(mesh.volume).toBeGreaterThan(0);
  });
});
