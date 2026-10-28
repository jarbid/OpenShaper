// SPDX-License-Identifier: GPL-3.0-or-later
/** The section fit and the blend along the board. */
import { describe, expect, it } from 'vitest';
import { blendAt, controlCount, fitSection, fitSide, sectionKnots } from './sections';
import { distanceToPolyline, sampleChain, section } from './testing';

describe('sectionKnots', () => {
  it('is clamped cubic with a triple knot at the apex', () => {
    const k = sectionKnots(12);
    expect(k.length).toBe(controlCount(12) + 4);
    expect(Array.from(k.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(k.slice(-4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(k).filter((x) => x === 0.5)).toHaveLength(3);
  });
});

describe('fitSection', () => {
  const s = section(0.88, 0.06, 0.38, 0.86, 0.78);
  const fit = fitSection(s, 24)!;

  it('holds the Phase 0 rules exactly and stays in bounds', () => {
    const c = fit.ctrl;
    const n = controlCount(24);
    expect([c[0], c[1], c[3]]).toEqual([0, 0, 0]); // bottom centre, horizontal tangent
    expect([c[2 * (n - 1)], c[2 * (n - 1) + 1], c[2 * (n - 2) + 1]]).toEqual([0, 1, 1]);
    const apex = c.slice(2 * (24 + 2), 2 * (24 + 2) + 2);
    expect(apex[0]).toBeCloseTo(1, 12);
    expect(apex[1]).toBeCloseTo(0.38, 12);
    for (let i = 0; i < n; i++) expect(c[2 * i]).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < n; i++) expect(c[2 * i]).toBeLessThanOrEqual(1);
  });

  it('is within a few 1e-4 (normalised) of the stored chain, and cached by identity', () => {
    expect(fit.error).toBeLessThan(5e-4);
    expect(fitSection(s, 24)).toBe(fit);
    expect(fitSection(section(0.88, 0.06, 0.38, 0.86, 0.78), 24)).not.toBe(fit);
  });
});

describe('the blend', () => {
  const xs = [10, 40, 90, 130, 170];
  const rows = [
    [0.7, 0.05, 0.3, 0.7, 0.7],
    [0.8, 0.05, 0.3, 0.78, 0.7],
    [0.9, 0.07, 0.4, 0.88, 0.8],
    [0.85, 0.06, 0.36, 0.84, 0.76],
    [0.7, 0.04, 0.3, 0.7, 0.65],
  ] as const;
  const items = xs.map((x, i) => ({
    id: `s${x}`,
    x,
    section: section(rows[i]![0], rows[i]![1], rows[i]![2], rows[i]![3], rows[i]![4]),
    scale: 25,
  }));
  const b = fitSide(items)!;
  const w = b.width;
  const mk = () => [new Float64Array(w), new Float64Array(w), new Float64Array(w)] as const;

  it("reproduces every station's fit exactly", () => {
    const [c, c1, c2] = mk();
    xs.forEach((x, i) => {
      blendAt(b, x, 0, c, c1, c2);
      expect(Array.from(c)).toEqual(Array.from(b.q.slice(i * w, (i + 1) * w)));
    });
    expect(Math.max(...b.stationError)).toBeLessThan(0.01);
  });

  it('is C2 across the interior stations and has zero slope at the ends', () => {
    const a = mk();
    const z = mk();
    for (const x of xs.slice(1, -1)) {
      blendAt(b, x - 1e-9, 2, ...a);
      blendAt(b, x + 1e-9, 2, ...z);
      for (let k = 0; k < w; k++) {
        expect(a[0][k]).toBeCloseTo(z[0][k]!, 8);
        expect(a[1][k]).toBeCloseTo(z[1][k]!, 6);
        expect(a[2][k]).toBeCloseTo(z[2][k]!, 4);
      }
    }
    const [c, c1] = mk();
    blendAt(b, xs[0]!, 1, c, c1, mk()[2]);
    expect(Math.max(...Array.from(c1).map(Math.abs))).toBe(0);
  });

  it('holds the end sections beyond the stations and interpolates a constant exactly', () => {
    const [c, c1, c2] = mk();
    blendAt(b, -5, 2, c, c1, c2);
    expect(Array.from(c)).toEqual(Array.from(b.q.slice(0, w)));
    expect(Math.max(...Array.from(c2).map(Math.abs))).toBe(0);
    const one = fitSide([items[0]!, { ...items[0]!, id: 'b', x: 50, section: items[0]!.section }])!;
    const [d0, d1, d2] = [0, 1, 2].map(() => new Float64Array(one.width));
    blendAt(one, 30, 2, d0!, d1!, d2!);
    Array.from(d0!).forEach((v, k) => expect(v).toBeCloseTo(one.q[k]!, 14));
    expect(Math.max(...Array.from(d1!).map(Math.abs), ...Array.from(d2!).map(Math.abs))).toBe(0);
  });

  it('stays close to the stored sections between stations (a plausible blend)', () => {
    const [c, c1, c2] = mk();
    blendAt(b, 65, 0, c, c1, c2);
    // the section halfway between two stations lies between their extremes in u at the tuck
    const pts = (i: number) => sampleChain(items[i]!.section.chain, 80);
    const mid: number[][] = [];
    for (let j = 0; j < controlCount(b.m); j++) mid.push([c[2 * j]!, c[2 * j + 1]!]);
    for (const p of mid) {
      expect(distanceToPolyline(pts(1), p) + distanceToPolyline(pts(2), p)).toBeLessThan(0.5);
    }
  });
});
