// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { vec2 } from './vec2';
import { knot, type Knot } from './knot';
import { maxX, pointByTT, splineFromKnots, ttByNormal } from './bezier-spline';
import { crossSection, csCenterThickness, csWidth, type CrossSection } from './cross-section';
import {
  RAIL_PRESETS,
  applyRailProfile,
  railPresetById,
  railProfileKnots,
  type RailProfileParams,
} from './rail-profile';

// ---- Helpers ----

/**
 * A plausible station to restyle: 36 cm wide, 6 cm thick, sitting 2 cm up the rocker so
 * the tests catch anything that assumes the bottom centre is at y = 0.
 */
const HALF_WIDTH = 18;
const THICKNESS = 6;
const Y0 = 2;

const makeSection = (): CrossSection =>
  crossSection(
    60,
    splineFromKnots([
      knot(vec2(0, Y0), vec2(-6, Y0), vec2(6, Y0)),
      knot(vec2(HALF_WIDTH, Y0 + 2), vec2(HALF_WIDTH, Y0 + 1), vec2(HALF_WIDTH, Y0 + 3)),
      knot(vec2(0, Y0 + THICKNESS), vec2(5, Y0 + THICKNESS), vec2(-5, Y0 + THICKNESS)),
    ]),
  );

/** Every control point of a knot, endpoints and handles alike. */
const allPoints = (ks: readonly Knot[]) =>
  ks.flatMap((k) => [k.end, k.tangentToPrev, k.tangentToNext]);

const SAMPLES = 4000;

/** Sample the profile densely and return the widest point found. */
const widestSampled = (cs: CrossSection) => {
  let best = pointByTT(cs.spline, 0);
  for (let i = 1; i <= SAMPLES; i++) {
    const p = pointByTT(cs.spline, i / SAMPLES);
    if (p.x > best.x) best = p;
  }
  return best;
};

const sampleAll = (cs: CrossSection) =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => pointByTT(cs.spline, i / SAMPLES));

describe('railProfileKnots', () => {
  const params: RailProfileParams = { apex: 0.4, edge: 0.5, fullness: 0.55, domed: 0.4 };

  it('returns five knots ordered bottom-centre → rail → deck-centre', () => {
    const ks = railProfileKnots(params);
    expect(ks).toHaveLength(5);
    expect(ks[0]!.end).toEqual(vec2(0, 0));
    expect(ks[4]!.end).toEqual(vec2(0, 1));
    expect(ks[2]!.end.x).toBe(1);
  });

  it('puts the apex endpoint and both its handles on u = 1', () => {
    // This is what makes the apex the widest point, via the convex-hull property.
    const apexKnot = railProfileKnots(params)[2]!;
    expect(apexKnot.end.x).toBe(1);
    expect(apexKnot.tangentToPrev.x).toBe(1);
    expect(apexKnot.tangentToNext.x).toBe(1);
  });

  it('keeps the centreline knots horizontal so the mirrored halves meet smoothly', () => {
    const ks = railProfileKnots(params);
    for (const k of [ks[0]!, ks[4]!]) {
      expect(k.tangentToPrev.y).toBeCloseTo(k.end.y, 12);
      expect(k.tangentToNext.y).toBeCloseTo(k.end.y, 12);
    }
  });
});

describe('applyRailProfile', () => {
  it('preserves position, width and centre thickness', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(cs, preset.params);
      expect(out.position).toBe(cs.position);
      // Exactly preserved, or the commit-time rescale would fight the preset.
      expect(csWidth(out)).toBeCloseTo(csWidth(cs), 9);
      expect(csCenterThickness(out)).toBeCloseTo(csCenterThickness(cs), 9);
    }
  });

  it('pins both centreline endpoints to the stringer', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const ks = applyRailProfile(cs, preset.params).spline.knots;
      expect(ks[0]!.end.x).toBe(0);
      expect(ks[ks.length - 1]!.end.x).toBe(0);
      // …and sits on the original bottom / deck heights.
      expect(ks[0]!.end.y).toBeCloseTo(Y0, 9);
      expect(ks[ks.length - 1]!.end.y).toBeCloseTo(Y0 + THICKNESS, 9);
    }
  });

  it('keeps every control point, handles included, inside the half-width', () => {
    // The precondition behind the apex guarantee: nothing may poke past u = 1.
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(cs, preset.params);
      for (const p of allPoints(out.spline.knots)) {
        expect(p.x).toBeLessThanOrEqual(HALF_WIDTH + 1e-9);
      }
    }
  });

  it('never samples wider than the half-width', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(cs, preset.params);
      expect(maxX(out.spline)).toBeCloseTo(HALF_WIDTH, 9);
      expect(widestSampled(out).x).toBeLessThanOrEqual(HALF_WIDTH + 1e-9);
    }
  });

  /**
   * The oracle that gives the preset names their meaning: the widest point of the drawn
   * curve must actually sit at the requested fraction of the thickness. If this drifts,
   * "80/20" has stopped being 80/20 and the feature is lying to the shaper.
   */
  it('puts the widest point of the curve at the requested apex height', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(cs, preset.params);
      const expected = Y0 + preset.params.apex * THICKNESS;
      expect(widestSampled(out).y, `${preset.id} apex height`).toBeCloseTo(expected, 6);
    }
  });

  it('reads back the ratio the name claims', () => {
    const cs = makeSection();
    const apexFraction = (id: string): number =>
      (widestSampled(applyRailProfile(cs, railPresetById(id)!.params)).y - Y0) / THICKNESS;
    expect(apexFraction('50-50-soft')).toBeCloseTo(0.5, 6);
    expect(apexFraction('60-40-tucked')).toBeCloseTo(0.4, 6);
    expect(apexFraction('70-30-tucked')).toBeCloseTo(0.3, 6);
    expect(apexFraction('80-20-hard')).toBeCloseTo(0.2, 6);
  });

  it('orders the ratio ladder from highest apex to lowest', () => {
    const cs = makeSection();
    const ladder = ['50-50-soft', '60-40-tucked', '70-30-tucked', '80-20-hard'].map(
      (id) => widestSampled(applyRailProfile(cs, railPresetById(id)!.params)).y,
    );
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
  });

  it('rises monotonically from bottom to deck — no fold-back', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const ys = sampleAll(applyRailProfile(cs, preset.params)).map((p) => p.y);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]!, `${preset.id} at sample ${i}`).toBeGreaterThanOrEqual(ys[i - 1]! - 1e-9);
      }
    }
  });

  it('stays within the bottom and deck planes', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      for (const p of sampleAll(applyRailProfile(cs, preset.params))) {
        expect(p.y).toBeGreaterThanOrEqual(Y0 - 1e-9);
        expect(p.y).toBeLessThanOrEqual(Y0 + THICKNESS + 1e-9);
      }
    }
  });

  /**
   * A knot flagged `continuous` promises the editor its handles are collinear. Clamping
   * a handle by clipping one coordinate rotates it and quietly breaks that promise — the
   * profile renders with a kink and snaps straight the first time it is dragged.
   */
  it('keeps the handles of every smooth knot collinear', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const ks = applyRailProfile(cs, preset.params).spline.knots;
      for (const [i, k] of ks.entries()) {
        if (!k.continuous) continue;
        const a = vec2(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
        const b = vec2(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
        // Opposite directions ⇒ zero cross product, negative dot product.
        expect(a.x * b.y - a.y * b.x, `${preset.id} knot ${i} cross`).toBeCloseTo(0, 9);
        expect(a.x * b.x + a.y * b.y, `${preset.id} knot ${i} dot`).toBeLessThan(0);
      }
    }
  });

  /**
   * `ttByNormal(spline, 90°)` is how `board.ts` locates the rail apex when integrating
   * cross-sectional area. If a preset's apex is not where that finder lands, volume goes
   * wrong — silently.
   */
  it('puts the apex where the kernel’s own apex finder looks for it', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(cs, preset.params);
      const found = pointByTT(out.spline, ttByNormal(out.spline, Math.PI / 2));
      expect(found.x, `${preset.id} apex x`).toBeCloseTo(HALF_WIDTH, 2);
      expect(found.y, `${preset.id} apex y`).toBeCloseTo(Y0 + preset.params.apex * THICKNESS, 2);
    }
  });

  it('creases the bottom edge for a hard rail but not a soft one', () => {
    const cs = makeSection();
    const edgeKnot = (id: string) => applyRailProfile(cs, railPresetById(id)!.params).spline.knots[1]!;
    expect(edgeKnot('80-20-hard').continuous).toBe(false);
    expect(edgeKnot('egg').continuous).toBe(true);
    expect(edgeKnot('50-50-soft').continuous).toBe(true);
  });

  it('is idempotent — applying the same preset twice changes nothing', () => {
    const cs = makeSection();
    for (const preset of RAIL_PRESETS) {
      const once = applyRailProfile(cs, preset.params);
      const twice = applyRailProfile(once, preset.params);
      expect(twice.spline.knots).toEqual(once.spline.knots);
    }
  });

  it('leaves a station with nothing to shape alone', () => {
    const params = RAIL_PRESETS[0]!.params;
    // Nose / tail dummies carry a single knot.
    const dummy = crossSection(0, splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]));
    expect(applyRailProfile(dummy, params)).toBe(dummy);
    // A collapsed station has no width to scale onto.
    const flat = crossSection(
      10,
      splineFromKnots([
        knot(vec2(0, 0), vec2(0, 0), vec2(0, 0)),
        knot(vec2(0, 4), vec2(0, 3), vec2(0, 5)),
      ]),
    );
    expect(applyRailProfile(flat, params)).toBe(flat);
  });
});

describe('RAIL_PRESETS', () => {
  it('has unique ids and non-empty prose', () => {
    const ids = RAIL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of RAIL_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.summary.length).toBeGreaterThan(0);
    }
  });

  it('keeps every parameter inside its documented range', () => {
    for (const { id, params } of RAIL_PRESETS) {
      expect(params.apex, `${id} apex`).toBeGreaterThanOrEqual(0.15);
      expect(params.apex, `${id} apex`).toBeLessThanOrEqual(0.85);
      for (const key of ['edge', 'fullness', 'domed'] as const) {
        expect(params[key], `${id} ${key}`).toBeGreaterThanOrEqual(0);
        expect(params[key], `${id} ${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('looks up by id and reports an unknown one', () => {
    expect(railPresetById('egg')?.label).toBe('Egg');
    expect(railPresetById('nope')).toBeUndefined();
  });
});
