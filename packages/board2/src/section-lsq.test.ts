// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section fit (docs/design/m1-model.md "As built (rail smoothness)"): graded knots, the registration
 * of the rail, exact corners, and the tangent-direction measure the span ladder gates on.
 */
import { describe, expect, it } from 'vitest';
import { fitSection, fitSide } from './sections';
import {
  computeFit,
  controlCount,
  gradedKnots,
  normalExcess,
  railKnot,
  sectionKnots,
} from './section-lsq';
import type { SampleAngles } from './section-lsq';
import {
  SECTION_FIT_TOL,
  SECTION_GRADE_RATIO,
  SECTION_HALF_SAMPLES,
  SECTION_NORMAL_TOL,
} from './params';
import { arcFractionParams, chainEval, compileChain } from './chain';
import { chain, knot, section } from './testing';
import { evalSection } from './test-support/rail-metrics';
import type { Pair, Section } from './types';

/** A boxy end-station section: flat bottom, a 90 degree edge at (1, 0), a wall of height `wall` to the apex, a rounded deck. */
function boxy(wall: number): Section {
  const apex: Pair = [1, wall];
  return {
    chain: chain(
      knot([0, 0], [0, 0], [0.33, 0], false),
      knot([1, 0], [0.66, 0], [1, wall / 3], false),
      knot(apex, [1, (2 * wall) / 3], [1, wall + (1 - wall) / 3]),
      knot([0.8, 0.85], [0.92, 0.7], [0.62, 0.95]),
      knot([0, 1], [0.25, 1], [0, 1], false),
    ),
    apex: 2,
  };
}

/** A section with a straight V bottom and no turning in its bottom half at all. */
const vee: Section = {
  chain: chain(
    knot([0, 0], [0, 0], [0, 0], false),
    knot([1, 0.15], [1, 0.15], [1, 0.4]),
    knot([0.7, 0.9], [0.9, 0.75], [0.5, 0.97]),
    knot([0, 1], [0.2, 1], [0, 1], false),
  ),
  apex: 1,
};

describe('gradedKnots', () => {
  const m = 48;
  const bottom = gradedKnots(m, true);
  const deck = gradedKnots(m, false);

  it('has m - 1 increasing interior knots, and the deck half is the bottom half mirrored', () => {
    expect(bottom).toHaveLength(m - 1);
    expect(deck).toHaveLength(m - 1);
    for (let i = 1; i < bottom.length; i++) expect(bottom[i]!).toBeGreaterThan(bottom[i - 1]!);
    expect(bottom[0]!).toBeGreaterThan(0);
    expect(bottom[m - 2]!).toBeLessThan(1);
    deck.forEach((t, i) => expect(t).toBeCloseTo(1 - bottom[m - 2 - i]!, 12));
  });

  it('puts SECTION_GRADE_RATIO times the spans per length on the rail as on the flat bottom', () => {
    const span = (i: number): number => (i === 0 ? bottom[0]! : bottom[i]! - bottom[i - 1]!);
    const flat = span(0);
    const rail = span(m - 3);
    expect(flat / rail).toBeGreaterThan(0.9 * SECTION_GRADE_RATIO);
    expect(flat / rail).toBeLessThan(1.1 * SECTION_GRADE_RATIO);
    // the whole vector is the shared clamped cubic one, with the triple knot at the apex
    const k = sectionKnots(m);
    expect(k.length).toBe(controlCount(m) + 4);
    expect(Array.from(k).filter((x) => x === 0.5)).toHaveLength(3);
    // graded, so the rail has more knots than a uniform vector would give it
    expect(Array.from(k).filter((x) => x > 0.35 && x < 0.5).length).toBeGreaterThan(0.15 * m);
  });
});

describe('the rail is registered', () => {
  const m = 24;
  const bottomRail = railKnot(m, true);
  const deckRail = railKnot(m, false);

  it.each([0.2, 0.5, 0.9])(
    'puts the corner of a boxy section with a wall of %f at the rail knot, however long the wall',
    (wall) => {
      const fit = fitSection(boxy(wall), m)!;
      // the bottom half is the first half of the whole parameter
      const at = evalSection(m, fit.ctrl, 0.5 * bottomRail.t);
      expect(at[0]).toBeCloseTo(1, 9);
      expect(at[1]).toBeCloseTo(0, 9);
      // held exactly: three coincident controls
      const c = fit.ctrl;
      for (const q of [bottomRail.k, bottomRail.k + 1, bottomRail.k + 2]) {
        expect(c[2 * q]).toBe(1);
        expect(c[2 * q + 1]).toBe(0);
      }
    },
  );

  it('holds the corner of a half exactly and fits both legs, whatever the stored handles', () => {
    for (const wall of [0.2, 0.5, 0.9]) {
      const fit = fitSection(boxy(wall), m)!;
      expect(fit.error).toBeLessThan(2e-3);
      expect(fit.clamped).toBe(0);
    }
  });

  it('does not register a half that barely turns (a straight V bottom): its controls stay on the line', () => {
    const fit = fitSection(vee, m)!;
    const nb = m + 3;
    for (let i = 0; i < nb; i++) {
      // the bottom half is the line v = 0.15 u
      expect(fit.ctrl[2 * i + 1]).toBeCloseTo(0.15 * fit.ctrl[2 * i]!, 9);
    }
  });

  it('moves the rail of a smooth section to the same parameter as another, whatever its arc fraction', () => {
    // the turning-weighted mean parameter of the bottom half: where the rail is
    const centre = (point: (t: number) => [number, number], e: number): number => {
      const n = 2000;
      let w = 0;
      let ws = 0;
      let prev = 0;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p0 = point(Math.max(0, t - e));
        const p1 = point(Math.min(1, t + e));
        const a = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        if (i > 0) {
          w += Math.abs(a - prev);
          ws += Math.abs(a - prev) * t;
        }
        prev = a;
      }
      return ws / w;
    };
    const shapes = [
      section(0.6, 0.08, 0.5, 0.6, 0.9),
      section(0.95, 0.02, 0.2, 0.9, 0.7),
      section(0.88, 0.06, 0.38, 0.86, 0.78),
    ];
    const stored = shapes.map((s) => {
      const ch = compileChain(s.chain);
      const arc = arcFractionParams(
        ch,
        0,
        s.apex,
        Float64Array.from({ length: 2001 }, (_, j) => j / 2000),
      );
      const o = new Float64Array(2);
      return centre((t) => {
        chainEval(ch, arc[Math.round(t * 2000)]!, 0, o, 0);
        return [o[0]!, o[1]!];
      }, 1 / 2000);
    });
    const fitted = shapes.map((s) => {
      const fit = fitSection(s, m)!;
      return centre((t) => evalSection(m, fit.ctrl, 0.5 * t), 1e-4);
    });
    const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
    // by arc length the rails of these three sections are 0.15 apart, after registration under half that
    expect(spread(stored)).toBeGreaterThan(0.12);
    expect(spread(fitted)).toBeLessThan(0.5 * spread(stored));
    for (const c of fitted) expect(Math.abs(c - bottomRail.t)).toBeLessThan(0.07);
    expect(deckRail.t).toBeLessThan(0.5);
  });
});

describe('the tangent direction of a fit', () => {
  it('a boxy end section is within the limit at its rung, with its corner held', () => {
    const fit = computeFit(boxy(0.5), 24)!;
    expect(normalExcess(fit.angles, 1, 1)).toBeLessThan(SECTION_NORMAL_TOL);
    // beside the corner the fitted tangent is the legs': flat, then vertical
    const { fit: ang } = fit.angles;
    const J = SECTION_HALF_SAMPLES;
    expect(ang[0]!).toBeCloseTo(0, 6); // bottom centre: horizontal
    expect(ang[J]!).toBeCloseTo(Math.PI / 2, 3); // apex: vertical
  });

  it('is measured on the shape of the section: a wall tilted by an angle is a bigger miss on a wide section', () => {
    const J = SECTION_HALF_SAMPLES;
    const vertical = Math.PI / 2;
    const make = (miss: number): SampleAngles => {
      const fit = new Float64Array(2 * (J + 1)).fill(vertical + miss);
      const lo = new Float64Array(2 * (J + 1)).fill(vertical);
      return { fit, lo, hi: lo };
    };
    expect(normalExcess(make(0), 4, 1)).toBe(0);
    // near vertical an angle error is magnified by chord / thickness
    expect(normalExcess(make(0.05), 1, 1)).toBeCloseTo(0.05, 6);
    expect(normalExcess(make(0.05), 4, 1)).toBeGreaterThan(0.19);
    expect(normalExcess(make(0.05), 4, 1)).toBeLessThan(0.21);
    expect(normalExcess(make(-0.05), 4, 1)).toBeCloseTo(normalExcess(make(0.05), 4, 1), 2);
    // a sliver (no chord, or none to speak of) is measured as at most 8 times wider than thick
    expect(normalExcess(make(0.05), 1e6, 1)).toBeLessThan(0.41);
    expect(normalExcess(make(0.05), 0, 0)).toBeCloseTo(0.05, 6);
  });

  it('accepts any angle within the stored window, and ignores samples where the curve has no speed', () => {
    const J = SECTION_HALF_SAMPLES;
    const n = 2 * (J + 1);
    const fit = new Float64Array(n).fill(0.3);
    const lo = new Float64Array(n).fill(0.2);
    const hi = new Float64Array(n).fill(0.4);
    expect(normalExcess({ fit, lo, hi }, 1, 1)).toBe(0);
    fit[5] = 0.5;
    expect(normalExcess({ fit, lo, hi }, 1, 1)).toBeCloseTo(0.1, 9);
    lo[5] = Number.NEGATIVE_INFINITY;
    hi[5] = Number.POSITIVE_INFINITY;
    expect(normalExcess({ fit, lo, hi }, 1, 1)).toBe(0);
  });
});

describe('the span ladder with the tangent-direction limit', () => {
  const smooth = section(0.88, 0.06, 0.38, 0.86, 0.78);
  const item = (id: string, x: number, s: Section) => ({
    id,
    x,
    section: s,
    scale: 25,
    chord: 25,
    thickness: 5,
  });

  it('reports the tangent-direction error of every station, within the limit when the rung is accepted', () => {
    const b = fitSide([
      item('tip', 1, boxy(0.5)),
      item('a', 60, smooth),
      item('b', 120, section(0.8, 0.05, 0.36, 0.8, 0.74)),
      item('c', 180, boxy(0.3)),
    ])!;
    expect(b.stationNormal).toHaveLength(4);
    expect(Math.max(...b.stationNormal)).toBeLessThanOrEqual(SECTION_NORMAL_TOL);
    expect(Math.max(...b.stationError)).toBeLessThanOrEqual(SECTION_FIT_TOL);
  });

  it('spends more spans on a section with a tight bend than on a gentle one (a tuck of 2 mm radius)', () => {
    // a tuck knot close to the bottom with a short handle is a tight bend
    const tight = section(0.97, 0.01, 0.3, 0.9, 0.8);
    const gentle = fitSide([item('a', 10, smooth), item('b', 90, smooth)])!;
    const tightFit = fitSide([item('a', 10, tight), item('b', 90, tight)])!;
    expect(tightFit.m).toBeGreaterThanOrEqual(gentle.m);
    expect(Math.max(...tightFit.stationError)).toBeLessThanOrEqual(SECTION_FIT_TOL);
  });

  it('is cached by section identity like the plain fit was', () => {
    const s = boxy(0.4);
    expect(fitSection(s, 24)).toBe(fitSection(s, 24));
    expect(fitSection(boxy(0.4), 24)).not.toBe(fitSection(s, 24));
  });
});
