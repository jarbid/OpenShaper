// SPDX-License-Identifier: GPL-3.0-or-later
/** The section fit and the blend along the board. */
import { describe, expect, it } from 'vitest';
import {
  arrivingDirection,
  blendAt,
  blendControls,
  controlCount,
  fitSection,
  fitSide,
  ladderClimb,
  leavingDirection,
  sectionKnots,
} from './sections';
import { SECTION_FIT_TOL } from './params';
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
    expect(Math.max(...b.stationError)).toBeLessThanOrEqual(SECTION_FIT_TOL);
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

describe('the span ladder stops when the fit is good enough or stops improving', () => {
  it('stops at the first rung within the limit and keeps it', () => {
    const climb = ladderClimb();
    expect(climb(SECTION_FIT_TOL * 4)).toEqual({ best: true, stop: false });
    expect(climb(SECTION_FIT_TOL * 0.9)).toEqual({ best: true, stop: true });
  });

  it('stops after two rungs in a row that fail to improve meaningfully, keeping the best', () => {
    const climb = ladderClimb();
    expect(climb(1)).toEqual({ best: true, stop: false });
    // 0.5 beats the best by more than the stall ratio; 0.49 and 0.48 do not
    expect(climb(0.5)).toEqual({ best: true, stop: false });
    expect(climb(0.49)).toEqual({ best: true, stop: false });
    expect(climb(0.48)).toEqual({ best: true, stop: true });
    // a rung that is worse than the best is not kept
    const worse = ladderClimb();
    worse(1);
    expect(worse(1.2)).toEqual({ best: false, stop: false });
    expect(worse(1.1)).toEqual({ best: false, stop: true });
  });

  it('fits a smooth section at the first rung and a board of smooth sections without the top rung', () => {
    const smooth = section(0.88, 0.06, 0.38, 0.86, 0.78);
    const items = [10, 90, 170].map((x) => ({ id: `s${x}`, x, section: smooth, scale: 25 }));
    expect(fitSide(items)!.m).toBe(12);
  });
});

describe("the centre tangents are the stored curve's, not an assumption", () => {
  const chain = (bottomOut: [number, number], deckIn: [number, number]) => ({
    knots: [
      { p: [0, 0], in: [0, 0], out: bottomOut, smooth: true },
      { p: [1, 0.3], in: [1, 0.3], out: [1, 0.5], smooth: true },
      { p: [0, 1], in: deckIn, out: [0, 1], smooth: true },
    ],
  });

  it('reads a zero-length handle as the polygon direction', () => {
    // bottom: (0,0) -> (1,0.3) with both handles at the knots: a straight, tilted line
    const c = chain([0, 0], [0, 1]) as never;
    const d = leavingDirection(c, 0)!;
    expect(d[1] / d[0]).toBeCloseTo(0.3, 12);
    const e = arrivingDirection(c, 2)!;
    expect(e[1] / e[0]).toBeCloseTo(-0.5, 12); // from the previous knot's out handle (1, 0.5)
  });

  it('holds a horizontal bottom centre tangent exactly and leaves a V bottom free', () => {
    const flat = fitSection({ chain: chain([0.4, 0], [0.4, 1]), apex: 1 } as never, 12)!;
    expect(flat.ctrl[3]).toBe(0); // second control of the bottom: still on the stringer's height
    const vee = fitSection({ chain: chain([0.5, 0.15], [0.4, 1]), apex: 1 } as never, 12)!;
    expect(vee.ctrl[3]! / vee.ctrl[2]!).toBeGreaterThan(0.2); // the stored slope is 0.3
    expect(vee.error).toBeLessThan(0.01);
  });
});

describe('the bounded blend (u stays within [0, 1], continuously in the stations)', () => {
  const m = 12;
  const width = 2 * controlCount(m);
  const xs = Float64Array.from([10, 40, 90, 130, 170]);
  // Station values of the u coordinates (even indices): pseudo-random in [0.2, 0.8], except that the
  // coordinates below are full (1) or empty (0) at the middle station, which makes the C2 spline overshoot.
  const base = ((): Float64Array => {
    const q = new Float64Array(xs.length * width);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < xs.length; i++) {
      for (let k = 0; k < width; k++) q[i * width + k] = k % 2 === 0 ? 0.2 + 0.6 * rnd() : rnd();
    }
    return q;
  })();
  const FULL = [2, 6, 10]; // u coordinates (even indices) pushed to 1 at the middle station
  const EMPTY = [14, 18]; // and to 0
  /** Station data with the middle station's FULL/EMPTY coordinates at `p` (1 or 0 when `p` is 1). */
  const data = (p: number): Float64Array => {
    const q = base.slice();
    for (const k of FULL) q[2 * width + k] = p;
    for (const k of EMPTY) q[2 * width + k] = 1 - p;
    // the neighbours are clear of the bounds, so the spline wants to go past them
    for (const k of FULL) q[1 * width + k] = 0.55;
    for (const k of EMPTY) q[1 * width + k] = 0.45;
    return q;
  };
  const grid: number[] = [];
  for (let x = 10; x <= 170; x += 0.5) grid.push(x);
  const eval0 = (q: Float64Array): Float64Array => {
    const b = blendControls(m, xs, q);
    const c = new Float64Array(width);
    const none = new Float64Array(width);
    const out = new Float64Array(grid.length * width);
    grid.forEach((x, i) => {
      blendAt(b, x, 0, c, none, none);
      out.set(c, i * width);
    });
    return out;
  };

  it('never leaves [0, 1], passes through every station value, and is the spline where there is room', () => {
    const q = data(1);
    const out = eval0(q);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      for (let k = 0; k < width; k += 2) {
        lo = Math.min(lo, out[i * width + k]!);
        hi = Math.max(hi, out[i * width + k]!);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    const b = blendControls(m, xs, q);
    const c = new Float64Array(width);
    const none = new Float64Array(width);
    xs.forEach((x, i) => {
      blendAt(b, x, 0, c, none, none);
      for (let k = 0; k < width; k++) expect(c[k]).toBeCloseTo(q[i * width + k]!, 12);
    });
  });

  it('is the C2 spline itself (to a few micrometres) where the data are smooth and well inside the bounds', () => {
    const q = data(1);
    const k = 20;
    const smooth = [0.5, 0.52, 0.55, 0.57, 0.6];
    smooth.forEach((v, i) => (q[i * width + k] = v));
    const b = blendControls(m, xs, q);
    const c = new Float64Array(width);
    const none = new Float64Array(width);
    let worst = 0;
    for (const x of [25, 65, 110, 150]) {
      blendAt(b, x, 0, c, none, none);
      const i = x < 40 ? 0 : x < 90 ? 1 : x < 130 ? 2 : 3;
      const h = xs[i + 1]! - xs[i]!;
      const A = (xs[i + 1]! - x) / h;
      const B = 1 - A;
      const spline =
        A * smooth[i]! +
        B * smooth[i + 1]! +
        (((A * A * A - A) * b.lm[i * width + k]! + (B * B * B - B) * b.rm[i * width + k]!) *
          h *
          h) /
          6;
      worst = Math.max(worst, Math.abs(c[k]! - spline));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('moves by a comparable amount when a station value moves (no switch between two blends)', () => {
    // sweep the middle station's FULL coordinates through the value at which the spline starts to overshoot
    let prev = eval0(data(0.9));
    let worstRatio = 0;
    const step = 1e-3;
    for (let p = 0.9 + step; p <= 1 + 1e-12; p += step) {
      const cur = eval0(data(p));
      let move = 0;
      for (let j = 0; j < cur.length; j++) move = Math.max(move, Math.abs(cur[j]! - prev[j]!));
      worstRatio = Math.max(worstRatio, move / step);
      prev = cur;
    }
    // a station value moves the blend by a small multiple of its own amount, not by the whole gap
    // between two blends (the monotone slopes are weighted harmonic means of the neighbouring chords)
    expect(worstRatio).toBeLessThan(3);
  });

  it('has continuous first derivatives across every station, bounds touched or not, and second derivatives where clear of them', () => {
    for (const p of [0.9, 1]) {
      const b = blendControls(m, xs, data(p));
      const a = [
        new Float64Array(width),
        new Float64Array(width),
        new Float64Array(width),
      ] as const;
      const z = [
        new Float64Array(width),
        new Float64Array(width),
        new Float64Array(width),
      ] as const;
      for (const x of [40, 90, 130]) {
        blendAt(b, x - 1e-7, 2, ...a);
        blendAt(b, x + 1e-7, 2, ...z);
        for (let k = 0; k < width; k++) {
          expect(Math.abs(a[1][k]! - z[1][k]!), `p ${p} x ${x} k ${k} slope`).toBeLessThan(1e-6);
          const touches = k % 2 === 0 && [...FULL, ...EMPTY].includes(k) && x === 90 && p === 1;
          if (!touches)
            expect(Math.abs(a[2][k]! - z[2][k]!), `p ${p} x ${x} k ${k}`).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('has derivatives that agree with finite differences of the blend', () => {
    for (const p of [0.9, 1]) {
      const b = blendControls(m, xs, data(p));
      const d = 1e-4;
      const at = (x: number, order: 0 | 1 | 2) => {
        const c = new Float64Array(width);
        const c1 = new Float64Array(width);
        const c2 = new Float64Array(width);
        blendAt(b, x, order, c, c1, c2);
        return { c, c1, c2 };
      };
      for (const x of [20, 63.3, 89.9, 90.1, 111, 150]) {
        const lo = at(x - d, 1);
        const hi = at(x + d, 1);
        const mid = at(x, 2);
        for (let k = 0; k < width; k++) {
          expect(mid.c1[k]!, `p ${p} x ${x} k ${k} c1`).toBeCloseTo(
            (hi.c[k]! - lo.c[k]!) / (2 * d),
            5,
          );
          expect(mid.c2[k]!, `p ${p} x ${x} k ${k} c2`).toBeCloseTo(
            (hi.c1[k]! - lo.c1[k]!) / (2 * d),
            4,
          );
        }
      }
    }
  });
});
