// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `convertGeometry` beyond the per-file exit checks (`convert.*.exit.test.ts`):
 * the §9.1 preconditions (also through `convertClassic`, S7), immutability of the classic input, the knife-tip
 * lift, and the inset keys of §9.5.
 *
 * The lift is exercised by raising `minRailHeight` on a converted knife-tip
 * board (no sample file needs it at the default 1 mm once its tips are
 * filleted: their smallest station rail heights are 1.1 and 1.2 mm, S6 as
 * built). Oracles: `validateBoard`'s own rail-height check at every station
 * (an independent evaluation through the band builder's columns), the deck
 * unchanged outside the tip zone (1e-12 × the deck height: exact knot
 * insertion and a lift of exactly zero there), bitwise symmetry.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { knotFromArray, splineFromKnots } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import { curveDerivatives, curvePoint, resolveTolerances } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { heightFieldSurface, heightSampler } from '../height-field';
import { evaluateLaw } from '../law';
import { planCurve } from '../plan';
import { checkHeightFieldSymmetry } from '../symmetry';
import { validateBoard } from '../validate';
import type { Board2Issue, BoardDoc } from '../types';
import { convergenceIssues, convertClassic, convertGeometry, liftKnifeTips } from './convert';
import type { ClassicGeometry } from './convert';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { classicSample } from './test-support/samples';

/** The −y half's parameter at x (bisection on geom's evaluation; x increases there). */
function paramAtX(doc: BoardDoc, x: number): number {
  const plan = planCurve(doc.plan);
  let lo = 0;
  let hi = 0.5;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (curvePoint(plan, mid).x < x) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

describe('preconditions (§9.1)', () => {
  it('a classic tail cutout is refused with unsupported-tail', () => {
    const b = classicSample('golden/shortboard.brd').load();
    const third = (x0: number, y0: number, x1: number, y1: number): number[] => [
      x0 + (x1 - x0) / 3,
      y0 + (y1 - y0) / 3,
    ];
    // The kernel's swallow fixture (outline-cutout.test.ts): the curve folds back in x.
    const swallow = splineFromKnots([
      knotFromArray([15, 0, 15, 0, ...third(15, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 15, 0), ...third(0, 9, 100, 25)], false, false),
      knotFromArray([100, 25, ...third(100, 25, 0, 9), ...third(100, 25, 200, 0)], false, false),
      knotFromArray([200, 0, ...third(200, 0, 100, 25), 200, 0], false, false),
    ]);
    const r = convertGeometry({ ...b, outline: swallow });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['unsupported-tail']);
    // The public entry (S7) refuses with the same issue.
    const c = convertClassic({ ...b, outline: swallow });
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.code)).toEqual(['unsupported-tail']);
  });

  it('a board without a real section is refused with too-few-sections', () => {
    const b = classicSample('golden/shortboard.brd').load();
    const bare = { ...b, crossSections: [b.crossSections[0]!, b.crossSections.at(-1)!] };
    const r = convertGeometry(bare);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['too-few-sections']);
    const c = convertClassic(bare);
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.code)).toEqual(['too-few-sections']);
  });
});

describe('a knife-tip board', () => {
  let board: BezierBoard;
  let before: string;
  let g: ClassicGeometry;
  let warnings: readonly Board2Issue[];
  beforeAll(() => {
    board = classicSample('synthetic-clean-6x22x2-75.s3dx').load();
    before = JSON.stringify(board);
    const r = convertGeometry(board);
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    g = r.value;
    warnings = r.issues;
  }, 120_000);

  it('leaves the classic board untouched', () => {
    expect(JSON.stringify(board)).toBe(before);
  });

  it('inset keys: fractions of the half-width at the real stations, clamped, flat tip keys (§9.5)', () => {
    const b = g.doc.build;
    for (const [lane, frac] of [
      ['deckInset', O.deckInsetFraction],
      ['tuckInset', O.tuckInsetFraction],
    ] as const) {
      const law = g.doc.laws[lane];
      expect(law.domain).toBe('half');
      expect(law.keys[0]!.s).toBe(0);
      expect(law.keys.at(-1)!.s).toBe(0.5);
      for (const k of law.keys) {
        expect(k.value).toBeGreaterThanOrEqual(b.minInset);
        expect(k.in).toBeUndefined();
        expect(k.out).toBeUndefined();
      }
      // The middle station x = 91.44 sits on the side corner's fillet, so its key is
      // the curvature cap κρ there (ρ by geom's curvature, the half-width from the plan).
      const u = paramAtX(g.doc, 91.44 - g.shift);
      const plan = planCurve(g.doc.plan);
      const half = -curvePoint(plan, u).y;
      const [, d1, d2] = curveDerivatives(plan, u, 2);
      const rho = Math.hypot(d1!.x, d1!.y) ** 3 / (d1!.x * d2!.y - d1!.y * d2!.x);
      const mid = law.keys.find((k) => Math.abs(k.s - 0.25) < 0.05)!;
      expect(mid.value).toBeCloseTo(
        Math.max(b.minInset, Math.min(frac * half, b.insetCurvatureFraction * rho)),
        9,
      );
      expect(evaluateLaw(law, mid.s)).toBe(mid.value);
    }
  });

  it('a raised minRailHeight lifts the deck at the tips only, symmetric, and every station meets it', () => {
    const tol = resolveTolerances();
    const raised = 0.2;
    const doc: BoardDoc = { ...g.doc, build: { ...g.doc.build, minRailHeight: raised } };
    expect(validateBoard(doc).some((i) => i.code === 'rail-height')).toBe(true);
    const zones = g.floors.zones.map(([a, b]) => [a - g.shift, b - g.shift] as const);
    const lift = liftKnifeTips(doc, zones, O);
    expect(lift.issues).toEqual([]);
    expect(lift.floored.length).toBeGreaterThan(0);
    expect(lift.lift).toBeGreaterThan(0);
    expect(lift.lift).toBeLessThanOrEqual(raised);
    expect(lift.minHeight).toBeGreaterThanOrEqual(raised);
    const lifted: BoardDoc = { ...doc, deck: lift.deck };
    expect(validateBoard(lifted).filter((i) => i.code === 'rail-height')).toEqual([]);
    expect(checkHeightFieldSymmetry(lift.deck, 'deck')).toEqual([]);
    // Outside the tip zone (floors and tip windows) the deck is unchanged.
    const nose = 182.88 - 2 * g.shift;
    const tail = Math.max(O.tipWindow, ...zones.filter(([a]) => a <= 0).map(([, b]) => b));
    const head = Math.min(
      nose - O.tipWindow,
      ...zones.filter(([, b]) => b >= nose).map(([a]) => a),
    );
    const a0 = heightSampler(heightFieldSurface(g.doc.deck, 'mirror-y', tol), g.doc.deck, tol);
    const a1 = heightSampler(heightFieldSurface(lift.deck, 'mirror-y', tol), lift.deck, tol);
    const rng = mulberry32(5);
    for (let k = 0; k < 2000; k++) {
      const x = tail + rng() * (head - tail);
      const y = (rng() - 0.5) * 50;
      expect(Math.abs(a1(x, y).z - a0(x, y).z), `seed 5: (${x}, ${y})`).toBeLessThanOrEqual(
        1e-12 * 10,
      );
    }
  });

  it('reports a violating station outside the tip zone (review of S6)', () => {
    // 20 cm: every station of a 7 cm thick board violates, the middle ones too.
    const doc: BoardDoc = { ...g.doc, build: { ...g.doc.build, minRailHeight: 20 } };
    const zones = g.floors.zones.map(([a, b]) => [a - g.shift, b - g.shift] as const);
    const lift = liftKnifeTips(doc, zones, O);
    const outside = lift.issues.filter((i) => i.message.includes('outside the tip zone'));
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ code: 'rail-height', severity: 'warning' });
    expect(outside[0]!.at!.x!).toBeGreaterThan(O.tipWindow);
    // The lift itself still meets every deficit (Λ ≥ each deficit in one round).
    expect(lift.minHeight).toBeGreaterThanOrEqual(20);
  });

  it('reports a rail height still short when no round is allowed (review of S6)', () => {
    const doc: BoardDoc = { ...g.doc, build: { ...g.doc.build, minRailHeight: 0.2 } };
    const zones = g.floors.zones.map(([a, b]) => [a - g.shift, b - g.shift] as const);
    const lift = liftKnifeTips(doc, zones, { ...O, maxRefinePasses: 0 });
    expect(lift.lift).toBe(0);
    expect(lift.minHeight).toBeLessThan(0.2);
    expect(lift.issues).toEqual([
      expect.objectContaining({ code: 'rail-height', severity: 'warning', value: lift.minHeight }),
    ]);
  });

  it('converts without warnings, and a stage above its target is reported (review of S6)', () => {
    expect(warnings).toEqual([]);
    const stages = [
      { stage: 'rocker', error: g.rocker.error, target: O.lineTol },
      { stage: 'deck', error: g.deck.maxResidual, target: O.surfaceTol },
    ];
    expect(convergenceIssues(stages)).toEqual([]);
    const missed = convergenceIssues([
      ...stages,
      { stage: 'plan loop', error: 2 * O.lineTol, target: O.lineTol },
    ]);
    expect(missed).toEqual([
      expect.objectContaining({ code: 'not-converged', severity: 'warning', value: 2 * O.lineTol }),
    ]);
  });
});
