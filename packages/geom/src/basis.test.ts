// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Basis oracles (design §16, `basis` rows):
 * - P&T Ex. 2.3 / 2.4 values and derivatives, exact in binary: bitwise;
 * - Bézier knots give Bernstein polynomials and their closed-form derivatives;
 * - A2.4 (an independent algorithm) against A2.2 / A2.3, clamped and periodic;
 * - partition of unity, non-negativity, derivative sums 0;
 * - `findSpan` against a linear scan, at every knot, both sides;
 * - every validation rule rejects what it should.
 *
 * Tolerances: values `4(p+1)ε` absolute (A2.2 sums p + 1 terms of O(1)
 * relative error). Derivative sums are measured against the sum of the
 * absolute terms (cancellation is the only error). Bernstein derivatives:
 * `4(p+1)ε · p!/(p−k)! · 2^k` (the k-th derivative is p!/(p−k)! times an
 * alternating sum of 2^k unit-bounded terms).
 */
import { describe, expect, it } from 'vitest';
import {
  basisDersInto,
  basisFunction,
  basisFunsInto,
  breakpoints,
  clampedBasis,
  clampedUniformKnots,
  createScratch,
  findSpan,
  isGeomError,
  knotMultiplicities,
  knotsFromBreaks,
  mergeNearKnots,
  periodicBasis,
  periodicUniformKnots,
} from './index';
import type { Basis, GeomErrorCode } from './index';
import { mulberry32, randomClampedBasis, randomPeriodicBasis } from './testing';

const EPS = Number.EPSILON;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function falling(p: number, k: number): number {
  let r = 1;
  for (let j = 0; j < k; j++) r *= p - j;
  return r;
}

/** Basis values and derivatives at t (right-hand span), as rows. */
function ders(b: Basis, t: number, nDer: number): number[][] {
  const p = b.degree;
  const span = findSpan(b, t);
  const out = new Float64Array((nDer + 1) * (p + 1));
  basisDersInto(b, span, t, nDer, out, 0, createScratch({ maxDegree: p }));
  return Array.from({ length: nDer + 1 }, (_, k) =>
    Array.from(out.subarray(k * (p + 1), (k + 1) * (p + 1))),
  );
}

describe('clampedBasis validation', () => {
  it('accepts a valid vector and freezes it', () => {
    const b = clampedBasis(2, [0, 0, 0, 1, 2, 3, 4, 4, 5, 5, 5]);
    expect(b.kind).toBe('clamped');
    expect(b.count).toBe(8);
    expect(b.domain).toEqual([0, 5]);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.domain)).toBe(true);
  });

  it('copies the caller knots', () => {
    const U = [0, 0, 1, 1];
    const b = clampedBasis(1, U);
    U[1] = 0.5;
    expect(b.knots[1]).toBe(0);
  });

  it('rejects each broken rule with its code', () => {
    expectCode(() => clampedBasis(0, [0, 1]), 'invalid-degree');
    expectCode(() => clampedBasis(1.5, [0, 0, 1, 1]), 'invalid-degree');
    expectCode(() => clampedBasis(2, [0, 0, 0, 1, 1]), 'knot-count');
    expectCode(() => clampedBasis(1, [0, 0, NaN, 1, 1]), 'non-finite');
    expectCode(() => clampedBasis(1, [0, 0, 0.6, 0.4, 1, 1]), 'knots-decreasing');
    expectCode(() => clampedBasis(2, [0, 0, 0.1, 0.5, 1, 1, 1]), 'knots-not-clamped');
    expectCode(() => clampedBasis(1, [0, 0, 0, 0]), 'empty-domain');
    expectCode(() => clampedBasis(2, [0, 0, 0, 0, 1, 1, 1]), 'knot-multiplicity'); // start p + 2
    expectCode(() => clampedBasis(2, [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1]), 'knot-multiplicity');
    expectCode(() => clampedBasis(1, [0, 0, 0.5, 0.5 + 5e-11, 1, 1]), 'knots-near-coincident');
  });

  it('places the near-coincidence threshold at knotRel × domain', () => {
    // knotRel = 1e-10; on [0, 10] the threshold is 1e-9.
    expectCode(() => clampedBasis(1, [0, 0, 5, 5 + 0.9e-9, 10, 10]), 'knots-near-coincident');
    expect(() => clampedBasis(1, [0, 0, 5, 5 + 1.1e-9, 10, 10])).not.toThrow();
    expect(() => clampedBasis(1, [0, 0, 5, 5 + 0.9e-9, 10, 10], { knotRel: 1e-11 })).not.toThrow();
  });
});

describe('periodicBasis validation', () => {
  it('accepts one period and derives the domain', () => {
    const b = periodicBasis(3, [0, 0.25, 0.5, 0.75], 1);
    expect(b.kind).toBe('periodic');
    expect(b.count).toBe(4);
    expect(b.domain).toEqual([0, 1]);
    expect(b.period).toBe(1);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('rejects each broken rule with its code', () => {
    expectCode(() => periodicBasis(2, [0, 0.5], 1), 'knot-count');
    expectCode(() => periodicBasis(1, [0, 0.5, 1], 1), 'knots-decreasing'); // t_{n−1} = t_0 + T
    expectCode(() => periodicBasis(1, [0, 0.5], 0), 'empty-domain');
    expectCode(() => periodicBasis(1, [0, 0.5], NaN), 'non-finite');
    expectCode(() => periodicBasis(2, [0, 0.5, 0.5, 0.5], 1), 'knot-multiplicity');
    // Near-coincidence across the seam: t_{n−1} against t_0 + T.
    expectCode(() => periodicBasis(1, [0, 0.5, 1 - 5e-11], 1), 'knots-near-coincident');
  });

  it('allows multiplicity p at the seam (a sharp tip on a loop)', () => {
    expect(() => periodicBasis(2, [0, 0, 0.5], 1)).not.toThrow();
  });
});

describe('knot generators and queries', () => {
  it('clampedUniformKnots spaces the interior evenly between exact ends', () => {
    expect(Array.from(clampedUniformKnots(2, 5, [1, 3]))).toEqual([
      1,
      1,
      1,
      1 + 2 / 3,
      1 + 4 / 3,
      3,
      3,
      3,
    ]);
    expect(Array.from(clampedUniformKnots(3, 4))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expectCode(() => clampedUniformKnots(3, 3), 'too-few-points');
  });

  it('periodicUniformKnots gives t_i = i·T/n', () => {
    expect(Array.from(periodicUniformKnots(4, 2))).toEqual([0, 0.5, 1, 1.5]);
  });

  it('knotsFromBreaks expands multiplicities and validates', () => {
    expect(Array.from(knotsFromBreaks([0, 1, 2], [3, 2, 3]))).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
    expectCode(() => knotsFromBreaks([0, 1], [1]), 'size-mismatch');
    expectCode(() => knotsFromBreaks([0, 0], [1, 1]), 'knots-decreasing');
    expectCode(() => knotsFromBreaks([0, 1], [1, 0]), 'knot-multiplicity');
  });

  it('knotMultiplicities and breakpoints read the stored vector', () => {
    const b = clampedBasis(2, [0, 0, 0, 1, 1, 2, 3, 3, 3]);
    const m = knotMultiplicities(b);
    expect(Array.from(m.values)).toEqual([0, 1, 2, 3]);
    expect(Array.from(m.mults)).toEqual([3, 2, 1, 3]);
    expect(Array.from(breakpoints(b))).toEqual([0, 1, 2, 3]);
    const pb = periodicBasis(2, [0, 0, 0.5, 0.7], 1);
    expect(Array.from(breakpoints(pb))).toEqual([0, 0.5, 0.7]);
    expect(Array.from(knotMultiplicities(pb).mults)).toEqual([2, 1, 1]);
  });

  it('mergeNearKnots snaps clusters and keeps the domain ends', () => {
    const U = [0, 0, 0, 1e-12, 0.5, 0.5 + 1e-12, 0.5 + 1e-12, 1 - 1e-12, 1, 1, 1];
    const r = mergeNearKnots(U);
    // The start cluster snaps to 0, the end cluster to 1, the interior one to its most
    // frequent value.
    expect(Array.from(r.knots)).toEqual([
      0,
      0,
      0,
      0,
      0.5 + 1e-12,
      0.5 + 1e-12,
      0.5 + 1e-12,
      1,
      1,
      1,
      1,
    ]);
    expect(r.moved).toBe(3);
    expect(() =>
      clampedBasis(2, mergeNearKnots([0, 0, 0, 0.5, 0.5 + 1e-12, 1, 1, 1]).knots),
    ).not.toThrow();
  });
});

describe('P&T examples 2.3 and 2.4 (bitwise: exact in binary)', () => {
  const b = clampedBasis(2, [0, 0, 0, 1, 2, 3, 4, 4, 5, 5, 5]);

  it('finds span 4 at u = 5/2 and N = (1/8, 6/8, 1/8)', () => {
    expect(findSpan(b, 2.5)).toBe(4);
    const N = new Float64Array(3);
    basisFunsInto(b, 4, 2.5, N, 0, createScratch({ maxDegree: 2 }));
    expect(Array.from(N)).toEqual([1 / 8, 6 / 8, 1 / 8]);
  });

  it('gives the derivatives (−1/2, 0, 1/2), (1, −2, 1) and zero third derivatives', () => {
    expect(ders(b, 2.5, 3)).toEqual([
      [1 / 8, 6 / 8, 1 / 8],
      [-1 / 2, 0, 1 / 2],
      [1, -2, 1],
      [0, 0, 0],
    ]);
  });
});

describe('Bézier knots give Bernstein polynomials', () => {
  const bern = (n: number, i: number, t: number): number =>
    i < 0 || i > n ? 0 : choose(n, i) * t ** i * (1 - t) ** (n - i);
  /** d^k/dt^k B_{i,p} = p!/(p−k)! Σ_j (−1)^j C(k,j) B_{i−k+j, p−k}. */
  const bernDer = (p: number, i: number, k: number, t: number): number => {
    let s = 0;
    for (let j = 0; j <= k; j++) s += (-1) ** j * choose(k, j) * bern(p - k, i - k + j, t);
    return falling(p, k) * s;
  };

  it('values and derivatives match the closed forms', () => {
    for (const p of [1, 2, 3, 5, 7]) {
      const b = clampedBasis(p, [...Array(p + 1).fill(0), ...Array(p + 1).fill(1)]);
      for (let s = 0; s <= 16; s++) {
        const t = s / 16;
        const D = ders(b, t, 3);
        for (let k = 0; k <= 3; k++) {
          const tol = 4 * (p + 1) * EPS * falling(p, k) * 2 ** k;
          for (let i = 0; i <= p; i++) {
            expect(
              Math.abs(D[k]![i]! - bernDer(p, i, k, t)),
              `p ${p} t ${t} k ${k} i ${i}`,
            ).toBeLessThanOrEqual(tol);
          }
        }
      }
    }
  });
});

describe('basis properties on random knot vectors', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

  for (const seed of seeds) {
    it(`A2.4, partition of unity, non-negativity, derivative sums (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const p = 1 + (seed % 5);
      const count = p + 1 + Math.floor(rng() * 8);
      const bases: Basis[] = [
        randomClampedBasis(rng, p, count, { maxMult: p, domain: [-2, 3] }),
        randomPeriodicBasis(rng, p, count, { maxMult: p, domain: [1, 1 + Math.PI] }),
      ];
      for (const b of bases) {
        const [a, e] = b.domain;
        const tol = 4 * (p + 1) * EPS;
        const samples = [...Array.from({ length: 40 }, () => a + rng() * (e - a)), ...b.knots];
        for (const t of samples) {
          if (b.kind === 'clamped' && (t < a || t > e)) continue;
          const D = ders(b, t, 3);
          const span = findSpan(b, t);
          let sum = 0;
          for (let j = 0; j <= p; j++) {
            const N = D[0]![j]!;
            expect(N).toBeGreaterThanOrEqual(0);
            sum += N;
            const i = (((span - p + j) % b.count) + b.count) % b.count;
            const oracle = basisFunction(b, i, t);
            expect(
              Math.abs(N - oracle),
              `seed ${seed} ${b.kind} t ${t} j ${j}`,
            ).toBeLessThanOrEqual(tol);
          }
          expect(Math.abs(sum - 1)).toBeLessThanOrEqual(tol);
          for (let k = 1; k <= 3; k++) {
            let s = 0;
            let abs = 0;
            for (const v of D[k]!) {
              s += v;
              abs += Math.abs(v);
            }
            expect(Math.abs(s)).toBeLessThanOrEqual(tol * abs);
          }
        }
      }
    });
  }

  it('A2.2 equals row 0 of A2.3 bit for bit', () => {
    const rng = mulberry32(99);
    const b = randomClampedBasis(rng, 4, 12, { maxMult: 3 });
    const s = createScratch({ maxDegree: 4 });
    for (let i = 0; i < 50; i++) {
      const t = rng();
      const span = findSpan(b, t);
      const N = new Float64Array(5);
      const D = new Float64Array(15);
      basisFunsInto(b, span, t, N, 0, s);
      basisDersInto(b, span, t, 2, D, 0, s);
      expect(Array.from(N)).toEqual(Array.from(D.subarray(0, 5)));
    }
  });

  it('periodic basis values repeat with the period', () => {
    const b = periodicBasis(3, [0, 0.125, 0.5, 0.625, 0.75], 1);
    const s = createScratch({ maxDegree: 3 });
    for (const t of [0, 0.0625, 0.3125, 0.5, 0.875]) {
      for (const k of [-2, -1, 1, 3]) {
        const N0 = new Float64Array(4);
        const N1 = new Float64Array(4);
        basisFunsInto(b, findSpan(b, t), t, N0, 0, s);
        basisFunsInto(b, findSpan(b, t + k), t + k, N1, 0, s);
        expect(findSpan(b, t + k)).toBe(findSpan(b, t));
        expect(Array.from(N1)).toEqual(Array.from(N0)); // dyadic t, T = 1: the wrap is exact
      }
    }
  });
});

describe('findSpan', () => {
  /** Linear-scan oracle: right side U[i] ≤ t < U[i+1], left side U[i] < t ≤ U[i+1]; inner side at the ends. */
  function scan(b: Basis, t: number, left: boolean): number {
    const U = b.knots;
    if (b.kind === 'clamped') {
      const n = b.count - 1;
      for (let i = b.degree; i <= n; i++) {
        if (left ? U[i]! < t && t <= U[i + 1]! : U[i]! <= t && t < U[i + 1]!) return i;
      }
      return left ? b.degree : n;
    }
    const n = b.count;
    const next = (i: number): number => (i + 1 < n ? U[i + 1]! : U[0]! + b.period);
    for (let i = 0; i < n; i++)
      if (left ? U[i]! < t && t <= next(i) : U[i]! <= t && t < next(i)) return i;
    return n - 1; // left of t_0: the previous period's last span
  }

  it('agrees with a linear scan at every knot and between, both sides', () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 20; trial++) {
      const p = 1 + (trial % 4);
      const b =
        trial % 2 === 0
          ? randomClampedBasis(rng, p, p + 1 + Math.floor(rng() * 10), { maxMult: p })
          : randomPeriodicBasis(rng, p, p + 1 + Math.floor(rng() * 10), { maxMult: p });
      const [a, e] = b.domain;
      const ts = [...b.knots, ...Array.from({ length: 30 }, () => a + rng() * (e - a))];
      for (const t of ts) {
        if (b.kind === 'clamped' && t === a) {
          expect(findSpan(b, t)).toBe(scan(b, t, false));
          expectCode(() => findSpan(b, t, 'left'), 'side-unavailable');
          continue;
        }
        if (b.kind === 'clamped' && t === e) {
          expect(findSpan(b, t)).toBe(scan(b, t, false));
          expect(findSpan(b, t, 'left')).toBe(scan(b, t, true));
          expectCode(() => findSpan(b, t, 'right'), 'side-unavailable');
          continue;
        }
        expect(findSpan(b, t, 'right'), `trial ${trial} t ${t}`).toBe(scan(b, t, false));
        expect(findSpan(b, t, 'left'), `trial ${trial} t ${t}`).toBe(scan(b, t, true));
      }
    }
  });

  it('throws outside a clamped domain beyond paramRel slack and clamps within it', () => {
    const b = clampedBasis(2, [0, 0, 0, 0.5, 1, 1, 1]);
    expect(findSpan(b, 1 + 1e-13)).toBe(3);
    expect(findSpan(b, -1e-13)).toBe(2);
    expectCode(() => findSpan(b, 1 + 1e-11), 'param-out-of-domain');
    expectCode(() => findSpan(b, NaN), 'non-finite');
  });

  it('wraps periodic parameters, t_0 + T exactly onto t_0', () => {
    const b = periodicBasis(2, [0, 0.25, 0.5, 0.75], 1);
    expect(findSpan(b, 1)).toBe(0);
    expect(findSpan(b, -0.1)).toBe(3);
    expect(findSpan(b, 0, 'left')).toBe(3);
  });
});

describe('basis kernels check their buffers', () => {
  const b = clampedBasis(3, clampedUniformKnots(3, 6));

  it('rejects a scratch that is too small, a bad span or a short output', () => {
    expectCode(
      () => basisFunsInto(b, 3, 0.5, new Float64Array(4), 0, createScratch({ maxDegree: 2 })),
      'scratch-too-small',
    );
    expectCode(
      () =>
        basisDersInto(
          b,
          3,
          0.5,
          3,
          new Float64Array(16),
          0,
          createScratch({ maxDegree: 3, maxDerivs: 2 }),
        ),
      'scratch-too-small',
    );
    expectCode(
      () => basisFunsInto(b, 2, 0.5, new Float64Array(4), 0, createScratch({ maxDegree: 3 })),
      'size-mismatch',
    );
    expectCode(
      () => basisFunsInto(b, 3, 0.5, new Float64Array(3), 0, createScratch({ maxDegree: 3 })),
      'size-mismatch',
    );
    expectCode(
      () => basisFunsInto(b, 3, 0.5, new Float64Array(4), 0, { maxDegree: 3, maxDerivs: 3 }),
      'scratch-too-small',
    );
  });

  it('clamps the parameter instead of throwing (kernels never throw on data)', () => {
    const s = createScratch({ maxDegree: 3 });
    const N = new Float64Array(4);
    basisFunsInto(b, 5, 7, N, 0, s);
    expect(Array.from(N)).toEqual([0, 0, 0, 1]);
    basisFunsInto(b, 3, NaN, N, 0, s);
    expect(Array.from(N)).toEqual([1, 0, 0, 0]);
  });

  it('basisFunction rejects an index outside the basis', () => {
    expectCode(() => basisFunction(b, 6, 0.5), 'size-mismatch');
  });
});
