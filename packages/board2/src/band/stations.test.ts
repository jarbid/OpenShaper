// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The band basis and its stations (docs/design/board2.md §5.4 conditions 1–2,
 * §3.2, §3.7).
 *
 * Oracles:
 * - **Conditions met, judged independently**: after `stationBasis`, every span
 *   of the band basis is at most `maxStationSpacing` long by geom's direct
 *   adaptive `curveLength` over the span (not the table the code uses), within
 *   1e-9 relative (`quadRel` 1e-10 of two quadratures); and the tangent turn
 *   between any two of 64 samples per span (geom's `curveTangent`) is at most
 *   the cone bound, itself at most `maxFrameTurn`. The bound is not vacuous:
 *   the largest sampled turn over the spans is within a factor 2 of the largest
 *   bound.
 * - **Same curve**: the refined apex plan evaluates to the plan loop within
 *   1e-12 × scale at random parameters (knot insertion is exact).
 * - **Bitwise function of (plan, inserted)**: two builds of the same list give
 *   `===` control points; the knot set stays mirror-symmetric (geom's pairing
 *   exists) and partners are exact mirrors.
 * - **Stations**: self-paired columns at exactly u = 0 and ½ with σ exactly 0
 *   and ½ and the exact tip frames; a partner's σ is `1 − σ_master` exactly;
 *   σ equals the arc fraction by geom's direct length within 1e-9.
 * - **Termination**: a span narrower than `2 · knotRel` is never split.
 */
import {
  controlPointsInto,
  curveLength,
  curvePoint,
  curveTangent,
  periodicBasis,
} from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILD_PARAMS } from '../params';
import { planArc, planCurve } from '../plan';
import { periodicKnotsSymmetric } from '../symmetry';
import { notchedLoopFixture, offKnotLoop, sampleDoc, stadiumPlan } from '../testing/index';
import type { PlanLoopJSON } from '../types';
import {
  bandBasis,
  bandColumns,
  basisSpans,
  insertMidpoints,
  spanGeometry,
  stationBasis,
} from './stations';

const B = DEFAULT_BUILD_PARAMS;

const loops: readonly (readonly [string, PlanLoopJSON])[] = [
  ['stadium', stadiumPlan()],
  ['sample', sampleDoc().plan],
  ['notched', notchedLoopFixture()],
  ['off-knot', offKnotLoop(mulberry32(4))],
];

describe('stationBasis: §5.4 conditions 1 and 2', () => {
  for (const [name, json] of loops) {
    it(`${name}: every span is short enough and turns little enough (independent judges)`, () => {
      const plan = planCurve(json);
      const arc = planArc(plan, true);
      const b = stationBasis(plan, arc, B, true);
      const g = spanGeometry(b, arc);
      let worstTurn = 0;
      let worstBound = 0;
      let worstLen = 0;
      let worstLenErr = 0;
      g.spans.forEach((s, k) => {
        const L = curveLength(b.apexPlan, [s.a, s.b]).value;
        worstLen = Math.max(worstLen, L);
        worstLenErr = Math.max(worstLenErr, Math.abs(L - g.length[k]!));
        // The sampled turn: the range of the tangent angle relative to the span start
        // (continuous across ±π because it never turns by π within a span).
        const t0 = curveTangent(b.apexPlan, s.a)!;
        const a0 = Math.atan2(t0.y, t0.x);
        let lo = 0;
        let hi = 0;
        for (let j = 1; j <= 64; j++) {
          const t = curveTangent(b.apexPlan, s.a + ((s.b - s.a) * j) / 64)!;
          let d = Math.atan2(t.y, t.x) - a0;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        if (!(hi - lo <= g.turn[k]! + 1e-12))
          expect(hi - lo, `span ${k}`).toBeLessThanOrEqual(g.turn[k]!);
        worstTurn = Math.max(worstTurn, hi - lo);
        worstBound = Math.max(worstBound, g.turn[k]!);
      });
      expect(worstLenErr).toBeLessThanOrEqual(1e-9 * arc.total);
      expect(worstLen).toBeLessThanOrEqual(B.maxStationSpacing * (1 + 1e-9));
      expect(worstBound).toBeLessThanOrEqual(B.maxFrameTurn);
      expect(worstTurn).toBeGreaterThan(0.5 * worstBound);
    });
  }

  it('the refined plan is the same curve; the build is a bitwise function of the inserted knots', () => {
    const plan = planCurve(stadiumPlan());
    const arc = planArc(plan, true);
    const b = stationBasis(plan, arc, B, true);
    expect(b.inserted.length).toBeGreaterThan(0);
    const rng = mulberry32(2);
    for (let k = 0; k < 200; k++) {
      const u = rng();
      const p = curvePoint(plan, u);
      const q = curvePoint(b.apexPlan, u);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(1e-12 * 200);
    }
    const again = bandBasis(plan, b.inserted, true);
    const p1 = new Float64Array(b.basis.count * 2);
    const p2 = new Float64Array(b.basis.count * 2);
    controlPointsInto(b.apexPlan, p1, 0);
    controlPointsInto(again.apexPlan, p2, 0);
    expect(p2).toEqual(p1);
    expect(Array.from(again.basis.knots)).toEqual(Array.from(b.basis.knots));
    expect(periodicKnotsSymmetric(b.basis)).toBe(true);
    const pr = b.pairing!;
    for (let i = 0; i < pr.partner.length; i++) {
      const j = pr.partner[i]!;
      if (pr.role[i] === 'self') expect(p1[2 * i + 1]).toBe(0);
      if (pr.role[i] === 'partner') {
        expect(p1[2 * i]).toBe(p1[2 * j]);
        expect(p1[2 * i + 1]).toBe(-p1[2 * j + 1]!);
      }
    }
  });
});

describe('bandColumns', () => {
  for (const [name, json] of loops) {
    it(`${name}: tips exact, partners mirrored in σ, σ = the arc fraction`, () => {
      const plan = planCurve(json);
      const arc = planArc(plan, true);
      const b = stationBasis(plan, arc, B, true);
      const cols = bandColumns(b, arc);
      let selves = 0;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i]!;
        if (c.role === 'self') {
          selves++;
          expect([0, 0.5]).toContain(c.u);
          expect(c.sigma).toBe(c.u);
          expect(c.frame.inward.y).toBe(0);
          expect(c.frame.inward.x).toBe(c.u === 0 ? 1 : -1);
        } else if (c.role === 'partner') {
          expect(c.sigma).toBe(1 - cols[c.partner]!.sigma);
        } else {
          const L = c.u === 0 ? 0 : curveLength(plan, [0, c.u]).value;
          expect(Math.abs(c.sigma - L / arc.total)).toBeLessThanOrEqual(1e-9);
        }
      }
      // Knots at 0 and ½ (uniform stadium, sample, notched) give self-paired columns there.
      if (name !== 'off-knot') expect(selves).toBe(2);
    });
  }
});

describe('insertMidpoints', () => {
  it('adds a span midpoint and its mirror, and never splits a span narrower than 2·knotRel', () => {
    const plan = planCurve(stadiumPlan());
    const b = bandBasis(plan, [], true);
    const spans = basisSpans(b.basis);
    const one = insertMidpoints(b, [spans[3]!], true);
    expect(one.length).toBe(2);
    const m = 0.5 * (spans[3]!.a + spans[3]!.b);
    expect(one).toContain(m);
    // The mirror −m, in the period.
    expect(one.some((x) => Math.abs(x - (1 - m)) <= 1e-15)).toBe(true);
    // A span of 1.5·knotRel: its midpoint is within knotRel of both ends and is dropped.
    const w = 1.5e-10;
    const tiny = periodicBasis(3, [0, 0.25, 0.5, 0.5 + w, 0.75], 1);
    const fake = { ...b, basis: tiny, inserted: [] };
    expect(insertMidpoints(fake, [{ a: 0.5, b: 0.5 + w }], false)).toEqual([]);
  });
});
