// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The discrepancy-principle helpers (docs/design/board2.md §9.8).
 *
 * Oracles: the thin-plate trace against geom's own `fairnessEnergy` of one
 * unit control value at a time (`tr G = Σ e_iᵀ G e_i`, an independent assembly
 * of the same matrix), to 1e-10 relative (two exact Gauss–Legendre sums of a
 * few hundred terms); the data trace against a direct sum of `B_ij(u, v)²` by
 * geom's `surfacePoint` on unit nets; the search against a closed-form
 * predicate.
 */
import { describe, expect, it } from 'vitest';
import { basisFunction, fairnessEnergy, makeSurface } from '@openshaper/geom';
import { mulberry32, randomClampedBasis } from '@openshaper/geom/testing';
import {
  dataTrace,
  discrepancySearch,
  gramDiagonalSums,
  smallestFeasible,
  thinPlateTrace,
} from './fairness';

describe('fairness traces', () => {
  it('tr(G₂) equals the sum of unit energies by geom (random bases, seeded)', () => {
    const seed = 6;
    const rng = mulberry32(seed);
    for (let trial = 0; trial < 4; trial++) {
      const u = randomClampedBasis(rng, 3, 5 + trial, { maxMult: 2 });
      const v = randomClampedBasis(rng, 3, 4 + trial);
      const nu = u.count;
      const nv = v.count;
      const zero = new Float64Array(nu * nv * 3);
      const ref = makeSurface({ u, v, points: zero });
      let sum = 0;
      for (let k = 0; k < nu * nv; k++) {
        const p = zero.slice();
        p[3 * k + 2] = 1;
        sum += fairnessEnergy(
          makeSurface({ u, v, points: p }),
          { bend: 1, metric: 'parametric' },
          ref,
        );
      }
      expect(
        Math.abs(thinPlateTrace(u, v) - sum),
        `seed ${seed} trial ${trial}`,
      ).toBeLessThanOrEqual(1e-10 * sum);
    }
  });

  it('g₀ = Σ ∫ N_i² is the integral of the squared partition (closed form on a Bézier basis)', () => {
    // One cubic Bézier span on [0, 1]: Σ ∫ B_i² = Σ C(3,i)² B(2i+1, 7−2i) = 2/7 + 2 · 9 · 48/7! = 16/35.
    const u = randomClampedBasis(mulberry32(1), 3, 4);
    expect(gramDiagonalSums(u)[0]).toBeCloseTo(16 / 35, 14);
  });

  it('tr(AᵀA) is Σ_k Σ_ij B_ij(u_k, v_k)² (independent basis functions)', () => {
    const rng = mulberry32(11);
    const u = randomClampedBasis(rng, 3, 7);
    const v = randomClampedBasis(rng, 3, 6);
    const uv = Float64Array.from({ length: 200 }, () => rng());
    let direct = 0;
    for (let k = 0; k < 100; k++) {
      for (let i = 0; i < u.count; i++) {
        for (let j = 0; j < v.count; j++) {
          direct += (basisFunction(u, i, uv[2 * k]!) * basisFunction(v, j, uv[2 * k + 1]!)) ** 2;
        }
      }
    }
    expect(dataTrace(u, v, uv)).toBeCloseTo(direct, 10);
  });
});

describe('discrepancy search', () => {
  // A predicate with a known boundary: meets iff ratio ≤ b; no fit below f.
  const make = (f: number, b: number) => (r: number) => (r < f ? null : { fit: r, meets: r <= b });

  it('finds the largest passing ratio to the bisection resolution', () => {
    const steps = 12;
    const fit = make(1e-10, 3.3e-4);
    const c = discrepancySearch(fit, 1e-10, 1, fit(1e-10)!, steps);
    expect(c.meets).toBe(true);
    expect(c.ratio).toBeLessThanOrEqual(3.3e-4);
    // Resolution: 10 decades / 2^12 in log scale.
    expect(Math.log(3.3e-4 / c.ratio)).toBeLessThanOrEqual(Math.log(1e10) / 2 ** steps);
    expect(c.evaluations).toBe(steps + 1);
  });

  it('takes the top when it passes and the bottom (not meeting) when nothing does', () => {
    const ok = make(1e-10, 2);
    expect(discrepancySearch(ok, 1e-10, 1, ok(1e-10)!, 12)).toMatchObject({
      ratio: 1,
      meets: true,
    });
    const never = make(1e-10, 1e-20);
    expect(discrepancySearch(never, 1e-10, 1, never(1e-10)!, 12)).toMatchObject({
      ratio: 1e-10,
      meets: false,
    });
  });

  it('moves up past ratios that give no fit', () => {
    const fit = make(1e-6, 1e-3);
    const first = smallestFeasible(fit, 1e-10, 1, 12)!;
    expect(first.ratio).toBeGreaterThanOrEqual(1e-6);
    // The first grid point at or above 1e-6: 10^(−10 + 10k/12).
    expect(first.ratio).toBeLessThan(1e-6 * Math.pow(1e10, 1 / 12) * (1 + 1e-12));
    const c = discrepancySearch(fit, first.ratio, 1, first.trial, 12);
    expect(c.meets).toBe(true);
    expect(c.ratio).toBeLessThanOrEqual(1e-3);
    expect(c.ratio).toBeGreaterThan(1e-3 * 0.99);
    expect(smallestFeasible(make(2, 3), 1e-10, 1, 12)).toBeNull();
  });
});
