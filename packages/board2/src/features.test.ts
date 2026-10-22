// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom features (docs/design/board2.md §6.2, §13.2 `features`).
 *
 * Oracles:
 * - **Closed form.** On the stadium's straight part the tuck row is exactly the
 *   line |y| = ρ − w_t (four collinear apex control points per span, offset by
 *   the constant inset along the constant normal), so `h_t = 23` cm there with
 *   no code of ours involved, and a depth whose keys are all auto with zero
 *   slopes is a smoothstep per segment (Fritsch–Carlson gives slope 0 at an
 *   extremum and at the ends). Displacements computed from these closed forms,
 *   written out here, are compared with the built bottom minus the base at
 *   seeded random points: within `featureTol` (the fit's target, the design's
 *   tolerance), and a vee, which lies in the spline space once its own knot
 *   lines are in (a parabola and lines in |y| with double knots at ±r h_t, a
 *   cubic smoothstep in x with double knots at the keys), to rounding.
 * - **Where h_t varies** (the tail arc): the same closed forms with `h_t`
 *   computed here, independently of `features.ts`: the tuck curve's −y half
 *   inverted by dense bracketing and Newton on geom's derivatives. A single
 *   concave and two channels (the case that took 149 s before the separable
 *   fit) reach `featureTol` within the suite's 20 s test budget.
 * - **The separable fit** equals geom's `approximateSurface` on the same grid
 *   and bases (the same least-squares minimiser) to rounding.
 * - **h_t** against its definition: `at(x(u)) = −y(u)` on the tuck curve at
 *   random u (an inverse-function identity), `minOver` against dense sampling.
 * - **Order independence**: the same features in another order give the same
 *   bottom within 1e-12 × scale; **identity**: no enabled feature returns the
 *   base surface itself.
 * - Negative controls for every geometric `feature-invalid` rule, and an
 *   honest `not-converged` warning when the target is out of reach.
 */
import {
  approximateSurface,
  clampedBasis,
  curveDerivatives,
  curvePoint,
  resolveTolerances,
  surfacePoint,
} from '@openshaper/geom';
import type { NurbsSurface, PeriodicCurve } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { bandContext, insetPlanCurve } from './band/band';
import { stationBasis } from './band/stations';
import { buildBoard } from './build';
import {
  bottomWithFeatures,
  bump,
  featureIssues,
  tensorLeastSquares,
  tuckWidth,
  veeProfile,
} from './features';
import { checkHeightFieldSymmetry } from './symmetry';
import { stadiumBoard, stadiumFacts } from './testing';
import type { BoardDoc, BottomFeature, KeyedCurve } from './types';

const TOL = resolveTolerances();
const RHO = 25;
const TUCK = 2; // the default tuck inset
const HT = RHO - TUCK; // h_t on the straight part, exactly

/** Depth keys (x, value) with every handle automatic. */
const depthOf = (...kv: [number, number][]): KeyedCurve => ({
  keys: kv.map(([s, value]) => ({ s, value })),
});
/** The smoothstep closed form of an all-auto depth whose key values are extremes or ends. */
function smoothstep(kv: readonly [number, number][], x: number): number {
  if (x <= kv[0]![0] || x >= kv[kv.length - 1]![0]) return 0;
  let k = 0;
  while (kv[k + 1]![0] < x) k++;
  const [a, va] = kv[k]!;
  const [b, vb] = kv[k + 1]!;
  const t = (x - a) / (b - a);
  return va + (vb - va) * (3 * t * t - 2 * t * t * t);
}
/** Keys inside the stadium's straight part [34.4, 154.4] (stadiumFacts). */
const KV: [number, number][] = [
  [60, 0],
  [100, 1],
  [140, 0],
];
const scaled = (d: number): [number, number][] => KV.map(([s, v]) => [s, v * d]);

const vee = (d = 0.5, r = 0.3): BottomFeature => ({
  id: 'vee',
  kind: 'vee',
  enabled: true,
  depth: depthOf(...scaled(d)),
  stringerRadius: r,
});
const concave = (d = 0.4, width = 0.6): BottomFeature => ({
  id: 'concave',
  kind: 'concave',
  enabled: true,
  depth: depthOf(...scaled(d)),
  layout: 'single',
  centre: 0,
  width,
});
const double = (d = 0.3): BottomFeature => ({
  id: 'double',
  kind: 'concave',
  enabled: true,
  depth: depthOf(...scaled(d)),
  layout: 'double',
  centre: 0.5,
  width: 0.3,
});
const channels = (d = 0.3): BottomFeature => ({
  id: 'channels',
  kind: 'channels',
  enabled: true,
  depth: depthOf(...scaled(d)),
  count: 2,
  width: 2,
  pitch: 4,
  railInset: 2,
});

/**
 * The closed forms of the module comment (independent of `features.ts`) at depth `depth`
 * and tuck half-width `ht`.
 */
function displacement(f: BottomFeature, depth: number, y: number, ht: number): number {
  const eta = Math.abs(y) / ht;
  const b4 = (t: number) => (Math.abs(t) < 1 ? (1 - t * t) ** 2 : 0);
  switch (f.kind) {
    case 'vee': {
      const r = f.stringerRadius;
      const g = eta < r ? (eta * eta) / (2 * r) : eta - r / 2;
      return (depth * g) / (1 - r / 2);
    }
    case 'concave':
      return depth * b4((eta - f.centre) / f.width);
    case 'channels': {
      let s = 0;
      for (let k = 0; k < f.count; k++) {
        const c = f.railInset + f.width / 2 + k * f.pitch;
        s += b4((Math.abs(y) - (ht - c)) / (f.width / 2));
      }
      return depth * s;
    }
  }
}

/** On the straight part: `h_t = HT` exactly and an all-auto depth of peak `d`. */
const closedForm = (f: BottomFeature, d: number, x: number, y: number): number =>
  displacement(f, smoothstep(scaled(d), x), y, HT);

/**
 * `h_t(x)` independently of `features.ts`: the tuck curve's −y half (u in [0, ½], x
 * strictly increasing) tabulated densely, the bracket of x found by binary search, then
 * Newton on `x(u) − x` with geom's first derivative, kept inside the bracket (bisection
 * when a step leaves it), to `|x(u) − x| ≤ 1e-13 × length`. Returns `−y(u)`.
 */
function independentHalfWidth(tuck: PeriodicCurve<2>): (x: number) => number {
  const N = 4000;
  const us = Array.from({ length: N + 1 }, (_, k) => (0.5 * k) / N);
  const xs = us.map((u) => curvePoint(tuck, u).x);
  const scale = xs[N]! - xs[0]!;
  return (x: number) => {
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid;
    }
    let a = us[lo]!;
    let b = us[hi]!;
    let u = 0.5 * (a + b);
    for (let it = 0; it < 100; it++) {
      const [p, d1] = curveDerivatives(tuck, u, 1);
      const r = p!.x - x;
      if (Math.abs(r) <= 1e-13 * scale) break;
      if (r < 0) a = u;
      else b = u;
      const next = u - r / d1!.x;
      u = next > a && next < b ? next : 0.5 * (a + b);
    }
    return -curvePoint(tuck, u).y;
  };
}

/** Stages 2–6 on a document: the base bottom, the tuck curve and the bottom with features. */
function stage6(doc: BoardDoc) {
  const ctx = bandContext(doc);
  const b = stationBasis(ctx.plan, ctx.arc, doc.build, true, ctx.tol);
  const tuck = insetPlanCurve(ctx, b, 'tuck');
  return { ctx, tuck, r: bottomWithFeatures(doc, ctx.bottom, tuck, ctx.tol) };
}

/** z of a height-field surface at plan (x, y) (its (u, v) is the affine image). */
function zAt(s: NurbsSurface, doc: BoardDoc, x: number, y: number): number {
  const [x0, x1] = doc.bottom.x;
  const [y0, y1] = doc.bottom.y;
  return surfacePoint(s, (x - x0) / (x1 - x0), (y - y0) / (y1 - y0)).z;
}

describe('closed-form profiles', () => {
  it('bump: (1 − t²)², zero value and slope at |t| = 1', () => {
    expect(bump(0)).toBe(1);
    expect(bump(0.5)).toBe(0.5625);
    expect(bump(1)).toBe(0);
    expect(bump(-1.5)).toBe(0);
    const h = 1e-6;
    expect(Math.abs(bump(1 - h) / h)).toBeLessThan(1e-5); // slope O(h) at the edge
  });

  it('vee: flat at the stringer, C¹ at r, g(1) = 1', () => {
    for (const r of [0.05, 0.3, 1]) {
      expect(veeProfile(0, r)).toBe(0);
      expect(veeProfile(1, r)).toBeCloseTo(1, 15);
      const h = 1e-7;
      // One-sided slopes at r agree (C¹): both 1/(1 − r/2), to the left quotient's truncation
      // h · g″ / 2 with g″ = 1/(r (1 − r/2)) on the parabola (the right side is linear), plus
      // the quotients' rounding (ε / h ≈ 2e-9).
      const left = (veeProfile(r, r) - veeProfile(r - h, r)) / h;
      const right = (veeProfile(r + h, r) - veeProfile(r, r)) / h;
      expect(Math.abs(left - right)).toBeLessThan(h / (r * (1 - r / 2)) + 1e-8);
      expect(right).toBeCloseTo(1 / (1 - r / 2), 6);
    }
  });
});

describe('the tuck half-width h_t', () => {
  const doc = stadiumBoard();
  const { tuck } = stage6(doc);
  const w = tuckWidth(tuck, TOL)!;

  it('is ρ − w_t on the straight part, and the inverse of the tuck curve elsewhere', () => {
    // The tuck row is exactly straight where every column of a span has a horizontal frame:
    // one spacing inside the plan's straight range at each end (60 … 140 is well inside).
    const f = stadiumFacts();
    expect(f.straight[0] + 10).toBeLessThan(60);
    expect(f.straight[1] - 10).toBeGreaterThan(140);
    for (const x of [60, 90, 140]) {
      expect(Math.abs(w.at(x) - HT)).toBeLessThan(1e-12 * RHO);
    }
    // The range is the tuck curve's own tips (≈ w_t from the tail: the row offsets control
    // points, so the curve's tip differs from w_t by about w Δθ²/8, §5.3).
    expect(w.xMin).toBe(curvePoint(tuck, 0).x);
    expect(w.xMax).toBe(curvePoint(tuck, 0.5).x);
    expect(Math.abs(w.xMin - TUCK)).toBeLessThan(0.005);
    const rng = mulberry32(41);
    for (let k = 0; k < 200; k++) {
      const u = 0.001 + 0.498 * rng();
      const p = curvePoint(tuck, u);
      // x is strictly increasing on (0, ½): its inverse at x(u) is u, so h_t(x(u)) = −y(u).
      // Bisection to the last bit: the error is |y′/x′| × an ulp of u.
      expect(Math.abs(w.at(p.x) + p.y)).toBeLessThan(1e-9);
    }
  });

  it('minOver is the exact minimum (dense sampling never finds a smaller one)', () => {
    for (const [a, b] of [
      [5, 50],
      [30, 160],
      [150, 185],
    ] as const) {
      const m = w.minOver(a, b);
      let dense = Infinity;
      for (let k = 0; k <= 4000; k++) dense = Math.min(dense, w.at(a + ((b - a) * k) / 4000));
      expect(m).toBeLessThanOrEqual(dense + 1e-12);
      expect(dense - m).toBeLessThan(1e-6);
    }
  });

  it('is undefined (null) for a tuck loop that is not a graph over x', () => {
    // The notched loop's tuck runs backwards round its swallow tips.
    expect(featureIssues([vee()], null).map((i) => i.code)).toEqual(['feature-invalid']);
  });
});

describe('features on the stadium: fit against the closed form', () => {
  const rng = mulberry32(7);
  for (const [name, f, d, exactTol] of [
    ['vee (in the spline space: rounding)', vee(), 0.5, 1e-12],
    ['single concave', concave(), 0.4, null],
    ['double concave', double(), 0.3, null],
    ['channels', channels(), 0.3, null],
  ] as const) {
    it(`${name}: total − base = d(x, η) within featureTol (seed 7)`, () => {
      const doc = { ...stadiumBoard(), features: [f] };
      const { ctx, r } = stage6(doc);
      expect(r.issues).toEqual([]);
      const fb = r.value!;
      const tolerance = exactTol ?? doc.build.featureTol;
      expect(fb.error).toBeLessThanOrEqual(tolerance);
      let worst = 0;
      for (let k = 0; k < 400; k++) {
        // Inside the straight part, across the whole tuck width and past the depth's support.
        const x = 40 + 110 * rng();
        const y = (2 * rng() - 1) * HT;
        const got = zAt(fb.surface, doc, x, y) - zAt(ctx.bottom, doc, x, y);
        worst = Math.max(worst, Math.abs(got - closedForm(f, d, x, y)));
      }
      // featureTol plus the rounding of two surface evaluations (6 cm field).
      expect(worst).toBeLessThanOrEqual(tolerance + 1e-12);
      // The fitted error is the verified maximum: the random samples see no more than it.
      expect(worst).toBeLessThanOrEqual(fb.error + 1e-12);
    });
  }

  // Where h_t varies the break lines curve across the tensor grid. The oracle is the closed
  // form with h_t inverted here (independentHalfWidth), at seeded random points over the
  // depth's support and the whole tuck width: within featureTol (plus the rounding of two
  // surface evaluations; the Newton residual 1e-13 × length moves h_t by less than that).
  for (const [name, f, kv] of [
    [
      'a single concave',
      { ...concave(0.4), depth: depthOf([10, 0], [45, 0.4], [80, 0]) },
      [
        [10, 0],
        [45, 0.4],
        [80, 0],
      ],
    ],
    [
      // 149 s (6 passes) when the fit was one banded solve on the whole net; the suite's 20 s
      // test budget (vitest.config.ts) is the time bound.
      'two channels',
      { ...channels(), depth: depthOf([10, 0], [30, 0.3], [70, 0]) },
      [
        [10, 0],
        [30, 0.3],
        [70, 0],
      ],
    ],
  ] as const) {
    it(`reaching the curved tail (h_t varies): ${name} within featureTol of the closed form`, () => {
      const doc = { ...stadiumBoard(), features: [f as BottomFeature] };
      const { ctx, tuck, r } = stage6(doc);
      expect(r.issues).toEqual([]);
      expect(r.value!.error).toBeLessThanOrEqual(doc.build.featureTol);
      const ht = independentHalfWidth(tuck);
      // The oracle is not trivially the code's: on the arc h_t differs from the straight 23 cm.
      expect(HT - ht(kv[0][0])).toBeGreaterThan(3);
      const rng2 = mulberry32(11);
      let worst = 0;
      for (let k = 0; k < 400; k++) {
        const x = kv[0][0] + (kv[2][0] - kv[0][0]) * rng2();
        const h = ht(x);
        const y = (2 * rng2() - 1) * h;
        const got = zAt(r.value!.surface, doc, x, y) - zAt(ctx.bottom, doc, x, y);
        const depth = smoothstep(kv as unknown as [number, number][], x);
        worst = Math.max(worst, Math.abs(got - displacement(f as BottomFeature, depth, y, h)));
      }
      expect(worst).toBeLessThanOrEqual(doc.build.featureTol + 1e-12);
    });
  }
});

describe('the separable least-squares fit', () => {
  it('equals approximateSurface on the same grid and bases (the same minimiser), to rounding', () => {
    // Random clamped bicubic bases (some double knots, as the feature fit has) and random
    // data on a grid of 8 samples per span: the Kronecker identity (Bu ⊗ Bv)⁺ = Bu⁺ ⊗ Bv⁺
    // makes the two minimisers equal; both solve normal equations of condition ~1e3, so they
    // agree to ~1e-13 of the data's unit scale.
    const rng = mulberry32(5);
    const interior = (n: number) => {
      const k = Array.from({ length: n }, () => 0.05 + 0.9 * rng()).sort((a, b) => a - b);
      return [...k, k[1]!].sort((a, b) => a - b); // one double knot
    };
    const full = (k: number[]) => [0, 0, 0, 0, ...k, 1, 1, 1, 1];
    const samples = (knots: number[]) => {
      const br = [...new Set(knots)].sort((a, b) => a - b);
      const out: number[] = [];
      for (let s = 0; s + 1 < br.length; s++) {
        for (let j = 0; j < 8; j++) out.push(br[s]! + ((j + 0.5) / 8) * (br[s + 1]! - br[s]!));
      }
      return Float64Array.from(out);
    };
    const KU = full(interior(6));
    const KV = full(interior(9));
    const bu = clampedBasis(3, KU, TOL);
    const bv = clampedBasis(3, KV, TOL);
    const us = samples(KU);
    const vs = samples(KV);
    const d = Float64Array.from({ length: us.length * vs.length }, () => 2 * rng() - 1);
    const z = tensorLeastSquares(d, us, vs, bu, bv, TOL);
    if (!(z instanceof Float64Array)) throw new Error(z.message);
    const pts = new Float64Array(d.length * 3);
    const uv = new Float64Array(d.length * 2);
    for (let i = 0; i < us.length; i++) {
      for (let j = 0; j < vs.length; j++) {
        const k = i * vs.length + j;
        pts.set([us[i]!, vs[j]!, d[k]!], 3 * k);
        uv.set([us[i]!, vs[j]!], 2 * k);
      }
    }
    const ref = approximateSurface(pts, { uv }, { u: bu, v: bv, tol: TOL });
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const cw = ref.value.surface.cw;
    expect(z.length).toBe(bu.count * bv.count);
    let diff = 0;
    for (let k = 0; k < z.length; k++) diff = Math.max(diff, Math.abs(z[k]! - cw[4 * k + 2]!));
    expect(diff).toBeLessThan(1e-12);
  });
});

describe('the sum', () => {
  it('does not depend on the features’ order (1e-12 × scale), and stays bitwise symmetric', () => {
    const fs = [vee(), concave(), channels()];
    const a = stage6({ ...stadiumBoard(), features: fs }).r.value!;
    const b = stage6({ ...stadiumBoard(), features: [fs[2]!, fs[0]!, fs[1]!] }).r.value!;
    expect(a.hf.knotsU).toEqual(b.hf.knotsU);
    expect(a.hf.knotsV).toEqual(b.hf.knotsV);
    let diff = 0;
    for (let k = 0; k < a.hf.z.length; k++)
      diff = Math.max(diff, Math.abs(a.hf.z[k]! - b.hf.z[k]!));
    // Three summands of size ≤ 1 cm on a 6 cm scale: a few ulps.
    expect(diff).toBeLessThan(1e-12 * 6);
    // The sum of three fits is within the sum of their errors of the sum of the closed forms.
    expect(checkHeightFieldSymmetry(a.hf, 'bottom', TOL)).toEqual([]);
  });

  it('break lines of two features closer than knotRel share one knot, still mirrored exactly', () => {
    // The vee's blend edge at 0.3 h_t and the double concave's inner edge (c − w) h_t, apart by
    // 1.2e-10 × 23 cm ≈ 5e-11 of the field's v extent: between paramRel (1e-12, the symmetry
    // check's slack) and knotRel (1e-10, below which geom refuses two distinct knots). Each
    // side's cluster gets one knot, and the two representatives must be a mirror pair.
    const near: BottomFeature = {
      ...(double() as Extract<BottomFeature, { kind: 'concave' }>),
      centre: 0.5,
      width: 0.2 + 1.2e-10,
    };
    const doc = { ...stadiumBoard(), features: [vee(), near] };
    const [y0, y1] = doc.bottom.y;
    const gap = (1.2e-10 * HT) / (y1 - y0);
    expect(gap).toBeGreaterThan(TOL.paramRel);
    expect(gap).toBeLessThan(TOL.knotRel);
    const r = stage6(doc).r;
    expect(r.issues).toEqual([]);
    const hf = r.value!.hf;
    expect(checkHeightFieldSymmetry(hf, 'bottom', TOL)).toEqual([]);
    // One knot (double) where the two break lines met, on each side.
    const v = (0.3 * HT - y0) / (y1 - y0);
    expect(hf.knotsV.filter((k) => Math.abs(k - (1 - v)) < 1e-9)).toHaveLength(2);
  });

  it('no enabled feature is the identity: the base surface itself', () => {
    const base = stadiumBoard();
    const off = { ...base, features: [{ ...vee(), enabled: false }] };
    const s = stage6(off);
    expect(s.r.value!.surface).toBe(s.ctx.bottom);
    expect(s.r.value!.error).toBe(0);
  });

  it('buildBoard: the band meets the bottom with its features, the rails rise by the vee', () => {
    const doc = { ...stadiumBoard(), features: [vee(0.5, 0.3)] };
    const r = buildBoard(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value;
    expect(b.report.featureFitError).toBeLessThan(1e-12);
    expect(b.report.edgeGaps.tuck).toBeLessThanOrEqual(TOL.fit);
    // At x = 100 (the depth's peak) the tuck sits at |η| ≈ 1, where the vee raised the bottom
    // by the full depth: find the tuck row point nearest x = 100 on the −y side.
    let best = { dx: Infinity, z: 0, y: 0 };
    for (let k = 0; k <= 2000; k++) {
      const p = curvePoint(b.tuck, (0.5 * k) / 2000);
      if (Math.abs(p.x - 100) < best.dx) best = { dx: Math.abs(p.x - 100), z: p.z, y: p.y };
    }
    expect(best.y).toBeCloseTo(-HT, 6);
    expect(best.z).toBeCloseTo(0.5, 4);
  });
});

describe('geometric feature checks (feature-invalid)', () => {
  const doc = stadiumBoard();
  const w = tuckWidth(stage6(doc).tuck, TOL)!;
  const codes = (fs: BottomFeature[]) => featureIssues(fs, w).map((i) => i.at?.feature);

  it('valid features pass; disabled ones are not judged', () => {
    expect(codes([vee(), concave(), double(), channels()])).toEqual([]);
    expect(codes([{ ...vee(), depth: depthOf([-50, 1], [0, 0]), enabled: false }])).toEqual([]);
  });

  it('a depth that does not start and end at 0', () => {
    expect(codes([{ ...vee(), depth: depthOf([60, 0], [100, 1]) }])).toEqual(['vee']);
    expect(codes([{ ...vee(), depth: depthOf([60, 0.2], [100, 1], [140, 0]) }])).toEqual(['vee']);
  });

  it('a depth support reaching the tuck loop’s ends', () => {
    expect(codes([{ ...vee(), depth: depthOf([1, 0], [100, 1], [140, 0]) }])).toEqual(['vee']);
    expect(codes([{ ...vee(), depth: depthOf([60, 0], [100, 1], [w.xMax, 0]) }])).toEqual(['vee']);
  });

  it('channels reaching past the stringer where the tuck is narrow', () => {
    const narrow: BottomFeature = {
      ...(channels() as Extract<BottomFeature, { kind: 'channels' }>),
      count: 3,
      pitch: 7,
      width: 3,
    };
    // Reach 2 + 1.5 + 14 + 1.5 = 19 cm: fine on the straight part (23 cm) …
    expect(codes([narrow])).toEqual([]);
    // … not where the support runs into the tail arc (h_t falls below 19 cm).
    expect(codes([{ ...narrow, depth: depthOf([8, 0], [60, 0.3], [100, 0]) }])).toEqual([
      'channels',
    ]);
  });
});

describe('an unreachable target is reported, not hidden', () => {
  it('featureTol 1e-9 with no refinement: a not-converged warning with the measured error', () => {
    const base = stadiumBoard();
    const doc: BoardDoc = {
      ...base,
      features: [concave()],
      build: { ...base.build, featureTol: 1e-9, edgeFit: { maxPasses: 0 } },
    };
    const r = stage6(doc).r;
    expect(r.value).not.toBeNull();
    const w = r.issues.find((i) => i.code === 'not-converged')!;
    expect(w.severity).toBe('warning');
    expect(w.at?.feature).toBe('concave');
    expect(w.value).toBe(r.value!.error);
    expect(r.value!.error).toBeGreaterThan(1e-9);
  });
});
