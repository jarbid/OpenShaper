// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keyed curves and laws (docs/design/board2.md §5.2, §13.2 `law` row).
 *
 * Oracles, and what each one judges:
 *
 * - **Hermite closed form**: an all-auto curve is the piecewise cubic Hermite
 *   interpolant with the monotone slopes. The reference here evaluates the Hermite
 *   basis directly (no Bézier, no root finding), so it judges the Bézier
 *   construction, the third-of-segment handles and the root solve together.
 * - **Round trip**: points `(s(t), v(t))` taken from the Bézier by de Casteljau
 *   must come back through `evaluateLaw(s(t))`; this judges the bracketed Newton
 *   for arbitrary explicit handles, with no reference solver at all.
 * - **Properties**: keys reproduced bitwise; linear data reproduced; no overshoot
 *   of monotone data; C¹ across every key (one-sided slopes read off the resolved
 *   control points); smoothstep convergence at O(h³).
 * - **Soundness of the certificate**: whenever a densely sampled curve leaves a
 *   range, the control-polygon certificate must have flagged it.
 *
 * Tolerances: 1e-14 absolute against the closed form (values are O(1), the
 * difference is a few flops: design §13.2); 1e-12 on slope continuity (a
 * subtraction and a division of O(1) numbers); 1e-10 on the round trip (the
 * Newton step stop is geom's `paramRel` = 1e-12 in t, times a slope of at most
 * ~10 here).
 */
import { checksum, mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import {
  certifyLawRange,
  checkLawKeys,
  evaluateLaw,
  lawEvaluator,
  lawSegments,
  lawValueRange,
} from './law';
import type { KeyedCurve, LawCurve, LawKey } from './types';

const SEED = 20261021;
console.info(`law.test.ts seed ${SEED}`);

const rng = mulberry32(SEED);
const between = (a: number, b: number): number => a + (b - a) * rng();

/** Random half-domain keys: 0 and ½ plus `inner` random interior keys, random values. */
function randomHalf(inner: number, valueRange: readonly [number, number] = [0, 1]): LawCurve {
  const s = Array.from({ length: inner }, () => between(0.02, 0.48)).sort((a, b) => a - b);
  // Keep the keys apart so no segment is tiny.
  const spaced = s.filter((x, i) => i === 0 || x - s[i - 1]! > 0.01);
  const all = [0, ...spaced, 0.5];
  return {
    domain: 'half',
    keys: all.map((x) => ({ s: x, value: between(valueRange[0], valueRange[1]) })),
  };
}

/** Independent Hermite reference: slopes from the stated rule, evaluated in the Hermite basis. */
function hermiteReference(keys: readonly LawKey[], flatEnds: boolean): (x: number) => number {
  const n = keys.length;
  const secant = (i: number): number =>
    (keys[i + 1]!.value - keys[i]!.value) / (keys[i + 1]!.s - keys[i]!.s);
  const m = keys.map((_, k) => {
    if (flatEnds && (k === 0 || k === n - 1)) return 0;
    const a = secant(k - 1);
    const b = secant(k);
    if (a * b <= 0) return 0;
    const ha = keys[k]!.s - keys[k - 1]!.s;
    const hb = keys[k + 1]!.s - keys[k]!.s;
    const three = (hb * a + ha * b) / (ha + hb);
    return Math.sign(three) * Math.min(Math.abs(three), 3 * Math.abs(a), 3 * Math.abs(b));
  });
  return (x) => {
    let k = 0;
    while (k < n - 2 && x >= keys[k + 1]!.s) k++;
    const h = keys[k + 1]!.s - keys[k]!.s;
    const t = (x - keys[k]!.s) / h;
    const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
    const h10 = t * (1 - t) * (1 - t);
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    return h00 * keys[k]!.value + h10 * h * m[k]! + h01 * keys[k + 1]!.value + h11 * h * m[k + 1]!;
  };
}

/**
 * Independent Hermite reference for a full (periodic) domain: cyclic neighbours,
 * the wrap segment of length `s0 + 1 - s_last`, evaluated in the Hermite basis.
 */
function hermiteCyclic(keys: readonly LawKey[]): (x: number) => number {
  const n = keys.length;
  const len = (k: number): number =>
    k + 1 < n ? keys[k + 1]!.s - keys[k]!.s : keys[0]!.s + 1 - keys[n - 1]!.s;
  const secant = (k: number): number => (keys[(k + 1) % n]!.value - keys[k]!.value) / len(k);
  const m = keys.map((_, k) => {
    const l = (k + n - 1) % n;
    const a = secant(l);
    const b = secant(k);
    if (a * b <= 0) return 0;
    const three = (len(k) * a + len(l) * b) / (len(l) + len(k));
    return Math.sign(three) * Math.min(Math.abs(three), 3 * Math.abs(a), 3 * Math.abs(b));
  });
  return (x) => {
    let k = n - 1; // the wrap segment holds x below the first key
    for (let j = 0; j < n; j++) if (x >= keys[j]!.s) k = j;
    const s0 = keys[k]!.s;
    const h = len(k);
    const t = (x >= s0 ? x - s0 : x + 1 - s0) / h;
    const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
    const h10 = t * (1 - t) * (1 - t);
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    return (
      h00 * keys[k]!.value +
      h10 * h * m[k]! +
      h01 * keys[(k + 1) % n]!.value +
      h11 * h * m[(k + 1) % n]!
    );
  };
}

describe('auto ease: the monotone cubic Hermite closed form', () => {
  it('matches the Hermite reference on 40 random half-domain laws (1e-14)', () => {
    let worst = 0;
    for (let trial = 0; trial < 40; trial++) {
      const law = randomHalf(2 + (trial % 6));
      const ref = hermiteReference(law.keys, true);
      const f = lawEvaluator(law);
      for (let i = 0; i <= 400; i++) {
        const x = 0.5 * (i / 400);
        worst = Math.max(worst, Math.abs(f(x) - ref(x)));
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-14);
  });

  it('matches the reference on open (feature) curves, also with negative and mixed values', () => {
    for (let trial = 0; trial < 20; trial++) {
      const n = 3 + (trial % 5);
      const xs = Array.from({ length: n }, (_, i) => 10 * i + between(0, 4));
      const curve: KeyedCurve = { keys: xs.map((s) => ({ s, value: between(-2, 2) })) };
      const ref = hermiteReference(curve.keys, true);
      const f = lawEvaluator(curve);
      for (let i = 0; i <= 200; i++) {
        const x = xs[0]! + ((xs[n - 1]! - xs[0]!) * i) / 200;
        expect(Math.abs(f(x) - ref(x))).toBeLessThanOrEqual(1e-14);
      }
    }
  });

  it('full-domain laws match the cyclic Hermite reference, across the wrap (5e-14)', () => {
    let worst = 0;
    for (let trial = 0; trial < 30; trial++) {
      const n = 3 + (trial % 5);
      const s = Array.from({ length: n }, (_, i) => (i + between(0.05, 0.9)) / n);
      const keys = s.map((x) => ({ s: x, value: between(-1, 2) }));
      const f = lawEvaluator({ domain: 'full', keys });
      const ref = hermiteCyclic(keys);
      for (let i = 0; i < 500; i++) {
        const x = i / 500;
        worst = Math.max(worst, Math.abs(f(x) - ref(x)));
      }
      // the wrap: just either side of sigma = 1 / 0
      worst = Math.max(worst, Math.abs(f(1 - 1e-9) - ref(1 - 1e-9)));
    }
    // Values span up to 3 and the Bezier route adds a root solve plus wrap shifts, so a few
    // tens of ulps of the value range: 5e-14 (measured worst ~1e-14).
    expect(worst).toBeLessThanOrEqual(5e-14);
  });

  it('pins the slope rule by hand-computed handles (exact arithmetic on small cases)', () => {
    // Half: keys (0,0) (0.1,1) (0.5,3). Interior secants 10 and 5, h = 0.1 and 0.4,
    // weighted slope (0.4*10 + 0.1*5)/0.5 = 9 (below the 3*5 = 15 box).
    // Handles reach 1/3 of the segment: v = 1 - 9*0.1/3 = 0.7 and 1 + 9*0.4/3 = 2.2.
    const half = lawSegments({
      domain: 'half',
      keys: [
        { s: 0, value: 0 },
        { s: 0.1, value: 1 },
        { s: 0.5, value: 3 },
      ],
    });
    expect(half[0]!.v[2]).toBeCloseTo(0.7, 14);
    expect(half[1]!.v[1]).toBeCloseTo(2.2, 14);
    // Box clamp: secants 10 and 0.05 give 8.01, limited to 3*0.05 = 0.15: v = 1 + 0.15*0.4/3 = 1.02.
    const boxed = lawSegments({
      domain: 'half',
      keys: [
        { s: 0, value: 0 },
        { s: 0.1, value: 1 },
        { s: 0.5, value: 1.02 },
      ],
    });
    expect(boxed[1]!.v[1]).toBeCloseTo(1.02, 14);
    expect(boxed[0]!.v[2]).toBeCloseTo(1 - (0.15 * 0.1) / 3, 14);
    // Full: s (0, .2, .5, .7), values (0, 1, 3, 2); wrap length 0.3. Key 3 has secants
    // -5 (h .2) and -20/3 (wrap, h .3): slope (0.3*-5 + 0.2*-20/3)/0.5 = -17/3; key 0 is an
    // extremum (slope 0). Wrap segment: v = 2, 2 - (17/3)*0.3/3, 0, 0.
    const full = lawSegments({
      domain: 'full',
      keys: [
        { s: 0, value: 0 },
        { s: 0.2, value: 1 },
        { s: 0.5, value: 3 },
        { s: 0.7, value: 2 },
      ],
    });
    const wrap = full[3]!;
    expect(wrap.v[0]).toBe(2);
    expect(wrap.v[1]).toBeCloseTo(2 - (17 / 3) * 0.1, 14);
    expect(wrap.v[2]).toBe(0);
    expect(wrap.v[3]).toBe(0);
    expect(wrap.s[3]).toBeCloseTo(1, 15);
  });

  it('reproduces every key value exactly (===), in all three kinds', () => {
    const half = randomHalf(5);
    for (const k of half.keys) expect(evaluateLaw(half, k.s)).toBe(k.value);
    const full: LawCurve = {
      domain: 'full',
      keys: [0.05, 0.3, 0.55, 0.8].map((s) => ({ s, value: between(0, 1) })),
    };
    for (const k of full.keys) expect(evaluateLaw(full, k.s)).toBe(k.value);
    const open: KeyedCurve = { keys: [3, 8, 20].map((s) => ({ s, value: between(0, 1) })) };
    for (const k of open.keys) expect(evaluateLaw(open, k.s)).toBe(k.value);
  });

  it('a constant law is constant everywhere (bitwise)', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0.4 },
        { s: 0.2, value: 0.4 },
        { s: 0.5, value: 0.4 },
      ],
    };
    for (let i = 0; i <= 100; i++) expect(evaluateLaw(law, i / 100)).toBe(0.4);
  });

  it('reproduces linear data on segments between two interior keys (the 3-point slope is the secant)', () => {
    const slope = 1.75;
    const xs = [0, 0.1, 0.17, 0.3, 0.41, 0.5];
    const law: LawCurve = {
      domain: 'half',
      keys: xs.map((s) => ({ s, value: 0.2 + slope * s })),
    };
    // Segments 1..3 have interior keys at both ends; segments 0 and 4 meet a flat tip.
    for (let i = 0; i <= 300; i++) {
      const x = 0.1 + (0.31 * i) / 300;
      expect(Math.abs(evaluateLaw(law, x) - (0.2 + slope * x))).toBeLessThanOrEqual(1e-14);
    }
  });

  it('never overshoots monotone data and stays monotone (dense, 30 random laws)', () => {
    for (let trial = 0; trial < 30; trial++) {
      const n = 4 + (trial % 5);
      // Strictly increasing values with very uneven steps provoke the limiter.
      let v = 0;
      const keys: LawKey[] = Array.from({ length: n }, (_, i) => {
        v += i === 0 ? 0 : Math.pow(10, between(-2, 1));
        return { s: (0.5 * i) / (n - 1), value: v };
      });
      const f = lawEvaluator({ domain: 'half', keys });
      let prev = -Infinity;
      for (let i = 0; i <= 2000; i++) {
        const y = f((0.5 * i) / 2000);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-13 * v);
        expect(y).toBeGreaterThanOrEqual(0 - 1e-13 * v);
        expect(y).toBeLessThanOrEqual(v * (1 + 1e-13));
        prev = y;
      }
    }
  });

  it('is C¹ at every key: one-sided slopes from the resolved control points agree (1e-12)', () => {
    for (let trial = 0; trial < 30; trial++) {
      const law = randomHalf(2 + (trial % 5));
      const segs = lawSegments(law);
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1]!;
        const b = segs[i]!;
        const left = (a.v[3] - a.v[2]) / (a.s[3] - a.s[2]);
        const right = (b.v[1] - b.v[0]) / (b.s[1] - b.s[0]);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it('half domain: flat at both tips (C¹ across σ = 0 and ½), mirrored onto (½, 1)', () => {
    const law = randomHalf(4);
    const segs = lawSegments(law);
    expect(segs[0]!.v[1]).toBe(segs[0]!.v[0]);
    expect(segs[segs.length - 1]!.v[2]).toBe(segs[segs.length - 1]!.v[3]);
    const f = lawEvaluator(law);
    for (let i = 1; i < 200; i++) {
      const x = (0.5 * i) / 200;
      // v(1 − σ) = v(σ); 1 − (1 − σ) is not bitwise σ, hence a tolerance of a few ulps × slope.
      expect(Math.abs(f(1 - x) - f(x))).toBeLessThanOrEqual(1e-14);
      // Periodic in σ.
      expect(f(x + 1)).toBeCloseTo(f(x), 12);
      expect(f(x - 3)).toBeCloseTo(f(x), 12);
    }
  });

  it('full domain: keys wrap, the curve is C¹ across σ = 1 and periodic', () => {
    for (let trial = 0; trial < 20; trial++) {
      const n = 3 + (trial % 4);
      const s = Array.from({ length: n }, (_, i) => (i + between(0.05, 0.9)) / n);
      const law: LawCurve = {
        domain: 'full',
        keys: s.map((x) => ({ s: x, value: between(0, 1) })),
      };
      const segs = lawSegments(law);
      expect(segs).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        const a = segs[i]!;
        const b = segs[(i + 1) % n]!;
        const left = (a.v[3] - a.v[2]) / (a.s[3] - a.s[2]);
        const right = (b.v[1] - b.v[0]) / (b.s[1] - b.s[0]);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-12);
      }
      const f = lawEvaluator(law);
      for (let i = 0; i <= 50; i++) {
        const x = i / 50;
        expect(f(x + 1)).toBeCloseTo(f(x), 12);
      }
      // The wrap segment: value at s = 0 lies between the neighbouring keys' values (no overshoot).
      const lo = Math.min(law.keys[n - 1]!.value, law.keys[0]!.value);
      const hi = Math.max(law.keys[n - 1]!.value, law.keys[0]!.value);
      const y = f(0);
      expect(y).toBeGreaterThanOrEqual(lo - 1e-14);
      expect(y).toBeLessThanOrEqual(hi + 1e-14);
    }
  });

  it('smoothstep keys converge at O(h³): halving h divides the error by ≥ 7.9 (measured 8.0001 to 8.0012)', () => {
    // g(x) = 3x² − 2x³ is monotone with g'(0) = g'(1) = 0, so the zero end slopes are exact
    // and the only error is the 3-point slope's O(h²) times the step h.
    const g = (x: number): number => 3 * x * x - 2 * x * x * x;
    const err: number[] = [];
    for (const n of [9, 17, 33, 65]) {
      const keys: LawKey[] = Array.from({ length: n }, (_, i) => {
        const x = i / (n - 1);
        return { s: 0.5 * x, value: g(x) };
      });
      const f = lawEvaluator({ domain: 'half', keys });
      let worst = 0;
      for (let i = 0; i <= 4000; i++) {
        const x = i / 4000;
        worst = Math.max(worst, Math.abs(f(0.5 * x) - g(x)));
      }
      err.push(worst);
    }
    for (let i = 1; i < err.length; i++) expect(err[i - 1]! / err[i]!).toBeGreaterThanOrEqual(7.9);
  });
});

/** de Casteljau, independent of the module's Bernstein form. */
function deCasteljau(p: readonly number[], t: number): number {
  let q = [...p];
  while (q.length > 1) q = q.slice(1).map((x, i) => (1 - t) * q[i]! + t * x);
  return q[0]!;
}

describe('explicit handles: the root solve', () => {
  it('round trip: evaluating at s(t) returns v(t) for random valid handles (1e-10)', () => {
    let worst = 0;
    for (let trial = 0; trial < 60; trial++) {
      const h = between(0.1, 0.3);
      // ds in [h/20, h/2): the sum stays below h, the σ-derivative stays positive.
      const outDs = between(h / 20, h * 0.45);
      const inDs = between(h / 20, h * 0.45);
      const law: LawCurve = {
        domain: 'half',
        keys: [
          { s: 0, value: 0.3, out: { ds: outDs, dv: 0 } },
          {
            s: h,
            value: between(0, 1),
            in: { ds: inDs, dv: between(-0.3, 0.3) },
            out: { ds: between(h / 20, h), dv: between(-0.3, 0.3) },
          },
          { s: 0.5, value: between(0, 1), in: { ds: (0.5 - h) / 3, dv: 0 } },
        ],
      };
      const seg = lawSegments(law)[0]!;
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const x = deCasteljau(seg.s, t);
        const v = deCasteljau(seg.v, t);
        worst = Math.max(worst, Math.abs(evaluateLaw(law, x) - v));
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-10);
  });

  it('handles that fill the segment exactly (σ′ vanishes nowhere but is smallest mid-segment) still solve', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0, out: { ds: 0.25, dv: 0 } },
        { s: 0.5, value: 1, in: { ds: 0.25, dv: 0 } },
      ],
    };
    const seg = lawSegments(law)[0]!;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      expect(
        Math.abs(evaluateLaw(law, deCasteljau(seg.s, t)) - deCasteljau(seg.v, t)),
      ).toBeLessThanOrEqual(1e-10);
    }
  });

  it('a zero-length handle (ds = 0, vertical start) falls back to bisection and stays correct', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0, out: { ds: 0, dv: 0 } },
        { s: 0.5, value: 1 },
      ],
    };
    const seg = lawSegments(law)[0]!;
    for (let i = 4; i <= 40; i++) {
      const t = i / 40;
      expect(
        Math.abs(evaluateLaw(law, deCasteljau(seg.s, t)) - deCasteljau(seg.v, t)),
      ).toBeLessThanOrEqual(1e-9);
    }
  });

  it('one explicit and one auto handle on the same segment mix as stated', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0, out: { ds: 0.1, dv: 0.2 } },
        { s: 0.5, value: 1 },
      ],
    };
    const seg = lawSegments(law)[0]!;
    expect(seg.s).toEqual([0, 0.1, 0.5 - 0.5 / 3, 0.5]);
    expect(seg.v[1]).toBe(0.2);
    expect(seg.v[2]).toBe(1); // the end key's auto slope is zero (flat tip)
  });
});

describe('open keyed curves (feature depths)', () => {
  const depth: KeyedCurve = {
    keys: [
      { s: 40, value: 0 },
      { s: 100, value: 0.3 },
      { s: 160, value: 0 },
    ],
  };

  it('is zero outside the first and last key, and takes the key values at the keys', () => {
    expect(evaluateLaw(depth, 39.999)).toBe(0);
    expect(evaluateLaw(depth, 160.001)).toBe(0);
    expect(evaluateLaw(depth, -1e6)).toBe(0);
    expect(evaluateLaw(depth, 100)).toBe(0.3);
    expect(evaluateLaw(depth, 40)).toBe(0);
  });

  it('a symmetric depth is symmetric about its peak (closed form: both slopes zero ⇒ smoothstep)', () => {
    // Keys 0, 0.3, 0 have a peak at the middle key: slope 0 there; the ends are flat.
    for (let i = 0; i <= 60; i++) {
      const x = 40 + i;
      expect(Math.abs(evaluateLaw(depth, x) - evaluateLaw(depth, 200 - x))).toBeLessThanOrEqual(
        1e-14,
      );
    }
    // Midpoint of the first segment: smoothstep(0.5) = 0.5 of the rise.
    expect(evaluateLaw(depth, 70)).toBeCloseTo(0.15, 14);
  });
});

describe('contract errors', () => {
  it('fewer than two keys throws RangeError; a non-finite abscissa throws RangeError', () => {
    expect(() => lawSegments({ keys: [{ s: 0, value: 1 }] })).toThrow(RangeError);
    expect(() => evaluateLaw({ domain: 'half', keys: [] }, 0.1)).toThrow(RangeError);
    const f = lawEvaluator({
      keys: [
        { s: 0, value: 1 },
        { s: 1, value: 2 },
      ],
    });
    expect(() => f(Number.NaN)).toThrow(RangeError);
    expect(() => f(Infinity)).toThrow(RangeError);
  });

  it('inputs are never mutated and results are frozen (checksum before and after)', () => {
    const law = randomHalf(4);
    const before = checksum(law);
    lawSegments(law);
    lawEvaluator(law)(0.2);
    checkLawKeys(law);
    certifyLawRange(law, 0, 1);
    lawValueRange(law);
    expect(checksum(law)).toBe(before);
    expect(Object.isFrozen(lawSegments(law))).toBe(true);
    expect(Object.isFrozen(lawSegments(law)[0])).toBe(true);
  });

  it('is deterministic: same input, same bits', () => {
    const law = randomHalf(5);
    const a = Array.from({ length: 50 }, (_, i) => evaluateLaw(law, i / 100));
    const b = Array.from({ length: 50 }, (_, i) => evaluateLaw(law, i / 100));
    expect(a).toEqual(b);
  });
});

describe('checkLawKeys: structure', () => {
  const good = (): LawCurve => ({
    domain: 'half',
    keys: [
      { s: 0, value: 1 },
      { s: 0.2, value: 2 },
      { s: 0.5, value: 1 },
    ],
  });
  const codes = (law: KeyedCurve | LawCurve): string[] => checkLawKeys(law).map((i) => i.code);

  it('accepts well-formed laws of every kind', () => {
    expect(codes(good())).toEqual([]);
    expect(
      codes({
        domain: 'full',
        keys: [
          { s: 0, value: 1 },
          { s: 0.5, value: 2 },
        ],
      }),
    ).toEqual([]);
    expect(
      codes({
        keys: [
          { s: -3, value: 1 },
          { s: 7, value: 2 },
        ],
      }),
    ).toEqual([]);
    expect(codes(randomHalf(6))).toEqual([]);
  });

  it('rejects each structural fault with its code (negative controls)', () => {
    const cases: [string, KeyedCurve | LawCurve, string][] = [
      ['one key', { domain: 'half', keys: [{ s: 0, value: 1 }] }, 'law-keys-unsorted'],
      [
        'unsorted',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1 },
            { s: 0.3, value: 1 },
            { s: 0.2, value: 1 },
            { s: 0.5, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'duplicate s',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1 },
            { s: 0.2, value: 1 },
            { s: 0.2, value: 2 },
            { s: 0.5, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'no key at 0',
        {
          domain: 'half',
          keys: [
            { s: 0.1, value: 1 },
            { s: 0.5, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'no key at ½',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1 },
            { s: 0.4, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'key past ½',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1 },
            { s: 0.5, value: 1 },
            { s: 0.6, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'full key at 1',
        {
          domain: 'full',
          keys: [
            { s: 0, value: 1 },
            { s: 1, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'NaN value',
        {
          domain: 'half',
          keys: [
            { s: 0, value: Number.NaN },
            { s: 0.5, value: 1 },
          ],
        },
        'doc-malformed',
      ],
      [
        'infinite s',
        {
          keys: [
            { s: 0, value: 1 },
            { s: Infinity, value: 1 },
          ],
        },
        'doc-malformed',
      ],
      [
        'negative handle length',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1, out: { ds: -0.1, dv: 0 } },
            { s: 0.5, value: 1 },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'overlapping handles',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1, out: { ds: 0.3, dv: 0 } },
            { s: 0.5, value: 1, in: { ds: 0.3, dv: 0 } },
          ],
        },
        'law-keys-unsorted',
      ],
      [
        'sloped leaving tail tip',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1, out: { ds: 0.1, dv: 0.2 } },
            { s: 0.5, value: 1 },
          ],
        },
        'law-tip-slope',
      ],
      [
        'sloped arriving at nose tip',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1 },
            { s: 0.5, value: 1, in: { ds: 0.1, dv: -0.2 } },
          ],
        },
        'law-tip-slope',
      ],
      [
        'vertical tip handle',
        {
          domain: 'half',
          keys: [
            { s: 0, value: 1, out: { ds: 0, dv: 0.2 } },
            { s: 0.5, value: 1 },
          ],
        },
        'law-tip-slope',
      ],
    ];
    for (const [name, law, code] of cases) {
      expect(codes(law), name).toContain(code);
    }
  });

  it('accepts handles that fill the segment exactly, rejects one ulp-scale-beyond-paramRel more', () => {
    const exact = (extra: number): LawCurve => ({
      domain: 'half',
      keys: [
        { s: 0, value: 1, out: { ds: 0.25 + extra, dv: 0 } },
        { s: 0.5, value: 1, in: { ds: 0.25, dv: 0 } },
      ],
    });
    expect(codes(exact(0))).toEqual([]);
    expect(codes(exact(1e-6))).toContain('law-keys-unsorted');
  });

  it('a degenerate zero-length tip handle defers to the next control point for flatness', () => {
    // P1 = P0 (no handle), P2 on the same value: tangent direction is P2 − P0, horizontal: flat.
    const flat: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 1, out: { ds: 0, dv: 0 } },
        { s: 0.5, value: 1, in: { ds: 0.1, dv: 0 } },
      ],
    };
    expect(codes(flat)).toEqual([]);
    const sloped: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 1, out: { ds: 0, dv: 0 } },
        { s: 0.5, value: 2, in: { ds: 0.1, dv: 0.5 } },
      ],
    };
    // P2 = (0.4, 1.5): the tangent at the start is sloped.
    expect(codes(sloped)).toContain('law-tip-slope');
  });

  it('judges tip flatness on the slope, not on the handle height', () => {
    const tip = (ds: number, dv: number): LawCurve => ({
      domain: 'half',
      keys: [
        { s: 0, value: 5, out: { ds, dv } },
        { s: 0.5, value: 5 },
      ],
    });
    // Slope 4e-3 with a tiny dv: not flat (the old absolute test accepted it).
    expect(codes(tip(1e-12, 4e-15))).toContain('law-tip-slope');
    // Rounding-sized slope: flat.
    expect(codes(tip(0.2, 5 * Number.EPSILON))).toEqual([]);
  });

  it('is total on tolerances geom rejects (falls back to the defaults)', () => {
    expect(() => checkLawKeys(good(), {}, { paramRel: -1 })).not.toThrow();
    expect(checkLawKeys(good(), {}, { paramRel: -1 })).toEqual([]);
  });

  it('locates issues by lane, key and σ', () => {
    const base = good();
    const law: LawCurve = {
      ...base,
      keys: [base.keys[0]!, { s: 0.2, value: 2, out: { ds: 0.5, dv: 0 } }, base.keys[2]!],
    };
    const [issue] = checkLawKeys(law, { lane: 'apexHeight' });
    expect(issue!.at).toMatchObject({ lane: 'apexHeight', key: 1 });
  });
});

describe('certifyLawRange: the convex-hull certificate', () => {
  it('auto laws certify exactly their key range (no slack needed beyond rounding)', () => {
    for (let trial = 0; trial < 60; trial++) {
      const law = randomHalf(2 + (trial % 6), [0.05, 1]);
      const vs = law.keys.map((k) => k.value);
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      expect(certifyLawRange(law, lo, hi)).toEqual([]);
      const [rlo, rhi] = lawValueRange(law);
      expect(rlo).toBeGreaterThanOrEqual(lo - 1e-15);
      expect(rhi).toBeLessThanOrEqual(hi + 1e-15);
    }
  });

  it('range bounds touching a key value exactly (the boundary of a lane) are accepted', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 1 },
        { s: 0.25, value: 0.05 },
        { s: 0.5, value: 1 },
      ],
    };
    expect(certifyLawRange(law, 0.05, 1)).toEqual([]);
  });

  it('rejects an overshooting handle even when every key is in range, locating the segment', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0.5 },
        { s: 0.25, value: 0.5, out: { ds: 0.05, dv: 0.6 } },
        { s: 0.5, value: 0.5 },
      ],
    };
    const issues = certifyLawRange(law, 0, 1, { lane: 'upperFullness' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'law-out-of-range',
      at: { lane: 'upperFullness', key: 1 },
    });
    expect(issues[0]!.value).toBeCloseTo(1.1, 14);
  });

  it('is sound: whenever the sampled curve leaves the range, the certificate flags it', () => {
    let leaving = 0;
    for (let trial = 0; trial < 200; trial++) {
      const law: LawCurve = {
        domain: 'half',
        keys: [
          { s: 0, value: between(0.3, 0.7) },
          {
            s: 0.25,
            value: between(0.3, 0.7),
            in: { ds: between(0.02, 0.1), dv: between(-1.5, 1.5) },
            out: { ds: between(0.02, 0.1), dv: between(-1.5, 1.5) },
          },
          { s: 0.5, value: between(0.3, 0.7) },
        ],
      };
      const f = lawEvaluator(law);
      let outside = false;
      for (let i = 0; i <= 1000; i++) {
        const y = f((0.5 * i) / 1000);
        if (y < 0 || y > 1) outside = true;
      }
      const flagged = certifyLawRange(law, 0, 1).length > 0;
      if (outside) {
        leaving++;
        expect(flagged).toBe(true);
      }
    }
    // The property is not vacuous: some random laws did leave the range.
    expect(leaving).toBeGreaterThan(40); // measured 90 of 200
  });

  it('unbounded above (the inset lanes) accepts large values and rejects low ones', () => {
    const law: LawCurve = {
      domain: 'half',
      keys: [
        { s: 0, value: 0.2 },
        { s: 0.5, value: 50 },
      ],
    };
    expect(certifyLawRange(law, 0.1, Infinity)).toEqual([]);
    expect(certifyLawRange(law, 0.3, Infinity)).toHaveLength(1);
  });
});
