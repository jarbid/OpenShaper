// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two shortcuts the rail-law study's measurement rests on, pinned against the exact
 * thing they stand in for. Unlike the rest of `railproto` this is a real test and runs in
 * the package suite: a study whose numbers come from a broken yardstick is worse than no
 * study, and the first version of this one did exactly that (a marching nearest-point search
 * read 15.4 mm where the truth was 0.23).
 */
import { describe, expect, it } from 'vitest';
import { conicPoint, conicPolyline, nearestExact } from './rail-geom';
import type { Conic } from './rail-geom';
import { CONIC_SAMPLES, NEAREST_STRIDE } from './rail-params';
import { fishBoard, swallowBoard } from '../testing';
import { boardSections } from './rail-samples';

/** The study's own coarse-to-fine scan, reached through the deviation it feeds. */
const coarse = (poly: Float64Array, y: number, z: number): number => {
  const segs = poly.length / 2 - 1;
  const seg = (k: number): number => {
    const ey = poly[2 * k + 2]! - poly[2 * k]!;
    const ez = poly[2 * k + 3]! - poly[2 * k + 1]!;
    const wy = y - poly[2 * k]!;
    const wz = z - poly[2 * k + 1]!;
    const ee = ey * ey + ez * ez;
    const f = ee > 0 ? Math.min(1, Math.max(0, (wy * ey + wz * ez) / ee)) : 0;
    return Math.hypot(wy - f * ey, wz - f * ez);
  };
  let best = Infinity;
  let at = 0;
  for (let k = 0; k < segs; k += NEAREST_STRIDE) {
    const e = seg(k);
    if (e < best) {
      best = e;
      at = k;
    }
  }
  for (
    let k = Math.max(0, at - NEAREST_STRIDE);
    k <= Math.min(segs - 1, at + NEAREST_STRIDE);
    k++
  ) {
    best = Math.min(best, seg(k));
  }
  return best;
};

describe('the conic polyline', () => {
  it('is spaced evenly by arc length, even at an extreme rho', () => {
    for (const rho of [0.1, 0.5, 0.8, 0.95]) {
      const c: Conic = { p0: [0, 0], p1: [3, 0], p2: [3, 5], rho };
      const poly = conicPolyline(c);
      const lens: number[] = [];
      for (let i = 0; i + 1 <= CONIC_SAMPLES; i++) {
        lens.push(Math.hypot(poly[2 * i + 2]! - poly[2 * i]!, poly[2 * i + 3]! - poly[2 * i + 1]!));
      }
      // Uniform in the rational parameter, rho = 0.95 spreads these by a factor of hundreds;
      // what matters is that the longest chord is bounded, since the sagitta a deviation
      // reads off a chord goes with its square.
      expect(Math.max(...lens) / Math.min(...lens), `rho ${rho}`).toBeLessThan(1.2);
    }
  });

  it('puts every sample on the curve, not on a chord of it', () => {
    const c: Conic = { p0: [0, 0], p1: [3, 0], p2: [3, 5], rho: 0.95 };
    const poly = conicPolyline(c);
    // A point of the polyline is on the conic when it is a conic point for some t: check by
    // the conic's implicit test — the nearest densely sampled curve point is within microns.
    const fine: number[] = [];
    for (let i = 0; i <= 20000; i++) {
      const p = conicPoint(c, i / 20000);
      fine.push(p[0], p[1]);
    }
    const dense = Float64Array.from(fine);
    let worst = 0;
    for (let i = 0; i <= CONIC_SAMPLES; i++) {
      worst = Math.max(worst, nearestExact(dense, poly[2 * i]!, poly[2 * i + 1]!));
    }
    expect(worst).toBeLessThan(1e-5);
  });
});

describe('the coarse-to-fine nearest-point scan', () => {
  it('agrees with the exact scan on every station of the test boards', () => {
    const boards = [
      { name: 'swallow', doc: swallowBoard(), group: 'synthetic' as const },
      { name: 'fish', doc: fishBoard(), group: 'synthetic' as const },
    ];
    let checked = 0;
    let worst = 0;
    for (const b of boards) {
      for (const s of boardSections(b).sections) {
        const apex: [number, number] = [s.pts[2 * s.apex]!, s.pts[2 * s.apex + 1]!];
        for (const rho of [0.2, 0.5, 0.9]) {
          const poly = conicPolyline({ p0: [apex[0] - 2, apex[1] - 2], p1: apex, p2: apex, rho });
          for (let i = 0; i < s.count; i += 29) {
            const a = coarse(poly, s.pts[2 * i]!, s.pts[2 * i + 1]!);
            const e = nearestExact(poly, s.pts[2 * i]!, s.pts[2 * i + 1]!);
            worst = Math.max(worst, a - e);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // A micron: the coarse pass may not land on the exact segment, the refine window does.
    expect(worst).toBeLessThan(1e-4);
  });
});
