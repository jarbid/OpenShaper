// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from './vec2';
import { knot, knotFromArray, type Knot } from './knot';
import { maxX, pointByTT, splineFromKnots, ttByNormal, type Spline } from './bezier-spline';
import { curvature, value } from './bezier-curve';
import { crossSection, csCenterThickness, csWidth, type CrossSection } from './cross-section';
import { RAIL_PRESETS, applyRailProfile, railPresetById } from './rail-profile';

// ---- Fixtures ----

/**
 * A real interior station, lifted verbatim from `docs/specs/golden/shortboard.brd`
 * (the `p35` block, x = 92.71). Testing against genuine board data matters here: a hand-
 * built fixture would have whatever curvature signature I happened to give it, and the
 * defect this suite exists to catch is precisely a curvature signature real boards do
 * not have. Half-width 23.485 cm, centre thickness 5.964 cm.
 */
const REAL_STATION: readonly (readonly [number[], boolean])[] = [
  [[0.0, 0.0, -8.893887834644426, 0.0, 8.893887834644426, 0.0], true],
  [
    [
      21.902468318686118, -0.2650241403498771, 21.14646174359174, -0.2650241403498767,
      22.533156429158936, -0.2650241403498767,
    ],
    false,
  ],
  [
    [
      23.48475356112796, 1.3999995229696496, 23.48531235391666, 0.2523573909474107,
      23.484016148785482, 2.9144884176892383,
    ],
    true,
  ],
  [
    [
      18.41641124650534, 4.281633943207307, 21.983945123654582, 3.57816150408675,
      13.78420819765474, 5.195045641453186,
    ],
    true,
  ],
  [
    [
      0.0, 5.963591277010156, 6.352784333777455, 5.963591277010156, -9.911642009536736,
      5.963591277010156,
    ],
    true,
  ],
];

const realSection = (): CrossSection =>
  crossSection(
    92.71,
    splineFromKnots(REAL_STATION.map(([v, cont]) => knotFromArray(v, cont, false))),
  );

/** A station with a pronounced bottom concave, sitting 2 cm up the rocker. */
const Y0 = 2;
const concaveSection = (): CrossSection =>
  crossSection(
    60,
    splineFromKnots([
      knot(vec2(0, Y0), vec2(-9, Y0), vec2(9, Y0)),
      // The concave: the bottom dips well below the stringer, then comes back up.
      knot(vec2(12, Y0 - 0.9), vec2(8, Y0 - 0.9), vec2(16, Y0 - 0.9)),
      knot(vec2(23.3, Y0 - 0.2), vec2(21, Y0 - 0.3), vec2(24.2, Y0 - 0.16)),
      knot(vec2(25, Y0 + 1.6), vec2(25, Y0 + 0.5), vec2(25, Y0 + 3)),
      knot(vec2(19.6, Y0 + 4.7), vec2(23, Y0 + 3.9), vec2(14, Y0 + 5.6)),
      knot(vec2(0, Y0 + 6.5), vec2(6.5, Y0 + 6.5), vec2(-9, Y0 + 6.5)),
    ]),
  );

// ---- Helpers ----

const SAMPLES = 3000;

const sampleAll = (s: Spline): Vec2[] =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => pointByTT(s, i / SAMPLES));

const widestSampled = (s: Spline): Vec2 =>
  sampleAll(s).reduce((best, p) => (p.x > best.x ? p : best));

const allPoints = (ks: readonly Knot[]): Vec2[] =>
  ks.flatMap((k) => [k.end, k.tangentToPrev, k.tangentToNext]);

/** Index of the knot at the rail apex — the widest one. */
const apexKnotIndex = (s: Spline): number =>
  s.knots.reduce((best, k, i) => (k.end.x > s.knots[best]!.end.x ? i : best), 0);

/** Height of the bottom branch at a lateral offset, by sampling up to the apex. */
const bottomYAt = (s: Spline, x: number): number => {
  const pts = sampleAll(s);
  let apex = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.x > pts[apex]!.x) apex = i;
  for (let i = 1; i <= apex; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (b.x >= x) {
      const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * f;
    }
  }
  return pts[apex]!.y;
};

/** Signed curvature sampled across a range of segments. */
const curvatures = (s: Spline, fromSeg: number, toSeg: number, per = 40): number[] => {
  const out: number[] = [];
  for (let i = fromSeg; i <= toSeg; i++)
    for (let j = 0; j <= per; j++) out.push(curvature(s.coeffs[i]!, j / per));
  return out;
};

const applied = (cs: CrossSection) =>
  RAIL_PRESETS.map((preset) => ({ preset, out: applyRailProfile(cs, preset.params) }));

// ---- Tests ----

describe('applyRailProfile: what it must not disturb', () => {
  it('preserves position, width and centre thickness', () => {
    for (const cs of [realSection(), concaveSection()]) {
      for (const { preset, out } of applied(cs)) {
        expect(out.position, preset.id).toBe(cs.position);
        // Exactly preserved, or the commit-time rescale drags the outline and rocker.
        expect(csWidth(out), `${preset.id} width`).toBeCloseTo(csWidth(cs), 9);
        expect(csCenterThickness(out), `${preset.id} thickness`).toBeCloseTo(
          csCenterThickness(cs),
          9,
        );
      }
    }
  });

  it('leaves both centreline knots exactly as they were', () => {
    const cs = realSection();
    const first = cs.spline.knots[0]!;
    const last = cs.spline.knots[cs.spline.knots.length - 1]!;
    for (const { preset, out } of applied(cs)) {
      const ks = out.spline.knots;
      expect(ks[0]!.end, `${preset.id} bottom centre`).toEqual(first.end);
      expect(ks[ks.length - 1]!.end, `${preset.id} deck centre`).toEqual(last.end);
      // The outward handles belong to the mirrored half and are never touched.
      expect(ks[0]!.tangentToPrev).toEqual(first.tangentToPrev);
      expect(ks[ks.length - 1]!.tangentToNext).toEqual(last.tangentToNext);
    }
  });

  /**
   * The reason this feature had to be rebuilt: re-cutting the whole section flattened
   * any bottom contour the shaper had put in. A concave is a day's work to get right and
   * would have vanished silently.
   */
  it('keeps a bottom concave intact', () => {
    const cs = concaveSection();
    const before = bottomYAt(cs.spline, 12);
    expect(before).toBeLessThan(Y0 - 0.5); // the fixture really is concave
    for (const { preset, out } of applied(cs)) {
      // Tolerance is the sampling resolution of `bottomYAt`, not a geometric allowance.
      expect(bottomYAt(out.spline, 12), `${preset.id} concave depth`).toBeCloseTo(before, 4);
    }
  });

  it('keeps the deck and bottom identical inboard of the bands', () => {
    const cs = realSection();
    for (const { preset, out } of applied(cs)) {
      // Well inboard of even the widest bottom band, which is 0.28 of the 23.485 cm
      // half-width — so the re-cut starts no further in than x = 16.9.
      for (const x of [2, 5, 9, 13, 16]) {
        expect(bottomYAt(out.spline, x), `${preset.id} bottom at x=${x}`).toBeCloseTo(
          bottomYAt(cs.spline, x),
          4,
        );
      }
    }
  });
});

describe('applyRailProfile: the rail itself', () => {
  it('pins the apex to the original half-width', () => {
    const cs = realSection();
    const halfWidth = csWidth(cs) / 2;
    for (const { preset, out } of applied(cs)) {
      expect(maxX(out.spline), preset.id).toBeCloseTo(halfWidth, 9);
      for (const p of allPoints(out.spline.knots)) {
        expect(p.x, `${preset.id} control point`).toBeLessThanOrEqual(halfWidth + 1e-9);
      }
    }
  });

  /**
   * The oracle that gives the preset names their meaning: the widest point of the drawn
   * curve must sit at the requested fraction of the way up the rail — from the bottom
   * band mark to the deck one. If this drifts, "80/20" has stopped being 80/20 and the
   * feature is lying to the shaper.
   */
  const apexFraction = (cs: CrossSection, id: string): number => {
    const s = applyRailProfile(cs, railPresetById(id)!.params).spline;
    const apex = apexKnotIndex(s);
    const tuckY = s.knots[apex - 1]!.end.y;
    const deckY = s.knots[apex + 1]!.end.y;
    return (widestSampled(s).y - tuckY) / (deckY - tuckY);
  };

  it('puts the widest point at the requested height up the rail', () => {
    const cs = realSection();
    for (const preset of RAIL_PRESETS) {
      expect(apexFraction(cs, preset.id), `${preset.id} apex height`).toBeCloseTo(
        preset.params.apex,
        4,
      );
    }
  });

  it('reads back the ratio the name claims, in order', () => {
    const cs = realSection();
    expect(apexFraction(cs, '50-50-soft')).toBeCloseTo(0.5, 4);
    expect(apexFraction(cs, '60-40-tucked')).toBeCloseTo(0.4, 4);
    expect(apexFraction(cs, '70-30-tucked')).toBeCloseTo(0.3, 4);
    expect(apexFraction(cs, '80-20-hard')).toBeCloseTo(0.2, 4);

    // Absolute heights, not just fractions, must fall as the ratio does.
    const heights = ['50-50-soft', '60-40-tucked', '70-30-tucked', '80-20-hard'].map(
      (id) => widestSampled(applyRailProfile(cs, railPresetById(id)!.params).spline).y,
    );
    for (let i = 1; i < heights.length; i++) expect(heights[i]!).toBeLessThan(heights[i - 1]!);
  });

  /**
   * The definitional case, and the cleanest oracle there is for the naming. On a square
   * blank — flat deck, flat bottom, vertical rail face, which is exactly how the guide's
   * dimensioned band drawing is laid out — every way of reading the ratio agrees, so a
   * 50/50 must put its apex at precisely half the thickness and an 80/20 at a fifth.
   */
  it('lands every ratio exactly on a square blank', () => {
    const T = 6;
    const HW = 25;
    const slab = crossSection(
      60,
      splineFromKnots([
        knot(vec2(0, 0), vec2(-12, 0), vec2(12, 0)),
        knot(vec2(HW, 0), vec2(HW - 6, 0), vec2(HW, 0.01)),
        knot(vec2(HW, T), vec2(HW, T - 0.01), vec2(HW - 6, T)),
        knot(vec2(0, T), vec2(12, T), vec2(-12, T)),
      ]),
    );
    for (const preset of RAIL_PRESETS) {
      const out = applyRailProfile(slab, preset.params);
      expect(widestSampled(out.spline).y / T, `${preset.id} on a square blank`).toBeCloseTo(
        preset.params.apex,
        3,
      );
    }
  });

  /**
   * The ratio is "the midpoint of the rail radius itself", not of the deck and bottom
   * planes — so on a shortboard, whose deck domes away while the bottom stays flat, even
   * a 50/50 apex sits below mid-thickness. Domed the bottom too, as a longboard or hull
   * is, and the apex is pushed back toward the middle. Both fall out of measuring up the
   * rail, and this pins the pair of them.
   *
   * Reference: Greenlight's surfboard rail design guide.
   */
  it('sits below mid-thickness on a flat bottom, and rises when the bottom domes too', () => {
    const heightOf = (cs: CrossSection): number => {
      const s = applyRailProfile(cs, railPresetById('50-50-soft')!.params).spline;
      const y0 = s.knots[0]!.end.y;
      return (widestSampled(s).y - y0) / csCenterThickness(cs);
    };

    // Flat bottom, domed deck — the golden shortboard station.
    const flatBottom = heightOf(realSection());
    expect(flatBottom).toBeGreaterThan(0.25);
    expect(flatBottom).toBeLessThan(0.45);

    // Same station, but with the bottom domed up toward the rail as a hull's would be.
    const domed = crossSection(
      92.71,
      splineFromKnots([
        knot(vec2(0, 0), vec2(-9, 0), vec2(9, 0)),
        knot(vec2(21.9, 1.5), vec2(17, 1.2), vec2(23, 1.6)),
        knot(vec2(23.485, 2.9), vec2(23.485, 2.1), vec2(23.485, 4)),
        knot(vec2(18.4, 4.9), vec2(22, 4.4), vec2(13.8, 5.5)),
        knot(vec2(0, 5.964), vec2(6.35, 5.964), vec2(-9.9, 5.964)),
      ]),
    );
    expect(heightOf(domed)).toBeGreaterThan(flatBottom + 0.05);
  });

  /** A 50/50 is symmetric by definition: as much rail above the apex as below it. */
  it('makes a 50/50 rail genuinely even above and below', () => {
    const cs = realSection();
    const s = applyRailProfile(cs, railPresetById('50-50-soft')!.params).spline;
    const apex = apexKnotIndex(s);
    const below = s.knots[apex]!.end.y - s.knots[apex - 1]!.end.y;
    const above = s.knots[apex + 1]!.end.y - s.knots[apex]!.end.y;
    expect(below).toBeCloseTo(above, 6);
  });

  it('leaves the apex where the kernel’s own apex finder looks for it', () => {
    // `board.ts` uses this to integrate cross-sectional area; break it and volume breaks.
    const cs = realSection();
    const halfWidth = csWidth(cs) / 2;
    for (const { preset, out } of applied(cs)) {
      const found = pointByTT(out.spline, ttByNormal(out.spline, Math.PI / 2));
      expect(found.x, `${preset.id} apex x`).toBeCloseTo(halfWidth, 1);
    }
  });

  it('creases the bottom edge for a hard rail but not a soft one', () => {
    const cs = realSection();
    const tuck = (id: string) => {
      const out = applyRailProfile(cs, railPresetById(id)!.params).spline;
      return out.knots[apexKnotIndex(out) - 1]!;
    };
    expect(tuck('80-20-hard').continuous).toBe(false);
    expect(tuck('egg').continuous).toBe(true);
    expect(tuck('50-50-soft').continuous).toBe(true);
  });
});

describe('applyRailProfile: curve quality', () => {
  /**
   * A knot flagged `continuous` promises the editor its handles are collinear. Clamping a
   * handle by clipping one coordinate rotates it and quietly breaks that promise — the
   * profile renders with a kink and snaps straight the first time it is dragged.
   */
  it('keeps the handles of every smooth knot collinear', () => {
    for (const cs of [realSection(), concaveSection()]) {
      for (const { preset, out } of applied(cs)) {
        const apex = apexKnotIndex(out.spline);
        // Only the three knots we generate. Retained knots are the shaper's, dishonest
        // flags and all — a rail re-cut has no business straightening them.
        for (const i of [apex - 1, apex, apex + 1]) {
          const k = out.spline.knots[i]!;
          if (!k.continuous) continue;
          const a = vec2(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
          const b = vec2(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
          if (Math.hypot(a.x, a.y) < 1e-9 || Math.hypot(b.x, b.y) < 1e-9) continue;
          expect(a.x * b.y - a.y * b.x, `${preset.id} knot ${i} cross`).toBeCloseTo(0, 7);
          expect(a.x * b.x + a.y * b.y, `${preset.id} knot ${i} dot`).toBeLessThan(0);
        }
      }
    }
  });

  /**
   * The regression test for the deck step. A real station's deck curvature is
   * single-signed and decays smoothly inboard; the previous implementation inflected at
   * about 60% of half-width on every preset, and crowned-then-hollow is exactly what the
   * eye reads as a step.
   */
  it('never inflects on the deck', () => {
    const cs = realSection();
    // The fixture itself is single-signed, so any sign change is ours.
    const before = curvatures(cs.spline, apexKnotIndex(cs.spline), cs.spline.coeffs.length - 1);
    expect(new Set(before.map(Math.sign)).size).toBe(1);

    for (const { preset, out } of applied(cs)) {
      const s = out.spline;
      const signs = new Set(
        curvatures(s, apexKnotIndex(s), s.coeffs.length - 1)
          .filter((k) => Math.abs(k) > 1e-6)
          .map(Math.sign),
      );
      expect(signs.size, `${preset.id} deck curvature sign changes`).toBe(1);
    }
  });

  /**
   * "Almost invisibly blend into the deck" is the craft rule. Tangent continuity alone
   * does not achieve it — a curvature step at the join still reads as a shoulder, and the
   * app's own curvature comb draws two coincident quills there, so a jump is plainly
   * visible. Real stations sit at about 1.3.
   */
  it('holds the curvature step across each blend within bounds', () => {
    const cs = realSection();
    for (const { preset, out } of applied(cs)) {
      const s = out.spline;
      const apex = apexKnotIndex(s);
      // The deck blend is the knot after the apex; its segments are `apex` and `apex+1`.
      const deckBlend = apex + 1;
      if (deckBlend >= s.coeffs.length) continue;
      const before = curvature(s.coeffs[deckBlend - 1]!, 1);
      const after = curvature(s.coeffs[deckBlend]!, 0);
      // The sign is the strong condition, and the one the old implementation failed on
      // every preset: a curve that reverses its bend at the join reads as a shoulder no
      // matter how small the numbers are.
      expect(Math.sign(before), `${preset.id} blend reverses its bend`).toBe(Math.sign(after));
      // Then the size of the step, in absolute terms rather than as a ratio — a deck is
      // nearly flat, so two near-zero curvatures can differ severalfold and still be
      // metres of radius apart from anything the eye could pick up.
      expect(Math.abs(before - after), `${preset.id} blend curvature step`).toBeLessThan(0.06);
    }
  });

  it('does not put a cusp at the apex', () => {
    const cs = realSection();
    // A radius tighter than a millimetre is a crease, not a rail.
    for (const { preset, out } of applied(cs)) {
      const s = out.spline;
      const apex = apexKnotIndex(s);
      for (const k of [curvature(s.coeffs[apex - 1]!, 1), curvature(s.coeffs[apex]!, 0)]) {
        // A radius under ~1.5 mm is a crease rather than a rail. `knifey` is meant to sit
        // near this bound; the old implementation reached 21 cm⁻¹, a 0.5 mm cusp.
        expect(Math.abs(k), `${preset.id} apex curvature`).toBeLessThan(6);
      }
    }
  });

  /**
   * The rail band climbs from the tuck to the apex and on to the deck blend without
   * doubling back. The tolerance exists because a soft rail leaves the tuck along the
   * *bottom's* own direction — so on a rolled bottom, which really does fall away below
   * the stringer, the band inherits a few microns of continued dip before it turns up.
   */
  it('rises without folding back across the rail band', () => {
    const cs = realSection();
    const slack = csCenterThickness(cs) * 1e-3;
    for (const { preset, out } of applied(cs)) {
      const s = out.spline;
      const apex = apexKnotIndex(s);
      const ys: number[] = [];
      for (let i = apex - 1; i <= apex; i++)
        for (let j = 0; j <= 60; j++) ys.push(value(s.coeffs[i]!, j / 60).y);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]!, `${preset.id} fold at ${i}`).toBeGreaterThanOrEqual(ys[i - 1]! - slack);
      }
    }
  });
});

describe('applyRailProfile: robustness', () => {
  it('is idempotent — applying the same preset twice changes nothing', () => {
    const cs = realSection();
    for (const { preset, out } of applied(cs)) {
      const twice = applyRailProfile(out, preset.params);
      expect(twice.spline.knots.length, `${preset.id} knot count`).toBe(out.spline.knots.length);
      for (const [i, k] of twice.spline.knots.entries()) {
        const was = out.spline.knots[i]!;
        expect(k.end.x, `${preset.id} knot ${i} x`).toBeCloseTo(was.end.x, 6);
        expect(k.end.y, `${preset.id} knot ${i} y`).toBeCloseTo(was.end.y, 6);
      }
    }
  });

  it('leaves a station with nothing to shape alone', () => {
    const params = RAIL_PRESETS[0]!.params;
    // Nose / tail dummies carry a single knot.
    const dummy = crossSection(0, splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]));
    expect(applyRailProfile(dummy, params)).toBe(dummy);
    // A collapsed station has no width to work against.
    const flat = crossSection(
      10,
      splineFromKnots([
        knot(vec2(0, 0), vec2(0, 0), vec2(0, 0)),
        knot(vec2(0, 4), vec2(0, 3), vec2(0, 5)),
      ]),
    );
    expect(applyRailProfile(flat, params)).toBe(flat);
  });

  it('declines rather than mangles a profile it cannot band', () => {
    // Two knots: the apex is an endpoint, so there is no deck branch to blend into.
    const wedge = crossSection(
      50,
      splineFromKnots([
        knot(vec2(0, 0), vec2(-3, 0), vec2(3, 0)),
        knot(vec2(10, 5), vec2(10, 3), vec2(10, 7)),
      ]),
    );
    expect(applyRailProfile(wedge, RAIL_PRESETS[0]!.params)).toBe(wedge);
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
      for (const key of ['edge', 'fullness'] as const) {
        expect(params[key], `${id} ${key}`).toBeGreaterThanOrEqual(0);
        expect(params[key], `${id} ${key}`).toBeLessThanOrEqual(1);
      }
      // The bands are the shaper's marks: the deck always rolls from further in than the
      // bottom tucks, on every real station.
      expect(params.deckBand, `${id} deckBand`).toBeGreaterThan(params.bottomBand);
      expect(params.deckBand, `${id} deckBand`).toBeLessThan(0.5);
      expect(params.bottomBand, `${id} bottomBand`).toBeGreaterThan(0);
    }
  });

  it('looks up by id and reports an unknown one', () => {
    expect(railPresetById('egg')?.label).toBe('Egg');
    expect(railPresetById('nope')).toBeUndefined();
  });
});
