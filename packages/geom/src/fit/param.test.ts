// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Parameterisation and knot-placement oracles (P&T §9.2.1, §9.4.1):
 *
 * - **book fixtures**: Ex. 9.1's chord-length parameters `{0, 5/17, 9/17,
 *   14/17, 1}` and averaged knots `{0,0,0,0, 28/51, 1,1,1,1}`; eqs. 9.68–9.69
 *   worked by hand for ten uniform parameters and six cubic control points
 *   (`{0,0,0,0, 7/27, 17/27, 1,1,1,1}`);
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

describe('lsqKnots (eqs. 9.68–9.69)', () => {
  it('matches a worked example', () => {
    const ub = Array.from({ length: 10 }, (_, k) => k / 9);
    close(lsqKnots(ub, 3, 6), [0, 0, 0, 0, 7 / 27, 17 / 27, 1, 1, 1, 1], 4 * EPS);
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
