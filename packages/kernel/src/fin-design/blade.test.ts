// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { DEG_TO_RAD, RAD_TO_DEG } from '../constants';
import { knot } from '../knot';
import { lerp, vec2, type Vec2 } from '../vec2';
import {
  bladeSection,
  chordAt,
  cosineStations,
  rootThickestFaces,
  prepareBlade,
  thicknessAt,
  type BladeSection,
  type PreparedBlade,
} from './blade';
import { defaultFinDesign, defaultTaper } from './fin-defaults';
import { yAtX } from './curve-shape';
import { smoothBladeOf } from './smooth-blade';
import { FIN_MIN_THICKNESS, FIN_POSITIONS, type FinDesign } from './fin-design';
import { finReadouts } from './fin-readouts';
import { validateFinDesign } from './fin-rules';

const polyline = (pts: readonly Vec2[]) =>
  splineFromKnots(
    pts.map((p, i) =>
      knot(
        p,
        i > 0 ? lerp(p, pts[i - 1]!, 1 / 3) : p,
        i < pts.length - 1 ? lerp(p, pts[i + 1]!, 1 / 3) : p,
        false,
      ),
    ),
  );

/** Lateral width of a section at each station (cm), measured horizontally. */
const widths = (s: BladeSection): number[] =>
  s.outside.map((o, j) => Math.abs(o.y - s.inside[j]!.y));

const heights = (b: ReturnType<typeof prepareBlade>) =>
  [0, 0.1, 0.25, 0.5, 0.7, 0.85, 0.95, 1].map((f) => f * b.depth);

/** The thickest station of a finely sampled section, and its width there. */
const thickestOf = (b: PreparedBlade, h: number): { at: number; width: number } => {
  const s = bladeSection(b, h, cosineStations(400));
  const w = widths(s);
  const j = w.indexOf(Math.max(...w));
  return { at: s.stations[j]!, width: w[j]! };
};

describe('minimum thickness', () => {
  const b = prepareBlade({ ...defaultFinDesign('side', 'left'), cant: 0 });

  it('ends both edges at exactly the minimum', () => {
    const s = bladeSection(b, b.depth * 0.3);
    const w = widths(s);
    expect(w[0]).toBeCloseTo(FIN_MIN_THICKNESS, 12);
    expect(w[w.length - 1]).toBeCloseTo(FIN_MIN_THICKNESS, 12);
  });

  it('keeps the faces convex right to the edges: no parallel-sided run', () => {
    // Round 2 testing: padding only where the foil was thin left the last few percent
    // of the chord flat. Now the outside face keeps bending the same way to the edge.
    const s = bladeSection(b, b.depth * 0.3, cosineStations(400));
    const y = s.outside.map((p) => p.y);
    const x = s.outside.map((p) => p.x);
    for (let j = s.stations.length - 60; j < s.stations.length - 2; j++) {
      const slopeA = (y[j + 1]! - y[j]!) / (x[j + 1]! - x[j]!);
      const slopeB = (y[j + 2]! - y[j + 1]!) / (x[j + 2]! - x[j + 1]!);
      expect(Math.abs(slopeA)).toBeGreaterThan(1e-4); // still thinning, not flat
      // And bending one way (x falls), to within the sweep's interpolation: a few
      // hundredths of a percent of the slope.
      expect(slopeB).toBeGreaterThanOrEqual(slopeA - 1e-3 * Math.abs(slopeA));
    }
  });
});

describe('chordAt', () => {
  // Leading-edge root (10, 0) → tip (4, 6) → trailing-edge root (0, 0).
  const tri = prepareBlade({
    ...defaultFinDesign('side'),
    outline: polyline([vec2(10, 0), vec2(4, 6), vec2(0, 0)]),
  });

  it('crosses straight edges where they should', () => {
    expect(chordAt(tri, 3).leading).toBeCloseTo(7, 12);
    expect(chordAt(tri, 3).trailing).toBeCloseTo(2, 12);
  });

  it('spans the root chord at the tab top and closes at the tip', () => {
    expect(chordAt(tri, 0)).toEqual({ leading: 10, trailing: 0 });
    const tip = chordAt(tri, 6);
    expect(tip.leading).toBeCloseTo(4, 12);
    expect(tip.trailing).toBeCloseTo(4, 12);
  });

  it('refuses heights off the blade', () => {
    expect(() => chordAt(tri, -0.01)).toThrow(RangeError);
    expect(() => chordAt(tri, 6.01)).toThrow(RangeError);
  });

  it.each(FIN_POSITIONS)('matches the root chord of the default %s', (position) => {
    const d = defaultFinDesign(position);
    const { leading, trailing } = chordAt(prepareBlade(d), 0);
    expect(leading - trailing).toBeCloseTo(finReadouts(d).rootChord, 9);
  });
});

describe.each(FIN_POSITIONS)('bladeSection(default %s)', (position) => {
  const d = defaultFinDesign(position, 'left');
  const flat = prepareBlade({ ...d, cant: 0 });

  it('is a valid design to start from', () => {
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('is exactly the taper thickness at the root’s thickest point', () => {
    const s = bladeSection(flat, 0, [flat.thickestAt]);
    expect(widths(s)[0]).toBeCloseTo(thicknessAt(flat, 0), 9);
  });

  it('is the thickness curve on the thickness path, read along the fin', () => {
    const sb = smoothBladeOf(flat);
    for (const f of [0.1, 0.25, 0.5, 0.75, 0.95]) {
      const s = f * sb.sTip;
      let thickest = 0;
      for (let k = 0; k <= 400; k++) {
        const [o, n] = sb.offsets(s, k / 400);
        thickest = Math.max(thickest, o - n);
      }
      const want = yAtX(flat.design.taper, sb.eta(s));
      expect(Math.abs(thickest / want - 1)).toBeLessThan(0.005);
    }
  });

  it('is never thinner than the minimum, nor thicker than its rows', () => {
    const sb = smoothBladeOf(flat);
    for (const h of heights(flat)) {
      const s = bladeSection(flat, h, cosineStations(200));
      widths(s).forEach((w, j) => {
        expect(w).toBeGreaterThanOrEqual(FIN_MIN_THICKNESS - 1e-9);
        // Each point is on a row, as thick at most as the curve says along the fin.
        const u = s.stations[j]!;
        const at = sb.nearest(s.leadingX + (s.trailingX - s.leadingX) * u, h);
        const row = sb.scale(at.s) + FIN_MIN_THICKNESS;
        expect(w).toBeLessThanOrEqual(row * flat.widen * 1.001);
      });
    }
  });

  it('runs from the leading edge to the trailing edge', () => {
    const s = bladeSection(flat, flat.depth / 3);
    expect(s.outside[0]!.x).toBeCloseTo(s.leadingX, 9);
    expect(s.outside[s.outside.length - 1]!.x).toBeCloseTo(s.trailingX, 12);
    expect(s.leadingX).toBeGreaterThan(s.trailingX);
    for (const p of [...s.outside, ...s.inside]) expect(p.z).toBe(flat.depth / 3);
  });

  it('makes a right fin the exact mirror of a left fin', () => {
    const left = prepareBlade(d);
    const right = prepareBlade({ ...d, hand: d.hand === null ? null : 'right' });
    for (const h of heights(left)) {
      const r = bladeSection(left, h);
      const l = bladeSection(right, h);
      if (d.hand === null) {
        expect(l).toEqual(r); // centre: no hand, nothing to mirror
        continue;
      }
      r.outside.forEach((p, j) => {
        expect(l.outside[j]).toEqual({ x: p.x, y: -p.y, z: p.z });
        expect(l.inside[j]).toEqual({ x: r.inside[j]!.x, y: -r.inside[j]!.y, z: p.z });
      });
    }
  });
});

describe('section faces', () => {
  it('keeps a flat inside face flat, adding the minimum to the outside', () => {
    const b = prepareBlade({ ...defaultFinDesign('side', 'left'), cant: 0 });
    for (const h of heights(b)) {
      for (const p of bladeSection(b, h).inside) expect(p.y).toBe(0);
    }
  });

  it('keeps a symmetric foil symmetric, adding the minimum both ways', () => {
    const b = prepareBlade(defaultFinDesign('centre'));
    for (const h of heights(b)) {
      const s = bladeSection(b, h);
      s.outside.forEach((p, j) => expect(s.inside[j]!.y).toBeCloseTo(-p.y, 15));
    }
  });

  it('puts the thickest point where the shape is thickest', () => {
    // Flat inside face: the section is thickest where the outside face peaks. At the
    // root exactly; up the blade the sweep's sections lean, so nearly.
    const b = prepareBlade(defaultFinDesign('side'));
    expect(Math.abs(thickestOf(b, 0).at - b.thickestAt)).toBeLessThan(0.01);
    expect(Math.abs(thickestOf(b, b.depth / 4).at - b.thickestAt)).toBeLessThan(0.05);
  });

  it('scales a thinner taper without changing the chord', () => {
    const d = defaultFinDesign('side');
    const thin = prepareBlade({ ...d, cant: 0, taper: defaultTaper(0.4) });
    const thick = prepareBlade({ ...d, cant: 0, taper: defaultTaper(0.8) });
    const h = 0;
    const a = bladeSection(thin, h, [thin.thickestAt]);
    const c = bladeSection(thick, h, [thick.thickestAt]);
    // Twice the taper, twice the thickness there: the minimum is part of it, not extra.
    expect(widths(c)[0]! / widths(a)[0]!).toBeCloseTo(
      thicknessAt(thick, h) / thicknessAt(thin, h),
      12,
    );
    expect(a.leadingX).toBe(c.leadingX);
    expect(a.trailingX).toBe(c.trailingX);
  });
});

describe('cant', () => {
  const base = defaultFinDesign('side', 'left');

  it.each([0, 4, 7, 12.5, 20])('leans the blade out by %s°', (cant) => {
    const b = prepareBlade({ ...base, cant });
    // A flat inside face is a straight line up the blade: its lean is the cant.
    const j = 10;
    const lo = bladeSection(b, 0.2 * b.depth).inside[j]!;
    const hi = bladeSection(b, 0.6 * b.depth).inside[j]!;
    expect(Math.atan2(hi.y - lo.y, hi.z - lo.z) * RAD_TO_DEG).toBeCloseTo(cant, 10);
  });

  it('leans a right fin the other way', () => {
    const b = prepareBlade({ ...base, hand: 'right', cant: 7 });
    expect(bladeSection(b, b.depth / 2).inside[5]!.y).toBeLessThan(0);
  });

  it.each([7, 20])('keeps the true thickness at the taper value at %s°', (cant) => {
    const b = prepareBlade({ ...base, cant });
    const s = bladeSection(b, 0, [b.thickestAt]);
    // Horizontal width × cos(cant) = thickness square to the leaning blade.
    expect(widths(s)[0]! * Math.cos(cant * DEG_TO_RAD)).toBeCloseTo(thicknessAt(b, 0), 6);
    // Up the blade too, on a row: the curve read along the fin.
    const sb = smoothBladeOf(b);
    const row = 0.4 * sb.sTip;
    let up = 0;
    for (let k = 0; k <= 400; k++) {
      const f = sb.faces(row, k / 400);
      up = Math.max(up, Math.abs(f.outside.y - f.inside.y));
    }
    expect(up * Math.cos(cant * DEG_TO_RAD)).toBeCloseTo(yAtX(b.design.taper, sb.eta(row)), 2);
  });

  it('leaves the root on the tab top whatever the cant', () => {
    const b = prepareBlade({ ...base, cant: 20 });
    const root = bladeSection(b, 0);
    for (const p of [...root.outside, ...root.inside]) expect(p.z).toBe(0);
    // No slide at the root: the flat face starts on the tab's centre plane.
    for (const p of root.inside) expect(p.y).toBe(0);
  });
});

describe('a cambered foil (not symmetric, not flat)', () => {
  // Inside face bulging inboard: mirror of the outside at a third of its offset.
  const d0 = defaultFinDesign('side', 'left');
  const bulge = splineFromKnots(
    d0.section.outside.knots.map((k) => {
      const m = (p: Vec2) => vec2(p.x, -p.y / 3);
      return knot(m(k.end), m(k.tangentToPrev), m(k.tangentToNext), k.continuous);
    }),
  );
  const d: FinDesign = { ...d0, cant: 0, section: { outside: d0.section.outside, inside: bulge } };

  it('is valid', () => expect(validateFinDesign(d)).toEqual([]));

  it('adds the minimum to the outside only, leaving the inside face as drawn', () => {
    const b = prepareBlade(d);
    const near = bladeSection(b, b.depth * 0.999); // nearly all minimum up here
    for (const p of near.inside) expect(p.y).toBeLessThanOrEqual(0);
    near.outside.forEach((p, j) =>
      expect(p.y - near.inside[j]!.y).toBeGreaterThanOrEqual(FIN_MIN_THICKNESS - 1e-12),
    );
  });
});

describe('rootThickestFaces', () => {
  it.each(FIN_POSITIONS)('matches the built root section at its thickest (%s)', (position) => {
    for (const d of [defaultFinDesign(position, 'left'), defaultFinDesign(position, 'right')]) {
      const b = prepareBlade(d);
      const s = bladeSection(b, 0, [b.thickestAt]);
      const f = rootThickestFaces(b);
      expect(f.outside).toBeCloseTo(s.outside[0]!.y, 9);
      expect(f.inside).toBeCloseTo(s.inside[0]!.y, 9);
    }
  });
});
