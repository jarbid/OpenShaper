// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Parameterisation and knot-placement oracles (P&T §9.2.1, §9.4.1):
 *
 * - **book fixtures**: Ex. 9.1's chord-length parameters `{0, 5/17, 9/17,
 *   14/17, 1}` and averaged knots `{0,0,0,0, 28/51, 1,1,1,1}`;
 * - **hand fixtures** for the knot rules that are not in the book: centred
 *   least-squares knots (ten uniform parameters and six cubic control points
 *   give `{0,0,0,0, 2/5, 3/5, 1,1,1,1}`, where the book's eq. 9.69 gives the
 *   lopsided `7/27, 17/27`; non-uniform cases), periodic averaging and
 *   periodic least-squares knots with their shifts;
 * - **symmetry**: reversing the parameters (`ū → 1 − ū`) reverses the
 *   least-squares knots, and at `count = params.length` they are the classic
 *   interpolation knots (data sites for odd degree, midpoints for even);
 * - **definitions**: centripetal increments are square roots of chords; the
 *   generalised exponent reproduces the three named methods bit for bit; a
 *   closed list counts the closing chord;
 * - **Schoenberg–Whitney**: least-squares knots leave every span with at
 *   least one parameter, for random parameters and every admissible count.
 *
 * Tolerances: book fractions `4ε` (a sum of at most four terms each rounded
 * once, then one division).
 */
import { describe, expect, it } from 'vitest';
import { averagedKnots, isGeomError, lsqKnots, parameterize } from '../index';
import type { GeomErrorCode } from '../index';
import { mulberry32 } from '../testing';
import { periodicAveraged, periodicLsq } from './param';

const EPS = Number.EPSILON;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e, code), String(e)).toBe(true);
    return;
  }
  throw new Error(`expected GeomError ${code}`);
}

function close(a: ArrayLike<number>, b: readonly number[], tol: number): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++)
    expect(Math.abs(a[i]! - b[i]!), `entry ${i}`).toBeLessThanOrEqual(tol);
}

const EX91 = [0, 0, 3, 4, -1, 4, -4, 0, -4, -3];

describe('parameterize (eqs. 9.3–9.6)', () => {
  it('matches P&T Ex. 9.1 and the centripetal and uniform definitions', () => {
    close(parameterize(EX91, 2, 'chord'), [0, 5 / 17, 9 / 17, 14 / 17, 1], 4 * EPS);
    const inc = [Math.sqrt(5), 2, Math.sqrt(5), Math.sqrt(3)];
    const total = inc.reduce((a, b) => a + b);
    let acc = 0;
    const cen = [0, ...inc.map((d) => (acc += d) / total)];
    close(parameterize(EX91, 2, 'centripetal'), cen, 4 * EPS);
    close(parameterize(EX91, 2, 'uniform'), [0, 0.25, 0.5, 0.75, 1], 0);
  });

  it('reproduces the named methods bit for bit with the exponent form', () => {
    const rng = mulberry32(71);
    const pts = Float64Array.from({ length: 30 }, () => rng());
    for (const [e, name] of [
      [0, 'uniform'],
      [0.5, 'centripetal'],
      [1, 'chord'],
    ] as const) {
      expect(Array.from(parameterize(pts, 3, { exponent: e }))).toEqual(
        Array.from(parameterize(pts, 3, name)),
      );
    }
    const half = parameterize(pts, 3, { exponent: 0.25 });
    expect(half[0]).toBe(0);
    expect(half[9]).toBe(1);
  });

  it('counts the closing chord for a closed list', () => {
    // A unit square: four equal chords, so the closed parameters are k/4.
    close(parameterize([0, 0, 1, 0, 1, 1, 0, 1], 2, 'chord', true), [0, 0.25, 0.5, 0.75], 0);
  });

  it('rejects degenerate input', () => {
    expectCode(() => parameterize([1, 1, 1, 1], 2, 'chord'), 'too-few-points');
    expectCode(() => parameterize([1], 1, 'chord'), 'too-few-points');
    expectCode(() => parameterize([0, 1, 2], 2, 'chord'), 'size-mismatch');
    expectCode(() => parameterize([0, 1, 2], 1, { exponent: -1 }), 'unsupported');
  });
});

describe('averagedKnots (eq. 9.8)', () => {
  it('matches P&T Ex. 9.1', () => {
    close(
      averagedKnots(parameterize(EX91, 2, 'chord'), 3),
      [0, 0, 0, 0, 28 / 51, 1, 1, 1, 1],
      4 * EPS,
    );
  });

  it('averages p consecutive parameters', () => {
    const ub = [0, 0.1, 0.3, 0.35, 0.8, 1];
    close(averagedKnots(ub, 2), [0, 0, 0, 0.2, 0.325, 0.575, 1, 1, 1], 2 * EPS);
  });

  it('rejects too few or decreasing parameters', () => {
    expectCode(() => averagedKnots([0, 0.5, 1], 3), 'too-few-points');
    expectCode(() => averagedKnots([0, 0.6, 0.5, 1], 2), 'knots-decreasing');
    expectCode(() => averagedKnots([0, 0.5, 1], 0), 'invalid-degree');
  });
});

describe('lsqKnots (eqs. 9.68–9.69, centred)', () => {
  it('matches worked examples', () => {
    // h = m/n = 9/5; s_j = h·(j + 1) = 3.6, 5.4 → ū = 0.4, 0.6.
    const ub = Array.from({ length: 10 }, (_, k) => k / 9);
    close(lsqKnots(ub, 3, 6), [0, 0, 0, 0, 2 / 5, 3 / 5, 1, 1, 1, 1], 4 * EPS);
    // Non-uniform, m = 5: p = 2, n = 3: s_1 = 5·3/6 = 2.5 → (0.3 + 0.6)/2.
    const nu = [0, 0.1, 0.3, 0.6, 0.8, 1];
    close(lsqKnots(nu, 2, 4), [0, 0, 0, 0.45, 1, 1, 1], 4 * EPS);
    // n = m: p = 2 at s = 1.5, 2.5, 3.5 (midpoints); p = 3 at s = 2, 3 (sites).
    close(lsqKnots(nu, 2, 6), [0, 0, 0, 0.2, 0.45, 0.7, 1, 1, 1], 4 * EPS);
    close(lsqKnots(nu, 3, 6), [0, 0, 0, 0, 0.3, 0.6, 1, 1, 1, 1], 4 * EPS);
  });

  it('is symmetric under reversal, and gives interpolation knots at count = params', () => {
    const rng = mulberry32(73);
    for (let trial = 0; trial < 10; trial++) {
      const m = 6 + Math.floor(rng() * 30);
      const ub = Float64Array.from({ length: m }, () => rng()).sort();
      ub[0] = 0;
      ub[m - 1] = 1;
      const rev = Float64Array.from(ub, (_, k) => 1 - ub[m - 1 - k]!);
      for (let p = 1; p <= 5 && p < m; p++) {
        for (let count = p + 1; count <= m; count++) {
          const U = lsqKnots(ub, p, count);
          const R = lsqKnots(rev, p, count);
          const L = U.length - 1;
          // Each knot is (1 − α)a + αb of values rounded once: a few ε.
          for (let i = 0; i <= L; i++) {
            expect(
              Math.abs(R[i]! - (1 - U[L - i]!)),
              `trial ${trial} p ${p} count ${count}`,
            ).toBeLessThanOrEqual(4 * EPS);
          }
        }
        const U = lsqKnots(ub, p, m);
        for (let j = 1; j <= m - 1 - p; j++) {
          const k = j + (p - 1) / 2;
          const want = p % 2 === 1 ? ub[k]! : (ub[Math.floor(k)]! + ub[Math.ceil(k)]!) / 2;
          expect(Math.abs(U[p + j]! - want)).toBeLessThanOrEqual(2 * EPS);
        }
      }
    }
  });

  it('leaves at least one parameter in every span', () => {
    const rng = mulberry32(72);
    for (let trial = 0; trial < 20; trial++) {
      const m = 8 + Math.floor(rng() * 40);
      const ub = Float64Array.from({ length: m }, () => rng()).sort();
      ub[0] = 0;
      ub[m - 1] = 1;
      for (let p = 1; p <= 4; p++) {
        for (let count = p + 1; count <= m; count++) {
          const U = lsqKnots(ub, p, count);
          expect(U.length).toBe(count + p + 1);
          for (let s = p; s < count; s++) {
            if (U[s + 1]! === U[s]!) continue;
            const inside = Array.from(ub).some((u) => u >= U[s]! && u <= U[s + 1]!);
            expect(inside, `trial ${trial} p ${p} count ${count} span ${s}`).toBe(true);
          }
        }
      }
    }
  });

  it('rejects counts outside degree + 1 … parameters', () => {
    expectCode(() => lsqKnots([0, 0.5, 1], 2, 4), 'too-few-points');
    expectCode(() => lsqKnots([0, 0.2, 0.5, 1], 2, 2), 'too-few-points');
  });
});

describe('periodic knot rules (not in the book)', () => {
  it('averages p consecutive parameters, shifted by τ_0 (interpolation)', () => {
    // Uniform k/n: τ_j = (j + (p − 1)/2)/n, so after the shift the knots are
    // j/n and the shift is (p − 1)/(2n): at the sites for odd p, midway for even.
    for (const n of [5, 8]) {
      const ub = Float64Array.from({ length: n }, (_, k) => k / n);
      for (const p of [1, 2, 3, 4]) {
        const { T, shift } = periodicAveraged(ub, p);
        expect(Math.abs(shift - (p - 1) / (2 * n)), `n ${n} p ${p}`).toBeLessThanOrEqual(4 * EPS);
        close(
          T,
          Array.from({ length: n }, (_, j) => j / n),
          4 * EPS,
        );
      }
    }
    // Non-uniform {0, 0.1, 0.4, 0.7}: p = 2: τ = {0.05, 0.25, 0.55, 0.85};
    // p = 3: τ = {1/6, 0.4, 0.7, 2.8/3}.
    const nu = Float64Array.from([0, 0.1, 0.4, 0.7]);
    const two = periodicAveraged(nu, 2);
    expect(Math.abs(two.shift - 0.05)).toBeLessThanOrEqual(4 * EPS);
    close(two.T, [0, 0.2, 0.5, 0.8], 4 * EPS);
    const three = periodicAveraged(nu, 3);
    expect(Math.abs(three.shift - 1 / 6)).toBeLessThanOrEqual(4 * EPS);
    close(three.T, [0, 7 / 30, 16 / 30, 23 / 30], 4 * EPS);
  });

  it('places least-squares knots at ū(h·(j + (p − 1)/2)), shifted by τ_0', () => {
    const nu = Float64Array.from([0, 0.1, 0.4, 0.7]);
    // count = m: midpoints for p = 2 (as averaging), sites for p = 3.
    const two = periodicLsq(nu, 4, 2);
    expect(Math.abs(two.shift - 0.05)).toBeLessThanOrEqual(4 * EPS);
    close(two.T, [0, 0.2, 0.5, 0.8], 4 * EPS);
    const three = periodicLsq(nu, 4, 3);
    expect(Math.abs(three.shift - 0.1)).toBeLessThanOrEqual(4 * EPS);
    close(three.T, [0, 0.3, 0.6, 0.9], 4 * EPS);
    // p = 1, count 2: h = 2, s = 0, 2 → {0, 0.4}, no shift.
    const one = periodicLsq(nu, 2, 1);
    expect(one.shift).toBe(0);
    close(one.T, [0, 0.4], 0);
    // p = 2, count 3: h = 4/3, s = 2/3, 2, 10/3 → {1/15, 0.4, 0.8}.
    const odd = periodicLsq(nu, 3, 2);
    expect(Math.abs(odd.shift - 1 / 15)).toBeLessThanOrEqual(4 * EPS);
    close(odd.T, [0, 1 / 3, 11 / 15], 4 * EPS);
  });
});
