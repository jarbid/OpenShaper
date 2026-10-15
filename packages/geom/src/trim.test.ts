// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trim loops and trimmed surfaces (design §6.16, §16 "trim").
 *
 * Oracles:
 * - signed areas: a circle `±πr²` (rational: `10 · quadRel` relative, the
 *   adaptive rule's target with the design's 10× margin); polygons by the
 *   shoelace formula (polynomial: exact rule, `1e-13` relative); the natural
 *   loop `L_u · L_v` exactly;
 * - validation: hand-built invalid loops of each kind (open, figure-eight,
 *   a cubic with a self-loop inside one Bézier piece, holes outside or nested,
 *   loops crossing or touching, outside the domain, on a periodic surface,
 *   wrong orientation);
 * - classification: against the analytic disc and annulus, and against the
 *   exact winding number of polygons (computed with exact `orient2d` and the
 *   crossing rule); points within 1e-9 of a boundary are skipped (the
 *   classifier's band is `√2 · paramRel · L` ≈ 1.4e-12 here);
 * - closest point on a trimmed plane: analytic; on a two-valley quartic
 *   trimmed to one valley (the surface's minimum outside, the trimmed minimum
 *   an interior one): brute force over a dense grid of the trimmed domain
 *   (the converged result is at most the best sample, and within 1e-6
 *   relative of it: grid step 1e-3 in x, the distance's error is quadratic in
 *   the step).
 */
import { describe, expect, it } from 'vitest';
import { bezierCurve, transformCurve2 } from './curve';
import { orient2d } from './mesh/predicates';
import { bezierSurface, circle2, line2, planeSurface, polyline, sphere } from './primitives';
import { surfacePoint } from './surface';
import { DEFAULT_TOLERANCES } from './tolerance';
import {
  checkTrimLoops,
  classifyUV,
  closestPointOnTrimmed,
  makeTrimLoop,
  makeTrimmedSurface,
  naturalBoundaryLoop,
} from './trim';
import { mulberry32 } from './testing';
import type { ClampedCurve, Result, TrimLoop, TrimmedSurface } from './types';

const QREL = 10 * DEFAULT_TOLERANCES.quadRel;

function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}
const codes = <T>(r: Result<T>): string[] => r.issues.map((i) => i.code);
const loop = (cs: ClampedCurve<2>[]): TrimLoop => ok(makeTrimLoop(cs));
const poly = (pts: number[]): TrimLoop => loop([polyline(pts, 2, true)]);
const cw = (c: ClampedCurve<2>, cv: number): ClampedCurve<2> =>
  transformCurve2(c, [1, 0, 0, 0, -1, 2 * cv]);

/** Unit-square domain plane, metric (x, y) = (u, v). */
const plane = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

function shoelace(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!;
  }
  return a / 2;
}

describe('makeTrimLoop', () => {
  it('computes signed areas: circle ±πr², polygon by the shoelace formula', () => {
    const c = loop([circle2({ x: 0.5, y: 0.5 }, 0.3)]);
    expect(Math.abs(c.signedArea / (Math.PI * 0.09) - 1)).toBeLessThanOrEqual(QREL);
    const m = loop([cw(circle2({ x: 0.5, y: 0.5 }, 0.3), 0.5)]);
    expect(Math.abs(m.signedArea / (-Math.PI * 0.09) - 1)).toBeLessThanOrEqual(QREL);
    const P = [0.1, 0.1, 0.8, 0.2, 0.9, 0.7, 0.4, 0.5, 0.2, 0.9];
    expect(Math.abs(poly(P).signedArea / shoelace(P) - 1)).toBeLessThanOrEqual(1e-13);
    // The same polygon as five line segments.
    const segs: ClampedCurve<2>[] = [];
    for (let i = 0; i < 5; i++) {
      const j = (i + 1) % 5;
      segs.push(line2({ x: P[2 * i]!, y: P[2 * i + 1]! }, { x: P[2 * j]!, y: P[2 * j + 1]! }));
    }
    expect(Math.abs(loop(segs).signedArea / shoelace(P) - 1)).toBeLessThanOrEqual(1e-13);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('requires bitwise joins; snaps a join within the parameter tolerance on request', () => {
    const a = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = line2({ x: 1, y: 0 }, { x: 0, y: 1 });
    // Join tolerance: paramRel × loop extent = 1e-12 in (u, v) units here.
    const gap = line2({ x: 0, y: 1 + 5e-13 }, { x: 0, y: 0 });
    const r = makeTrimLoop([a, b, gap]);
    expect(codes(r)).toEqual(['trim-not-closed']);
    const s = ok(makeTrimLoop([a, b, gap], { snap: true }));
    expect(s.curves[2]!.cw[1]).toBe(1);
    expect(Math.abs(s.signedArea - 0.5)).toBeLessThanOrEqual(1e-15);
    const far = line2({ x: 0, y: 1.001 }, { x: 0, y: 0 });
    expect(codes(makeTrimLoop([a, b, far], { snap: true }))).toEqual(['trim-not-closed']);
    // A (u, v) gap is not compared with the 3D length `point` (1e-6 cm): 9e-7
    // is far above parameter equality and is not snapped.
    const near = line2({ x: 0, y: 1 + 9e-7 }, { x: 0, y: 0 });
    expect(codes(makeTrimLoop([a, b, near], { snap: true }))).toEqual(['trim-not-closed']);
    // The tolerance scales with the loop: the same relative gap on a loop 1000× larger snaps.
    const k = 1000;
    const big = [
      line2({ x: 0, y: 0 }, { x: k, y: 0 }),
      line2({ x: k, y: 0 }, { x: 0, y: k }),
      line2({ x: 0, y: k * (1 + 5e-13) }, { x: 0, y: 0 }),
    ];
    expect(codes(makeTrimLoop(big))).toEqual(['trim-not-closed']);
    expect(ok(makeTrimLoop(big, { snap: true })).curves[2]!.cw[1]).toBe(k);
    // There and back: zero area, no orientation.
    expect(codes(makeTrimLoop([a, line2({ x: 1, y: 0 }, { x: 0, y: 0 })]))).toEqual([
      'trim-orientation',
    ]);
    expect(() => makeTrimLoop([])).toThrow(/at least one/);
  });

  it('natural boundary loop: counter-clockwise, area L_u · L_v exactly; none on periodic surfaces', () => {
    const p = planeSurface(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { u: [-1, 2], v: [0.5, 3] },
    );
    expect(naturalBoundaryLoop(p).signedArea).toBe(3 * 2.5);
    expect(() => naturalBoundaryLoop(sphere({ x: 0, y: 0, z: 0 }, 1))).toThrow(/periodic/);
  });
});

describe('makeTrimmedSurface validation', () => {
  const outer = loop([circle2({ x: 0.5, y: 0.5 }, 0.4)]);
  const hole = (x: number, y: number, r: number): TrimLoop => loop([cw(circle2({ x, y }, r), y)]);

  it('reverses a clockwise outer loop with a warning', () => {
    const r = makeTrimmedSurface(plane, hole(0.5, 0.5, 0.3));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['trim-orientation', 'warning']]);
    expect(r.value.outer!.signedArea).toBeGreaterThan(0);
    expect(checkTrimLoops(r.value)).toEqual([]);
  });

  it('rejects self-intersections, crossing and touching loops, misplaced holes, the outside, periodic surfaces', () => {
    // Figure-eight polygon.
    expect(
      codes(makeTrimmedSurface(plane, poly([0.1, 0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.9]))),
    ).toContain('trim-self-intersects');
    // A single cubic piece with a loop, closed by a line.
    const knot = bezierCurve(2, [0.2, 0.5, 1.1, 0.9, -0.1, 0.9, 0.8, 0.5]);
    expect(
      codes(makeTrimmedSurface(plane, loop([knot, line2({ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 })]))),
    ).toContain('trim-self-intersects');
    expect(codes(makeTrimmedSurface(plane, outer, [hole(0.85, 0.5, 0.1)]))).toEqual([
      'trim-loops-intersect',
    ]);
    // Touching from inside (tangent circles).
    expect(codes(makeTrimmedSurface(plane, outer, [hole(0.7, 0.5, 0.2)]))).toEqual([
      'trim-loops-intersect',
    ]);
    expect(
      codes(makeTrimmedSurface(plane, outer, [hole(0.4, 0.5, 0.05), hole(0.45, 0.5, 0.05)])),
    ).toEqual(['trim-loops-intersect']);
    // Nested holes and a hole outside (both disjoint from every loop).
    expect(
      codes(makeTrimmedSurface(plane, outer, [hole(0.5, 0.5, 0.2), hole(0.5, 0.5, 0.1)])),
    ).toContain('trim-hole-outside');
    const small = loop([circle2({ x: 0.3, y: 0.3 }, 0.1)]);
    expect(codes(makeTrimmedSurface(plane, small, [hole(0.7, 0.7, 0.1)]))).toEqual([
      'trim-hole-outside',
    ]);
    expect(codes(makeTrimmedSurface(plane, loop([circle2({ x: 0.9, y: 0.5 }, 0.2)])))).toEqual([
      'trim-outside-domain',
    ]);
    expect(codes(makeTrimmedSurface(sphere({ x: 0, y: 0, z: 0 }, 1), outer))).toEqual([
      'trim-on-periodic',
    ]);
    // A valid face: no issues.
    expect(
      codes(makeTrimmedSurface(plane, outer, [hole(0.4, 0.5, 0.1), hole(0.65, 0.5, 0.1)])),
    ).toEqual([]);
  });

  it('checkTrimLoops reports wrong orientation on an unvalidated record', () => {
    const bad = {
      surface: plane,
      outer: hole(0.5, 0.5, 0.3),
      holes: [],
    } as unknown as TrimmedSurface;
    expect(checkTrimLoops(bad).map((i) => i.code)).toEqual(['trim-orientation']);
  });
});

/** Exact winding number of a closed polygon round (x, y), or null on it (exact orient2d). */
function windingExact(p: number[], x: number, y: number): number | null {
  const n = p.length / 2;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay, bx, by] = [p[2 * i]!, p[2 * i + 1]!, p[2 * j]!, p[2 * j + 1]!];
    const o = orient2d(ax, ay, bx, by, x, y);
    if (
      o === 0 &&
      Math.min(ax, bx) <= x &&
      x <= Math.max(ax, bx) &&
      Math.min(ay, by) <= y &&
      y <= Math.max(ay, by)
    ) {
      return null;
    }
    if (ay <= y && y < by && o > 0) w++;
    else if (by <= y && y < ay && o < 0) w--;
  }
  return w;
}

describe('classifyUV', () => {
  it('matches the analytic disc and annulus', () => {
    const ts = ok(
      makeTrimmedSurface(plane, loop([circle2({ x: 0.5, y: 0.5 }, 0.4)]), [
        loop([cw(circle2({ x: 0.5, y: 0.5 }, 0.15), 0.5)]),
      ]),
    );
    const rng = mulberry32(21);
    let checked = 0;
    for (let k = 0; k < 4000; k++) {
      const u = rng();
      const v = rng();
      const d = Math.hypot(u - 0.5, v - 0.5);
      if (Math.abs(d - 0.4) < 1e-9 || Math.abs(d - 0.15) < 1e-9) continue;
      expect(classifyUV(ts, { u, v }), `(${u}, ${v})`).toBe(
        d < 0.4 && d > 0.15 ? 'inside' : 'outside',
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(3990);
    // On the circle: boundary.
    expect(classifyUV(ts, { u: 0.9, v: 0.5 })).toBe('boundary');
    expect(classifyUV(ts, { u: 0.5, v: 0.35 })).toBe('boundary');
  });

  it('matches the exact winding number of random polygons, vertices and edges included', () => {
    const rng = mulberry32(22);
    for (let trial = 0; trial < 30; trial++) {
      // A star-shaped polygon (simple), counter-clockwise.
      const n = 5 + Math.floor(rng() * 10);
      const P: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * (i + 0.2 + 0.6 * rng())) / n;
        const r = 0.1 + 0.35 * rng();
        P.push(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a));
      }
      const ts = ok(makeTrimmedSurface(plane, poly(P)));
      for (let k = 0; k < 200; k++) {
        let u = rng();
        let v = rng();
        if (k % 10 === 0) {
          // A polygon vertex, or a point exactly on an edge's line within it.
          const i = Math.floor(rng() * n);
          u = P[2 * i]!;
          v = P[2 * i + 1]!;
        }
        const w = windingExact(P, u, v);
        const got = classifyUV(ts, { u, v });
        if (w === null) expect(got).toBe('boundary');
        else expect(got, `trial ${trial} (${u}, ${v})`).toBe(w === 1 ? 'inside' : 'outside');
      }
    }
  });

  it('natural boundary: the domain rectangle; periodic directions have none', () => {
    const ts = ok(makeTrimmedSurface(plane, null));
    expect(classifyUV(ts, { u: 0.5, v: 0.5 })).toBe('inside');
    expect(classifyUV(ts, { u: 1, v: 0.5 })).toBe('boundary');
    expect(classifyUV(ts, { u: 1.5, v: 0.5 })).toBe('outside');
    const sp = ok(makeTrimmedSurface(sphere({ x: 0, y: 0, z: 0 }, 1), null));
    expect(classifyUV(sp, { u: 0, v: 0.5 })).toBe('inside');
  });
});

describe('closestPointOnTrimmed', () => {
  const ts = ok(makeTrimmedSurface(plane, loop([circle2({ x: 0.5, y: 0.5 }, 0.3)])));

  it('returns the surface point inside, and the trim curve point outside', () => {
    const a = closestPointOnTrimmed(ts, { x: 0.55, y: 0.6, z: 1 });
    expect(a.onBoundary).toBe(false);
    expect(a.distance).toBeCloseTo(1, 14);
    const b = closestPointOnTrimmed(ts, { x: 1.2, y: 0.5, z: 0.2 });
    expect(b.onBoundary).toBe('trim');
    expect(b.converged).toBe(true);
    // Closest point of the circle (0.8, 0.5, 0): distance √(0.4² + 0.2²).
    expect(Math.abs(b.distance - Math.hypot(0.4, 0.2))).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(b.point.x - 0.8)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(b.point.y - 0.5)).toBeLessThanOrEqual(1e-12);
    // At an angle: the radial point.
    const th = 2.2;
    const c = closestPointOnTrimmed(ts, {
      x: 0.5 + 0.7 * Math.cos(th),
      y: 0.5 + 0.7 * Math.sin(th),
      z: -0.1,
    });
    expect(Math.abs(c.distance - Math.hypot(0.4, 0.1))).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(c.uv.u - (0.5 + 0.3 * Math.cos(th)))).toBeLessThanOrEqual(1e-12);
  });

  it('finds a minimum inside the trim when the surface minimum is outside it', () => {
    // z = (x² − 1)² over x = 4u − 2 ∈ [−2, 2], y = 2v − 1: valleys at x = ±1.
    // Power basis in u: 256u⁴ − 512u³ + 352u² − 96u + 9; Bernstein coefficients
    // b_i = Σ_{j≤i} C(i, j)/C(4, j) a_j.
    const a = [9, -96, 352, -512, 256];
    const C = (n: number, k: number): number => {
      let r = 1;
      for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
      return r;
    };
    const pts: number[] = [];
    for (let i = 0; i <= 4; i++) {
      let b = 0;
      for (let j = 0; j <= i; j++) b += (C(i, j) / C(4, j)) * a[j]!;
      for (let j = 0; j <= 1; j++) pts.push(-2 + i, -1 + 2 * j, b);
    }
    const S = bezierSurface(pts, 5, 2);
    // Trimmed to u ∈ [0, 0.5] (x ≤ 0): the valley at x = −1 only.
    const left = ok(makeTrimmedSurface(S, poly([0, 0, 0.5, 0, 0.5, 1, 0, 1])));
    const p = { x: 0.01, y: 0, z: -5 };
    const r = closestPointOnTrimmed(left, p);
    let bf = Infinity;
    const n = 2000;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= 10; j++) {
        const q = surfacePoint(S, (0.5 * i) / n, j / 10);
        bf = Math.min(bf, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
      }
    }
    expect(r.onBoundary).toBe(false);
    expect(r.converged).toBe(true);
    expect(classifyUV(left, r.uv)).toBe('inside');
    expect(r.distance).toBeLessThanOrEqual(bf);
    expect((bf - r.distance) / bf).toBeLessThanOrEqual(1e-6);
    // The untrimmed minimum is the other valley, outside the trim.
    const right = ok(makeTrimmedSurface(S, poly([0.5, 0, 1, 0, 1, 1, 0.5, 1])));
    const rr = closestPointOnTrimmed(right, p);
    expect(rr.uv.u).toBeGreaterThan(0.5);
    expect(rr.distance).toBeLessThan(r.distance);
  });
});
