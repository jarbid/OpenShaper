// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { adaptiveSimpson, simpsonIntegral } from './math';

describe('adaptiveSimpson', () => {
  it('is exact for cubics (Simpson order)', () => {
    const f = (x: number) => 2 * x ** 3 - x ** 2 + 3 * x - 5;
    // ∫₀² = 2⁴/2 − 2³/3 + 3·2²/2 − 5·2 = 8 − 8/3 + 6 − 10
    expect(adaptiveSimpson(f, 0, 2)).toBeCloseTo(8 - 8 / 3 + 6 - 10, 12);
  });

  it('matches known transcendental integrals to the requested tolerance', () => {
    expect(adaptiveSimpson(Math.sin, 0, Math.PI, 1e-9)).toBeCloseTo(2, 8);
    expect(adaptiveSimpson(Math.exp, 0, 1, 1e-9)).toBeCloseTo(Math.E - 1, 8);
  });

  it('resolves a sharp peak that defeats a coarse fixed-split Simpson', () => {
    // Narrow Gaussian bump: ∫ over [-1,1] ≈ σ√(2π) for σ ≪ 1.
    const sigma = 0.01;
    const f = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma));
    const exact = sigma * Math.sqrt(2 * Math.PI);
    const fixed = simpsonIntegral(f, -1, 1, 10);
    const adaptive = adaptiveSimpson(f, -1, 1, 1e-8);
    expect(Math.abs(fixed - exact) / exact).toBeGreaterThan(0.5); // coarse grid misses the peak
    expect(Math.abs(adaptive - exact) / exact).toBeLessThan(1e-6);
  });

  it('guards NaN samples as 0, like the legacy integrator', () => {
    const f = (x: number) => (x === 0 ? NaN : 1);
    expect(Number.isFinite(adaptiveSimpson(f, 0, 1))).toBe(true);
  });
});
