// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The blend along the board: the same as `sections.ts` blends an unlimited control coordinate,
 * through its stations, held beyond them, C2 across them, and monotone on monotone data.
 */
import { describe, expect, it } from 'vitest';
import { blendAt, blendControls, controlCount } from '../sections';
import { alongAt, alongPolynomials, quinticAlong } from './along';

/** A small deterministic generator (an LCG), so a failure can be replayed. */
const rng = (seed: number) => {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const stations = (r: () => number, n: number): Float64Array => {
  const xs = new Float64Array(n);
  let x = r() * 10;
  for (let i = 0; i < n; i++) {
    xs[i] = x;
    x += 2 + r() * 40;
  }
  return xs;
};

describe('quinticAlong', () => {
  it("equals sections.ts's blend of an unlimited coordinate", () => {
    // The reference is blendControls / blendAt on a section of m = 2 spans: its odd coordinates
    // (the v's) are not limited, so the scalars go there and the even ones get filler in [0, 1].
    const m = 2;
    const wide = 2 * controlCount(m);
    const width = wide / 2;
    let worst = 0;
    let worstD = 0;
    for (let trial = 0; trial < 40; trial++) {
      const r = rng(trial + 1);
      const n = 1 + Math.floor(r() * 9);
      const xs = stations(r, n);
      const q = new Float64Array(n * width);
      const Q = new Float64Array(n * wide);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < width; k++) {
          const v = (r() - 0.5) * 20;
          q[i * width + k] = v;
          Q[i * wide + 2 * k + 1] = v;
          Q[i * wide + 2 * k] = r();
        }
      }
      const a = quinticAlong(xs, q, width);
      const ref = blendControls(m, xs, Q);
      const out = new Float64Array(width);
      const d1 = new Float64Array(width);
      const c = new Float64Array(wide);
      const c1 = new Float64Array(wide);
      const c2 = new Float64Array(wide);
      const lo = xs[0]! - 5;
      const hi = xs[n - 1]! + 5;
      for (let s = 0; s <= 400; s++) {
        const x = lo + ((hi - lo) * s) / 400;
        alongAt(a, x, out, d1);
        blendAt(ref, x, 1, c, c1, c2);
        for (let k = 0; k < width; k++) {
          worst = Math.max(worst, Math.abs(out[k]! - c[2 * k + 1]!));
          worstD = Math.max(worstD, Math.abs(d1[k]! - c1[2 * k + 1]!));
        }
      }
    }
    // the same arithmetic in the same order: equal to the bit
    expect(worst).toBe(0);
    expect(worstD).toBe(0);
  });

  it('passes through the station values and holds the ends beyond them', () => {
    const r = rng(7);
    const xs = stations(r, 6);
    const width = 5;
    const q = Float64Array.from({ length: 6 * width }, () => r() * 10 - 5);
    const a = quinticAlong(xs, q, width);
    const out = new Float64Array(width);
    const d1 = new Float64Array(width);
    for (let i = 0; i < 6; i++) {
      alongAt(a, xs[i]!, out, d1);
      for (let k = 0; k < width; k++) expect(out[k]).toBeCloseTo(q[i * width + k]!, 12);
    }
    for (const x of [xs[0]! - 30, xs[0]! - 0.1]) {
      alongAt(a, x, out, d1);
      for (let k = 0; k < width; k++) {
        expect(out[k]).toBe(q[k]);
        expect(d1[k]).toBe(0);
      }
    }
    for (const x of [xs[5]! + 0.1, xs[5]! + 30]) {
      alongAt(a, x, out, d1);
      for (let k = 0; k < width; k++) {
        expect(out[k]).toBe(q[5 * width + k]);
        expect(d1[k]).toBe(0);
      }
    }
  });

  it('gives a constant from one station', () => {
    const a = quinticAlong(Float64Array.of(12), Float64Array.of(3, -1), 2);
    const out = new Float64Array(2);
    const d1 = new Float64Array(2);
    for (const x of [-10, 12, 40]) {
      alongAt(a, x, out, d1);
      expect([...out]).toEqual([3, -1]);
      expect([...d1]).toEqual([0, 0]);
    }
  });

  it('is continuous in value, slope and second derivative across a station', () => {
    const r = rng(11);
    const xs = stations(r, 7);
    const width = 6;
    const q = Float64Array.from({ length: 7 * width }, () => r() * 10 - 5);
    const a = quinticAlong(xs, q, width);
    const f = (x: number): Float64Array => {
      const out = new Float64Array(width);
      alongAt(a, x, out);
      return out;
    };
    const e = 1e-3;
    // the first and last station too: the blend joins the held end with C2
    for (let i = 0; i < 7; i++) {
      const x = xs[i]!;
      const m2 = f(x - 2 * e);
      const m1 = f(x - e);
      const z = f(x);
      const p1 = f(x + e);
      const p2 = f(x + 2 * e);
      for (let k = 0; k < width; k++) {
        const scale = 1 + Math.abs(a.dd[i * width + k]!);
        // one-sided first and second differences either side agree
        const left1 = (z[k]! - m1[k]!) / e;
        const right1 = (p1[k]! - z[k]!) / e;
        expect(Math.abs(left1 - right1)).toBeLessThan(4 * e * scale);
        const left2 = (z[k]! - 2 * m1[k]! + m2[k]!) / (e * e);
        const right2 = (p2[k]! - 2 * p1[k]! + z[k]!) / (e * e);
        // second differences carry the third derivative times 3e, and rounding of about 1e-15 / e²
        expect(Math.abs(left2 - right2)).toBeLessThan(0.05 * scale);
        // the stored slope and second derivative are the finite differences'
        expect(Math.abs((p1[k]! - m1[k]!) / (2 * e) - a.d[i * width + k]!)).toBeLessThan(e * scale);
      }
    }
  });

  it('keeps monotone data monotone', () => {
    for (let trial = 0; trial < 20; trial++) {
      const r = rng(100 + trial);
      const n = 2 + Math.floor(r() * 8);
      const xs = stations(r, n);
      const q = new Float64Array(n);
      let v = 0;
      for (let i = 0; i < n; i++) {
        // rising, with flat steps and steep ones
        v += r() < 0.2 ? 0 : r() * r() * 30;
        q[i] = v;
      }
      const a = quinticAlong(xs, q, 1);
      const out = new Float64Array(1);
      let prev = -Infinity;
      for (let s = 0; s <= 2000; s++) {
        const x = xs[0]! - 1 + ((xs[n - 1]! - xs[0]! + 2) * s) / 2000;
        alongAt(a, x, out);
        expect(out[0]!).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(out[0]!).toBeLessThanOrEqual(q[n - 1]! + 1e-12);
        prev = out[0]!;
      }
    }
  });

  it("alongPolynomials give alongAt's values and derivatives", () => {
    const r = rng(23);
    for (const n of [1, 2, 5]) {
      const xs = stations(r, n);
      const width = 4;
      const q = Float64Array.from({ length: n * width }, () => r() * 10 - 5);
      const a = quinticAlong(xs, q, width);
      const poly = alongPolynomials(a);
      const out = new Float64Array(width);
      const d1 = new Float64Array(width);
      for (let s = 0; s <= 300; s++) {
        const x = xs[0]! + ((xs[n - 1]! - xs[0]!) * s) / 300;
        alongAt(a, x, out, d1);
        let i = 0;
        while (i + 2 < n && xs[i + 1]! <= x) i++;
        const h = n > 1 ? xs[i + 1]! - xs[i]! : 1;
        const t = (x - xs[i]!) / h;
        for (let k = 0; k < width; k++) {
          const c = poly.subarray((i * width + k) * 6, (i * width + k) * 6 + 6);
          const v = c[0]! + t * (c[1]! + t * (c[2]! + t * (c[3]! + t * (c[4]! + t * c[5]!))));
          const dv =
            (c[1]! + t * (2 * c[2]! + t * (3 * c[3]! + t * (4 * c[4]! + t * 5 * c[5]!)))) / h;
          expect(Math.abs(v - out[k]!)).toBeLessThan(1e-12 * (1 + Math.abs(out[k]!)));
          if (n > 1) expect(Math.abs(dv - d1[k]!)).toBeLessThan(1e-11 * (1 + Math.abs(d1[k]!)));
        }
      }
    }
  });
});
