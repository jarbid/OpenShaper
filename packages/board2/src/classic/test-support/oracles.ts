// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Independent measurements for the converter's tests (test-only). Nothing here
 * calls the converter's own fitting or membership code: classic curves are
 * evaluated from their control points in the Bernstein form written out below,
 * distances are to dense exact polylines through a uniform grid, and plan
 * membership is geom's `classifyUV`.
 */
import type { Spline } from '@openshaper/kernel';

/** Exact points of every segment of a classic spline: `perSegment + 1` uniform parameters each (x, y pairs). */
export function splinePoints(s: Spline, perSegment: number): Float64Array {
  const out: number[] = [];
  s.curves.forEach((c, i) => {
    for (let k = i === 0 ? 0 : 1; k <= perSegment; k++) {
      const t = k / perSegment;
      const r = 1 - t;
      const b0 = r * r * r;
      const b1 = 3 * r * r * t;
      const b2 = 3 * r * t * t;
      const b3 = t * t * t;
      out.push(
        b0 * c.p0.x + b1 * c.c1.x + b2 * c.c2.x + b3 * c.p3.x,
        b0 * c.p0.y + b1 * c.c1.y + b2 * c.c2.y + b3 * c.p3.y,
      );
    }
  });
  return Float64Array.from(out);
}

/**
 * Distance queries to a polyline (x, y pairs; consecutive points joined) by a
 * uniform grid of `cell` cm: each segment is listed in every cell its box
 * touches, and a query scans rings of cells until no closer segment can exist.
 */
export function polylineDistance(
  pts: Float64Array,
  cell: number,
): (x: number, y: number, cap?: number) => number {
  const n = pts.length / 2;
  const grid = new Map<string, number[]>();
  let imin = Infinity;
  let imax = -Infinity;
  let jmin = Infinity;
  let jmax = -Infinity;
  const key = (i: number, j: number): string => `${i},${j}`;
  for (let s = 0; s + 1 < n; s++) {
    const x0 = Math.min(pts[2 * s]!, pts[2 * s + 2]!);
    const x1 = Math.max(pts[2 * s]!, pts[2 * s + 2]!);
    const y0 = Math.min(pts[2 * s + 1]!, pts[2 * s + 3]!);
    const y1 = Math.max(pts[2 * s + 1]!, pts[2 * s + 3]!);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
        imin = Math.min(imin, i);
        imax = Math.max(imax, i);
        jmin = Math.min(jmin, j);
        jmax = Math.max(jmax, j);
        const k = key(i, j);
        const list = grid.get(k);
        if (list) list.push(s);
        else grid.set(k, [s]);
      }
    }
  }
  const segDist = (s: number, x: number, y: number): number => {
    const ax = pts[2 * s]!;
    const ay = pts[2 * s + 1]!;
    const dx = pts[2 * s + 2]! - ax;
    const dy = pts[2 * s + 3]! - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(ax + t * dx - x, ay + t * dy - y);
  };
  // `cap`: stop looking past this distance (the result is then only known to be ≥ cap).
  return (x: number, y: number, cap = Infinity): number => {
    const ci = Math.floor(x / cell);
    const cj = Math.floor(y / cell);
    let best = Infinity;
    const last = Math.max(
      Math.abs(ci - imin),
      Math.abs(ci - imax),
      Math.abs(cj - jmin),
      Math.abs(cj - jmax),
    );
    for (let ring = 0; ring <= last; ring++) {
      // A segment not yet seen lies only in rings ≥ `ring`: at least `(ring − 1) · cell` away.
      if (best <= (ring - 1) * cell || (ring - 1) * cell > cap) break;
      for (let i = ci - ring; i <= ci + ring; i++) {
        for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          const list = grid.get(key(i, j));
          if (!list) continue;
          for (const s of list) best = Math.min(best, segDist(s, x, y));
        }
      }
    }
    return best;
  };
}

/**
 * Crossings of a closed polygon (x, y pairs, the last point joined to the
 * first) with the line at `x`, as their y values: a dense-polygon stand-in for
 * an exact loop, wrong only within its chord error of the loop.
 */
export function polygonCrossings(poly: Float64Array, x: number): number[] {
  const n = poly.length / 2;
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const xa = poly[2 * k]!;
    const xb = poly[2 * j]!;
    if ((xa <= x && x < xb) || (xb <= x && x < xa)) {
      const t = (x - xa) / (xb - xa);
      ys.push(poly[2 * k + 1]! + t * (poly[2 * j + 1]! - poly[2 * k + 1]!));
    }
  }
  return ys;
}
