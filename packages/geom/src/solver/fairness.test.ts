// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Oracles for the fairness energies and their Gram matrices (design §10.2,
 * §16 `solver`):
 *
 * - **Zero on affine geometry.** Control points at the Greville abscissae of
 *   an affine map make the geometry that map exactly; its bending (and jerk)
 *   energy is 0 under either metric, on clamped and periodic bases.
 * - **Closed forms** (parametric metric) for polynomial surfaces with known
 *   Bézier nets: `z = u²` → 4, `z = uv` → 2, `z = u²v²` → 232/45, the thin
 *   plate scaled to a `[0, a] × [0, b]` domain (`/(a³ b)`), and curves
 *   `(t, t³)`: stretch 1 + 9/5, bend 12, jerk 36.
 * - **Scaled metric** against its closed form: a displacement
 *   `(0, 0, c u²)` from the reference plane `(a u, b v, 0)` (speeds exactly
 *   `a`, `b`) has energy `4c² b / a³`; a curve `(0, c t²)` from the line
 *   `(L t, 0)` has `4c² / L³`. Affine reparameterisation leaves the scaled
 *   energy unchanged and scales the parametric one by the known power.
 * - **Invariance under knot insertion and degree elevation** (the same
 *   geometry on a finer basis has the same energy).
 * - **The quadratic form equals direct quadrature** of the derivatives from
 *   `surfaceDerivatives` / `curveDerivatives` on random clamped and periodic,
 *   polynomial and rational geometry (an independent evaluation path).
 * - **Kronecker path ↔ point-wise path**: the polynomial assembly by
 *   Kronecker products equals the rational (point-wise, adaptive) assembly run
 *   on the same net with unit weights.
 *
 * Tolerances: polynomial cases are exact up to rounding in sums of
 * O(10²–10³) terms of size ~1: `1e-12` relative. Rational cases converge to
 * `quadRel` (1e-10) per span block by construction; the energy sums blocks
 * of mixed sign, so `1e-9` relative. The direct-quadrature oracle uses 48
 * points per span and checks its own convergence against 40 (to a tenth of
 * the tolerance): with weights in [0.5, 2] and double knots, 16 points were
 * still 9e-8 off on a jerk energy (measured), which is why it is not lower.
 */
import { describe, expect, it } from 'vitest';
import {
  bezierCurve,
  bezierSurface,
  clampedBasis,
  clampedUniformKnots,
  curveDerivatives,
  elevateDegreeSurface,
  fairnessEnergy,
  gaussLegendre,
  makeCurve,
  makeDofMap,
  makeSurface,
  periodicBasis,
  periodicUniformKnots,
  prepareFairSolver,
  refineKnots,
  refineKnotsSurface,
  reparameterize,
  reparameterizeSurface,
  surfaceDerivatives,
} from '../index';
import type { Basis, NurbsCurve, NurbsSurface } from '../index';
import { DEFAULT_TOLERANCES } from '../tolerance';
import { mulberry32, randomCurve, randomSurface } from '../testing';
import { curveFairnessMatrix, surfaceFairnessMatrix } from './fairness';
import { csrToDense } from '../linalg/sparse';

const EXACT = 1e-12;
/** "Zero" relative to the energy of a non-affine net of the same size (rounding of the sum). */
const ZERO = 1e-13;
/** Gauss–Legendre points per span of the direct-quadrature oracle (checked against 40 below). */
const ORACLE_ORDER = 48;
const RATIONAL = 1e-9;

function relClose(a: number, b: number, rel: number, what = ''): void {
  expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(
    rel * Math.max(1, Math.abs(b)),
  );
}

/** Greville abscissae of a basis (periodic: one period, wrapped into the domain). */
function greville(b: Basis): number[] {
  const p = b.degree;
  const out: number[] = [];
  if (b.kind === 'clamped') {
    for (let i = 0; i < b.count; i++) {
      let s = 0;
      for (let k = 1; k <= p; k++) s += b.knots[i + k]!;
      out.push(s / p);
    }
  }
  return out;
}

/** Non-empty spans `[a, b]` of a basis. */
function spanList(b: Basis): [number, number][] {
  const U = b.knots;
  const out: [number, number][] = [];
  if (b.kind === 'clamped') {
    for (let k = b.degree; k < b.count; k++) if (U[k + 1]! > U[k]!) out.push([U[k]!, U[k + 1]!]);
  } else {
    for (let k = 0; k < b.count; k++) {
      const e = k + 1 < b.count ? U[k + 1]! : U[0]! + b.period;
      if (e > U[k]!) out.push([U[k]!, e]);
    }
  }
  return out;
}

const dot = (a: { x: number; y: number; z: number }, b = a): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

/** Parametric thin-plate (and membrane) energy by tensor Gauss–Legendre of `surfaceDerivatives`. */
function directSurface(
  s: NurbsSurface,
  bend: number,
  stretch: number,
  order = ORACLE_ORDER,
): number {
  const g = gaussLegendre(order);
  let e = 0;
  for (const [ua, ue] of spanList(s.u)) {
    for (const [va, ve] of spanList(s.v)) {
      const hu = (ue - ua) / 2;
      const hv = (ve - va) / 2;
      for (let i = 0; i < order; i++) {
        for (let j = 0; j < order; j++) {
          const u = ua + hu * (g.nodes[i]! + 1);
          const v = va + hv * (g.nodes[j]! + 1);
          const d = surfaceDerivatives(s, u, v, 2);
          const w = hu * hv * g.weights[i]! * g.weights[j]!;
          e +=
            w *
            (bend * (dot(d.Suu) + 2 * dot(d.Suv) + dot(d.Svv)) + stretch * (dot(d.Su) + dot(d.Sv)));
        }
      }
    }
  }
  return e;
}

/**
 * Parametric curve energy `Σ_k c_k ∫|C^(k)|²` by Gauss–Legendre of
 * `curveDerivatives`, each span cut into `sub` equal pieces.
 */
function directCurve(
  c: NurbsCurve,
  coef: readonly number[],
  order = ORACLE_ORDER,
  sub = 1,
): number {
  const g = gaussLegendre(order);
  let e = 0;
  for (const [a0, b0] of spanList(c.basis)) {
    for (let piece = 0; piece < sub; piece++) {
      const a = a0 + ((b0 - a0) * piece) / sub;
      const h = (b0 - a0) / sub / 2;
      for (let i = 0; i < order; i++) {
        const t = a + h * (g.nodes[i]! + 1);
        const d = curveDerivatives(c as NurbsCurve<3>, t, 3);
        for (let k = 1; k <= 3; k++) {
          const v = d[k]!;
          e += h * g.weights[i]! * coef[k - 1]! * dot(v);
        }
      }
    }
  }
  return e;
}

/**
 * Parametric thin-plate energy of a single Bézier patch whose weights depend
 * on the v-row only: then `W = W(v)`, the u-factor of every integrand is a
 * polynomial of degree ≤ 2p in u (exact with `p + 1` points; 16 used), and v
 * is cut into `sub` pieces of `order` points each.
 */
function directPatchRows(s: NurbsSurface, sub: number, order: number): number {
  const gu = gaussLegendre(16);
  const gv = gaussLegendre(order);
  let e = 0;
  for (let piece = 0; piece < sub; piece++) {
    const v0 = piece / sub;
    const hv = 0.5 / sub;
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < order; j++) {
        const u = 0.5 * (gu.nodes[i]! + 1);
        const v = v0 + hv * (gv.nodes[j]! + 1);
        const d = surfaceDerivatives(s, u, v, 2);
        e +=
          0.5 * hv * gu.weights[i]! * gv.weights[j]! * (dot(d.Suu) + 2 * dot(d.Suv) + dot(d.Svv));
      }
    }
  }
  return e;
}

/** A biquadratic or bicubic Bézier patch `(u, v, z(u, v))` from Bernstein coefficients of z. */
function graph(zc: readonly number[], p: number, q: number): NurbsSurface {
  const pts: number[] = [];
  for (let i = 0; i <= p; i++)
    for (let j = 0; j <= q; j++) pts.push(i / p, j / q, zc[i * (q + 1) + j]!);
  return bezierSurface(pts, p + 1, q + 1);
}

describe('fairness energy: affine geometry has none', () => {
  it('a surface that is an affine map of its domain: zero bending, clamped and refined', () => {
    const rng = mulberry32(3);
    for (let t = 0; t < 4; t++) {
      const bu = clampedBasis(3, clampedUniformKnots(3, 6 + t));
      const bv = clampedBasis(2, [0, 0, 0, 0.3, 0.55, 1, 1, 1]);
      const A = Array.from({ length: 9 }, () => 2 * rng() - 1);
      const gu = greville(bu);
      const gv = greville(bv);
      const pts: number[] = [];
      for (const u of gu)
        for (const v of gv)
          pts.push(A[0]! * u + A[1]! * v + 3, A[2]! * u + A[3]! * v - 1, A[4]! * u + A[5]! * v + 7);
      const s = makeSurface({ u: bu, v: bv, points: pts });
      // The scale of rounding: the energy of a net of the same size that is not affine.
      const rough = makeSurface({ u: bu, v: bv, points: pts.map((x) => x * (1 + rng())) });
      for (const metric of ['parametric', 'scaled'] as const) {
        const ref = fairnessEnergy(rough, { bend: 1, metric: 'parametric' });
        expect(Math.abs(fairnessEnergy(s, { bend: 1, metric }))).toBeLessThanOrEqual(ZERO * ref);
      }
    }
  });

  it('a curve on a straight line (Greville), clamped: zero bending and jerk', () => {
    const b = clampedBasis(4, [0, 0, 0, 0, 0, 0.2, 0.5, 0.6, 1, 1, 1, 1, 1]);
    const pts = greville(b).flatMap((t) => [2 * t - 1, 3 * t, -t]);
    const c = makeCurve({ dim: 3, basis: b, points: pts });
    const rough = makeCurve({
      dim: 3,
      basis: b,
      points: pts.map((x, i) => x + (((i * 7) % 5) - 2) * 0.3), // not on a line
    });
    const ref = fairnessEnergy(rough, { bend: 1, jerk: 1, metric: 'parametric' });
    expect(Math.abs(fairnessEnergy(c, { bend: 1, jerk: 1 }))).toBeLessThanOrEqual(ZERO * ref);
    expect(
      Math.abs(fairnessEnergy(c, { bend: 1, jerk: 1, metric: 'parametric' })),
    ).toBeLessThanOrEqual(ZERO * ref);
  });

  it('a periodic curve whose net is a constant point has zero energy of every order', () => {
    const b = periodicBasis(3, periodicUniformKnots(7), 1);
    const c = makeCurve({
      dim: 2,
      basis: b,
      points: Array.from({ length: 14 }, (_, i) => (i % 2 ? 4 : -2)),
    });
    const rough = makeCurve({ dim: 2, basis: b, points: Array.from({ length: 14 }, (_, i) => i) });
    const ref = fairnessEnergy(rough, { stretch: 1, bend: 1, jerk: 1, metric: 'parametric' });
    // Every span is degenerate (speed at rounding level): the metric falls back to 1.
    expect(Math.abs(fairnessEnergy(c, { stretch: 1, bend: 1, jerk: 1 }))).toBeLessThanOrEqual(
      ZERO * ref,
    );
  });
});

describe('fairness energy: closed forms (parametric metric)', () => {
  it('thin plate of z = u², z = uv, z = u²v² on the unit square', () => {
    // Bernstein coefficients: u² → [0, 0, 1]; u → [0, ½, 1] (degree 2).
    const u2 = [0, 0, 0, 0, 0, 0, 1, 1, 1];
    const uv = [0, 0, 0, 0, 0.25, 0.5, 0, 0.5, 1];
    const u2v2 = [0, 0, 0, 0, 0, 0, 0, 0, 1];
    const w = { bend: 1, metric: 'parametric' } as const;
    relClose(fairnessEnergy(graph(u2, 2, 2), w), 4, EXACT, 'u²');
    relClose(fairnessEnergy(graph(uv, 2, 2), w), 2, EXACT, 'uv');
    relClose(fairnessEnergy(graph(u2v2, 2, 2), w), 232 / 45, EXACT, 'u²v²');
  });

  it('scales as 1/(a³ b) on a [0, a] × [0, b] domain; refinement and elevation keep it', () => {
    const s = graph([0, 0, 0, 0, 0, 0, 1, 1, 1], 2, 2); // z = u²
    const a = 2.5;
    const b = 0.4;
    const r = reparameterizeSurface(reparameterizeSurface(s, 'u', [0, a]), 'v', [0, b]);
    // S′(u′, v′) = S(u′/a, v′/b): S′_u′u′ = (0, 0, 2/a²), the rest vanish, so
    // ∫₀ᵃ∫₀ᵇ 4/a⁴ = 4b/a³.
    relClose(fairnessEnergy(r, { bend: 1, metric: 'parametric' }), (4 * b) / (a * a * a), EXACT);
    const fine = elevateDegreeSurface(refineKnotsSurface(s, 'u', [0.3, 0.3, 0.7]), 'v', 1);
    relClose(fairnessEnergy(fine, { bend: 1, metric: 'parametric' }), 4, EXACT, 'refined');
    // Elevation keeps the spans, so the scaled metric's speeds and energy too.
    // (Knot insertion does not: a finer partition follows the speed more
    // closely; the scaled energy is a property of geometry and partition.)
    const up = elevateDegreeSurface(elevateDegreeSurface(s, 'v', 1), 'u', 2);
    relClose(
      fairnessEnergy(up, { bend: 1 }),
      fairnessEnergy(s, { bend: 1 }),
      EXACT,
      'elevated scaled',
    );
  });

  it('curve (t, t³): stretch 1 + 9/5, bend 12, jerk 36', () => {
    // t³ → Bernstein [0, 0, 0, 1]; t → [0, ⅓, ⅔, 1].
    const c = bezierCurve(2, [0, 0, 1 / 3, 0, 2 / 3, 0, 1, 1]);
    const p = { metric: 'parametric' } as const;
    relClose(fairnessEnergy(c, { ...p, bend: 0, stretch: 1 }), 1 + 9 / 5, EXACT, 'stretch');
    relClose(fairnessEnergy(c, { ...p, bend: 1 }), 12, EXACT, 'bend');
    relClose(fairnessEnergy(c, { ...p, bend: 0, jerk: 1 }), 36, EXACT, 'jerk');
    relClose(
      fairnessEnergy(c, { ...p, bend: 2, jerk: 0.5, stretch: 3 }),
      2 * 12 + 0.5 * 36 + 3 * 2.8,
      EXACT,
    );
    const fine = refineKnots(c, [0.1, 0.5, 0.5, 0.9]);
    relClose(fairnessEnergy(fine, { ...p, bend: 1 }), 12, EXACT, 'refined');
  });
});

describe('fairness energy: scaled metric', () => {
  it('displacement (0, 0, c u²) from the plane (a u, b v, 0): 4 c² b / a³', () => {
    const a = 3;
    const b = 2;
    const c = 0.5;
    const ref: number[] = [];
    const g: number[] = [];
    const zc = [0, 0, 1];
    for (let i = 0; i <= 2; i++)
      for (let j = 0; j <= 2; j++) {
        ref.push((a * i) / 2, (b * j) / 2, 0);
        g.push((a * i) / 2, (b * j) / 2, c * zc[i]!);
      }
    const R = bezierSurface(ref, 3, 3);
    const G = bezierSurface(g, 3, 3);
    relClose(fairnessEnergy(G, { bend: 1 }, R), (4 * c * c * b) / (a * a * a), EXACT);
    // Swapping the reference for the parametric metric gives 4 c² (no speeds).
    relClose(fairnessEnergy(G, { bend: 1, metric: 'parametric' }, R), 4 * c * c, EXACT);
  });

  it('curve displacement (0, c t²) from the line (L t, 0): 4 c² / L³; invariant under reparameterisation', () => {
    const L = 7;
    const c = 0.3;
    const R = bezierCurve(2, [0, 0, L / 2, 0, L, 0]);
    const G = bezierCurve(2, [0, 0, L / 2, 0, L, c]);
    relClose(fairnessEnergy(G, { bend: 1 }, R), (4 * c * c) / (L * L * L), EXACT);
    // Reparameterise both to [2, 7] (factor s = 5): scaled unchanged, parametric × s⁻³.
    const s = 5;
    const R2 = reparameterize(R, [2, 7]);
    const G2 = reparameterize(G, [2, 7]);
    relClose(fairnessEnergy(G2, { bend: 1 }, R2), (4 * c * c) / (L * L * L), EXACT, 'scaled');
    relClose(
      fairnessEnergy(G2, { bend: 1, metric: 'parametric' }, R2),
      (4 * c * c) / (s * s * s),
      EXACT,
      'parametric',
    );
  });

  it('a random surface: scaled energy unchanged by affine reparameterisation', () => {
    const rng = mulberry32(8);
    const s = randomSurface(rng, { degreeU: 3, degreeV: 2, countU: 7, countV: 5, extent: 10 });
    const r = reparameterizeSurface(reparameterizeSurface(s, 'u', [-3, 9]), 'v', [1, 1.5]);
    relClose(
      fairnessEnergy(r, { bend: 1, stretch: 0.3 }),
      fairnessEnergy(s, { bend: 1, stretch: 0.3 }),
      EXACT,
    );
  });
});

describe('fairness energy: quadratic form ↔ direct quadrature of the derivatives', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`random surfaces (seed ${seed}): clamped/periodic, polynomial/rational`, () => {
      const rng = mulberry32(seed);
      const rational = seed % 2 === 0;
      const s = randomSurface(rng, {
        degreeU: 3,
        degreeV: 2,
        countU: 7,
        countV: 6,
        kindU: seed > 2 ? 'periodic' : 'clamped',
        weightRange: rational ? [0.5, 2] : undefined,
        basis: { maxMult: 2 },
      });
      const tolE = rational ? RATIONAL : EXACT;
      // The oracle itself is converged: 40 and 48 points agree far below tolE.
      relClose(directSurface(s, 1, 0, 40), directSurface(s, 1, 0), tolE / 10, 'oracle');
      relClose(
        fairnessEnergy(s, { bend: 1, metric: 'parametric' }),
        directSurface(s, 1, 0),
        tolE,
        'bend',
      );
      relClose(
        fairnessEnergy(s, { bend: 0.7, stretch: 1.3, metric: 'parametric' }),
        directSurface(s, 0.7, 1.3),
        tolE,
        'bend + stretch',
      );
    });

    it(`random curves (seed ${seed}): stretch, bend, jerk`, () => {
      const rng = mulberry32(100 + seed);
      const rational = seed % 2 === 0;
      const c = randomCurve(rng, {
        dim: 3,
        degree: 4,
        count: 9,
        kind: seed > 2 ? 'periodic' : 'clamped',
        weightRange: rational ? [0.5, 2] : undefined,
        maxMult: 2,
      });
      const tolE = rational ? RATIONAL : EXACT;
      const coef = [0.4, 1.1, 0.02];
      relClose(directCurve(c, coef, 40), directCurve(c, coef), tolE / 10, 'oracle');
      relClose(
        fairnessEnergy(c, {
          stretch: coef[0],
          bend: coef[1]!,
          jerk: coef[2],
          metric: 'parametric',
        }),
        directCurve(c, coef),
        tolE,
      );
    });
  }

  // A rational basis has R^(k) ≠ 0 for k > p (P&T eq. 4.8): a weighted line
  // bends and a conic arc has jerk, so the Gram matrix must not stop at order p.
  it('rational curves of degree ≤ 2: a 90° arc has jerk, a weighted line has bend', () => {
    const arc = bezierCurve(3, [1, 0, 0, 1, 1, 0, 0, 1, 0], [1, Math.SQRT1_2, 1]);
    const line = bezierCurve(3, [0, 0, 0, 1, 0, 0], [1, 3]);
    for (const [c, coef] of [
      [arc, [0, 0, 1]],
      [arc, [0.3, 0.8, 0.05]],
      [line, [0, 1, 0]],
      [line, [0.2, 1, 0.4]],
    ] as const) {
      const direct = directCurve(c, coef);
      expect(direct).toBeGreaterThan(1); // non-trivial: the energy the bug dropped
      relClose(directCurve(c, coef, 40), direct, RATIONAL / 10, 'oracle');
      relClose(
        fairnessEnergy(c, { stretch: coef[0], bend: coef[1], jerk: coef[2], metric: 'parametric' }),
        direct,
        RATIONAL,
        `degree ${c.basis.degree}, coef ${coef.join(',')}`,
      );
    }
    for (const degree of [1, 2]) {
      const rng = mulberry32(300 + degree);
      const c = randomCurve(rng, { dim: 3, degree, count: 6, weightRange: [0.5, 2] });
      const coef = [0.4, 1.1, 0.02];
      relClose(directCurve(c, coef, 40), directCurve(c, coef), RATIONAL / 10, 'oracle');
      relClose(
        fairnessEnergy(c, {
          stretch: coef[0],
          bend: coef[1]!,
          jerk: coef[2],
          metric: 'parametric',
        }),
        directCurve(c, coef),
        RATIONAL,
        `random rational degree ${degree}`,
      );
    }
  });

  it('the Kronecker (polynomial) assembly equals the point-wise (rational) one on unit weights', () => {
    const rng = mulberry32(17);
    const s = randomSurface(rng, {
      degreeU: 3,
      degreeV: 3,
      countU: 6,
      countV: 5,
      kindV: 'periodic',
    });
    const pts = new Float64Array(s.u.count * s.v.count * 3);
    for (let i = 0; i < pts.length / 3; i++)
      for (let c = 0; c < 3; c++) pts[i * 3 + c] = s.cw[i * 4 + c]!;
    const fw = { stretch: 0.5, bend: 1, jerk: 0, metric: 'scaled', on: 'shape' } as const;
    const sp = { kind: 'geometry', points: pts, dim: 3 } as const;
    const A = csrToDense(surfaceFairnessMatrix(s.u, s.v, s.cw, false, fw, sp, DEFAULT_TOLERANCES));
    const B = csrToDense(surfaceFairnessMatrix(s.u, s.v, s.cw, true, fw, sp, DEFAULT_TOLERANCES));
    let m = 0;
    for (const x of A) m = Math.max(m, Math.abs(x));
    for (let i = 0; i < A.length; i++)
      expect(Math.abs(A[i]! - B[i]!)).toBeLessThanOrEqual(RATIONAL * m);
  });
});

// Large weight ratios give the rational integrands narrow peaks that a single
// Gauss–Legendre rule, however high its order, misses (a 64-point rule was
// 0.4 % off at ratio 100 and 82 % at 1000): the spans are bisected. Oracles
// cut each span into 256 pieces of 48 (curves) or 20 (surfaces) points and
// check their own convergence against 128 pieces, to a tenth of RATIONAL.
describe('fairness energy: large weight ratios (adaptive rational quadrature)', () => {
  it('a rational cubic with weights (1, w, 1, 1), w up to 1000: bend and jerk', () => {
    for (const w of [10, 100, 1000]) {
      const c = bezierCurve(3, [0, 0, 0, 1, 2, 0, 2, 0, 0, 3, 1, 0], [1, w, 1, 1]);
      for (const coef of [
        [0, 1, 0],
        [0.3, 1, 0.01],
      ]) {
        const direct = directCurve(c, coef, ORACLE_ORDER, 256);
        relClose(directCurve(c, coef, ORACLE_ORDER, 128), direct, RATIONAL / 10, 'oracle');
        relClose(
          fairnessEnergy(c, {
            stretch: coef[0],
            bend: coef[1]!,
            jerk: coef[2],
            metric: 'parametric',
          }),
          direct,
          RATIONAL,
          `w = ${w}, coef ${coef.join(',')}`,
        );
      }
    }
  });

  it('a bicubic patch with v-rows weighted w / 1 / w / 1, w up to 50: thin plate', () => {
    // (At w = 500 the oracle itself needs more than 256 pieces.)
    for (const w of [5, 50]) {
      const pts: number[] = [];
      const ws: number[] = [];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          pts.push(10 * i, 2 * j, 3 * Math.sin(0.3 * i) * Math.cos(0.2 * j));
          ws.push(j % 2 === 0 ? w : 1);
        }
      }
      const s = bezierSurface(pts, 4, 4, ws);
      const direct = directPatchRows(s, 256, 20);
      relClose(directPatchRows(s, 128, 20), direct, RATIONAL / 10, 'oracle');
      relClose(fairnessEnergy(s, { bend: 1, metric: 'parametric' }), direct, RATIONAL, `w = ${w}`);
    }
  });

  it('reports non-convergence: the matrix flag, and a not-converged warning from the solver', () => {
    const fw = { stretch: 0, bend: 1, jerk: 0, metric: 'parametric', on: 'shape' } as const;
    const uniform = { kind: 'uniform', u: 1, v: 1 } as const;
    const c = bezierCurve(3, [0, 0, 0, 1, 2, 0, 2, 0, 0, 3, 1, 0], [1, 1000, 1, 1]);
    const capped = { ...DEFAULT_TOLERANCES, quadMaxSplits: 1 };
    expect(
      curveFairnessMatrix(c.basis, c.cw, 3, true, fw, uniform, DEFAULT_TOLERANCES).converged,
    ).toBe(true);
    expect(curveFairnessMatrix(c.basis, c.cw, 3, true, fw, uniform, capped).converged).toBe(false);
    const pts: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i < 16; i++) {
      pts.push(i >> 2, i & 3, 0);
      ws.push((i & 3) % 2 === 0 ? 50 : 1);
    }
    const s = bezierSurface(pts, 4, 4, ws);
    expect(surfaceFairnessMatrix(s.u, s.v, s.cw, true, fw, uniform, capped).converged).toBe(false);
    const problem = {
      target: s,
      dof: makeDofMap(s, []),
      constraints: [],
      fairness: { bend: 1 },
      stiffness: 0.01,
    };
    const warned = prepareFairSolver(problem, { quadMaxSplits: 1 });
    expect(warned.ok).toBe(true);
    expect(warned.issues.map((i) => [i.code, i.severity])).toEqual([['not-converged', 'warning']]);
    expect(prepareFairSolver(problem).issues).toEqual([]);
    // Polynomial geometry is integrated exactly: always converged.
    const poly = bezierSurface(pts, 4, 4);
    expect(
      surfaceFairnessMatrix(poly.u, poly.v, poly.cw, false, fw, uniform, capped).converged,
    ).toBe(true);
  });

  it('nearly equal weights: blocks that are zero up to rounding converge to the polynomial matrix', () => {
    // Weights 1 and 1 + 1e-12 alternate: every rational span is adaptive, its
    // orders above the degree (curve jerk at degree 2) are rounding noise,
    // and the rounding floor must stop the bisection. The polynomial matrix
    // differs by O(1e-12) relative.
    const rng = mulberry32(23);
    const c = randomCurve(rng, { dim: 3, degree: 2, count: 7 });
    const cw = Float64Array.from(c.cw, (x, i) =>
      i % 4 === 3 && (i >> 2) % 2 === 1 ? 1 + 1e-12 : x,
    );
    const fw = { stretch: 0.2, bend: 1, jerk: 0.5, metric: 'parametric', on: 'shape' } as const;
    const uniform = { kind: 'uniform', u: 1, v: 1 } as const;
    const R = curveFairnessMatrix(c.basis, cw, 3, true, fw, uniform, DEFAULT_TOLERANCES);
    const P = curveFairnessMatrix(c.basis, c.cw, 3, false, fw, uniform, DEFAULT_TOLERANCES);
    expect(R.converged).toBe(true);
    const A = csrToDense(R);
    const B = csrToDense(P);
    let m = 0;
    for (const x of B) m = Math.max(m, Math.abs(x));
    for (let i = 0; i < A.length; i++)
      expect(Math.abs(A[i]! - B[i]!)).toBeLessThanOrEqual(RATIONAL * m);
  });
});

describe('fairness energy: contract', () => {
  it('rejects jerk on a surface, negative or missing weights, and a mismatched reference', () => {
    const s = graph([0, 0, 0, 0, 0, 0, 1, 1, 1], 2, 2);
    const c = bezierCurve(2, [0, 0, 1, 0, 2, 1]);
    expect(() => fairnessEnergy(s, { bend: 1, jerk: 1 })).toThrow(/curves only/);
    expect(() => fairnessEnergy(s, { bend: -1 })).toThrow(/bend/);
    expect(() => fairnessEnergy(s, {} as { bend: number })).toThrow(/bend/);
    expect(() => fairnessEnergy(c, { bend: 1 }, s)).toThrow(/same kind/);
    expect(() => fairnessEnergy(c, { bend: 1 }, bezierCurve(2, [0, 0, 1, 0, 2, 1, 3, 3]))).toThrow(
      /basis/,
    );
    expect(() =>
      fairnessEnergy(c, { bend: 1 }, bezierCurve(2, [0, 0, 1, 0, 2, 1], [1, 2, 1])),
    ).toThrow(/weights/);
  });
});
