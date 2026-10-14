// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Quadrature oracles (design §16, `quadrature` row):
 * - Gauss–Legendre nodes and weights against closed forms (n ≤ 5) and the
 *   published 10-point table; exactness on monomials to degree 2n − 1 for every
 *   tabulated n, and visible inexactness at degree 2n (so the test can fail);
 * - the GK15 constants: the G7 subset equals our 7-point rule, K15 is exact to
 *   degree 22 (3·7 + 1) and not at 24;
 * - the adaptive integrator against closed forms (a rational integrand, √x
 *   with its endpoint singularity, a kink at a break), its cap and its
 *   honesty about convergence.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES, GL_MAX_ORDER, gaussLegendre, integrate1d, isGeomError } from './index';
import { GK15_TABLE } from './quadrature';

const EPS = Number.EPSILON;
/** Adaptive results: the GK error estimate is not a bound, so 10× margin (design §16). */
const ADAPTIVE_REL = 10 * DEFAULT_TOLERANCES.quadRel;

describe('gaussLegendre', () => {
  // Nodes and weights 4ε absolute (design §16): Newton converges to the last
  // bit and the closed forms below carry a few ulps of their own.
  const TOL = 4 * EPS;
  const closed: Record<number, { x: number[]; w: number[] }> = {
    1: { x: [0], w: [2] },
    2: { x: [-1 / Math.sqrt(3), 1 / Math.sqrt(3)], w: [1, 1] },
    3: { x: [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)], w: [5 / 9, 8 / 9, 5 / 9] },
    4: (() => {
      const a = Math.sqrt(3 / 7 - (2 / 7) * Math.sqrt(6 / 5));
      const b = Math.sqrt(3 / 7 + (2 / 7) * Math.sqrt(6 / 5));
      const wa = (18 + Math.sqrt(30)) / 36;
      const wb = (18 - Math.sqrt(30)) / 36;
      return { x: [-b, -a, a, b], w: [wb, wa, wa, wb] };
    })(),
    5: (() => {
      const a = Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3;
      const b = Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3;
      const wa = (322 + 13 * Math.sqrt(70)) / 900;
      const wb = (322 - 13 * Math.sqrt(70)) / 900;
      return { x: [-b, -a, 0, a, b], w: [wb, wa, 128 / 225, wa, wb] };
    })(),
  };

  it('matches the closed-form rules for n ≤ 5', () => {
    for (const [n, ref] of Object.entries(closed)) {
      const { nodes, weights } = gaussLegendre(Number(n));
      for (let i = 0; i < ref.x.length; i++) {
        expect(Math.abs(nodes[i]! - ref.x[i]!)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(weights[i]! - ref.w[i]!)).toBeLessThanOrEqual(TOL);
      }
    }
  });

  it('matches the published 10-point table (Abramowitz & Stegun 25.4.30, extended digits)', () => {
    const x = [
      '0.148874338981631210885',
      '0.433395394129247190799',
      '0.679409568299024406234',
      '0.865063366688984510732',
      '0.973906528517171720078',
    ].map(Number);
    const w = [
      '0.295524224714752870174',
      '0.269266719309996355091',
      '0.219086362515982043996',
      '0.149451349150580593146',
      '0.066671344308688137594',
    ].map(Number);
    const { nodes, weights } = gaussLegendre(10);
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(nodes[5 + i]! - x[i]!)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(nodes[4 - i]! + x[i]!)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(weights[5 + i]! - w[i]!)).toBeLessThanOrEqual(TOL);
    }
  });

  it('is exact on monomials up to degree 2n − 1 for every tabulated n', () => {
    // 4nε relative (design §16): n products summed, each a few ulps.
    for (let n = 1; n <= GL_MAX_ORDER; n++) {
      const { nodes, weights } = gaussLegendre(n);
      for (let k = 0; k <= 2 * n - 1; k++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += weights[i]! * nodes[i]! ** k;
        const exact = k % 2 === 1 ? 0 : 2 / (k + 1);
        expect(Math.abs(s - exact), `n = ${n}, k = ${k}`).toBeLessThanOrEqual(
          4 * n * EPS * Math.max(1, exact),
        );
      }
    }
  });

  it('is not exact at degree 2n (the error E_n = 2^{2n+1}(n!)^4 / ((2n+1)((2n)!)^2) shows)', () => {
    for (let n = 1; n <= 20; n++) {
      const { nodes, weights } = gaussLegendre(n);
      let s = 0;
      for (let i = 0; i < n; i++) s += weights[i]! * nodes[i]! ** (2 * n);
      let fact = 1;
      for (let i = 2; i <= n; i++) fact *= i;
      let fact2 = 1;
      for (let i = 2; i <= 2 * n; i++) fact2 *= i;
      const En = (2 ** (2 * n + 1) * fact ** 4) / ((2 * n + 1) * fact2 ** 2);
      // The rule underestimates ∫x^{2n} by E_n·(2n)!/(2n)! = E_n.
      expect(2 / (2 * n + 1) - s).toBeCloseTo(En, 12);
      expect(En / (2 / (2 * n + 1))).toBeGreaterThan(4 * n * EPS);
    }
  });

  it('rejects orders outside [1, 64]', () => {
    for (const n of [0, 65, 2.5, NaN]) {
      expect(() => gaussLegendre(n)).toThrow();
    }
  });
});

describe('GK15 constants', () => {
  const { xgk, wgk, wg } = GK15_TABLE;

  it('embed our 7-point Gauss–Legendre rule', () => {
    const g7 = gaussLegendre(7);
    for (let j = 0; j < 4; j++) {
      // xgk[1], xgk[3], xgk[5], xgk[7] are the non-negative G7 nodes, descending.
      expect(Math.abs(xgk[2 * j + 1]! - g7.nodes[6 - j]!)).toBeLessThanOrEqual(4 * EPS);
      expect(Math.abs(wg[j]! - g7.weights[6 - j]!)).toBeLessThanOrEqual(4 * EPS);
    }
  });

  it('integrate monomials exactly to degree 22 and not at 24', () => {
    const k15 = (k: number): number => {
      let s = wgk[7]! * (k === 0 ? 1 : 0);
      for (let j = 0; j < 7; j++) s += wgk[j]! * (xgk[j]! ** k + (-xgk[j]!) ** k);
      return s;
    };
    for (let k = 0; k <= 22; k++) {
      const exact = k % 2 === 1 ? 0 : 2 / (k + 1);
      expect(Math.abs(k15(k) - exact), `k = ${k}`).toBeLessThanOrEqual(60 * EPS);
    }
    // K15 misses ∫x^24 by 5.7·10⁻⁹, far above rounding: the rule stops at degree 22.
    expect(Math.abs(k15(24) - 2 / 25)).toBeGreaterThan(1e3 * 60 * EPS);
  });
});

describe('integrate1d', () => {
  it('integrates a rational function to quadRel: ∫₀¹ 1/(1+x²) = π/4', () => {
    const r = integrate1d((x) => 1 / (1 + x * x), 0, 1);
    expect(r.converged).toBe(true);
    expect(Math.abs(r.value - Math.PI / 4)).toBeLessThanOrEqual(ADAPTIVE_REL * (Math.PI / 4));
  });

  it('adapts to an endpoint singularity in the derivative: ∫₀¹ √x = 2/3', () => {
    const r = integrate1d(Math.sqrt, 0, 1);
    expect(r.converged).toBe(true);
    expect(Math.abs(r.value - 2 / 3)).toBeLessThanOrEqual(ADAPTIVE_REL * (2 / 3));
    expect(r.evaluations).toBeGreaterThan(15);
  });

  it('is exact and immediate on a kink placed at a break: ∫₀¹ |x − 1/3| = 5/18', () => {
    const f = (x: number): number => Math.abs(x - 1 / 3);
    const withBreak = integrate1d(f, 0, 1, { breaks: [1 / 3] });
    expect(withBreak.converged).toBe(true);
    expect(withBreak.evaluations).toBe(30); // two panels, polynomial on each: no split
    expect(Math.abs(withBreak.value - 5 / 18)).toBeLessThanOrEqual(8 * EPS);
    const without = integrate1d(f, 0, 1);
    expect(without.converged).toBe(true);
    expect(without.evaluations).toBeGreaterThan(30);
    expect(Math.abs(without.value - 5 / 18)).toBeLessThanOrEqual(ADAPTIVE_REL * (5 / 18));
  });

  it('honours the requested tolerance (error ≤ 10 · quadRel across targets)', () => {
    for (const quadRel of [1e-4, 1e-6, 1e-8, 1e-10, 1e-12]) {
      const r = integrate1d(Math.sqrt, 0, 2, { tol: { quadRel } });
      const exact = (2 / 3) * 2 ** 1.5;
      expect(r.converged).toBe(true);
      expect(Math.abs(r.value - exact)).toBeLessThanOrEqual(10 * quadRel * exact + 4 * EPS * exact);
    }
  });

  it('measures cancelling integrands against ∫|f|: ∫₋₁¹ x³ = 0 converges', () => {
    const r = integrate1d((x) => x ** 3, -1, 1);
    expect(r.converged).toBe(true);
    expect(Math.abs(r.value)).toBeLessThanOrEqual(4 * EPS);
  });

  it('signs a reversed interval and returns 0 on an empty one', () => {
    const f = (x: number): number => Math.exp(x);
    const fwd = integrate1d(f, 0, 1);
    const rev = integrate1d(f, 1, 0);
    expect(rev.value).toBe(-fwd.value);
    expect(integrate1d(f, 2, 2)).toEqual({
      value: 0,
      errorEstimate: 0,
      evaluations: 0,
      converged: true,
    });
  });

  it('reports converged: false at the split cap, with a finite best value', () => {
    const r = integrate1d((x) => 1 / Math.sqrt(x), 0, 1, { tol: { quadMaxSplits: 8 } });
    expect(r.converged).toBe(false);
    expect(Number.isFinite(r.value)).toBe(true);
    // Each split replaces one panel by two: N final panels cost 15·(2N − 1) evaluations.
    expect(r.evaluations).toBe(15 * (2 * 8 - 1));
    expect(r.value).toBeGreaterThan(1.5); // ∫ = 2, approached from below
  });

  it('is deterministic', () => {
    const f = (x: number): number => Math.sin(10 * x) / (1 + x);
    expect(integrate1d(f, 0, 3)).toEqual(integrate1d(f, 0, 3));
  });

  it('throws non-finite for non-finite limits, breaks or integrand values', () => {
    expect(() => integrate1d((x) => x, 0, Infinity)).toThrow();
    expect(() => integrate1d((x) => x, 0, 1, { breaks: [NaN] })).toThrow();
    try {
      integrate1d((x) => 1 / x, -1, 1);
      expect.unreachable();
    } catch (e) {
      // 0 is the centre node of the panel [−1, 1], where 1/x is infinite.
      expect(isGeomError(e, 'non-finite')).toBe(true);
    }
  });
});
