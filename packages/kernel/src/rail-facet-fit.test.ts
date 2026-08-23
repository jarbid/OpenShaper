// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the bands go, and how much foam that leaves.
 *
 * There is no legacy oracle (BoardCAD-LE has no rail bands), so the assertions are
 * analytic. The load-bearing one is the circular rail: every cap on a circle turns on
 * the same radius, so the foam-minimising placement is provably **equal angular gaps**,
 * `90k/(n+1)`, and the leftover it produces has a closed form. Anything the dynamic
 * program does differently there is a bug in the dynamic program.
 *
 * The circle cannot separate the objectives — with a constant radius, minimising foam
 * and equalising turn are the same problem — so the ellipse fixture exists to pull them
 * apart, and the golden boards pin the empirical claim the default rests on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vec2, type Vec2 } from './vec2';
import { normalByTT, pointByTT } from './bezier-spline';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { circleRailSection, ellipseRailSection, oracle } from './test-support/rail-sections';
import {
  bisectionLadder,
  clearOf,
  measureLeftover,
  type RailAngleMode,
} from './rail-facet-fit';
import {
  MAX_BANDS,
  railBandTradeoff,
  railFacetPlan,
  railFacetsForSection,
  type RailManualMarks,
  type RailStationFacets,
} from './rail-facets';
import type { CrossSection } from './cross-section';
import type { BezierBoard } from './board';

const W = 25;
const R = 6;
const o = oracle(W, R);

const anglesOf = (st: RailStationFacets): number[] => st.deckFacets.map((f) => f.targetAngle);
const fit = (n: number, mode: RailAngleMode, cs = circleRailSection(W, R)): RailStationFacets =>
  railFacetsForSection(cs, { deckBands: n, bottomAngle: 30, angleMode: mode });

describe('placing bands on an exactly circular rail', () => {
  // On a circle f(Δ) = tan(Δ/2) − Δ/2 is strictly convex and every cap shares the same
  // radius, so Σ f(Δᵢ) subject to ΣΔᵢ = 90° is uniquely minimised by equal gaps. That
  // makes 90k/(n+1) an oracle, not a guess.
  for (const n of [1, 2, 3, 4]) {
    it(`spaces ${n} band${n === 1 ? '' : 's'} at equal ${(90 / (n + 1)).toFixed(2)}° gaps`, () => {
      const angles = anglesOf(fit(n, 'least-foam'));
      expect(angles).toHaveLength(n);
      angles.forEach((a, i) => {
        // half a grid step: the fit is optimal *on* the 0.5° grid, not off it
        expect(a).toBeCloseTo((90 * (n - i)) / (n + 1), 0);
        expect(Math.abs(a - (90 * (n - i)) / (n + 1))).toBeLessThanOrEqual(0.25 + 1e-9);
      });
    });
  }

  it('leaves the foam the closed form says it must', () => {
    for (const n of [1, 2, 3]) {
      const st = fit(n, 'least-foam');
      // (n+1) equal caps of 90/(n+1) degrees each.
      const expected = (n + 1) * o.capArea(90 / (n + 1));
      expect(st.leftover.deck.areaCm2).toBeCloseTo(expected, 2);
    }
  });

  it('measures the bare corner as R²(1 − π/4)', () => {
    // Nothing cut yet: the foam proud of the deck side is the corner outside the quarter
    // circle, which is exactly R² − πR²/4.
    const bare = railFacetsForSection(circleRailSection(W, R), { deckAngles: [] });
    expect(bare.deckFacets).toHaveLength(0);
    expect(bare.leftover.deck.areaCm2).toBeCloseTo(o.bareDeckArea(), 2);
    expect(bare.leftover.deck.removed).toBeCloseTo(0, 6);
  });

  it('reports the fraction removed against that same corner', () => {
    const st = fit(3, 'least-foam');
    const left = 4 * o.capArea(22.5);
    expect(st.leftover.deck.removed).toBeCloseTo(1 - left / o.bareDeckArea(), 3);
    // three bands take out the overwhelming majority of it
    expect(st.leftover.deck.removed).toBeGreaterThan(0.95);
  });

  it('is a rounding of the answer, not a menu of answers', () => {
    // Every angle lands on the half-degree grid, but the *values* come from the section:
    // a circle of a different radius puts its bands in the same place because it is the
    // same shape, while a different shape does not. The grid rounds; it does not choose.
    expect(anglesOf(fit(3, 'least-foam', circleRailSection(50, 12)))).toEqual(
      anglesOf(fit(3, 'least-foam', circleRailSection(25, 6))),
    );
    expect(anglesOf(fit(3, 'least-foam', ellipseRailSection(25, 12, 2.5)))).not.toEqual(
      anglesOf(fit(3, 'least-foam', circleRailSection(25, 6))),
    );
  });
});

/**
 * Deepest foam left on the **rail corner** — section points whose own slope is steeper
 * than `fromDeg`, which is the stretch a shaper judges a rail by.
 *
 * The whole-section number cannot stand in for this: a placement can win it outright
 * while leaving the corner twice as proud, which is exactly what unconstrained
 * minimisation does.
 */
const worstAtRail = (st: RailStationFacets, fromDeg = 45): number => {
  const cut: Vec2[] = [];
  const inner = st.deckFacets[st.deckFacets.length - 1];
  if (inner) {
    cut.push(inner.cutTo);
    for (let i = st.deckFacets.length - 1; i >= 0; i--) cut.push(st.deckFacets[i]!.cutFrom);
  }
  cut.push(st.apex);
  let worst = 0;
  for (let i = 0; i <= 600; i++) {
    const tt = i / 600;
    const nu = (normalByTT(st.section.spline, tt) * 180) / Math.PI;
    if (nu < fromDeg || nu > 90) continue;
    const p = pointByTT(st.section.spline, tt);
    let d = Infinity;
    for (let k = 0; k < cut.length - 1; k++) {
      const a = cut[k]!;
      const b = cut[k + 1]!;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      let u = len2 > 1e-12 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
      u = Math.max(0, Math.min(1, u));
      d = Math.min(d, Math.hypot(p.x - (a.x + vx * u), p.y - (a.y + vy * u)));
    }
    worst = Math.max(worst, d);
  }
  return worst;
};


/**
 * The marks that reproduce a given set of tangent angles — how a shaper would transcribe
 * a fitted sheet back onto a blank.
 */
const marksFromAngles = (cs: CrossSection, angles: readonly number[]): RailManualMarks => {
  const st = railFacetsForSection(cs, { deckAngles: angles });
  const railUp = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!.distance;
  return {
    railPercent: (railUp / st.blank.thickness) * 100,
    deckIn: st.deckFacets.map(
      (f) => f.marks.find((m) => m.ref.kind === 'deckPlane')!.distance,
    ),
  };
};

describe('holding the rail corner is manual mode now', () => {
  // Scoring runs in to the stringer, where the deck crown holds more removable foam than
  // the rail turn does, so the unconstrained fit trades the corner away for crown. There
  // used to be a `balanced` mode pinning band 1 at 45°; it duplicated `least-foam`
  // everywhere else, and a shaper who wants the corner held now says so directly.
  const cs = ellipseRailSection(W, 12, 2.5);
  const manual45 = railFacetsForSection(cs, {
    angleMode: 'manual',
    manualMarks: marksFromAngles(cs, [45, 15, 6]),
  });

  it('least-foam opens the first gap past 45°, and pays for it at the corner', () => {
    const least = fit(3, 'least-foam', cs);
    expect(anglesOf(least)[0]!).toBeLessThan(45);
    expect(worstAtRail(least)).toBeGreaterThan(worstAtRail(manual45));
  });

  it('and it is still the unconstrained minimum on area, which is what it is for', () => {
    const least = fit(3, 'least-foam', cs);
    expect(least.leftover.deck.areaCm2).toBeLessThanOrEqual(
      manual45.leftover.deck.areaCm2 + 1e-9,
    );
  });
});

describe('the angles are usable numbers', () => {
  for (const mode of ['least-foam'] as const) {
    it(`${mode}: on the half-degree grid, decreasing, spaced, above the floor`, () => {
      const angles = anglesOf(fit(4, mode));
      expect(angles).toHaveLength(4);
      for (const a of angles) {
        expect(Math.abs(a * 2 - Math.round(a * 2))).toBeLessThan(1e-9);
        expect(a).toBeGreaterThanOrEqual(3);
        expect(a).toBeLessThan(90);
      }
      for (let i = 1; i < angles.length; i++) {
        expect(angles[i - 1]! - angles[i]!).toBeGreaterThanOrEqual(4 - 1e-9);
      }
    });
  }

  it('honours an explicit ladder over any fit', () => {
    const st = railFacetsForSection(circleRailSection(W, R), {
      deckAngles: [50, 20, 8],
      angleMode: 'least-foam',
    });
    expect(anglesOf(st)).toEqual([50, 20, 8]);
  });

  it('still offers the halving ladder unchanged', () => {
    expect(anglesOf(fit(3, 'ladder'))).toEqual([45, 22.5, 11.25]);
  });
});

describe('more bands always leave less foam', () => {
  for (const mode of ['least-foam'] as const) {
    it(`${mode}: strictly decreasing leftover, 1..${MAX_BANDS} bands`, () => {
      let prev = Infinity;
      for (let n = 1; n <= MAX_BANDS; n++) {
        const area = fit(n, mode).leftover.deck.areaCm2;
        expect(area).toBeLessThan(prev);
        prev = area;
      }
    });
  }

  it('prices the halving ladder too, so the two can be compared honestly', () => {
    // A dialog showing the fitted placement's numbers next to a ladder the user chose
    // would be describing a board they are not going to cut.
    const ladder = railBandTradeoff(circleRailSection(W, R), { angleMode: 'ladder' });
    const fitted = railBandTradeoff(circleRailSection(W, R), { angleMode: 'least-foam' });
    expect(ladder).toHaveLength(MAX_BANDS);
    // At one band they agree — the ladder's 45° is also where the constrained optimum
    // puts it. From the second band on, the ladder falls behind and keeps falling.
    expect(ladder[0]!.removed).toBeCloseTo(fitted[0]!.removed, 6);
    for (let i = 1; i < MAX_BANDS; i++) {
      expect(ladder[i]!.removed).toBeLessThan(fitted[i]!.removed);
    }
    // and it is the actual ladder being priced, not a fit that happens to be near it
    const three = railFacetsForSection(circleRailSection(W, R), {
      deckBands: 3,
      angleMode: 'ladder',
    });
    expect(three.leftover.deck.removed).toBeCloseTo(ladder[2]!.removed, 2);
  });

  it('reports the whole curve at once, so a shaper can see the returns die', () => {
    const curve = railBandTradeoff(circleRailSection(W, R), { angleMode: 'least-foam' });
    expect(curve).toHaveLength(MAX_BANDS);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.removed).toBeGreaterThan(curve[i - 1]!.removed);
      expect(curve[i]!.areaCm2).toBeLessThan(curve[i - 1]!.areaCm2);
    }
    expect(curve[0]!.bands).toBe(1);
    expect(curve[curve.length - 1]!.removed).toBeLessThanOrEqual(1);
  });
});

describe('sliding a facet clear of the shape', () => {
  // A deck facet runs inboard, so its direction is (-cos ν, sin ν): at ν = 0 that is
  // (-1, 0) and the outward side is up.
  it('leaves a tangent that already clears everything alone', () => {
    const line = { p: vec2(0, 1), d: vec2(-1, 0) };
    const pts = [vec2(-1, 0), vec2(0, 1), vec2(1, 0)];
    expect(clearOf(line, pts).line.p).toEqual(line.p);
  });

  it('slides out to the worst offender, keeping the angle', () => {
    const line = { p: vec2(0, 1), d: vec2(-1, 0) };
    const pts = [vec2(-1, 0), vec2(0, 1), vec2(2, 1.5), vec2(3, 1.2)];
    const cleared = clearOf(line, pts);
    expect(cleared.line.p).toEqual(vec2(2, 1.5));
    expect(cleared.line.d).toEqual(line.d);
    expect(cleared.touch).toEqual(vec2(2, 1.5));
  });
});

describe('measuring the leftover', () => {
  it('agrees with a plain shoelace on a triangle', () => {
    // cut path across the top of a unit right triangle, section along its hypotenuse
    const section = [vec2(0, 1), vec2(0.5, 0.5), vec2(1, 0)];
    const cut = [vec2(0, 1), vec2(1, 1), vec2(1, 0)];
    const m = measureLeftover(cut, cut, section);
    expect(m.areaCm2).toBeCloseTo(0.5, 9);
    expect(m.removed).toBeCloseTo(0, 9);
    // the hypotenuse's midpoint is half a unit off both legs of the corner
    expect(m.worstDepth).toBeCloseTo(0.5, 9);
  });

  it('reports removing everything when the cut follows the section', () => {
    const section = [vec2(0, 1), vec2(0.5, 0.5), vec2(1, 0)];
    const m = measureLeftover(section, [vec2(0, 1), vec2(1, 1), vec2(1, 0)], section);
    expect(m.areaCm2).toBeCloseTo(0, 9);
    expect(m.removed).toBeCloseTo(1, 9);
    expect(m.worstDepth).toBeCloseTo(0, 9);
  });
});


describe('manual marks, the way a shaper pencils them', () => {
  const cs = circleRailSection(W, R);
  // 8 cm up a 12 cm blank is a 66.7% rail
  const marks = { railPercent: (8 / (2 * R)) * 100, deckIn: [4, 9, 14] } as const;
  const st = railFacetsForSection(cs, { angleMode: 'manual', manualMarks: marks });

  it('prints back exactly the numbers it was given', () => {
    // The whole point of a manual mode: a mark the shaper did not type has no business
    // on the sheet.
    const railMark = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!;
    expect(railMark.distance).toBeCloseTo(8, 9);
    st.deckFacets.forEach((f, i) => {
      const deck = f.marks.find((m) => m.ref.kind === 'deckPlane')!;
      expect(deck.distance).toBeCloseTo(marks.deckIn[i]!, 9);
    });
  });

  it('starts each later band at the midpoint of the one before it', () => {
    // Greenlight's rule, and the reason one new number per band is enough: by the time
    // band 2 is marked, band 1 is a flat face whose middle can be found by eye.
    for (let i = 1; i < st.deckFacets.length; i++) {
      const prev = st.deckFacets[i - 1]!;
      const mid = vec2((prev.cutFrom.x + prev.cutTo.x) / 2, (prev.cutFrom.y + prev.cutTo.y) / 2);
      expect(st.deckFacets[i]!.cutFrom.x).toBeCloseTo(mid.x, 9);
      expect(st.deckFacets[i]!.cutFrom.y).toBeCloseTo(mid.y, 9);
    }
  });

  it('band 1 runs from the rail mark to the deck mark, and nowhere else', () => {
    const f = st.deckFacets[0]!;
    expect(f.cutFrom.x).toBeCloseTo(W, 9);
    expect(f.cutFrom.y).toBeCloseTo(8, 9);
    expect(f.cutTo.x).toBeCloseTo(W - marks.deckIn[0]!, 9);
    expect(f.cutTo.y).toBeCloseTo(2 * R, 9);
  });

  it('reproduces the tangent construction when given the tangent’s own marks', () => {
    // Transcribing a fitted sheet back onto a blank must land the same first band.
    const fitted = railFacetsForSection(cs, { deckAngles: [45] });
    const back = railFacetsForSection(cs, {
      angleMode: 'manual',
      manualMarks: marksFromAngles(cs, [45]),
    });
    expect(back.deckFacets[0]!.angle).toBeCloseTo(fitted.deckFacets[0]!.angle, 3);
    expect(back.deckFacets[0]!.cutsInside).toBeUndefined();
    expect(back.warnings.some((w) => w.code === 'cuts-inside')).toBe(false);
  });

  it('measures a band that cuts into the rail instead of quietly moving it', () => {
    // Marks pulled deliberately deep: the facet stays exactly where it was told to go,
    // and the damage is reported.
    const deep = railFacetsForSection(cs, {
      angleMode: 'manual',
      manualMarks: { railPercent: 25, deckIn: [3] },
    });
    const f = deep.deckFacets[0]!;
    expect(f.cutFrom.y).toBeCloseTo(3, 9); // 25% of a 12 cm blank; not nudged
    expect(deep.warnings.some((w) => w.code === 'cuts-inside')).toBe(true);
    expect(f.cutsInside).toBeGreaterThan(0.01);

    // and the depth agrees with an independent measure of the same thing
    const out = vec2(Math.sin((f.angle * Math.PI) / 180), Math.cos((f.angle * Math.PI) / 180));
    let worst = 0;
    for (let i = 0; i <= 800; i++) {
      const q = pointByTT(cs.spline, i / 800);
      worst = Math.max(worst, (q.x - f.cutFrom.x) * out.x + (q.y - f.cutFrom.y) * out.y);
    }
    expect(f.cutsInside!).toBeCloseTo(worst, 2);
  });

  it('refuses marks that run backwards rather than drawing them', () => {
    const bad = railFacetsForSection(cs, {
      angleMode: 'manual',
      manualMarks: { railPercent: 66.7, deckIn: [9, 4] },
    });
    expect(bad.warnings.some((w) => w.code === 'facet-inverted')).toBe(true);
    expect(bad.deckFacets).toHaveLength(1);
  });

  it('builds the tuck from its two marks', () => {
    const t = railFacetsForSection(cs, {
      angleMode: 'manual',
      manualMarks: { railPercent: 66.7, deckIn: [4], tuckUp: 1.27, tuckIn: 2.22 },
    }).bottomFacets[0]!;
    expect(t.marks.find((m) => m.ref.kind === 'railPlane')!.distance).toBeCloseTo(1.27, 9);
    expect(t.marks.find((m) => m.ref.kind === 'bottomPlane')!.distance).toBeCloseTo(2.22, 9);
  });
});

describe('marks travelling down the board', () => {
  const board = ((): BezierBoard =>
    parseBrdGeometry(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../docs/specs/golden/shortboard.brd',
        ),
        'utf8',
      ),
    ))();

  const plan = railFacetPlan(board, {
    deckBands: 2,
    angleMode: 'manual',
    manual: { by: 'distance', railPercent: 60, deckInCm: [2.5, 5.5] },
  });

  it('keeps the rail mark at the percentage of thickness it was given', () => {
    // A 60/40 rail is 60% at every station, which is what makes one number work for a
    // whole board — Greenlight's "1 5/8 inch at 2 1/2 thick reduces to 1 inch at 1 5/8".
    expect(plan.stations.length).toBeGreaterThan(2);
    for (const st of plan.stations) {
      const railUp = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!.distance;
      expect(railUp / st.blank.thickness).toBeCloseTo(0.6, 6);
    }
  });

  it('scales the deck marks with thickness, which holds the angle', () => {
    // The corner being cut is a triangle whose height is the thickness, so scaling both
    // marks with it keeps the band angle roughly constant as the foil thins.
    const angles = plan.stations.map((st) => st.deckFacets[0]!.angle);
    const spread = Math.max(...angles) - Math.min(...angles);
    expect(spread).toBeLessThan(6);
  });

  it('varies the rail percentage toward a tip when asked', () => {
    const tapered = railFacetPlan(board, {
      deckBands: 2,
      angleMode: 'manual',
      manual: { by: 'distance', railPercent: 60, railPercentTail: 45, deckInCm: [2.5, 5.5] },
    });
    const pct = (st: RailStationFacets): number =>
      st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!.distance /
      st.blank.thickness;
    expect(pct(tapered.stations[0]!)).toBeCloseTo(0.45, 3);
    expect(pct(tapered.stations[tapered.stations.length - 1]!)).toBeCloseTo(0.6, 3);
  });

  it('takes explicit angles straight through when asked by angle', () => {
    const byAngle = railFacetPlan(board, {
      deckBands: 3,
      angleMode: 'manual',
      manual: { by: 'angle', angles: [50, 20, 8] },
    });
    for (const st of byAngle.stations) {
      expect(st.deckFacets.map((f) => f.targetAngle)).toEqual([50, 20, 8]);
    }
  });
});

describe('real boards', () => {
  const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
  const load = (name: string): BezierBoard =>
    parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

  for (const name of ['shortboard', 'funboard', 'longboard']) {
    describe(name, () => {
      const board = load(name);
      const plan = (mode: RailAngleMode) =>
        railFacetPlan(board, { deckBands: 3, bottomAngle: 30, angleMode: mode });

      it('beats the halving ladder on foam left AND on the worst spot', () => {
        // Station by station. Both directions matter: removing more foam by leaving a
        // deeper spot behind would be no gain at all.
        const fitted = plan('least-foam').stations;
        const lad = plan('ladder').stations;
        expect(fitted.length).toBe(lad.length);
        for (let i = 0; i < fitted.length; i++) {
          expect(fitted[i]!.leftover.deck.areaCm2).toBeLessThan(lad[i]!.leftover.deck.areaCm2);
          expect(fitted[i]!.leftover.deck.worstDepth).toBeLessThan(
            lad[i]!.leftover.deck.worstDepth,
          );
        }
      });

      it('solves every band from the section, with nothing preset', () => {
        // The property that would be lost if a floor or a default ever crept back in.
        // Under the old `balanced` mode band 1 read 45° at every station on every board;
        // it cannot now, because nothing pins it.
        const sts = plan('least-foam').stations;
        expect(sts.length).toBeGreaterThan(2);
        for (let b = 0; b < 3; b++) {
          const angles = sts.map((st) => st.deckFacets[b]?.targetAngle);
          expect(new Set(angles).size).toBeGreaterThan(1);
        }
        // and no station's set is the ladder wearing a different name
        for (const st of sts) {
          expect(anglesOf(st)).not.toEqual(bisectionLadder(st.deckFacets.length));
        }
      });

      it('opens the rail corner doing it, which is the known cost', () => {
        // Stated rather than prevented. A shaper who wants the corner held sets band 1
        // themselves in manual mode; see the `holding the rail corner` block above.
        const least = plan('least-foam').stations;
        const lad = plan('ladder').stations;
        let opened = 0;
        for (let i = 0; i < least.length; i++) {
          if (worstAtRail(least[i]!) > worstAtRail(lad[i]!)) opened++;
        }
        expect(opened).toBeGreaterThan(least.length / 2);
      });

      it('removes most of the proud foam with three passes', () => {
        for (const st of plan('least-foam').stations) {
          expect(st.leftover.deck.removed).toBeGreaterThan(0.85);
        }
      });

      it('still never cuts a facet inside the shape it is meant to leave', () => {
        // The module's whole reason for existing, re-asserted for the fitted angles —
        // which reach into deck crown, where a real board is not quite convex.
        for (const mode of ['least-foam', 'ladder'] as const) {
          for (const st of plan(mode).stations) {
            for (const f of [...st.deckFacets, ...st.bottomFacets]) {
              const nu = ((f.side === 'deck' ? f.angle : 180 - f.angle) * Math.PI) / 180;
              const out = vec2(Math.sin(nu), Math.cos(nu));
              let worst = -Infinity;
              for (let i = 0; i <= 800; i++) {
                const q = pointByTT(st.section.spline, i / 800);
                worst = Math.max(worst, (q.x - f.touch.x) * out.x + (q.y - f.touch.y) * out.y);
              }
              expect(worst).toBeLessThan(1e-3);
            }
          }
        }
      });
    });
  }
});
