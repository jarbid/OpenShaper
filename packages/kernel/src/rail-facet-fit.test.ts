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
import { clearOf, measureLeftover, type RailAngleMode } from './rail-facet-fit';
import {
  MAX_BANDS,
  railBandTradeoff,
  railFacetPlan,
  railFacetsForSection,
  type RailStationFacets,
} from './rail-facets';
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

  it('costs nothing to protect the rail here, because the optimum already does', () => {
    // Equal gaps put band 1 at 90n/(n+1), which is ≥ 45° for every n. The `balanced`
    // constraint is therefore inactive on a circle, and the two modes must agree.
    for (const n of [1, 2, 3, 4]) {
      expect(anglesOf(fit(n, 'balanced'))).toEqual(anglesOf(fit(n, 'least-foam')));
    }
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

describe('what the rail constraint is worth', () => {
  // A circle cannot show it — equal gaps put band 1 at 90n/(n+1), which already clears
  // 45°. Nor can a chunky ellipse: the constraint only starts to bind at board-like
  // proportions, where there is enough flat deck for the crown to outbid the rail. This
  // one is 5 cm thick over a 25 cm half-width, which is a real shortboard's midsection.
  const cs = ellipseRailSection(W, 12, 2.5);

  it('least-foam removes more overall by opening the rail gap', () => {
    const bal = fit(3, 'balanced', cs);
    const least = fit(3, 'least-foam', cs);
    // by construction least-foam is the unconstrained minimum
    expect(least.leftover.deck.areaCm2).toBeLessThanOrEqual(bal.leftover.deck.areaCm2 + 1e-9);
    // and it pays for it where it matters
    expect(anglesOf(least)[0]!).toBeLessThan(45);
    expect(anglesOf(bal)[0]!).toBeGreaterThanOrEqual(45);
    // the constraint costs area, but not much of it
    expect(bal.leftover.deck.areaCm2).toBeLessThan(least.leftover.deck.areaCm2 * 1.5);
  });

  it('and the corner it opens is the whole reason to constrain it', () => {
    expect(worstAtRail(fit(3, 'least-foam', cs))).toBeGreaterThan(
      worstAtRail(fit(3, 'balanced', cs)),
    );
  });
});

describe('the angles are usable numbers', () => {
  for (const mode of ['balanced', 'least-foam'] as const) {
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
      angleMode: 'balanced',
    });
    expect(anglesOf(st)).toEqual([50, 20, 8]);
  });

  it('still offers the halving ladder unchanged', () => {
    expect(anglesOf(fit(3, 'ladder'))).toEqual([45, 22.5, 11.25]);
  });
});

describe('more bands always leave less foam', () => {
  for (const mode of ['balanced', 'least-foam'] as const) {
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
    const balanced = railBandTradeoff(circleRailSection(W, R), { angleMode: 'balanced' });
    expect(ladder).toHaveLength(MAX_BANDS);
    // At one band they agree — the ladder's 45° is also where the constrained optimum
    // puts it. From the second band on, the ladder falls behind and keeps falling.
    expect(ladder[0]!.removed).toBeCloseTo(balanced[0]!.removed, 6);
    for (let i = 1; i < MAX_BANDS; i++) {
      expect(ladder[i]!.removed).toBeLessThan(balanced[i]!.removed);
    }
    // and it is the actual ladder being priced, not a fit that happens to be near it
    const three = railFacetsForSection(circleRailSection(W, R), {
      deckBands: 3,
      angleMode: 'ladder',
    });
    expect(three.leftover.deck.removed).toBeCloseTo(ladder[2]!.removed, 2);
  });

  it('reports the whole curve at once, so a shaper can see the returns die', () => {
    const curve = railBandTradeoff(circleRailSection(W, R), { angleMode: 'balanced' });
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
        // The claim the default rests on, station by station. Both directions matter:
        // removing more foam by leaving the rail coarser is exactly the trade `balanced`
        // exists to refuse.
        const bal = plan('balanced').stations;
        const lad = plan('ladder').stations;
        expect(bal.length).toBe(lad.length);
        for (let i = 0; i < bal.length; i++) {
          expect(bal[i]!.leftover.deck.areaCm2).toBeLessThan(lad[i]!.leftover.deck.areaCm2);
          expect(bal[i]!.leftover.deck.worstDepth).toBeLessThan(lad[i]!.leftover.deck.worstDepth);
        }
      });

      it('never opens the rail gap wider than the ladder does', () => {
        // Band 1 at 45° or steeper is the constraint; it is what keeps the rail turn from
        // being spent on deck crown.
        for (const st of plan('balanced').stations) {
          expect(st.deckFacets[0]!.targetAngle).toBeGreaterThanOrEqual(45);
        }
      });

      it('leaves the rail corner exactly where the ladder leaves it', () => {
        // Not "close to" — identical. Both pin band 1 at 45°, so the corner is untouched
        // by the change and every gain shows up further in.
        const bal = plan('balanced').stations;
        const lad = plan('ladder').stations;
        for (let i = 0; i < bal.length; i++) {
          expect(worstAtRail(bal[i]!)).toBeCloseTo(worstAtRail(lad[i]!), 6);
        }
      });

      it('unconstrained least-foam leaves the corner proud, which is why it is not the default', () => {
        const bal = plan('balanced').stations;
        const least = plan('least-foam').stations;
        for (let i = 0; i < bal.length; i++) {
          expect(anglesOf(least[i]!)[0]!).toBeLessThan(45);
          expect(worstAtRail(least[i]!)).toBeGreaterThan(worstAtRail(bal[i]!));
        }
      });

      it('removes most of the proud foam with three passes', () => {
        for (const st of plan('balanced').stations) {
          expect(st.leftover.deck.removed).toBeGreaterThan(0.85);
        }
      });

      it('still never cuts a facet inside the shape it is meant to leave', () => {
        // The module's whole reason for existing, re-asserted for the fitted angles —
        // which reach into deck crown, where a real board is not quite convex.
        for (const mode of ['balanced', 'least-foam', 'ladder'] as const) {
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
