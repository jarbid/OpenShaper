// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Constrained Delaunay triangulation (design §12, §16 "cdt").
 *
 * Oracles, all exact (no tolerance: every check is an exact predicate or an
 * integer count) except the area sum:
 * - invariants (`checkTriangulation`): every triangle strictly counter-
 *   clockwise, symmetric half-edges, every unconstrained interior edge locally
 *   Delaunay (exact incircle), every segment present as a constrained chain;
 * - Euler's formula `T = 2V − B − 2 + 2H` (B boundary vertices, H holes);
 * - area: the triangles' areas sum to the shoelace area of the region,
 *   relative 1e-12 (double summation of ~10³ terms of mixed sign);
 * - differential: `delaunator` (unconstrained, general position: the Delaunay
 *   triangulation is unique, so the triangle sets are equal) and
 *   `@kninnug/constrainautor` (constrained, general position: the CDT is
 *   unique, so the edge sets are equal), on 10⁴ seeded cases in total;
 * - adversarial inputs: points exactly on segments, collinear chains, 1-ulp
 *   near-duplicates, cocircular grids, slivers, crossing segments.
 */
import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../testing';
import {
  buildCdt,
  checkTriangulation,
  classifyRegions,
  constrainedDelaunay,
  exportTriangulation,
  insertSteiner,
} from './cdt';
import type { Triangulation } from './cdt';
import { orient2d } from './predicates';

/**
 * Triangles as sorted vertex triples (delaunator orders its triangles
 * clockwise in a y-up frame, geom counter-clockwise: compare as sets).
 */
function triangleSet(tris: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    out.push([tris[i]!, tris[i + 1]!, tris[i + 2]!].sort((a, b) => a - b).join(','));
  }
  return out.sort();
}

/** Undirected edge set of a triangle list. */
function edgeSet(tris: ArrayLike<number>): string[] {
  const s = new Set<string>();
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[i + k]!;
      const b = tris[i + ((k + 1) % 3)]!;
      s.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
  }
  return [...s].sort();
}

/** Boundary vertices (ends of half-edges without twin). */
function boundaryVertices(t: Triangulation): number {
  const s = new Set<number>();
  for (let e = 0; e < t.halfedges.length; e++) if (t.halfedges[e]! < 0) s.add(t.triangles[e]!);
  return s.size;
}

function usedVertices(t: Triangulation): number {
  return new Set(t.triangles).size;
}

function triangleArea(t: Triangulation): number {
  let a = 0;
  const P = t.points;
  for (let i = 0; i < t.triangles.length; i += 3) {
    const p = t.triangles[i]!;
    const q = t.triangles[i + 1]!;
    const r = t.triangles[i + 2]!;
    a +=
      0.5 *
      ((P[2 * q]! - P[2 * p]!) * (P[2 * r + 1]! - P[2 * p + 1]!) -
        (P[2 * q + 1]! - P[2 * p + 1]!) * (P[2 * r]! - P[2 * p]!));
  }
  return a;
}

function shoelace(pts: readonly number[], loop: readonly number[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    a += pts[2 * p]! * pts[2 * q + 1]! - pts[2 * q]! * pts[2 * p + 1]!;
  }
  return a / 2;
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

function randomPoints(rng: () => number, n: number): number[] {
  return Array.from({ length: 2 * n }, () => rng() * 100 - 50);
}

/** Whether segments p–q and r–s intersect at all (closed, exact). */
function segmentsTouch(P: readonly number[], p: number, q: number, r: number, s: number): boolean {
  const o = (a: number, b: number, c: number): number =>
    Math.sign(
      orient2d(P[2 * a]!, P[2 * a + 1]!, P[2 * b]!, P[2 * b + 1]!, P[2 * c]!, P[2 * c + 1]!),
    );
  if (p === r || p === s || q === r || q === s) return false;
  return o(p, q, r) * o(p, q, s) <= 0 && o(r, s, p) * o(r, s, q) <= 0;
}

/** Up to `m` random segments that neither cross nor pass through another point. */
function randomSegments(rng: () => number, P: readonly number[], m: number): number[] {
  const n = P.length / 2;
  const segs: number[] = [];
  for (let tries = 0; tries < 20 * m && segs.length < 2 * m; tries++) {
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a === b) continue;
    let bad = false;
    for (let s = 0; s < segs.length && !bad; s += 2) {
      const c = segs[s]!;
      const d = segs[s + 1]!;
      if ((c === a && d === b) || (c === b && d === a)) bad = true;
      else bad = segmentsTouch(P, a, b, c, d);
    }
    for (let v = 0; v < n && !bad; v++) {
      if (v === a || v === b) continue;
      const on =
        orient2d(P[2 * a]!, P[2 * a + 1]!, P[2 * b]!, P[2 * b + 1]!, P[2 * v]!, P[2 * v + 1]!) ===
        0;
      if (on) bad = true;
    }
    if (!bad) segs.push(a, b);
  }
  return segs;
}

describe('constrainedDelaunay: unconstrained', () => {
  it('equals delaunator on random point sets (general position) and keeps every invariant', () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const rng = mulberry32(seed);
      const n = 3 + Math.floor(rng() * (seed % 50 === 0 ? 400 : 30));
      const P = randomPoints(rng, n);
      const t = ok(constrainedDelaunay({ points: P, segments: [] }));
      expect(checkTriangulation(t), `seed ${seed}`).toEqual([]);
      const d = new Delaunator(Float64Array.from(P));
      expect(triangleSet(t.triangles), `seed ${seed}`).toEqual(triangleSet(d.triangles));
      // Euler for a triangulated convex hull: T = 2V − B − 2.
      expect(t.triangles.length / 3).toBe(2 * n - boundaryVertices(t) - 2);
    }
  });

  it('handles cocircular grids and collinear chains (exact predicates)', () => {
    // A 12 × 9 grid: every grid square is cocircular.
    const P: number[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 9; j++) P.push(i * 0.1, j * 0.3);
    const t = ok(constrainedDelaunay({ points: P, segments: [] }));
    expect(checkTriangulation(t)).toEqual([]);
    expect(t.triangles.length / 3).toBe(2 * 11 * 8);
    // Collinear points plus one off the line: a fan.
    const C = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 2, 1];
    const tc = ok(constrainedDelaunay({ points: C, segments: [] }));
    expect(checkTriangulation(tc)).toEqual([]);
    expect(tc.triangles.length / 3).toBe(4);
    // All collinear: nothing to triangulate.
    const r = constrainedDelaunay({ points: [0, 0, 1, 1, 2, 2], segments: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('cdt-failure');
  });

  it('separates 1-ulp near-duplicates and reports or merges exact duplicates', () => {
    const e = 1 + Number.EPSILON;
    const P = [0, 0, 1, 0, e, 0, 1, 1, 0, 1];
    const t = ok(constrainedDelaunay({ points: P, segments: [] }));
    expect(checkTriangulation(t)).toEqual([]);
    expect(usedVertices(t)).toBe(5);
    const D = [0, 0, 1, 0, 1, 1, 1, 0, 0, 1];
    const r = constrainedDelaunay({ points: D, segments: [0, 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('cdt-duplicate-point');
    const m = ok(
      constrainedDelaunay({ points: D, segments: [0, 3, 3, 1] }, { duplicates: 'merge' }),
    );
    expect(checkTriangulation(m, [0, 1])).toEqual([]);
    expect(usedVertices(m)).toBe(4);
  });

  it('is deterministic (same input, same bits)', () => {
    const rng = mulberry32(5);
    const P = randomPoints(rng, 300);
    const a = ok(constrainedDelaunay({ points: P, segments: [] }));
    const b = ok(constrainedDelaunay({ points: P, segments: [] }));
    expect(Array.from(a.triangles)).toEqual(Array.from(b.triangles));
  });

  it('rejects contract violations', () => {
    expect(() => constrainedDelaunay({ points: [0, 0, 1], segments: [] })).toThrow(/pairs/);
    expect(() => constrainedDelaunay({ points: [0, 0, 1, NaN], segments: [] })).toThrow(/finite/);
    expect(() => constrainedDelaunay({ points: [0, 0, 1, 0, 0, 1], segments: [0, 3] })).toThrow(
      /outside/,
    );
    expect(() => constrainedDelaunay({ points: [0, 0, 1, 0, 0, 1], segments: [1, 1] })).toThrow(
      /itself|starts and ends/,
    );
  });
});

describe('constrainedDelaunay: constrained', () => {
  it('equals constrainautor on random constrained sets (unique CDT) and keeps every invariant', () => {
    for (let seed = 1; seed <= 6000; seed++) {
      const rng = mulberry32(100000 + seed);
      const n = 4 + Math.floor(rng() * 25);
      const P = randomPoints(rng, n);
      const segs = randomSegments(rng, P, 1 + Math.floor(rng() * n));
      const t = ok(constrainedDelaunay({ points: P, segments: segs }));
      expect(checkTriangulation(t, segs), `seed ${seed}`).toEqual([]);
      const d = new Delaunator(Float64Array.from(P));
      const pairs: [number, number][] = [];
      for (let s = 0; s < segs.length; s += 2) pairs.push([segs[s]!, segs[s + 1]!]);
      new Constrainautor(d, pairs);
      expect(edgeSet(t.triangles), `seed ${seed}`).toEqual(edgeSet(d.triangles));
    }
  });

  it('splits a segment at points exactly on it (collinear chain)', () => {
    const P = [0, 0, 4, 0, 1, 0, 2, 0, 3, 0, 2, 2, 2, -2];
    const t = ok(constrainedDelaunay({ points: P, segments: [0, 1] }));
    expect(checkTriangulation(t, [0, 1])).toEqual([]);
    const cons = new Set<string>();
    for (let e = 0; e < t.constrained.length; e++) {
      if (t.constrained[e])
        cons.add([t.triangles[e], t.triangles[e % 3 === 2 ? e - 2 : e + 1]].sort().join('-'));
    }
    expect([...cons].sort()).toEqual(['0-2', '1-4', '2-3', '3-4']);
  });

  it('recovers a segment through a cocircular grid and through slivers', () => {
    const P: number[] = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) P.push(i, j);
    // A segment that cuts every column at a non-lattice point, and one along a
    // diagonal through four lattice points (split there).
    P.push(-0.5, 0.25, 9.5, 3.75);
    const segs = [100, 101, 9, 54];
    const t = ok(constrainedDelaunay({ points: P, segments: segs }));
    expect(checkTriangulation(t, segs)).toEqual([]);
    // Slivers: points 1 ulp off a long segment, on both sides.
    const S = [0, 0, 1000, 0];
    for (let k = 1; k < 20; k++) S.push(k * 50, (k % 2 ? 1 : -1) * Number.MIN_VALUE * 2 ** 1000);
    const ts = ok(constrainedDelaunay({ points: S, segments: [0, 1] }));
    expect(checkTriangulation(ts, [0, 1])).toEqual([]);
  });

  it('reports crossing segments', () => {
    const P = [0, 0, 2, 2, 0, 2, 2, 0, 1, 3];
    const r = constrainedDelaunay({ points: P, segments: [0, 1, 2, 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]!.code).toBe('cdt-segments-intersect');
      expect(r.issues[0]!.at?.index).toBe(1);
    }
  });
});

describe('constrainedDelaunay: regions', () => {
  /** A square with a square hole: outer CCW, hole CW. */
  const P = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 3, 7, 7, 7, 7, 3, 1, 5, 5, 1, 9, 5, 5, 9, 5, 5];
  const outer = [0, 1, 2, 3];
  const hole = [4, 5, 6, 7];
  const loopSegs = (l: readonly number[]): number[] =>
    l.flatMap((v, i) => [v, l[(i + 1) % l.length]!]);

  it('removes the exterior and holes; area and Euler characteristic match', () => {
    const segs = [...loopSegs(outer), ...loopSegs(hole)];
    const t = ok(constrainedDelaunay({ points: P, segments: segs }, { removeExterior: true }));
    expect(checkTriangulation(t, segs)).toEqual([]);
    const area = shoelace(P, outer) + shoelace(P, hole);
    expect(shoelace(P, hole)).toBeLessThan(0);
    expect(Math.abs(triangleArea(t) - area)).toBeLessThanOrEqual(1e-12 * Math.abs(area));
    // The point (5, 5) is inside the hole: unused.
    const V = usedVertices(t);
    expect(V).toBe(12);
    // T = 2V − B − 2 + 2H with one hole.
    expect(t.triangles.length / 3).toBe(2 * V - boundaryVertices(t) - 2 + 2);
  });

  it('reports a hole oriented like the outer loop (winding 2)', () => {
    const segs = [...loopSegs(outer), ...loopSegs([...hole].reverse())];
    const r = constrainedDelaunay({ points: P, segments: segs }, { removeExterior: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('trim-orientation');
  });

  it('keeps constraints and the Delaunay property under Steiner insertion', () => {
    const segs = [...loopSegs(outer), ...loopSegs(hole)];
    const built = buildCdt({ points: P, segments: segs }, 'error');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const st = built.value.st;
    classifyRegions(st);
    const rng = mulberry32(3);
    let inserted = 0;
    let rejected = 0;
    for (let k = 0; k < 400; k++) {
      const v = insertSteiner(st, rng() * 12 - 1, rng() * 12 - 1, 1);
      if (v >= 0) inserted++;
      else rejected++;
    }
    // Grid points on the hole and outer edges are rejected (on a segment).
    for (const [x, y] of [
      [5, 3],
      [10, 4],
      [3, 3],
    ] as const) {
      expect(insertSteiner(st, x, y, 1)).toBe(-1);
    }
    expect(inserted).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(50); // outside the square or in the hole
    const t = exportTriangulation(st, (i) => st.region[i] === 1);
    expect(checkTriangulation(t, segs)).toEqual([]);
    const area = shoelace(P, outer) + shoelace(P, hole);
    expect(Math.abs(triangleArea(t) - area)).toBeLessThanOrEqual(1e-12 * Math.abs(area));
  });

  it('detects a broken invariant (the checks can fail)', () => {
    const t = ok(constrainedDelaunay({ points: [0, 0, 1, 0, 0, 1, 1, 1], segments: [0, 3] }));
    const tris = Uint32Array.from(t.triangles);
    [tris[0], tris[1]] = [tris[1]!, tris[0]!];
    expect(checkTriangulation({ ...t, triangles: tris }).length).toBeGreaterThan(0);
    expect(checkTriangulation(t, [0, 3])).toEqual([]);
    expect(checkTriangulation(t, [1, 2])).toHaveLength(1);
    // An unconstrained square split along the wrong (non-Delaunay) diagonal.
    const kite = ok(constrainedDelaunay({ points: [0, 0, 2, -1, 4, 0, 2, 3], segments: [0, 2] }));
    expect(
      checkTriangulation({ ...kite, constrained: new Uint8Array(kite.constrained.length) }),
    ).toHaveLength(1);
  });
});
