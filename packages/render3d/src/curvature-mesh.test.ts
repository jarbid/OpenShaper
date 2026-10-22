// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The exact-curvature tessellation: where its vertices go, what they carry, and
 * which way everything faces. The curvature maths itself is pinned in the kernel
 * (`bspline-surface.curvature.test.ts`); this checks the mesh is built from it
 * faithfully.
 */
import {
  HULL_ORIENTATION,
  evalSurfaceDeriv2,
  fitBoardSurface,
  hasTailCutout,
  knotMultiplicities,
  principalCurvatures,
  type BoardSurfaceModel,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  MAX_RADIUS,
  boardCurvatureMesh,
  curvatureMesh,
  curvatureTransferables,
  curvatureUnsupported,
  gridParams,
  weightedQuantiles,
  type CurvatureMesh,
} from './curvature-mesh';
import { stationBoard, swallowBoard } from './test-support/boards';

const vec = (a: Float32Array, i: number) => ({ x: a[3 * i]!, y: a[3 * i + 1]!, z: a[3 * i + 2]! });

describe('gridParams', () => {
  // Cubic: simple knot at 0.3, a C1 double knot at 0.5, a C0 crease at 0.8.
  const knots = [0, 0, 0, 0, 0.3, 0.5, 0.5, 0.8, 0.8, 0.8, 1, 1, 1, 1];

  it('samples every distinct knot, both sides of every knot that is not C2', () => {
    const ps = gridParams(knots, 3, () => 1);
    expect(ps).toEqual([
      { t: 0, side: 'above' },
      { t: 0.3, side: 'above' },
      { t: 0.5, side: 'below' },
      { t: 0.5, side: 'above' },
      { t: 0.8, side: 'below' },
      { t: 0.8, side: 'above' },
      { t: 1, side: 'below' },
    ]);
  });

  it('subdivides each span as asked, starting after its knot', () => {
    const ps = gridParams([0, 0, 0, 0, 0.4, 1, 1, 1, 1], 3, (a, b) => (b - a > 0.5 ? 3 : 2));
    expect(ps.map((p) => +p.t.toFixed(6))).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe('weightedQuantiles', () => {
  const exact = (vs: number[], ws: number[], q: number) => {
    const idx = vs.map((_, i) => i).sort((a, b) => vs[a]! - vs[b]!);
    const total = ws.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const i of idx) {
      acc += ws[i]!;
      if (acc >= q * total) return vs[i]!;
    }
    return vs[idx[idx.length - 1]!]!;
  };

  it('matches a sorted weighted quantile to the histogram resolution', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Eight orders of magnitude, like the curvature of a board.
    const vs = Array.from({ length: 5000 }, () => 10 ** (8 * rnd() - 6));
    const ws = vs.map(() => rnd());
    for (const q of [0.02, 0.5, 0.8, 0.95]) {
      const [got] = weightedQuantiles(vs, ws, [q]);
      const want = exact(vs, ws, q);
      expect(Math.abs(Math.log(got! / want))).toBeLessThan(Math.log(2) / 32);
    }
  });

  it('weighs by area, skips weightless entries, and ignores a lone extreme', () => {
    // Nine small patches at 1 and one huge one at 100: by area, 100 dominates.
    expect(
      weightedQuantiles([...Array(9).fill(1), 100], [...Array(9).fill(1), 100], [0.5])[0],
    ).toBeCloseTo(100, -1);
    // A spike with no area does not move the scale at all.
    const [q] = weightedQuantiles([1, 1, 1, 1e9], [1, 1, 1, 0], [0.99]);
    expect(q).toBeCloseTo(1, 1);
  });
});

describe('curvatureMesh on a fitted board', () => {
  const model: BoardSurfaceModel = fitBoardSurface(stationBoard(), {
    lengthRows: 30,
    ringCols: 24,
  });
  const m: CurvatureMesh = curvatureMesh(model);
  const verts = m.positions.length / 3;
  const half = m.rows * m.cols;
  const s = model.plus;

  it('carries one of every attribute per vertex and indexes only real vertices', () => {
    expect(verts).toBe(2 * half + 2 * (2 * m.cols + 1));
    for (const a of [m.mean, m.gaussian, m.minRadius]) expect(a.length).toBe(verts);
    expect(m.normals.length).toBe(m.positions.length);
    expect(m.indices.length % 3).toBe(0);
    expect(m.hullIndexCount % 3).toBe(0);
    expect(m.hullIndexCount).toBeLessThan(m.indices.length);
    expect(Math.max(...m.indices)).toBeLessThan(verts);
    for (let i = 0; i < verts; i++) {
      const n = vec(m.normals, i);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
      expect(Number.isFinite(m.mean[i]!) && Number.isFinite(m.gaussian[i]!)).toBe(true);
      expect(m.minRadius[i]!).toBeGreaterThan(0);
      expect(m.minRadius[i]!).toBeLessThanOrEqual(MAX_RADIUS);
    }
  });

  it('puts a row on every distinct u-knot, and two on every station crease', () => {
    const { values, mults } = knotMultiplicities(s.uKnots);
    const rowX = Array.from({ length: m.rows }, (_, r) => m.positions[3 * r * m.cols]!);
    for (let i = 0; i < values.length; i++) {
      const x = evalSurfaceDeriv2(s, values[i]!, 0).point.x;
      const hits = rowX.filter((rx) => Math.abs(rx - x) < 1e-4).length;
      const crease = i > 0 && i < values.length - 1 && mults[i]! >= 3;
      expect(hits, `knot ${values[i]} at x=${x}`).toBe(crease ? 2 : 1);
    }
    // The fit has a crease at each of the three real stations.
    expect(m.creases).toBe(3);
    expect(model.breaks).toHaveLength(3);
  });

  it('draws no triangle across a crease, so the colour jumps exactly on the station', () => {
    const creaseRows: number[] = [];
    for (let r = 0; r + 1 < m.rows; r++) {
      if (m.positions[3 * r * m.cols] === m.positions[3 * (r + 1) * m.cols]) creaseRows.push(r);
    }
    expect(creaseRows).toHaveLength(3);
    const rowOf = (vi: number) => Math.floor((vi % half) / m.cols);
    for (let t = 0; t < m.hullIndexCount; t += 3) {
      const rows = [0, 1, 2].map((k) => rowOf(m.indices[t + k]!));
      for (const r of creaseRows) expect(rows.includes(r) && rows.includes(r + 1)).toBe(false);
    }
    // And the two sides of a crease really do differ: these are the bands.
    for (const r of creaseRows) {
      let differ = 0;
      for (let c = 0; c < m.cols; c++) {
        const a = m.mean[r * m.cols + c]!;
        const b = m.mean[(r + 1) * m.cols + c]!;
        if (Math.abs(a - b) > 1e-4 * Math.max(1e-3, Math.abs(a))) differ++;
      }
      expect(differ).toBeGreaterThan(m.cols / 2);
    }
  });

  it('stores the kernel’s curvature for each vertex, against outward normals', () => {
    const { values } = knotMultiplicities(s.uKnots);
    // Spot-check vertices on simple-knot rows (one sample each, side irrelevant).
    const u = values[Math.floor(values.length / 2)]!;
    const x = evalSurfaceDeriv2(s, u, 0).point.x;
    let r = 0;
    while (Math.abs(m.positions[3 * r * m.cols]! - x) > 1e-4) r++;
    const vs = gridParams(s.vKnots, s.vDegree, () => 2);
    for (const c of [0, 5, Math.floor(m.cols / 2), m.cols - 1]) {
      const k = principalCurvatures(s, u, vs[c]!.t, { orientation: HULL_ORIENTATION.plus })!;
      const vi = r * m.cols + c;
      expect(m.mean[vi]).toBeCloseTo(k.mean, 6);
      expect(m.gaussian[vi]).toBeCloseTo(k.gaussian, 8);
      const kmax = Math.max(Math.abs(k.k1), Math.abs(k.k2));
      expect(m.minRadius[vi]! / Math.min(MAX_RADIUS, 1 / kmax)).toBeCloseTo(1, 5);
    }
  });

  it('mirrors into exactly what evaluating the -Y patch gives, normals outward on both', () => {
    const us = gridParams(s.uKnots, s.uDegree, () => 1);
    const vs = gridParams(s.vKnots, s.vDegree, () => 2);
    expect(us.length).toBeLessThanOrEqual(m.rows);
    for (let r = 1; r < m.rows - 1; r += 7) {
      for (let c = 0; c < m.cols; c += 5) {
        const vi = half + r * m.cols + c;
        // Recover (u, v) for this row from x: rows are station planes.
        const x = m.positions[3 * vi]!;
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (evalSurfaceDeriv2(model.minus, mid, 0).point.x < x) lo = mid;
          else hi = mid;
        }
        const k = principalCurvatures(model.minus, (lo + hi) / 2, vs[c]!.t, {
          orientation: HULL_ORIENTATION.minus,
        });
        if (!k) continue;
        expect(m.mean[vi]).toBeCloseTo(k.mean, 4);
        expect(m.gaussian[vi]).toBeCloseTo(k.gaussian, 6);
        const n = vec(m.normals, vi);
        expect(n.x * k.normal.x + n.y * k.normal.y + n.z * k.normal.z).toBeGreaterThan(0.999);
      }
    }
    // Outward: away from the stringer at the rail, down under the bottom, up on the deck.
    const mid = Math.floor(m.rows / 2) * m.cols;
    const railCol = vs.reduce(
      (best, _, c) =>
        m.positions[3 * (mid + c) + 1]! > m.positions[3 * (mid + best) + 1]! ? c : best,
      0,
    );
    expect(vec(m.normals, mid + railCol).y).toBeGreaterThan(0.9);
    expect(vec(m.normals, half + mid + railCol).y).toBeLessThan(-0.9);
    expect(vec(m.normals, mid).z).toBeLessThan(-0.9);
    expect(vec(m.normals, mid + m.cols - 1).z).toBeGreaterThan(0.9);
  });

  it('winds every hull and cap triangle to face the way its normals point', () => {
    let checked = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vec(m.positions, m.indices[t + k]!));
      const ux = b!.x - a!.x;
      const uy = b!.y - a!.y;
      const uz = b!.z - a!.z;
      const wx = c!.x - a!.x;
      const wy = c!.y - a!.y;
      const wz = c!.z - a!.z;
      const g = { x: uy * wz - uz * wy, y: uz * wx - ux * wz, z: ux * wy - uy * wx };
      const len = Math.hypot(g.x, g.y, g.z);
      if (len < 1e-9) continue; // a seam sliver
      const n = vec(m.normals, m.indices[t]!);
      expect((g.x * n.x + g.y * n.y + g.z * n.z) / len).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(m.indices.length / 3 - 4 * m.cols);
  });

  it('closes each end with a cap facing along the board', () => {
    const capStart = 2 * half;
    for (let i = capStart; i < verts; i++) {
      const n = vec(m.normals, i);
      expect(Math.abs(n.x)).toBe(1);
    }
    // Tail cap faces -x, nose cap +x.
    expect(vec(m.normals, capStart).x).toBe(model.end0.dir);
    expect(vec(m.normals, verts - 1).x).toBe(model.end1.dir);
  });

  it('scales robustly: positive limits and an open radius range', () => {
    expect(m.scale.mean).toBeGreaterThan(0);
    expect(m.scale.gaussian).toBeGreaterThan(0);
    const [tight, flat] = m.scale.radius;
    expect(tight).toBeGreaterThan(0);
    expect(flat).toBeGreaterThan(tight);
    // Robust, not the extreme: the scale sits well inside the data's own range.
    const absMean = Array.from(m.mean.subarray(0, 2 * half), Math.abs);
    expect(m.scale.mean).toBeLessThan(Math.max(...absMean));
  });
});

describe('boardCurvatureMesh', () => {
  it('fits and tessellates a board in one call', () => {
    const m = boardCurvatureMesh(stationBoard());
    expect(m.indices.length).toBeGreaterThan(0);
    expect(m.creases).toBe(3);
  });

  it('refuses a concave tail, which the fit does not model', () => {
    const b = swallowBoard();
    expect(hasTailCutout(b.outline)).toBe(true);
    expect(curvatureUnsupported(b)).toBe('concave-tail');
    expect(curvatureUnsupported(stationBoard())).toBeNull();
    expect(() => boardCurvatureMesh(b)).toThrow(/concave/);
  });

  it('hands every array over for transfer, each on its own buffer', () => {
    const m = curvatureMesh(
      fitBoardSurface(stationBoard(), { lengthRows: 24, ringCols: 16, tolerance: 0 }),
    );
    const buffers = curvatureTransferables(m);
    expect(buffers).toHaveLength(6);
    expect(new Set(buffers).size).toBe(6);
  });
});
