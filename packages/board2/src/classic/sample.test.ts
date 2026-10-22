// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Classic sampling (docs/design/board2.md §9.2).
 *
 * Oracles: the floors are the kernel's own `surfaceStations(...).span`; the
 * rows are checked against their definition; the ring samples against the
 * kernel's `loftRing` (the +y half of a ring of 2 × `ringSamples` steps uses
 * the same ladder: bitwise); the crease angles converge at O(δ) in the probe
 * (one-sided differences): halving δ halves the change, ratio in [1.6, 2.4]
 * (measured 2.00 to 2.02 at the shortboard's interior stations). The exact
 * apex (S7) against dense sampling of the ring at 2e5 fractions: its y is at
 * least the dense maximum (to rounding, 1e-12 cm) and its z within one dense
 * step's z change of the dense argmax (y is flat at the apex, so z is the
 * sensitive coordinate).
 */
import { describe, expect, it } from 'vitest';
import { getLength, loftPoint, loftRing, loftSection, surfaceStations } from '@openshaper/kernel';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import {
  classicFloors,
  classicStations,
  creaseAngles,
  loftRowPositions,
  sampleLoft,
} from './sample';
import { classicSample } from './test-support/samples';

describe('classic sampling', () => {
  const board = classicSample('golden/shortboard.brd').load();
  const knife = classicSample('synthetic-clean-6x22x2-75.s3dx').load();

  it('floors are the kernel’s solid span; zones lie outside it', () => {
    for (const b of [board, knife]) {
      const f = classicFloors(b);
      expect(f.span).toEqual(surfaceStations(b).span);
      expect(f.length).toBe(getLength(b));
      for (const [a, c] of f.zones) expect(c > a && (c <= f.span[0] || a >= f.span[1])).toBe(true);
    }
    // The knife-tip file floors 6.5 cm at each end (§2.3).
    expect(classicFloors(knife).zones.map(([a, c]) => c - a)[0]).toBeGreaterThan(6);
  });

  it('rows: both span ends, at most sampleSpacingX apart, station probes, sorted and distinct', () => {
    const f = classicFloors(board);
    const xs = loftRowPositions(board, f, O);
    expect(xs[0]).toBe(f.span[0]);
    expect(xs.at(-1)).toBe(f.span[1]);
    for (let k = 1; k < xs.length; k++) {
      expect(xs[k]! > xs[k - 1]!).toBe(true);
      expect(xs[k]! - xs[k - 1]!).toBeLessThanOrEqual(O.sampleSpacingX * (1 + 1e-12));
    }
    for (const s of classicStations(board)) {
      for (const x of [s - O.creaseProbe, s + O.creaseProbe]) {
        if (x > f.span[0] && x < f.span[1]) expect(xs).toContain(x);
      }
    }
  });

  it('ring samples are the kernel loft’s +y half; the apex index is the widest point', () => {
    const xs = [10, 92.71, 150];
    const s = sampleLoft(board, xs, O);
    const nf = s.fractions.length;
    expect(nf).toBe(O.ringSamples);
    xs.forEach((x, r) => {
      const ring = loftRing(board, x, 2 * O.ringSamples)!;
      for (let k = 0; k < nf; k++) {
        expect(s.y[r * nf + k]).toBe(ring[k]!.y);
        expect(s.z[r * nf + k]).toBe(ring[k]!.z);
      }
      const ys = Array.from(s.y.subarray(r * nf, (r + 1) * nf));
      expect(s.apex[r]).toBe(ys.indexOf(Math.max(...ys)));
    });
  });

  it('crease angles converge at O(δ) and are recorded for every station inside the span', () => {
    const f = classicFloors(board);
    const at = (d: number) => creaseAngles(board, f, { ...O, creaseProbe: d });
    const a = at(O.creaseProbe);
    expect(a.map((c) => c.x)).toEqual(
      classicStations(board).filter((x) => x - O.creaseProbe >= f.span[0]),
    );
    const b = at(O.creaseProbe / 2);
    const c = at(O.creaseProbe / 4);
    a.forEach((ca, i) => {
      expect(ca.angle).toBeGreaterThan(0);
      expect(ca.angle).toBeLessThan(Math.PI / 2);
      const d1 = ca.angle - b[i]!.angle;
      const d2 = b[i]!.angle - c[i]!.angle;
      // Interior stations only: near an end the loft's second x-derivative is
      // large and δ = 0.01 cm is not yet asymptotic (ratios 2.3 measured at
      // x = 0.95 and 185.35; and on the polygonal synthetic files the kernel's
      // valueAt, whose Newton stops at POS_TOLERANCE = 0.003 cm in x, makes the
      // quotients noisy below δ ≈ 0.005: S6 as built).
      if (ca.x > 10 && ca.x < getLength(board) - 10) {
        expect(d1 / d2).toBeGreaterThan(1.6);
        expect(d1 / d2).toBeLessThan(2.4);
      }
    });
  });

  it('the exact apex is the section’s widest point (S7)', () => {
    const f = classicFloors(board);
    const xs = [f.span[0] + 1, 60, 120, f.span[1] - 1];
    const loft = sampleLoft(board, xs, O);
    const N = 200_000;
    loft.x.forEach((x, r) => {
      const s = loftSection(board, x)!;
      let best = -Infinity;
      let bestZ = 0;
      let step = 0;
      let prev = loftPoint(s, 0);
      for (let k = 1; k <= N; k++) {
        const p = loftPoint(s, k / N);
        step = Math.max(step, Math.abs(p.y - prev.y));
        prev = p;
        if (p.x > best) {
          best = p.x;
          bestZ = p.y + s.rocker;
        }
      }
      expect(loft.apexY[r]!).toBeGreaterThanOrEqual(best - 1e-12);
      expect(Math.abs(loft.apexZ[r]! - bestZ)).toBeLessThanOrEqual(step);
    });
  });
});
