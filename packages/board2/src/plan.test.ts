// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan loop (docs/design/board2.md §3.2, §3.3, §13.2 `plan`).
 *
 * Oracles and tolerances:
 * - **Pieces** are the curve: each Bézier piece evaluated by de Casteljau's
 *   closed form equals `curvePoint` at the same loop parameter within
 *   `1e-13 × scale` (two evaluation orders of a cubic, ~10 roundings each).
 * - **Standard-tail certificate against dense sampling** (4,000 samples of x′
 *   per loop, 300 seeded random symmetric loops): a certified loop has no
 *   sample of the wrong sign (soundness); a loop with such a sample is refused
 *   at or before it (completeness at the sampling's resolution); a loop refused
 *   without a bad sample has x′ of the wrong sign just after the reported u.
 * - **Extent**: the stadium's closed forms (x from 0 to L, |y| ≤ ρ attained
 *   on the straight sides) within `1e-12 × L` (the exact extremes are
 *   evaluations of a cubic: rounding); no dense sample beyond them.
 * - **Area**: Green's theorem with a rule exact for degree 5. Two stadiums that
 *   differ by one straight point differ by exactly `2ρ h` (the straight part's
 *   rectangle; the ends are congruent): `1e-11` relative (rounding of two
 *   sums over ~50 pieces); scaling x by 2 doubles the area bitwise (powers of two
 *   commute with rounding); reversing the loop negates it.
 * - **Radius**: closed forms for a uniform cubic on a regular N-gon (at the knots
 *   `R(1 + cos θ)/2`, at mid-span `R (sin(3θ/2) + 5 sin(θ/2))² / (16 (cos(θ/2) −
 *   cos(3θ/2)))`) and the stadium's arcs: `1e-10` relative (the design's bar;
 *   the golden-section search leaves rounding at a smooth maximum).
 * - **Side certificate** (each half on its own side of y = 0) against 4,000
 *   samples of geom's y on 240 random off-knot loops: a certified
 *   loop has no sample on the wrong side beyond `Tolerances.point`, a sample on
 *   the wrong side means a refusal, and the reported u is on the wrong side
 *   (within `1e-12 × 200 cm`, two evaluation orders).
 * - **Off-knot loops** (`offKnotLoop`: non-uniform symmetric knots without a
 *   knot at u = 0 and/or ½) run the certificate's straddling-½ and
 *   non-knot-tail paths against the same dense sampling.
 * - **σ ↔ u**: σ(0) = 0 and σ(½) = ½ exactly; σ on the +y half, on a loop
 *   stored from another period start and on an off-knot loop against geom's
 *   direct adaptive arc length from the tail (`curveLength`, not the table)
 *   within `1e-9`; u(σ(u)) = u within `1e-12` (geom's `paramRel` stop), and along
 *   the stadium's straight side `Δσ · total = Δx` within `1e-9 × total` (two
 *   adaptive quadratures at geom's `quadRel` 1e-10 each, plus the table).
 */
import {
  createScratch,
  curveDerivatives,
  curveEvalBatchInto,
  curveLength,
  curvePoint,
  curveSignedCurvature,
  DEFAULT_TOLERANCES,
  makeCurve,
  periodicBasis,
  reverseCurve,
} from '@openshaper/geom';
import type { PeriodicCurve } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import {
  paramAtSigma,
  planArc,
  planCurve,
  planExtent,
  planFrame,
  planMinRadius,
  planPieces,
  planSideViolation,
  planSignedArea,
  quadraticRoots,
  sigmaAt,
  standardTailViolation,
  wrapUnit,
} from './plan';
import type { PlanPiece } from './plan';
import {
  notchedLoopFixture,
  offKnotLoop,
  sampleDoc,
  stadiumFacts,
  stadiumPlan,
} from './testing/index';
import type { PlanLoopJSON } from './types';

const EPS = Number.EPSILON;

/** A uniform symmetric loop from its −y half in Greville order (tail Q_0 … nose Q_h). */
function loopFromHalf(half: readonly (readonly [number, number])[]): PlanLoopJSON {
  const h = half.length - 1;
  const n = 2 * h;
  const q = half.map(([x, y]) => [x, y] as const);
  for (let k = h + 1; k < n; k++) q.push([q[n - k]![0], -q[n - k]![1]] as const);
  const points: number[] = [];
  for (let i = 0; i < n; i++) points.push(...q[(i + 2) % n]!);
  return { degree: 3, knots: Array.from({ length: n }, (_, i) => i / n), points };
}

/** Evaluates a piece at local s ∈ [0, 1] (Bernstein form). */
function pieceAt(p: PlanPiece, s: number): [number, number] {
  const r = 1 - s;
  const b = [r * r * r, 3 * r * r * s, 3 * r * s * s, s * s * s];
  let x = 0;
  let y = 0;
  for (let k = 0; k < 4; k++) {
    x += b[k]! * p.p[2 * k]!;
    y += b[k]! * p.p[2 * k + 1]!;
  }
  return [x, y];
}

describe('planPieces', () => {
  it('cut at the tail, contiguous, and equal to the curve', () => {
    for (const json of [stadiumPlan(), sampleDoc().plan, notchedLoopFixture()]) {
      const c = planCurve(json);
      const pieces = planPieces(c);
      expect(pieces[0]!.u0).toBe(0);
      expect(pieces[pieces.length - 1]!.u1).toBe(1);
      for (let k = 1; k < pieces.length; k++) expect(pieces[k]!.u0).toBe(pieces[k - 1]!.u1);
      for (const p of pieces) {
        for (const s of [0, 0.3, 0.71, 1]) {
          const [x, y] = pieceAt(p, s);
          const q = curvePoint(c, p.u0 + s * (p.u1 - p.u0));
          expect(Math.hypot(x - q.x, y - q.y)).toBeLessThanOrEqual(1e-13 * 300);
        }
      }
    }
  });

  it('a loop whose stored period does not start at 0 is still cut at u = 0', () => {
    const json = stadiumPlan();
    const n = json.knots.length;
    // The same curve with the period stored as [−2/n, 1 − 2/n): shift the knots and
    // the point list together.
    const knots = json.knots.map((t, i) => (i < n - 2 ? t : t - 1));
    const order = [...Array(n).keys()].map((i) => (i + n - 2) % n);
    const shiftedKnots = order.map((i) => knots[i]!);
    const points = order.flatMap((i) => [json.points[2 * i]!, json.points[2 * i + 1]!]);
    const c = planCurve({ degree: 3, knots: shiftedKnots, points });
    const ref = planCurve(json);
    const pieces = planPieces(c);
    expect(pieces[0]!.u0).toBe(0);
    const p = curvePoint(c, 0.123);
    const q = curvePoint(ref, 0.123);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(1e-12);
  });
});

describe('quadraticRoots', () => {
  /** Bernstein coefficients of k (s − a)(s − b). */
  const bern = (k: number, a: number, b: number): [number, number, number] => [
    k * a * b,
    k * (a * b - 0.5 * (a + b)),
    k * (1 - a) * (1 - b),
  ];
  it('finds the roots in (0, 1), ascending, and only those', () => {
    const r = quadraticRoots(bern(3, 0.7, 0.2));
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.2, 14);
    expect(r[1]).toBeCloseTo(0.7, 14);
    expect(quadraticRoots(bern(1, 0.4, 1.5)).map((x) => +x.toFixed(12))).toEqual([0.4]);
    expect(quadraticRoots(bern(1, -0.2, 1.5))).toEqual([]);
    expect(quadraticRoots(bern(2, 0.25, 0.25))).toEqual([0.25]); // double root
    expect(quadraticRoots([1, 1, 1])).toEqual([]); // positive constant
    expect(quadraticRoots([0, 0, 0])).toEqual([]); // identically zero: no isolated root
    expect(quadraticRoots([-1, 0, 1])).toEqual([0.5]); // linear
  });
});

describe('standard-tail certificate (invariant 2)', () => {
  it('accepts the stadium and the sample, refuses the notched loop near u = 0', () => {
    expect(standardTailViolation(planPieces(planCurve(stadiumPlan())))).toBeNull();
    expect(standardTailViolation(planPieces(planCurve(sampleDoc().plan)))).toBeNull();
    const u = standardTailViolation(planPieces(planCurve(notchedLoopFixture())));
    expect(u).not.toBeNull();
    expect(u!).toBeLessThan(DEFAULT_TOLERANCES.paramRel);
  });

  it('refuses a straight transom (x′ ≡ 0 on a piece) at its start', () => {
    // Four collinear points on x = −1 at the tail make the tail span a vertical line.
    const json = loopFromHalf([
      [-1, 0],
      [-1, -5],
      [-1, -10],
      [10, -20],
      [60, -24],
      [120, -22],
      [170, -12],
      [190, 0],
    ]);
    const u = standardTailViolation(planPieces(planCurve(json)));
    expect(u).not.toBeNull();
    expect(u!).toBeLessThan(0.5);
  });

  it('refuses a loop rooted at the nose (x′ < 0 on (0, ½)); a reversed loop still passes', () => {
    // Shifting the parameter by ½ (rotating the points by n/2) puts u = 0 at the nose.
    const json = sampleDoc().plan;
    const n = json.knots.length;
    const points = json.points.map((_, i) => json.points[(i + n) % (2 * n)]!);
    expect(standardTailViolation(planPieces(planCurve({ ...json, points })))).toBe(0);
    // Reversal keeps u = 0 at the tail and runs (0, ½) along +y, still forwards:
    // invariant 2 holds, and orientation is a separate check (validateBoard).
    const r = reverseCurve(planCurve(json)) as PeriodicCurve<2>;
    expect(standardTailViolation(planPieces(r))).toBeNull();
    expect(planSignedArea(planPieces(r))).toBeLessThan(0);
  });

  /** Judges one loop against 4,000 samples of geom's x′; returns [refused, sampled bad]. */
  const M = 4000;
  const ts = Float64Array.from({ length: M }, (_, k) => (k + 0.5) / M);
  const out = new Float64Array(4 * M);
  const scratch = createScratch({ maxDegree: 3 });
  function judgeTail(c: PeriodicCurve<2>, label: string): [boolean, boolean] {
    const v = standardTailViolation(planPieces(c));
    curveEvalBatchInto(c, ts, 1, out, scratch);
    let firstBad = -1;
    for (let k = 0; k < M; k++) {
      const u = ts[k]!;
      const xp = out[4 * k + 2]!;
      if (u < 0.5 ? !(xp > 0) : !(xp < 0)) {
        firstBad = u;
        break;
      }
    }
    if (firstBad >= 0) {
      expect(v, `${label}: sampling found x′ of the wrong sign`).not.toBeNull();
      expect(v!, label).toBeLessThanOrEqual(firstBad);
    } else if (v !== null) {
      // Refused between samples: x′ has the wrong sign just after v.
      let seen = false;
      for (let e = 12; e >= 1 && !seen; e--) {
        const u = v + 10 ** -e;
        const xp = curveDerivatives(c, u, 1)[1]!.x;
        if (u < 0.5 ? !(xp > 0) : !(xp < 0)) seen = true;
      }
      expect(seen, `${label}: refused at ${v} without evidence`).toBe(true);
    }
    return [v !== null, firstBad >= 0];
  }

  it('agrees with dense sampling of x′ on random symmetric loops', () => {
    let refused = 0;
    let sampledBad = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const h = 5 + Math.floor(rng() * 8);
      const half: [number, number][] = [];
      const noise = 60 * rng();
      for (let k = 0; k <= h; k++) {
        const x = (200 * k) / h + (k === 0 || k === h ? 0 : noise * (rng() - 0.5) * 2);
        const y = k === 0 || k === h ? 0 : -(5 + 25 * Math.sin((Math.PI * k) / h) * rng());
        half.push([x, y]);
      }
      const [r, b] = judgeTail(planCurve(loopFromHalf(half)), `seed ${seed}`);
      if (r) refused++;
      if (b) sampledBad++;
    }
    // Both outcomes occur, so the comparison has teeth.
    expect(refused).toBeGreaterThan(30);
    expect(300 - refused).toBeGreaterThan(30);
    expect(sampledBad).toBeGreaterThan(0);
  });

  it('agrees with dense sampling on non-uniform knot sets without knots at u = 0 and/or ½', () => {
    // The tail need not be a knot (toClamped inserts it) and a piece may straddle ½.
    let refused = 0;
    let straddles = 0;
    for (let seed = 1; seed <= 240; seed++) {
      const rng = mulberry32(1000 + seed);
      const json = offKnotLoop(rng, {
        tailKnot: seed % 4 === 1,
        noseKnot: seed % 4 === 2,
        noise: 40 * rng(),
      });
      const c = planCurve(json);
      const pieces = planPieces(c);
      if (pieces.some((p) => p.u0 < 0.5 && p.u1 > 0.5)) straddles++;
      expect(pieces[0]!.u0).toBe(0);
      expect(pieces[pieces.length - 1]!.u1).toBe(1);
      const [r] = judgeTail(c, `seed ${seed}`);
      if (r) refused++;
    }
    expect(straddles).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(30);
    expect(240 - refused).toBeGreaterThan(30);
  });
});

describe('side certificate (the halves on their own sides: a simple loop)', () => {
  const M = 4000;
  const POINT = DEFAULT_TOLERANCES.point;
  const ts = Float64Array.from({ length: M }, (_, k) => (k + 0.5) / M);
  const ys = new Float64Array(2 * M);
  const scratch = createScratch({ maxDegree: 3 });
  it('the stadium and the sample pass; a loop lying on the stringer fails', () => {
    expect(planSideViolation(planPieces(planCurve(stadiumPlan())))).toBeNull();
    expect(planSideViolation(planPieces(planCurve(sampleDoc().plan)))).toBeNull();
    // A loop with y ≡ 0 on both halves (a degenerate outline on the stringer) fails.
    const flat = loopFromHalf([
      [-10, 0],
      [20, 0],
      [100, 0],
      [180, 0],
      [210, 0],
    ]);
    expect(planSideViolation(planPieces(planCurve(flat)))).not.toBeNull();
  });

  it('agrees with dense sampling of y on random loops, with and without knots at the tips', () => {
    // Sound: a certified loop has no sample on the wrong side (beyond Tolerances.point
    // where the interval touches a tip). Complete: a sample on the wrong side means a
    // refusal. A refusal reports a u where y is on the wrong side (geom's evaluation;
    // 1e-12 × 200 cm for the two evaluation orders).
    let refused = 0;
    for (let seed = 1; seed <= 240; seed++) {
      const rng = mulberry32(5000 + seed);
      const json = offKnotLoop(rng, {
        tailKnot: seed % 3 === 0,
        noseKnot: seed % 5 === 0,
        crossing: 0.6 + 0.4 * rng(),
      });
      const c = planCurve(json);
      const v = planSideViolation(planPieces(c));
      curveEvalBatchInto(c, ts, 0, ys, scratch);
      let bad = false;
      for (let k = 0; k < M; k++) {
        const u = ts[k]!;
        const y = ys[2 * k + 1]!;
        const side = u < 0.5 ? -1 : 1;
        if (!(side * y > 0)) bad = true;
        if (v === null) expect(side * y, `seed ${seed}, u ${u}`).toBeGreaterThanOrEqual(-POINT);
      }
      if (bad) expect(v, `seed ${seed}: sampling found y on the wrong side`).not.toBeNull();
      if (v !== null) {
        refused++;
        const side = v < 0.5 ? -1 : 1;
        expect(side * curvePoint(c, v).y, `seed ${seed}`).toBeLessThanOrEqual(1e-12 * 200);
      }
    }
    expect(refused).toBeGreaterThan(30);
    expect(240 - refused).toBeGreaterThan(30);
  });
});

describe('planExtent and planSignedArea', () => {
  it('stadium closed forms: length L, width 2ρ, attained where expected', () => {
    const f = stadiumFacts();
    const c = planCurve(stadiumPlan());
    const e = planExtent(planPieces(c));
    const L = f.length;
    expect(Math.abs(e.xMin)).toBeLessThanOrEqual(1e-12 * L);
    expect(Math.abs(e.xMax - L)).toBeLessThanOrEqual(1e-12 * L);
    expect(Math.abs(e.yMax - 25)).toBeLessThanOrEqual(1e-12 * L);
    expect(Math.abs(e.yMin + 25)).toBeLessThanOrEqual(1e-12 * L);
    expect(wrapUnit(e.uXMin) < 1e-9 || wrapUnit(e.uXMin) > 1 - 1e-9).toBe(true);
    expect(e.uXMax).toBeCloseTo(0.5, 9);
    expect(curvePoint(c, e.uYMin).x).toBeGreaterThanOrEqual(f.straight[0] - 1e-9);
    // No dense sample exceeds the exact extremes (beyond rounding).
    for (let k = 0; k < 5000; k++) {
      const p = curvePoint(c, k / 5000);
      expect(p.x).toBeGreaterThanOrEqual(e.xMin - 1e-13 * L);
      expect(p.x).toBeLessThanOrEqual(e.xMax + 1e-13 * L);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(25 + 1e-13 * L);
    }
  });

  it('the Δ identity: one more straight point adds exactly the rectangle 2ρ·h', () => {
    for (const s of [3, 7, 14]) {
      const a = planSignedArea(planPieces(planCurve(stadiumPlan({ straightPoints: s }))));
      const b = planSignedArea(planPieces(planCurve(stadiumPlan({ straightPoints: s + 1 }))));
      expect(Math.abs(b - a - 2 * 25 * 10)).toBeLessThanOrEqual(1e-11 * b);
    }
  });

  it('scales and flips exactly; counter-clockwise is positive', () => {
    const json = stadiumPlan();
    const a = planSignedArea(planPieces(planCurve(json)));
    expect(a).toBeGreaterThan(0);
    const scaled = { ...json, points: json.points.map((v, i) => (i % 2 === 0 ? 2 * v : v)) };
    expect(planSignedArea(planPieces(planCurve(scaled)))).toBe(2 * a);
    const flipped = { ...json, points: json.points.map((v, i) => (i % 2 === 1 ? -v : v)) };
    expect(Math.abs(planSignedArea(planPieces(planCurve(flipped))) + a)).toBeLessThanOrEqual(
      1e-12 * a,
    );
  });
});

describe('planMinRadius (invariant 3)', () => {
  function polygonLoop(N: number, R: number): PeriodicCurve<2> {
    const pts: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      pts.push(R * Math.cos(a), R * Math.sin(a));
    }
    return makeCurve({
      dim: 2,
      basis: periodicBasis(
        3,
        Array.from({ length: N }, (_, i) => i / N),
        1,
      ),
      points: pts,
    });
  }

  it('matches the closed forms of a uniform cubic on a regular N-gon', () => {
    for (const [N, R] of [
      [6, 10],
      [12, 3],
      [40, 100],
    ] as const) {
      const th = (2 * Math.PI) / N;
      const knot = (R * (1 + Math.cos(th))) / 2;
      const mid =
        (R * (Math.sin(1.5 * th) + 5 * Math.sin(0.5 * th)) ** 2) /
        (16 * (Math.cos(0.5 * th) - Math.cos(1.5 * th)));
      const r = planMinRadius(planPieces(polygonLoop(N, R)));
      const expected = Math.min(knot, mid);
      expect(Math.abs(r.radius - expected) / expected, `N = ${N}`).toBeLessThanOrEqual(1e-10);
    }
  });

  it('the stadium: ρ(1 + cos θ)/2 at an arc knot for K = 2, 4; dense sampling otherwise', () => {
    for (const K of [2, 4]) {
      const r = planMinRadius(planPieces(planCurve(stadiumPlan({ arcSteps: K }))));
      const th = Math.PI / (2 * K);
      const expected = (25 * (1 + Math.cos(th))) / 2;
      expect(Math.abs(r.radius - expected) / expected, `K = ${K}`).toBeLessThanOrEqual(1e-10);
    }
    // With K = 6 the arc steps (6.5 cm) are shorter than the straight spacing
    // (10 cm) and the arc-to-straight span is the tightest: no closed form. Judge:
    // geom's own curvature on N = 20,000 samples plus every knot (|κ| is kinked at
    // a knot of a C² cubic). The search is never above the sampled minimum (beyond
    // rounding), and below it by at most what the sampling can miss round a smooth
    // minimum, ½ r″ (Δu/2)² with r″ measured by a central difference at the found
    // minimum (×2 for the difference's own error). Measured at K = 6: r″ ≈ 1.4e5
    // per unit u², so the allowance is ~2e-5 cm, 1e-6 relative.
    for (const K of [3, 6, 9]) {
      const c = planCurve(stadiumPlan({ arcSteps: K }));
      const found = planMinRadius(planPieces(c));
      const r = found.radius;
      const rad = (u: number): number => 1 / Math.abs(curveSignedCurvature(c, u));
      const N = 20000;
      let dense = Infinity;
      const at = [...Array.from({ length: N }, (_, k) => k / N), ...c.basis.knots];
      for (const u of at) dense = Math.min(dense, rad(u));
      const h = 1e-4;
      const r2 = Math.abs(rad(found.u + h) - 2 * rad(found.u) + rad(found.u - h)) / (h * h);
      const miss = 2 * 0.5 * r2 * (0.5 / N) ** 2;
      expect(r, `K = ${K}`).toBeLessThanOrEqual(dense * (1 + 1e-12));
      expect(dense - r, `K = ${K}`).toBeLessThanOrEqual(miss + 1e-12 * r);
    }
  });

  it('a cusp (three coincident control points) has radius 0; a notch has its own radius', () => {
    const json = loopFromHalf([
      [-10, 0],
      [20, -20],
      [100, -27],
      [100, -27],
      [100, -27],
      [180, -20],
      [210, 0],
    ]);
    expect(planMinRadius(planPieces(planCurve(json))).radius).toBe(0);
    const notch = planMinRadius(planPieces(planCurve(notchedLoopFixture())));
    // (Q₋₁ − 2Q₀ + Q₁) = (−12, 0), (Q₁ − Q₋₁)/2 = (0, −3): |κ| = 36/27 at the notch bottom.
    expect(Math.abs(notch.radius - 0.75) / 0.75).toBeLessThanOrEqual(1e-10);
    expect(wrapUnit(notch.u) < 1e-6 || wrapUnit(notch.u) > 1 - 1e-6).toBe(true);
  });
});

describe('frames and σ', () => {
  const c = planCurve(stadiumPlan());
  const f = stadiumFacts();

  it('exact frames at the tail and nose centres; t̂ unit, n̂ = ẑ × t̂ elsewhere', () => {
    expect(planFrame(c, 0, true)).toEqual({
      tangent: { x: 0, y: -1, z: 0 },
      inward: { x: 1, y: 0, z: 0 },
    });
    expect(planFrame(c, 0.5, true)!.inward).toEqual({ x: -1, y: 0, z: 0 });
    expect(planFrame(c, 1, true)!.inward).toEqual({ x: 1, y: 0, z: 0 });
    // Asymmetric mode computes it (to rounding).
    expect(Math.abs(planFrame(c, 0, false)!.inward.x - 1)).toBeLessThanOrEqual(4 * EPS);
    for (let k = 1; k < 100; k++) {
      const fr = planFrame(c, k / 100, true)!;
      expect(Math.hypot(fr.tangent.x, fr.tangent.y) - 1).toBeLessThanOrEqual(4 * EPS);
      expect(fr.inward.x).toBe(-fr.tangent.y);
      expect(fr.inward.y).toBe(fr.tangent.x);
    }
    // On the straight −y side the inward normal is +ŷ.
    // Q_11 (u = 11/44) is the middle of the straight −y side (K = 4, s = 14).
    const uStraight = 11 / f.count;
    const fr = planFrame(c, uStraight, true)!;
    expect(Math.abs(fr.inward.y - 1)).toBeLessThanOrEqual(4 * EPS);
  });

  it('σ: exact at the tips, the +y half against direct arc length, inverse to geom paramRel, arc length on the straight', () => {
    const a = planArc(c, true);
    expect(sigmaAt(a, 0)).toBe(0);
    expect(sigmaAt(a, 0.5)).toBe(0.5);
    expect(sigmaAt(a, 1)).toBe(0);
    expect(paramAtSigma(a, 0)).toBe(0);
    expect(paramAtSigma(a, 0.5)).toBe(0.5);
    let last = 0;
    for (let k = 1; k < 400; k++) {
      const u = k / 400;
      const s = sigmaAt(a, u);
      expect(s).toBeGreaterThan(last);
      last = s;
      expect(Math.abs(paramAtSigma(a, s) - u)).toBeLessThanOrEqual(1e-12);
    }
    // The +y half against an independent oracle: geom's direct adaptive arc length
    // from the tail (not the table), over the loop's length. By the mirror symmetry
    // ℓ(u) = total − ℓ(1 − u) and total = 2 ℓ(½), so σ(u) = ℓ(u) / total on (½, 1);
    // two quadratures at quadRel 1e-10 and the table: 1e-9.
    const total = curveLength(c).value;
    for (let k = 1; k < 40; k++) {
      const u = 0.5 + k / 80;
      const direct = curveLength(c, [0, u]).value / total;
      expect(Math.abs(sigmaAt(a, u) - direct), `u ${u}`).toBeLessThanOrEqual(1e-9);
    }
    // Along the straight side arc length is Δx.
    const xs = [f.straight[0] + 1, f.straight[1] - 1];
    const us = xs.map((x) => {
      let lo = 0.05;
      let hi = 0.45;
      for (let i = 0; i < 80; i++) {
        const m = 0.5 * (lo + hi);
        if (curvePoint(c, m).x < x) lo = m;
        else hi = m;
      }
      return 0.5 * (lo + hi);
    });
    const ds = (sigmaAt(a, us[1]!) - sigmaAt(a, us[0]!)) * a.total;
    expect(Math.abs(ds - (xs[1]! - xs[0]!))).toBeLessThanOrEqual(1e-9 * a.total);
    expect(Math.abs(a.total - 2 * a.half)).toBeLessThanOrEqual(1e-9 * a.total);
  });

  it('σ on a loop whose stored period does not start at the tail (and an off-knot loop)', () => {
    // The stadium with its period stored as [−2/n, 1 − 2/n) (as in the planPieces
    // test), and a loop with no knot at u = 0 or ½: σ is measured from the tail, so
    // it equals geom's direct arc length from u = 0 over the total within 1e-9.
    const json = stadiumPlan();
    const n = json.knots.length;
    const knots = json.knots.map((t, i) => (i < n - 2 ? t : t - 1));
    const order = [...Array(n).keys()].map((i) => (i + n - 2) % n);
    const shifted = planCurve({
      degree: 3,
      knots: order.map((i) => knots[i]!),
      points: order.flatMap((i) => [json.points[2 * i]!, json.points[2 * i + 1]!]),
    });
    expect(shifted.basis.domain[0]).toBeLessThan(0);
    for (const curve of [shifted, planCurve(offKnotLoop(mulberry32(3)))]) {
      const a = planArc(curve, true);
      expect(sigmaAt(a, 0)).toBe(0);
      expect(sigmaAt(a, 0.5)).toBe(0.5);
      const total = curveLength(curve).value;
      for (let k = 1; k < 40; k++) {
        const u = k / 40;
        const direct = curveLength(curve, [0, u]).value / total;
        expect(Math.abs(sigmaAt(a, u) - direct), `u ${u}`).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(paramAtSigma(a, sigmaAt(a, u)) - u)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it('asymmetric mode: σ is the plain arc fraction', () => {
    const a = planArc(c, false);
    const b = planArc(c, true);
    for (const u of [0.1, 0.37, 0.8]) {
      expect(Math.abs(sigmaAt(a, u) - sigmaAt(b, u))).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(paramAtSigma(a, sigmaAt(a, u)) - u)).toBeLessThanOrEqual(1e-12);
    }
  });
});
