// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Height fields (docs/design/board2.md §3.4, §13.2 `height-field`).
 *
 * Oracles and tolerances:
 * - **Affine exactness** (linear precision of the Greville abscissae): x(u, v)
 *   and y(u, v) equal `x0 + u (x1 − x0)` and `y0 + v (y1 − y0)` on random
 *   knots, within `1e-13 × extent`: the evaluation is a convex combination of
 *   at most 16 coordinates of size ≤ the extent, ~10 roundings of ε each.
 * - **Pcurve = affine image**: the surface along the mapped plan curve has the
 *   plan curve's x and y within `1e-13 × extent` (the same rounding plus the map).
 * - **Stringer identity**: after a fit constrained by `stringerConstraints`, the
 *   stringer iso-curve's control values equal the target line's. The residual
 *   `e` at the Greville sites is what geom's solver leaves (≤ `constraint`);
 *   the coefficients then differ by exactly `A⁻¹ e` (A the Greville
 *   collocation matrix), so the bound is `‖A⁻¹‖∞ · max|e|` (computed in the
 *   test) plus the rounding of the iso sums. Without the constraints the same
 *   fit misses the line by centimetres: identity, not closeness.
 * - Symmetric builds: partner rows are exact mirrors (bitwise) and differ from
 *   the plain affine build by rounding only (`4ε × extent`).
 *
 * Randomised tests print their seed (mulberry32) on failure.
 */
import {
  approximateSurface,
  basisFunction,
  clampedBasis,
  controlPointsInto,
  curveOnSurface,
  curveOnSurfacePoint,
  curvePoint,
  DEFAULT_TOLERANCES,
  makeCurve,
  surfaceControlPoint,
  surfacePoint,
} from '@openshaper/geom';
import type { ClampedBasis, NurbsCurve } from '@openshaper/geom';
import { checksum, mulberry32, randomClampedBasis } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import {
  grevilleAbscissae,
  heightFieldSurface,
  planCurvePcurve,
  planToUV,
  stringerConstraints,
  stringerLines,
  stringerParam,
  uvOfPlanPoint,
} from './height-field';
import { planCurve } from './plan';
import { sampleDoc, stadiumBoard } from './testing/index';
import type { HeightFieldJSON } from './types';

const EPS = Number.EPSILON;

function randomField(rng: () => number, nu: number, nv: number): HeightFieldJSON {
  const u = randomClampedBasis(rng, 3, nu);
  const v = randomClampedBasis(rng, 3, nv);
  const x0 = -10 + 20 * rng();
  const y0 = -40 + 20 * rng();
  return {
    degreeU: 3,
    degreeV: 3,
    knotsU: Array.from(u.knots),
    knotsV: Array.from(v.knots),
    x: [x0, x0 + 150 + 150 * rng()],
    y: [y0, y0 + 30 + 50 * rng()],
    z: Array.from({ length: nu * nv }, () => 20 * rng() - 10),
  };
}

describe('grevilleAbscissae', () => {
  it('clamped: the knot averages, exactly 0 and 1 at the ends', () => {
    const b = clampedBasis(3, [0, 0, 0, 0, 0.2, 0.5, 1, 1, 1, 1]);
    const g = grevilleAbscissae(b);
    expect(g[0]).toBe(0);
    expect(g[g.length - 1]).toBe(1);
    const U = b.knots;
    for (let i = 0; i < b.count; i++) {
      expect(g[i]).toBeCloseTo((U[i + 1]! + U[i + 2]! + U[i + 3]!) / 3, 15);
    }
  });

  it('periodic uniform: control point i sits at (i + 2)/n (beyond the period, unwrapped)', () => {
    const n = 12;
    const c = planCurve({
      degree: 3,
      knots: Array.from({ length: n }, (_, i) => i / n),
      points: Array.from({ length: 2 * n }, () => 0),
    });
    const g = grevilleAbscissae(c.basis);
    for (let i = 0; i < n; i++) expect(g[i]).toBeCloseTo((i + 2) / n, 15);
  });
});

describe('heightFieldSurface: an exact graph over the plan', () => {
  it('x and y are affine in (u, v) on random knots (linear precision)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed);
      const hf = randomField(rng, 4 + Math.floor(rng() * 8), 4 + Math.floor(rng() * 8));
      const s = heightFieldSurface(hf, 'none');
      const ex = hf.x[1] - hf.x[0];
      const ey = hf.y[1] - hf.y[0];
      const scale = Math.max(Math.abs(hf.x[0]), Math.abs(hf.x[1]), Math.abs(hf.y[0]), ex, ey);
      for (let k = 0; k < 50; k++) {
        const u = rng();
        const v = rng();
        const p = surfacePoint(s, u, v);
        expect(Math.abs(p.x - (hf.x[0] + u * ex)), `seed ${seed}`).toBeLessThanOrEqual(
          1e-13 * scale,
        );
        expect(Math.abs(p.y - (hf.y[0] + v * ey)), `seed ${seed}`).toBeLessThanOrEqual(
          1e-13 * scale,
        );
        const uv = uvOfPlanPoint(hf, p.x, p.y);
        expect(Math.abs(uv.u - u) + Math.abs(uv.v - v), `seed ${seed}`).toBeLessThanOrEqual(1e-12);
      }
      // z is the stored data, u-major.
      expect(surfaceControlPoint(s, 2, 1).z).toBe(hf.z[2 * (hf.knotsV.length - 4) + 1]);
    }
  });

  it('the pcurve of a plan curve is its exact affine image', () => {
    const d = sampleDoc();
    const plan = planCurve(d.plan);
    const s = heightFieldSurface(d.deck, d.symmetry);
    const pc = planCurvePcurve(plan, d.deck);
    const cs = curveOnSurface(s, pc);
    const scale = 210;
    for (let k = 0; k < 400; k++) {
      const t = k / 400;
      const q = curvePoint(plan, t);
      const p = curveOnSurfacePoint(cs, t);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(1e-13 * scale);
    }
    // The map itself: row-major 2×3.
    const m = planToUV(d.deck);
    expect(m[0] * d.deck.x[0] + m[2]).toBe(0);
    expect(m[4] * d.deck.y[1] + m[5]).toBe(1);
  });

  it('symmetric mode: partner rows are bitwise mirrors, the middle row y = 0, else rounding', () => {
    const d = stadiumBoard({ spansY: 4 }); // four spans: seven rows, a middle row
    const sym = heightFieldSurface(d.deck, 'mirror-y');
    const plain = heightFieldSurface(d.deck, 'none');
    const m = sym.v.count;
    expect(m % 2).toBe(1);
    const ext = d.deck.y[1] - d.deck.y[0];
    for (let i = 0; i < sym.u.count; i++) {
      for (let j = 0; j < m; j++) {
        const p = surfaceControlPoint(sym, i, j);
        const q = surfaceControlPoint(sym, i, m - 1 - j);
        expect(p.x).toBe(q.x);
        // `===` (as geom's mirror contract), so the middle row's 0 equals its own −0.
        expect(p.y === -q.y).toBe(true);
        expect(p.z).toBe(q.z);
        expect(Math.abs(p.y - surfaceControlPoint(plain, i, j).y)).toBeLessThanOrEqual(
          4 * EPS * ext,
        );
      }
      expect(surfaceControlPoint(sym, i, (m - 1) / 2).y).toBe(0);
    }
  });
});

describe('stringer lines', () => {
  it('v_s is the parameter of y = 0, exactly ½ on a symmetric extent', () => {
    expect(stringerParam({ y: [-29, 29] })).toBe(0.5);
    expect(stringerParam({ y: [-31.7, 31.7] })).toBe(0.5);
    expect(stringerParam({ y: [-10, 30] })).toBe(0.25);
  });

  it('stadium: the rocker is the flat bottom and the deck line the flat deck, x affine', () => {
    const d = stadiumBoard();
    const deck = heightFieldSurface(d.deck, d.symmetry);
    const bottom = heightFieldSurface(d.bottom, d.symmetry);
    const before = [checksum(deck), checksum(bottom)];
    const lines = stringerLines({ deck, bottom });
    expect([checksum(deck), checksum(bottom)]).toEqual(before);
    const ext = d.deck.x[1] - d.deck.x[0];
    for (let k = 0; k <= 100; k++) {
      const u = k / 100;
      const r = curvePoint(lines.rocker, u);
      const t = curvePoint(lines.deck, u);
      expect(r.z).toBe(0);
      // A partition of unity times 6: rounding of the four-term sums.
      expect(Math.abs(t.z - 6)).toBeLessThanOrEqual(4 * EPS * 6);
      expect(r.y).toBe(0);
      expect(Math.abs(r.x - (d.deck.x[0] + u * ext))).toBeLessThanOrEqual(1e-13 * ext);
    }
  });

  it('a symmetric random field: the line is the surface along y = 0 (to rounding)', () => {
    // geom's isoCurve in v is the surface's sums re-associated (bitwise only in u),
    // so the agreement is to the rounding of two 16-term sums of |z| ≤ 10: 16ε·10.
    const rng = mulberry32(7);
    const nv = 7;
    const base = randomField(rng, 9, nv);
    const z = [...base.z];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) z[i * nv + nv - 1 - j] = z[i * nv + j]!;
    const hf: HeightFieldJSON = {
      ...base,
      knotsV: [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1],
      y: [-30, 30],
      z,
    };
    const s = heightFieldSurface(hf, 'mirror-y');
    const { rocker } = stringerLines({ deck: s, bottom: s });
    for (let k = 0; k <= 50; k++) {
      const u = k / 50;
      const a = curvePoint(rocker, u);
      const b = surfacePoint(s, u, 0.5);
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeLessThanOrEqual(16 * EPS * 210);
      expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(16 * EPS * 10);
    }
  });

  /** ‖A⁻¹‖∞ of the Greville collocation matrix A_ij = N_j(ū_i) (Gauss–Jordan with pivoting). */
  function collocationInverseNorm(b: ClampedBasis): number {
    const g = grevilleAbscissae(b);
    const n = b.count;
    const a = Array.from({ length: n }, (_, i) => [
      ...Array.from({ length: n }, (_, j) => basisFunction(b, j, g[i]!)),
      ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    ]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
      [a[c], a[p]] = [a[p]!, a[c]!];
      const piv = a[c]![c]!;
      for (let k = 0; k < 2 * n; k++) a[c]![k]! /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r]![c]!;
        for (let k = 0; k < 2 * n; k++) a[r]![k]! -= f * a[c]![k]!;
      }
    }
    let norm = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += Math.abs(a[i]![n + j]!);
      norm = Math.max(norm, row);
    }
    return norm;
  }

  it('the stringer identity: a constrained fit reproduces the target line, coefficient for coefficient', () => {
    for (let seed = 11; seed <= 16; seed++) {
      const rng = mulberry32(seed);
      const nu = 10;
      const u = randomClampedBasis(rng, 3, nu, { minSpacing: 1 / 15 });
      const hfBase: HeightFieldJSON = {
        degreeU: 3,
        degreeV: 3,
        knotsU: Array.from(u.knots),
        knotsV: [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1],
        x: [-2, 202],
        y: [-30, 30],
        z: Array.from({ length: nu * 7 }, () => 0),
      };
      // The target rocker: a random spline on the field's own u basis.
      const r = Array.from({ length: nu }, () => 10 * rng());
      const line: NurbsCurve<1> = makeCurve({ dim: 1, basis: u, points: r });
      // Data from a surface whose stringer is something else (a bump and a tilt).
      const F = (x: number, y: number): number =>
        3 + 0.02 * x + 0.004 * y * y + 2 * Math.sin(x / 30) * Math.cos(y / 20);
      const pts: number[] = [];
      const uv: number[] = [];
      for (let a = 0; a <= 40; a++) {
        for (let b = 0; b <= 20; b++) {
          const pu = a / 40;
          const pv = b / 20;
          const x = -2 + pu * 204;
          const y = -30 + pv * 60;
          pts.push(x, y, F(x, y));
          uv.push(pu, pv);
        }
      }
      const vb = clampedBasis(3, hfBase.knotsV);
      const fitWith = (constrained: boolean): HeightFieldJSON => {
        const fit = approximateSurface(
          pts,
          { uv },
          {
            u,
            v: vb,
            ...(constrained ? { constraints: stringerConstraints(hfBase, line) } : {}),
          },
        );
        expect(fit.ok, `seed ${seed}`).toBe(true);
        if (!fit.ok) throw new Error('fit failed');
        const z: number[] = [];
        for (let i = 0; i < nu; i++)
          for (let j = 0; j < 7; j++) z.push(surfaceControlPoint(fit.value.surface, i, j).z);
        return { ...hfBase, z };
      };
      const lineCoeffDiff = (hf: HeightFieldJSON): number => {
        const s = heightFieldSurface(hf, 'none');
        const { rocker } = stringerLines({ deck: s, bottom: s });
        const cp = new Float64Array(nu * 3);
        controlPointsInto(rocker, cp, 0);
        let worst = 0;
        for (let i = 0; i < nu; i++) worst = Math.max(worst, Math.abs(cp[3 * i + 2]! - r[i]!));
        return worst;
      };
      const free = lineCoeffDiff(fitWith(false));
      const hf = fitWith(true);
      const s = heightFieldSurface(hf, 'none');
      const g = grevilleAbscissae(u);
      let e = 0;
      for (let i = 0; i < nu; i++) {
        e = Math.max(e, Math.abs(surfacePoint(s, g[i]!, 0.5).z - curvePoint(line, g[i]!)));
      }
      expect(e, `seed ${seed}: residual at the sites`).toBeLessThanOrEqual(
        DEFAULT_TOLERANCES.constraint,
      );
      const bound = collocationInverseNorm(u) * DEFAULT_TOLERANCES.constraint + 16 * EPS * 20;
      expect(lineCoeffDiff(hf), `seed ${seed}: coefficients`).toBeLessThanOrEqual(bound);
      expect(free, `seed ${seed}: unconstrained fit is not the line`).toBeGreaterThan(0.1);
    }
  });

  it('stringerConstraints refuses a line on another basis (the identity would not hold)', () => {
    const d = stadiumBoard();
    const other = clampedBasis(3, [0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
    const line = makeCurve({ dim: 1, basis: other, points: [0, 1, 2, 3, 4] });
    expect(() => stringerConstraints(d.bottom, line)).toThrow(/own u basis/);
  });
});
