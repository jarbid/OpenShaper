// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { splineFromKnots, type Spline } from '../bezier-spline';
import { knot, type Knot } from '../knot';
import { vec2, type Vec2 } from '../vec2';
import { defaultFinDesign, defaultTaper, flatFace } from './fin-defaults';
import { FIN_MAX_FRONT_OVERHANG, FIN_MIN_THICKNESS, type FinDesign } from './fin-design';
import { validateFinDesign, type FinIssueCode } from './fin-rules';

const codes = (d: FinDesign): FinIssueCode[] => validateFinDesign(d).map((i) => i.code);

/** Every point of the spline (ends and handles) moved through `f`. */
const mapSpline = (s: Spline, f: (p: Vec2) => Vec2): Spline =>
  splineFromKnots(
    s.knots.map((k): Knot => knot(f(k.end), f(k.tangentToPrev), f(k.tangentToNext), k.continuous)),
  );

/** The spline with knot `i` replaced. */
const withKnot = (s: Spline, i: number, k: Knot): Spline =>
  splineFromKnots(s.knots.map((old, j) => (j === i ? k : old)));

const side = defaultFinDesign('side');
const centre = defaultFinDesign('centre');

describe('validateFinDesign', () => {
  it('accepts the defaults', () => {
    expect(codes(side)).toEqual([]);
    expect(codes(centre)).toEqual([]);
  });

  describe('hand', () => {
    it('requires a side for side and quad-rear fins', () => {
      expect(codes({ ...side, hand: null })).toEqual(['hand']);
      expect(codes({ ...defaultFinDesign('quad-rear'), hand: null })).toEqual(['hand']);
    });
    it('forbids a side on a centre fin', () => {
      expect(codes({ ...centre, hand: 'left' })).toEqual(['hand']);
    });
  });

  describe('cant', () => {
    it('allows 0 to 20° on side fins', () => {
      expect(codes({ ...side, cant: 0 })).toEqual([]);
      expect(codes({ ...side, cant: 20 })).toEqual([]);
      expect(codes({ ...side, cant: 20.01 })).toEqual(['cant']);
      expect(codes({ ...side, cant: -1 })).toEqual(['cant']);
      expect(codes({ ...side, cant: Number.NaN })).toEqual(['cant']);
    });
    it('forbids cant on a centre fin', () => {
      expect(codes({ ...centre, cant: 5 })).toEqual(['cant']);
    });
  });

  describe('outline', () => {
    /** The side fin moved so its leading-edge root is at `x` (cm). */
    const placeLe = (x: number, d: FinDesign = side): FinDesign => {
      const dx = x - d.outline.knots[0]!.end.x;
      return { ...d, outline: mapSpline(d.outline, (p) => vec2(p.x + dx, p.y)) };
    };

    it('lets the leading edge overhang the tab front by up to 4 mm', () => {
      expect(codes(placeLe(11.3 + FIN_MAX_FRONT_OVERHANG))).toEqual([]);
      expect(codes(placeLe(11.3 + FIN_MAX_FRONT_OVERHANG + 0.001))).toEqual(['front-overhang']);
    });

    it('flags a fin whose leading edge has left the tab', () => {
      expect(codes(placeLe(-0.001))).toContain('tab-rear');
      expect(codes(placeLe(0))).not.toContain('tab-rear');
    });

    it('flags a base that runs behind the tab without a raised rear', () => {
      // Moved back 1 mm, the default's flat base sits behind the tab on the base line.
      expect(codes(placeLe(side.outline.knots[0]!.end.x - 0.1))).toEqual(['rear-clearance']);
    });

    it('measures the overhang from the fin position’s own tab', () => {
      expect(codes(placeLe(11.3 + 0.5, defaultFinDesign('quad-rear')))).toEqual(['front-overhang']);
    });

    it('needs both roots on the tab top', () => {
      const lifted = mapSpline(side.outline, (p) => (p.y === 0 ? vec2(p.x, 0.1) : p));
      expect(codes({ ...side, outline: lifted })).toContain('outline-root');
    });

    it('needs the leading-edge root in front of the trailing-edge root', () => {
      // Mirror the outline front to back: the chain now starts at the rear.
      const flipped = mapSpline(side.outline, (p) => vec2(10 - p.x, p.y));
      expect(codes({ ...side, outline: flipped })).toContain('outline-root');
    });

    it('rejects a dip in the leading edge', () => {
      // Knot 1 is just below the peak. Raising its incoming handle well above it makes the
      // leading edge overshoot, drop back to the knot, then climb again into the tip.
      const k = side.outline.knots[1]!;
      const dipped = withKnot(
        side.outline,
        1,
        knot(k.end, vec2(k.tangentToPrev.x, k.end.y + 5), k.tangentToNext, k.continuous),
      );
      expect(codes({ ...side, outline: dipped })).toEqual(['outline-rising']);
    });

    it('rejects a trailing edge that climbs back up', () => {
      const k = side.outline.knots[3]!; // on the trailing edge
      const bumped = withKnot(
        side.outline,
        3,
        knot(vec2(k.end.x, 10.5), k.tangentToPrev, k.tangentToNext, k.continuous),
      );
      expect(codes({ ...side, outline: bumped })).toEqual(['outline-rising']);
    });
  });

  describe('section', () => {
    it('keeps centre fins symmetric', () => {
      expect(codes({ ...centre, section: { ...centre.section, inside: flatFace() } })).toEqual([
        'section-symmetry',
      ]);
    });

    it('allows a symmetric section on a side fin', () => {
      expect(codes({ ...side, section: { ...side.section, inside: null } })).toEqual([]);
    });

    it('allows an inside face that bulges inboard', () => {
      const bulge = mapSpline(side.section.outside, (p) => vec2(p.x, -0.3 * p.y));
      expect(codes({ ...side, section: { ...side.section, inside: bulge } })).toEqual([]);
    });

    it('rejects an inside face that crosses the outside face', () => {
      const crossing = mapSpline(side.section.outside, (p) => vec2(p.x, 1.2 * p.y));
      expect(codes({ ...side, section: { ...side.section, inside: crossing } })).toEqual([
        'section-crossing',
      ]);
    });

    it('rejects a foil with no thickness', () => {
      const flat = { outside: flatFace(), inside: flatFace() };
      expect(codes({ ...side, section: flat })).toEqual(['section-crossing']);
    });

    it('needs each face to span the chord', () => {
      const short = mapSpline(side.section.outside, (p) => vec2(p.x * 0.9, p.y));
      expect(codes({ ...side, section: { ...side.section, outside: short } })).toEqual([
        'section-ends',
      ]);
    });

    it('lets the edges leave the chord line where both faces meet them', () => {
      // Owner's request, to blend twists: a foil with its own inside face only.
      const lift = (s: Spline) => mapSpline(s, (p) => vec2(p.x, p.y + 0.01 * p.x));
      const off = { outside: lift(side.section.outside), inside: lift(side.section.inside!) };
      expect(codes({ ...side, section: off })).toEqual([]);
      // The faces apart at the trailing edge: open.
      expect(codes({ ...side, section: { ...off, inside: side.section.inside } })).toEqual([
        'section-ends',
      ]);
      // A symmetric foil mirrors its outside face: its edges stay on the line.
      expect(codes({ ...side, section: { outside: off.outside, inside: null } })).toEqual([
        'section-ends',
      ]);
    });

    it('rejects a face that turns back toward the leading edge', () => {
      const k = side.section.outside.knots[1]!;
      const back = withKnot(
        side.section.outside,
        1,
        knot(k.end, k.tangentToPrev, vec2(k.end.x - 0.6, k.tangentToNext.y), k.continuous),
      );
      expect(codes({ ...side, section: { ...side.section, outside: back } })).toEqual([
        'section-direction',
      ]);
    });
  });

  describe('taper', () => {
    it(`keeps the fin at least ${FIN_MIN_THICKNESS * 10} mm thick`, () => {
      const thin = mapSpline(side.taper, (p) => vec2(p.x, p.y - 0.01));
      expect(codes({ ...side, taper: thin })).toEqual(['taper-thickness']);
    });

    it('catches a dip below the minimum between knots', () => {
      // Ends are fine, but the handles pull the middle of the last curve under the minimum.
      const t = defaultTaper(0.8);
      const k = t.knots[2]!;
      const dipping = withKnot(t, 2, knot(k.end, vec2(0.92, 0), k.tangentToNext, false));
      expect(codes({ ...side, taper: dipping })).toEqual(['taper-thickness']);
    });

    it('must run from the root to the tip', () => {
      const short = mapSpline(side.taper, (p) => vec2(p.x * 0.8, p.y));
      expect(codes({ ...side, taper: short })).toEqual(['taper-span']);
    });

    it('must not turn back toward the root', () => {
      const k = side.taper.knots[1]!;
      const back = withKnot(
        side.taper,
        1,
        knot(k.end, k.tangentToPrev, vec2(k.end.x - 0.3, k.tangentToNext.y), k.continuous),
      );
      expect(codes({ ...side, taper: back })).toEqual(['taper-span']);
    });
  });
});
