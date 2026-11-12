// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail read off a section, against sections built from a rail that is known: a straight
 * panel and one conic blend. And the round trip the conversion rests on: a section, the rail
 * fitted to it, the kernel's solid built from that rail, and the solid's own section back.
 */
import { describe, expect, it } from 'vitest';
import { buildLoop } from './loop';
import { railLaws } from './rails';
import type { RailRecipe } from './rails';
import { buildTrimMesh, checkClosed, sliceX } from './solid';
import { TRIM } from '../params';
import { BAND_RULES, builtWidth, fitHalf, panelCurve, recipeGap, sectionRail } from './station';

const RAD = Math.PI / 180;
/** Spacing of a made section's panel samples, and samples along its blend. */
const PANEL_STEP = 0.04;
const BLEND_SAMPLES = 300;

interface Shape {
  /** Half width of the section, cm. */
  readonly half: number;
  /** Width of the blend. Zero: the panel runs to the wall. */
  readonly width: number;
  /** Slope of the panel, rise per cm outward. */
  readonly slope: number;
  /** Height of the apex above the point the panel's tangent meets the wall. */
  readonly rise: number;
  /** Angle the blend leaves the panel at, degrees. */
  readonly edge: number;
  readonly rho: number;
}

/** What a shape's rail is, in the terms the fit reports. */
const truth = (s: Shape): { wall: number; shoulder: number; apex: number } => {
  const wall = s.slope * s.half;
  return { wall, shoulder: wall + s.width * Math.tan(s.edge * RAD), apex: wall + s.rise };
};

/**
 * A half section with the apex above the panel, as on a bottom: a straight panel from the
 * stringer, then one conic to the apex. `wobble` drops the panel's last half millimetre by
 * that much, the way a sampled section misbehaves just inboard of a crease.
 */
function made(s: Shape, wobble = 0): Float64Array {
  const ye = s.half - s.width;
  const pts: number[] = [];
  const steps = Math.ceil(ye / PANEL_STEP);
  for (let i = 0; i < steps; i++) {
    const y = (ye * i) / steps;
    const near = Math.max(0, 1 - (ye - y) / 0.05);
    pts.push(y, s.slope * y - wobble * near);
  }
  return Float64Array.from(withBlend(pts, s, s.slope * ye, s.slope));
}

/**
 * `pts` followed by the blend of `s` from its band edge, at height `ze` on a panel whose line
 * there rises at `slope`: the blend leaves that line at `s.edge` and stands `s.rise` above the
 * point the line meets the wall.
 */
function withBlend(pts: number[], s: Shape, ze: number, slope: number): number[] {
  const ye = s.half - s.width;
  const wall = ze + s.width * slope;
  if (s.width === 0) {
    pts.push(s.half, wall);
    return pts;
  }
  const shoulder = wall + s.width * Math.tan(s.edge * RAD);
  const apex = wall + s.rise;
  const w = s.rho / (1 - s.rho);
  for (let j = 0; j <= BLEND_SAMPLES; j++) {
    const u = j / BLEND_SAMPLES;
    const v = 1 - u;
    const den = v * v + 2 * w * v * u + u * u;
    const k0 = (v * v) / den;
    const k1 = (2 * w * v * u) / den;
    const k2 = (u * u) / den;
    pts.push(k0 * ye + (k1 + k2) * s.half, k0 * ze + k1 * shoulder + k2 * apex);
  }
  return pts;
}

/**
 * A half with a bevel: a level panel to a crease, a flat facet `facet` cm wide rising at
 * `degrees`, a second crease, then the blend of `s` from the facet's line.
 */
function bevelled(s: Shape, degrees: number, facet: number): Float64Array {
  const yb = s.half - s.width;
  const ya = yb - facet;
  const rise = Math.tan(degrees * RAD);
  const pts: number[] = [];
  const steps = Math.ceil(ya / PANEL_STEP);
  for (let i = 0; i < steps; i++) pts.push((ya * i) / steps, 0);
  const across = Math.ceil(facet / PANEL_STEP);
  for (let i = 0; i < across; i++) {
    const y = ya + (facet * i) / across;
    pts.push(y, rise * (y - ya));
  }
  return Float64Array.from(withBlend(pts, s, rise * facet, rise));
}

/** The height of a half at `y`, between its samples. */
function heightOf(pts: Float64Array, y: number): number {
  for (let i = 2; i < pts.length; i += 2) {
    if (pts[i]! >= y) {
      const f = (y - pts[i - 2]!) / (pts[i]! - pts[i - 2]!);
      return pts[i - 1]! + f * (pts[i + 1]! - pts[i - 1]!);
    }
  }
  return pts[pts.length - 1]!;
}

/** The same half as a deck under a top at height `top`: the apex below the panel. */
const flipped = (pts: Float64Array, top: number): Float64Array =>
  pts.map((v, i) => (i % 2 === 1 ? top - v : v));

/**
 * A half with a curving facet: a level panel to a crease, then a facet `facet` cm wide whose
 * direction turns evenly with distance from `from` to `to` degrees, a second crease, and the
 * blend of `s` from the facet's last direction.
 */
function curvedBevel(s: Shape, from: number, to: number, facet: number): Float64Array {
  const yb = s.half - s.width;
  const ya = yb - facet;
  const pts: number[] = [];
  const steps = Math.ceil(ya / PANEL_STEP);
  for (let i = 0; i < steps; i++) pts.push((ya * i) / steps, 0);
  // the height integrated finely, sampled at the panel's spacing
  const fine = 50;
  const across = Math.ceil(facet / PANEL_STEP) * fine;
  let z = 0;
  for (let i = 0; i < across; i++) {
    const y = ya + (facet * i) / across;
    if (i % fine === 0) pts.push(y, z);
    z += Math.tan((from + ((to - from) * (y - ya)) / facet) * RAD) * (facet / across);
  }
  return Float64Array.from(withBlend(pts, s, z, Math.tan(to * RAD)));
}

/** A half from the stringer out: level, then turning up evenly by `degrees` over its last `length` cm. */
function curled(half: number, degrees: number, length: number): Float64Array {
  const pts: number[] = [];
  const steps = Math.ceil((half - length) / PANEL_STEP);
  for (let i = 0; i < steps; i++) pts.push(((half - length) * i) / steps, 0);
  const r = length / (degrees * RAD);
  for (let j = 0; j <= BLEND_SAMPLES; j++) {
    const a = (degrees * RAD * j) / BLEND_SAMPLES;
    pts.push(half - length + r * Math.sin(a), r * (1 - Math.cos(a)));
  }
  return Float64Array.from(pts);
}

/** A quarter ellipse from the stringer to a vertical apex, `half` wide and `ratio` times that tall, as a deck under `top`. */
function ellipticDeck(half: number, ratio: number, top: number): Float64Array {
  const pts: number[] = [];
  for (let i = 0; i <= 600; i++) {
    const t = (Math.PI / 2) * (i / 600);
    pts.push(half * Math.sin(t), top - ratio * half * (1 - Math.cos(t)));
  }
  return Float64Array.from(pts);
}

const TUCKED: Shape = { half: 24, width: 1.2, slope: -0.03, rise: 1.5, edge: 14, rho: 0.45 };
const SOFT: Shape = { half: 24, width: 2.4, slope: 0.02, rise: 2.2, edge: 0, rho: 0.5 };

describe('the rail of a section', () => {
  it('finds a crease, and the blend that leaves it', () => {
    const f = fitHalf(made(TUCKED), 1, BAND_RULES.bottom);
    const t = truth(TUCKED);
    expect(f.width).toBeGreaterThan(TUCKED.width - 0.05);
    expect(f.width).toBeLessThan(TUCKED.width + 0.05);
    expect(f.wall).toBeCloseTo(t.wall, 1);
    const edge = Math.atan2(f.shoulder - f.wall, f.width) / RAD;
    expect(Math.abs(edge - TUCKED.edge)).toBeLessThan(2);
    expect(Math.abs(f.rho - TUCKED.rho)).toBeLessThan(0.05);
    expect(f.gap).toBeLessThan(0.005);
  });

  it('gives a smooth rail no edge, whatever its shape', () => {
    // from a flat bevel to a blend that hugs its corner, narrow and tall to wide and low
    for (const rho of [0.3, 0.45, 0.6, 0.75]) {
      for (const width of [0.8, 1.6, 3]) {
        const f = fitHalf(made({ ...SOFT, rho, width }), 1, BAND_RULES.bottom);
        expect(f.shoulder, `rho ${rho}, width ${width}`).toBe(f.wall);
        expect(f.gap, `rho ${rho}, width ${width}`).toBeLessThan(0.012);
        // the band starts where the turn is under way, so inside the blend the section was made
        // with: well inside when that blend runs along its panel before it turns
        expect(f.width, `rho ${rho}, width ${width}`).toBeLessThanOrEqual(width + 0.02);
        expect(f.width, `rho ${rho}, width ${width}`).toBeGreaterThan(0.3 * width);
      }
    }
  });

  it('runs the panel to the wall where the section has no rail', () => {
    const f = fitHalf(made({ ...TUCKED, width: 0, rise: 0 }), 1, BAND_RULES.bottom);
    expect(f.width).toBe(0);
    expect(f.wall).toBeCloseTo(truth(TUCKED).wall, 6);
    expect(f.gap).toBeLessThan(0.001);
  });

  it('reads a deck as the mirror of a bottom', () => {
    const top = 6;
    const b = fitHalf(made(SOFT), 1, BAND_RULES.deck);
    const d = fitHalf(flipped(made(SOFT), top), -1, BAND_RULES.deck);
    expect(d.width).toBeCloseTo(b.width, 9);
    expect(d.rho).toBeCloseTo(b.rho, 9);
    expect(d.wall).toBeCloseTo(top - b.wall, 9);
    expect(d.shoulder).toBeCloseTo(top - b.shoulder, 9);
    expect(d.panel.slope).toBeCloseTo(-b.panel.slope, 9);
  });

  it('does not let the wobble at a crease set the panel tangent', () => {
    // a tenth of a millimetre over the last half millimetre is a slope of 0.2: read as the
    // panel's direction it would move the wall point by more than two millimetres
    const clean = fitHalf(made(TUCKED), 1, BAND_RULES.bottom);
    const rough = fitHalf(made(TUCKED, 0.01), 1, BAND_RULES.bottom);
    expect(Math.abs(rough.wall - clean.wall)).toBeLessThan(0.01);
    expect(Math.abs(rough.width - clean.width)).toBeLessThan(0.05);
    expect(rough.gap).toBeLessThan(0.015);
  });

  it('carries a panel on along its own tangent past the cut', () => {
    const pts = made(TUCKED);
    const panel = panelCurve(pts, 1, builtWidth(TUCKED.width, 1));
    // inboard, the section itself
    expect(panel(10)).toBeCloseTo(TUCKED.slope * 10, 9);
    // at the wall, where the panel's tangent meets it, not where the rail went
    expect(panel(TUCKED.half)).toBeCloseTo(truth(TUCKED).wall, 4);
    expect(panel(TUCKED.half)).toBeLessThan(truth(TUCKED).apex - 1);
  });

  it('hands the kernel a deck panel whose tangent is the one the fit read', () => {
    // a creased deck with the wobble of a sampled section before its crease
    const top = 6;
    const deck = flipped(made({ ...SOFT, width: 1.6, edge: 28, rho: 0.45 }, 0.03), top);
    for (const cos of [1, 0.6]) {
      const fit = fitHalf(deck, -1, BAND_RULES.deck, builtWidth(0, cos));
      expect(fit.panel.crease).toBe(true);
      const panel = panelCurve(deck, -1, builtWidth(fit.width * cos, cos));
      expect(panel(SOFT.half)).toBeCloseTo(fit.wall, 9);
      expect(panel(fit.panel.y - 1)).toBeCloseTo(heightOf(deck, fit.panel.y - 1), 9);
    }
  });

  it('turns two halves into the seven numbers of a rail', () => {
    const top = 6;
    const bottom = made(TUCKED);
    // the two halves share an apex
    const deckShape: Shape = { ...SOFT, rise: top - truth(TUCKED).apex - truth(SOFT).wall };
    const deck = flipped(made(deckShape), top);
    expect(deck[deck.length - 1]).toBeCloseTo(bottom[bottom.length - 1]!, 9);
    const square = sectionRail(bottom, deck, 1);
    const r = square.recipe;
    expect(r.tuck).toBeCloseTo(square.bottom.width, 9);
    expect(r.band).toBeCloseTo(square.deck.width, 9);
    expect(Math.abs(r.bottomEdge - TUCKED.edge)).toBeLessThan(2);
    expect(r.deckEdge).toBe(0);
    // the apex as a share of the wall, between where the two panels' tangents meet it
    const wall = square.deck.wall - square.bottom.wall;
    expect(r.apex).toBeCloseTo((truth(TUCKED).apex - square.bottom.wall) / wall, 9);
    // a section that cuts the outline at an angle sees its bands wider than they are
    const skew = sectionRail(bottom, deck, 0.8).recipe;
    expect(skew.band).toBeCloseTo(0.8 * r.band, 9);
    expect(skew.tuck).toBeCloseTo(0.8 * r.tuck, 9);
    expect(Math.tan(skew.bottomEdge * RAD)).toBeCloseTo(Math.tan(r.bottomEdge * RAD) / 0.8, 6);
    expect(skew.apex).toBeCloseTo(r.apex, 9);
  });

  /** A deck blend that leaves its facet at an edge, so the deck's band edge is the crease at the facet's outer end. */
  const BEVEL: Shape = { half: 24, width: 2.4, slope: 0, rise: 2.2, edge: 15, rho: 0.45 };
  const degreesOf = (slope: number): number => Math.atan(slope) / RAD;

  it('reads a bevel inboard of the band edge as a facet, not as the panel before it', () => {
    for (const width of [1.5, 2.4]) {
      for (const facet of [0.3, 0.45]) {
        for (const degrees of [12, 15, 18]) {
          const at = `${facet * 10} mm at ${degrees} degrees, blend ${width} cm`;
          const s = { ...BEVEL, width };
          const f = fitHalf(flipped(bevelled(s, degrees, facet), 6), -1, BAND_RULES.deck);
          // the band edge is the facet's outer crease, and the panel ends on the facet
          expect(Math.abs(f.width - width), at).toBeLessThan(0.05);
          expect(f.panel.crease, at).toBe(true);
          expect(Math.abs(degreesOf(-f.panel.slope) - degrees), at).toBeLessThan(1);
          // 0.07 mm at most, from a band edge read a fraction of a millimetre past the crease
          expect(f.gap, at).toBeLessThan(0.015);
        }
      }
    }
  });

  it('gives up a facet too short to read a direction off', () => {
    // a millimetre and a half: the panel ends inboard of it, level, and misses it by its rise
    const f = fitHalf(flipped(bevelled(BEVEL, 15, 0.15), 6), -1, BAND_RULES.deck);
    expect(Math.abs(degreesOf(f.panel.slope))).toBeLessThan(0.1);
    expect(f.gap).toBeLessThan(0.04);
  });

  it('reads a curving facet without a jump as its crease leaves the stretch the direction is read over', () => {
    // the facet turns from 10 to 20 degrees; as it widens, the stretch clear of its inner crease
    // grows through the full `panelBase`
    let last: ReturnType<typeof fitHalf> | null = null;
    for (let i = 0; i <= 20; i++) {
      const facet = 0.5 + i * 0.01;
      const f = fitHalf(flipped(curvedBevel(BEVEL, 10, 20, facet), 6), -1, BAND_RULES.deck);
      const degrees = degreesOf(-f.panel.slope);
      // between the facet's direction at the middle of what is read and at its end
      expect(degrees, `facet ${facet}`).toBeGreaterThan(14.5);
      expect(degrees, `facet ${facet}`).toBeLessThan(20);
      expect(f.gap, `facet ${facet}`).toBeLessThan(0.015);
      if (last) {
        // a tenth of a millimetre more facet moves the wall point by 0.08 to 0.14 mm, as the
        // facet's own direction changes; a switch from a line to a parabola moved it by 1.6 mm
        expect(Math.abs(f.wall - last.wall), `facet ${facet}`).toBeLessThan(0.02);
        expect(Math.abs(degrees - degreesOf(-last.panel.slope)), `facet ${facet}`).toBeLessThan(
          0.3,
        );
      }
      last = f;
    }
  });

  it('gives a rounder section a wider band, never a hard edge', () => {
    // a quarter ellipse 5 cm wide: the deck comes down to `deckSlope` further in the rounder it
    // is, until that is past the widest band a half allows, and from there the band is that wide
    let last = -1;
    for (const ratio of [0.78, 0.8, 0.82, 0.83, 0.84, 0.85, 0.88, 0.9, 1, 1.2]) {
      const f = fitHalf(ellipticDeck(5, ratio, 6), -1, BAND_RULES.deck);
      expect(f.width, `ratio ${ratio}`).toBeGreaterThan(2.8);
      expect(f.width, `ratio ${ratio}`).toBeLessThanOrEqual(TRIM.fitWidest * 5 + 1e-9);
      // under 0.03 mm: a conic is an ellipse
      expect(f.gap, `ratio ${ratio}`).toBeLessThan(0.005);
      if (last >= 0) expect(Math.abs(f.width - last), `ratio ${ratio}`).toBeLessThan(0.1);
      last = f.width;
    }
  });

  it('gives a bottom that curls up a little a band that changes little', () => {
    // a level bottom turning up over its last centimetre: the band edge is where half the turn
    // is done, so the band hardly changes with the curl, and its shape changes with it
    let last = -1;
    for (const degrees of [2, 4, 6, 8, 10, 12]) {
      const f = fitHalf(curled(24, degrees, 1), 1, BAND_RULES.bottom);
      expect(f.width, `${degrees} degrees`).toBeGreaterThan(0.3);
      expect(f.gap, `${degrees} degrees`).toBeLessThan(0.005);
      if (last >= 0) expect(Math.abs(f.width - last), `${degrees} degrees`).toBeLessThan(0.2);
      last = f.width;
    }
    // under `turnFloor` it is a hard edge
    expect(fitHalf(curled(24, 0.5, 1), 1, BAND_RULES.bottom).width).toBe(0);
  });

  it('ends a hard edge, and a band narrower than the kernel builds, for the narrowest blend', () => {
    const narrowest = builtWidth(0, 0.5);
    const hard = fitHalf(made({ ...TUCKED, width: 0, rise: 0 }), 1, BAND_RULES.bottom, narrowest);
    expect(hard.width).toBe(0);
    expect(hard.panel.y).toBeCloseTo(TUCKED.half - narrowest - TRIM.panelLead, 9);
    // a blend 0.4 mm wide is read at the narrowest blend the kernel builds
    const narrow = fitHalf(
      made({ ...TUCKED, width: 0.04, edge: 0 }),
      1,
      BAND_RULES.bottom,
      narrowest,
    );
    expect(narrow.width).toBe(narrowest);
  });

  it('reads a half that ends at the stringer as level there', () => {
    // narrower than the narrowest blend: no panel is left to read a direction off
    const f = fitHalf(Float64Array.of(0, 0, 0.03, 0.001, 0.06, 0.04), 1, BAND_RULES.bottom);
    expect(f.panel.y).toBe(0);
    expect(f.panel.slope).toBe(0);
    expect(Number.isFinite(f.wall) && Number.isFinite(f.gap)).toBe(true);
  });

  it('shows in the gap a section that doubles back past its widest point', () => {
    const top = 6;
    const bottom = made(TUCKED);
    const deckShape: Shape = { ...SOFT, rise: top - truth(TUCKED).apex - truth(SOFT).wall };
    const deck = flipped(made(deckShape), top);
    // the bottom curls back under the apex by a millimetre as it rises 3 mm more
    const yA = bottom[bottom.length - 2]!;
    const zA = bottom[bottom.length - 1]!;
    const under = [...bottom];
    for (let j = 1; j <= 10; j++) under.push(yA - 0.01 * j, zA + 0.03 * j);
    const undercut = Float64Array.from(under);
    // the farthest the undercut lies from the half the fit keeps, which ends at the apex
    const miss = Math.hypot(0.1, 0.3);
    const f = fitHalf(undercut, 1, BAND_RULES.bottom);
    expect(f.gap).toBeGreaterThanOrEqual(miss - 1e-9);
    // the apex is the half's own, not the last sample of the section
    expect(f.apex).toBeCloseTo(zA, 9);
    const rail = sectionRail(undercut, deck, 1);
    expect(rail.recipe.apex).toBeCloseTo(sectionRail(bottom, deck, 1).recipe.apex, 9);
    expect(recipeGap(undercut, deck, rail.recipe, 1)).toBeGreaterThanOrEqual(miss - 1e-9);
  });

  it('reads a section nearly tangent to the outline as one at `skewMin`', () => {
    const top = 6;
    const bottom = made(TUCKED);
    const deckShape: Shape = { ...SOFT, rise: top - truth(TUCKED).apex - truth(SOFT).wall };
    const deck = flipped(made(deckShape), top);
    const recipe = sectionRail(bottom, deck, 1).recipe;
    const at = recipeGap(bottom, deck, recipe, TRIM.skewMin);
    expect(Number.isFinite(at)).toBe(true);
    for (const cos of [0, 0.01]) {
      expect(recipeGap(bottom, deck, recipe, cos)).toBe(at);
      expect(sectionRail(bottom, deck, cos).recipe).toEqual(
        sectionRail(bottom, deck, TRIM.skewMin).recipe,
      );
    }
  });
});

describe('a section through the kernel and back', () => {
  /** A straight board of the given half width, long enough that its middle knows nothing of its ends. */
  const slab = (half: number) => {
    const length = 160;
    const side = new Float64Array(2 * 201);
    const back = new Float64Array(2 * 201);
    const tail = new Float64Array(2 * 41);
    const nose = new Float64Array(2 * 41);
    for (let i = 0; i <= 200; i++) {
      side[2 * i] = length - (length * i) / 200;
      side[2 * i + 1] = half;
      back[2 * i] = (length * i) / 200;
      back[2 * i + 1] = -half;
    }
    for (let i = 0; i <= 40; i++) {
      tail[2 * i] = 0;
      tail[2 * i + 1] = half - (2 * half * i) / 40;
      nose[2 * i] = length;
      nose[2 * i + 1] = -half + (2 * half * i) / 40;
    }
    return buildLoop({
      pieces: [
        { pts: side, kind: 0 },
        { pts: tail, kind: 1 },
        { pts: back, kind: 0 },
        { pts: nose, kind: 1 },
      ],
      corners: [1.5, 1.5, 1.5, 1.5],
    });
  };

  const distance = (py: number, pz: number, ay: number, az: number, by: number, bz: number) => {
    const ey = by - ay;
    const ez = bz - az;
    const ee = ey * ey + ez * ez;
    const f = ee > 0 ? Math.min(1, Math.max(0, ((py - ay) * ey + (pz - az) * ez) / ee)) : 0;
    return Math.hypot(py - ay - f * ey, pz - az - f * ez);
  };

  /** Worst distance from the points of a section's halves to a slice, and from the slice's points back. */
  const gap = (slice: Float64Array, halves: readonly Float64Array[]): number => {
    let worst = 0;
    for (const h of halves) {
      for (let i = 0; i < h.length; i += 2) {
        let d = Infinity;
        for (let s = 0; s < slice.length; s += 5) {
          d = Math.min(
            d,
            distance(h[i]!, h[i + 1]!, slice[s]!, slice[s + 1]!, slice[s + 2]!, slice[s + 3]!),
          );
        }
        worst = Math.max(worst, d);
      }
    }
    for (let s = 0; s < slice.length; s += 5) {
      for (const o of [0, 2]) {
        if (slice[s + o]! < 0) continue;
        let d = Infinity;
        for (const h of halves) {
          for (let i = 0; i + 3 < h.length; i += 2) {
            d = Math.min(
              d,
              distance(slice[s + o]!, slice[s + o + 1]!, h[i]!, h[i + 1]!, h[i + 2]!, h[i + 3]!),
            );
          }
        }
        worst = Math.max(worst, d);
      }
    }
    return worst;
  };

  /**
   * How far a hard edge stands off the sharp corner it replaces, cm: the kernel never leaves
   * a blend out, so it builds the narrowest one, `bandMin` wide, to an apex kept `apexInset`
   * of the wall above the corner, 1.2 mm here. That stands 0.19 mm off the corner, in the
   * kernel's slice and in `recipeGap` alike.
   */
  const HARD_EDGE = 0.02;
  /** A deck that leaves its panel at an edge, with the wobble of a sampled section before the crease. */
  const CREASED_DECK: Shape = { ...SOFT, width: 1.6, edge: 28, rho: 0.45 };
  const cases: [string, Shape, Shape, number, number?][] = [
    ['a tucked-under edge under a soft deck', TUCKED, SOFT, 0],
    ['a soft rail top and bottom', { ...SOFT, width: 1.6, rise: 1.4 }, { ...SOFT, width: 3.2 }, 0],
    ['a boxy rail', { ...SOFT, width: 0.8, rho: 0.75 }, { ...SOFT, width: 1.2, rho: 0.7 }, 0],
    ['a chine', { ...TUCKED, width: 2.2, edge: 24, rho: 0.25, rise: 2 }, SOFT, 0],
    [
      'a hard bottom edge',
      { ...TUCKED, width: 0, rise: 0 },
      { ...SOFT, width: 2, rho: 0.62 },
      HARD_EDGE,
    ],
    ['a creased deck with wobble before its crease', TUCKED, CREASED_DECK, 0, 0.03],
  ];

  /**
   * A section of the slab: the bottom from `bottomShape`, the deck from `deckShape` with their
   * apexes met, and `deckWobble` on the deck before its band edge.
   */
  const sectionOf = (bottomShape: Shape, deckShape: Shape, deckWobble = 0) => {
    const top = 6;
    // wide enough that the limit which keeps bands from crossing is far from these bands
    const half = 24;
    const bottom = made({ ...bottomShape, half });
    const apex = bottom[bottom.length - 1]!;
    const deck = flipped(
      made({ ...deckShape, half, rise: top - apex - deckShape.slope * half }, deckWobble),
      top,
    );
    return { half, bottom, deck };
  };

  /** The slab the kernel builds from `recipe` on the two halves' panels for blends that wide, and its section. */
  const rebuilt = (
    half: number,
    bottom: Float64Array,
    deck: Float64Array,
    recipe: RailRecipe,
    widths: { readonly bottom: number; readonly deck: number },
  ) => {
    const panelB = panelCurve(bottom, 1, widths.bottom);
    const panelD = panelCurve(deck, -1, widths.deck);
    const panels = {
      deck: (_x: number, y: number) => panelD(Math.abs(y)),
      bottom: (_x: number, y: number) => panelB(Math.abs(y)),
    };
    const loop = slab(half);
    // rows enough that the mesh's own facets are well under what is being measured
    const mesh = buildTrimMesh(
      loop,
      railLaws(loop, () => recipe),
      panels,
      0.7,
      { deckRows: 64, tuckRows: 48 },
    );
    return { mesh, slice: sliceX(mesh, panels, 80) };
  };

  it.each(cases)('rebuilds %s', (_, bottomShape, deckShape, allowed, deckWobble) => {
    const { half, bottom, deck } = sectionOf(bottomShape, deckShape, deckWobble);
    const rail = sectionRail(bottom, deck, 1);
    const { mesh, slice } = rebuilt(half, bottom, deck, rail.recipe, {
      bottom: builtWidth(rail.recipe.tuck, 1),
      deck: builtWidth(rail.recipe.band, 1),
    });
    expect(checkClosed(mesh).openEdges).toBe(0);
    // the solid's own section is the section it was fitted to, to the fit's own gap and two
    // hundredths of a millimetre
    const fit = Math.max(rail.bottom.gap, rail.deck.gap);
    expect(fit).toBeLessThan(0.01);
    expect(gap(slice, [bottom, deck])).toBeLessThan(fit + allowed + 0.002);
  });

  describe('how far a recipe stands off a section', () => {
    it.each(cases)(
      "is the fit's own gap for %s",
      (_, bottomShape, deckShape, allowed, deckWobble) => {
        const { bottom, deck } = sectionOf(bottomShape, deckShape, deckWobble);
        const rail = sectionRail(bottom, deck, 1);
        const fit = Math.max(rail.bottom.gap, rail.deck.gap);
        const g = recipeGap(bottom, deck, rail.recipe, 1);
        expect(Math.abs(g - fit)).toBeLessThan(0.002 + allowed);
      },
    );

    it('predicts the kernel, not only the fit', () => {
      const { half, bottom, deck } = sectionOf(TUCKED, SOFT);
      const fitted = sectionRail(bottom, deck, 1).recipe;
      const recipe: RailRecipe = { ...fitted, tuck: fitted.tuck * 1.4, apex: fitted.apex + 0.08 };
      const { slice } = rebuilt(half, bottom, deck, recipe, {
        bottom: builtWidth(recipe.tuck, 1),
        deck: builtWidth(recipe.band, 1),
      });
      const sliced = gap(slice, [bottom, deck]);
      const predicted = recipeGap(bottom, deck, recipe, 1);
      const before = recipeGap(bottom, deck, fitted, 1);
      expect(Math.abs(predicted - sliced)).toBeLessThan(0.004);
      expect(predicted).toBeGreaterThan(5 * before);
      expect(sliced).toBeGreaterThan(5 * before);
    });

    // not a hard edge: the kernel's narrowest blend is `bandMin` square to the outline, which a
    // skewed section sees wider, so there the rail it builds is not the same
    const blended = cases.filter(([, , , allowed]) => allowed === 0);
    it.each(blended)(
      'reads %s the same through a skewed section',
      (_, bottomShape, deckShape, _a, deckWobble) => {
        const { bottom, deck } = sectionOf(bottomShape, deckShape, deckWobble);
        const square = recipeGap(bottom, deck, sectionRail(bottom, deck, 1).recipe, 1);
        const skew = recipeGap(bottom, deck, sectionRail(bottom, deck, 0.8).recipe, 0.8);
        expect(Math.abs(skew - square)).toBeLessThan(0.001);
      },
    );
  });
});
