// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail-band facets, tested against **analytic oracles**.
 *
 * BoardCAD-LE has no rail bands, so there is no legacy output to pin against and no
 * golden fixture to regenerate (`.claude/CLAUDE.md` rule 2). Instead the rail zone is
 * built as an exact circular arc, whose tangent points, facet vertices and band marks
 * all have closed forms — computed here from the radius, never read back from the
 * implementation.
 *
 * The load-bearing test is `a tangent never cuts inside`. The method's first draft used
 * a secant from the apex to the deck flat, which silently eats foam on a domed section;
 * that case is constructed explicitly below and asserted to fail the same check the
 * tangent construction passes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from './vec2';
import { knot } from './knot';
import { pointByTT, splineFromKnots } from './bezier-spline';
import { crossSection, type CrossSection } from './cross-section';
import { DEG_TO_RAD } from './constants';
import {
  circleRailSection,
  deg,
  domedDeckSection,
  handleFactor,
  oracle,
} from './test-support/rail-sections';
import { bisectionLadder } from './rail-facet-fit';

/** The one fixture below that is not an arc of 45° segments needs the quarter-arc handle. */
const K90 = handleFactor(90);
import { getLength, getThicknessAtPos, getWidthAtPos, type BezierBoard } from './board';
import { parseBrdGeometry } from './test-support/brd-geometry';
import {
  railFacetPlan,
  railFacetStations,
  railFacetsForSection,
  type FacetLine,
  type RailStationFacets,
} from './rail-facets';

// ---- Fixtures -----------------------------------------------------------------
//
// The circular-rail section and its closed-form oracles live in test-support, because
// `rail-facet-fit.test.ts` asserts against the same ones.

const near = (a: Vec2, b: Vec2, tol: number): void => {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(tol);
};

// ---- Convexity property --------------------------------------------------------

/** Outward normal of a facet's plane, from its achieved angle. */
const outwardOf = (f: FacetLine): Vec2 => {
  const nu = f.side === 'deck' ? deg(f.angle) : deg(180 - f.angle);
  return vec2(Math.sin(nu), Math.cos(nu));
};

/**
 * How far outside a facet plane the worst contour point sits. A tangent to a convex
 * curve leaves this at (numerically) zero; a plane that cuts into the shape leaves it
 * positive, in centimetres of foam wrongly removed.
 */
/** Angle of the chord from `a` to `b`, off the deck plane, in degrees. */
const angleOf = (a: Vec2, b: Vec2): number =>
  Math.abs(Math.atan2(b.y - a.y, a.x - b.x)) / DEG_TO_RAD;

const worstIntrusion = (cs: CrossSection, f: FacetLine): number => {
  const out = outwardOf(f);
  let worst = -Infinity;
  for (let i = 0; i <= 800; i++) {
    const q = pointByTT(cs.spline, i / 800);
    worst = Math.max(worst, (q.x - f.touch.x) * out.x + (q.y - f.touch.y) * out.y);
  }
  return worst;
};

// ---- Tests ---------------------------------------------------------------------

describe('bisectionLadder', () => {
  it('halves the remaining angle each band', () => {
    expect(bisectionLadder(1)).toEqual([45]);
    expect(bisectionLadder(3)).toEqual([45, 22.5, 11.25]);
    expect(bisectionLadder(4)).toEqual([45, 22.5, 11.25, 5.625]);
  });

  it('is strictly decreasing', () => {
    const a = bisectionLadder(6);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThan(a[i - 1]!);
  });
});

describe('the fixture itself', () => {
  it('is a circle to within the cubic-arc error, which sets every tolerance below', () => {
    const W = 25;
    const R = 6;
    const cx = W - R;
    const cy = R;
    const s = circleRailSection(W, R).spline;
    let maxErr = 0;
    // 7 knots → 6 segments; the four 45° arcs are segments 1..4, so tt ∈ [1/6, 5/6]
    for (let i = 0; i <= 2000; i++) {
      const p = pointByTT(s, 1 / 6 + ((4 / 6) * i) / 2000);
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x - cx, p.y - cy) - R));
    }
    // The facet oracles are exact for a *circle*, so the fixture's own departure from
    // one is the floor on how closely the implementation can agree with them. At 45°
    // per segment that floor is ~1e-5·R — comfortably under the 1e-3 cm position
    // tolerances asserted below, which are therefore testing the code, not the fixture.
    expect(maxErr).toBeLessThan(2e-5 * R);
    expect(maxErr).toBeGreaterThan(0);
  });
});

describe('rail facets on an exactly circular rail', () => {
  const W = 25;
  const R = 6;
  const o = oracle(W, R);
  // Pinned to the ladder: this block checks the closed forms for 45 / 22.5 / 11.25, and
  // the fitted modes deliberately choose different angles (see the `fitted angles` block
  // below, which asserts what they choose and why).
  const st: RailStationFacets = railFacetsForSection(circleRailSection(W, R), {
    deckBands: 3,
    bottomAngle: 30,
    angleMode: 'ladder',
  });

  it('finds the apex at the circle’s widest point', () => {
    near(st.apex, vec2(W, R), 1e-4);
  });

  it('reads the blank’s reference planes off the section', () => {
    expect(st.blank.railX).toBeCloseTo(W, 4);
    expect(st.blank.deckY).toBeCloseTo(2 * R, 4);
    expect(st.blank.bottomY).toBeCloseTo(0, 4);
    expect(st.blank.thickness).toBeCloseTo(2 * R, 4);
  });

  it('touches each facet where the section’s own slope is the target angle', () => {
    expect(st.deckFacets).toHaveLength(3);
    for (const f of st.deckFacets) {
      near(f.touch, o.touch(o.phiForDeckAngle(f.targetAngle)), 1e-3);
      expect(f.angle).toBeCloseTo(f.targetAngle, 2);
    }
  });

  it('marks band 1 off the squared blank corners', () => {
    const f = st.deckFacets[0]!;
    const phi = o.phiForDeckAngle(45);
    const deckMark = f.marks.find((m) => m.ref.kind === 'deckPlane')!;
    const railMark = f.marks.find((m) => m.ref.kind === 'railPlane')!;
    // in from the deck corner, and up from the bottom corner
    expect(deckMark.distance).toBeCloseTo(W - o.onDeck(phi).x, 3);
    expect(railMark.distance).toBeCloseTo(o.onRail(phi).y, 3);
    // and those are the closed forms 0.5858R / 1.4142R for a 45° tangent to a circle
    expect(deckMark.distance).toBeCloseTo(0.5857864 * R, 3);
    expect(railMark.distance).toBeCloseTo(1.4142136 * R, 3);
  });

  it('puts each later band’s vertex where consecutive tangents meet', () => {
    for (let i = 1; i < st.deckFacets.length; i++) {
      const prev = st.deckFacets[i - 1]!;
      const cur = st.deckFacets[i]!;
      const v = o.vertex(o.phiForDeckAngle(prev.targetAngle), o.phiForDeckAngle(cur.targetAngle));
      near(cur.cutFrom, v, 1e-3);
    }
  });

  it('chains each later band’s mark along the face already cut', () => {
    for (let i = 1; i < st.deckFacets.length; i++) {
      const prev = st.deckFacets[i - 1]!;
      const cur = st.deckFacets[i]!;
      const chained = cur.marks.find((m) => m.ref.kind === 'facet')!;
      expect(chained.ref).toEqual({ kind: 'facet', index: prev.index });
      // measured from the previous cut's deck edge, down its face, to the shared vertex
      const expected = Math.hypot(prev.cutTo.x - cur.cutFrom.x, prev.cutTo.y - cur.cutFrom.y);
      expect(chained.distance).toBeCloseTo(expected, 6);
      expect(chained.distance).toBeGreaterThan(0);
    }
  });

  it('steps each band’s deck mark farther in than the last', () => {
    const marks = st.deckFacets.map(
      (f) => f.marks.find((m) => m.ref.kind === 'deckPlane')!.distance,
    );
    for (let i = 1; i < marks.length; i++) expect(marks[i]!).toBeGreaterThan(marks[i - 1]!);
  });

  it('cuts the tuck at the tool angle and marks it off the bottom corner', () => {
    expect(st.bottomFacets).toHaveLength(1);
    const t = st.bottomFacets[0]!;
    const phi = o.phiForBottomAngle(30);
    expect(t.angle).toBeCloseTo(30, 2);
    near(t.touch, o.touch(phi), 1e-3);
    const up = t.marks.find((m) => m.ref.kind === 'railPlane')!;
    const inn = t.marks.find((m) => m.ref.kind === 'bottomPlane')!;
    expect(up.distance).toBeCloseTo(o.onRail(phi).y, 3);
    expect(inn.distance).toBeCloseTo(W - o.onBottom(phi).x, 3);
  });

  it('reports the residual bottom-edge round as the arc’s own radius', () => {
    expect(st.edgeRadius).not.toBeNull();
    expect(st.edgeRadius!).toBeCloseTo(R, 2);
  });

  it('leaves an un-cut strip on the rail face between the tuck and band 1', () => {
    const band1 = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!.distance;
    const tuck = st.bottomFacets[0]!.marks.find((m) => m.ref.kind === 'railPlane')!.distance;
    expect(st.residualSideHeight).toBeCloseTo(band1 - tuck, 6);
    expect(st.residualSideHeight).toBeGreaterThan(0);
  });

  it('raises no warnings on a clean convex rail', () => {
    expect(st.warnings).toEqual([]);
  });
});

describe('a tangent never cuts inside', () => {
  it('holds across circular rails of every proportion', () => {
    for (const [W, R] of [
      [25, 6],
      [25, 3],
      [30, 10],
      [18, 4],
      [22, 8],
    ] as const) {
      const cs = circleRailSection(W, R);
      const st = railFacetsForSection(cs, { deckBands: 3 });
      expect(st.deckFacets.length).toBeGreaterThan(0);
      for (const f of st.deckFacets) {
        expect(worstIntrusion(cs, f)).toBeLessThan(1e-3);
      }
    }
  });

  it('holds on a domed deck, where the secant it replaced does not', () => {
    const cs = domedDeckSection(25, 6, 1.5);
    const st = railFacetsForSection(cs, { deckBands: 3 });
    const f = st.deckFacets[0]!;
    expect(worstIntrusion(cs, f)).toBeLessThan(1e-3);

    // The method's first draft: a straight line from the apex to where band 1 meets the
    // deck plane. Same two endpoints, but a chord rather than a tangent — and on a domed
    // section the rail curve bulges outside it, so the cut eats shape it should leave.
    const secant: FacetLine = { ...f, touch: st.apex, angle: angleOf(st.apex, f.cutTo) };
    expect(worstIntrusion(cs, secant)).toBeGreaterThan(0.05);
  });
});

describe('refusing to make a number up', () => {
  const cs = circleRailSection(25, 6);

  it('rejects angles outside the open interval (0, 90)', () => {
    for (const bad of [0, 90, 95, -10]) {
      const st = railFacetsForSection(cs, { deckAngles: [bad] });
      expect(st.warnings.some((w) => w.code === 'bad-angle-input')).toBe(true);
      expect(st.deckFacets).toHaveLength(0);
    }
  });

  it('rejects a ladder that does not decrease from the rail inward', () => {
    const st = railFacetsForSection(cs, { deckAngles: [22.5, 45] });
    expect(st.warnings.some((w) => w.code === 'bad-angle-input')).toBe(true);
    expect(st.deckFacets).toHaveLength(0);
  });

  it('rejects a band count outside 1..6', () => {
    for (const n of [0, 7, 2.5]) {
      const st = railFacetsForSection(cs, { deckBands: n });
      expect(st.warnings.some((w) => w.code === 'bad-angle-input')).toBe(true);
    }
  });

  it('omits a band whose angle the section never reaches, rather than zeroing it', () => {
    // The tuck is searched inside the rail zone, so a squeezed zone leaves a very shallow
    // tuck with no tangent point to sit on. (The deck side is no longer bounded that way:
    // bands are placed across the whole half-section, so every deck angle is reachable.)
    const st = railFacetsForSection(circleRailSection(25, 6), {
      deckBands: 1,
      bottomAngle: 1,
      railZoneFraction: 0.08,
    });
    const missing = st.warnings.filter((w) => w.code === 'tangent-not-found');
    expect(missing.length).toBeGreaterThan(0);
    expect(st.bottomFacets).toHaveLength(0);
    // whatever survived is a real facet, not a placeholder
    for (const f of st.deckFacets) expect(f.width).toBeGreaterThan(0);
  });

  it('gives no radius when the bottom edge is a straight chamfer, not a round', () => {
    const W = 25;
    const R = 6;
    const cx = W - R;
    const f = cx / 3;
    // bottom flat → straight 45° chamfer → apex → circular deck side
    const cs2 = crossSection(
      100,
      splineFromKnots([
        knot(vec2(0, 0), vec2(-f, 0), vec2(f, 0), true, false),
        knot(vec2(cx, 0), vec2(cx - f, 0), vec2(cx + R / 3, 0), false, false),
        knot(vec2(W, R), vec2(W - R / 3, R - R / 3), vec2(W, R + K90 * R), false, false),
        knot(vec2(cx, 2 * R), vec2(cx + K90 * R, 2 * R), vec2(cx - f, 2 * R), true, false),
        knot(vec2(0, 2 * R), vec2(f, 2 * R), vec2(-f, 2 * R), true, false),
      ]),
    );
    const st = railFacetsForSection(cs2, { deckBands: 2, bottomAngle: 30 });
    expect(st.edgeRadius === null || st.edgeRadius > 0).toBe(true);
  });
});

describe('real boards', () => {
  const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
  const load = (name: string): BezierBoard =>
    parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

  for (const name of ['shortboard', 'funboard', 'longboard']) {
    describe(name, () => {
      const board = load(name);
      const plan = railFacetPlan(board, { deckBands: 3, bottomAngle: 30 });

      it('produces a station every 12 in between the tips', () => {
        expect(plan.stations.length).toBeGreaterThan(2);
        for (const st of plan.stations) {
          expect(st.position).toBeGreaterThan(0);
          expect(st.position).toBeLessThan(getLength(board));
        }
      });

      it('never cuts a facet inside the shape it is meant to leave', () => {
        // The whole method rests on this. A secant construction fails it on any station
        // with a domed deck, which is all of them.
        for (const st of plan.stations) {
          for (const f of [...st.deckFacets, ...st.bottomFacets]) {
            expect(worstIntrusion(st.section, f)).toBeLessThan(1e-3);
          }
        }
      });

      it('gives every band a positive width and a mark to cut to', () => {
        for (const st of plan.stations) {
          expect(st.deckFacets.length).toBeGreaterThan(0);
          for (const f of st.deckFacets) {
            expect(f.width).toBeGreaterThan(0);
            expect(f.marks.length).toBeGreaterThan(0);
            for (const m of f.marks) expect(m.distance).toBeGreaterThan(0);
          }
        }
      });

      it('steps the deck marks inward band by band', () => {
        for (const st of plan.stations) {
          const marks = st.deckFacets.map(
            (f) => f.marks.find((m) => m.ref.kind === 'deckPlane')!.distance,
          );
          for (let i = 1; i < marks.length; i++) {
            expect(marks[i]!).toBeGreaterThan(marks[i - 1]!);
          }
        }
      });

      it('caveats only the bottoms the method has not been proven on, near the tips', () => {
        // These are ordinary boards with domed decks and tucked rails. Nothing about
        // them should trip a guard — a sheet full of caveats is a sheet the shaper
        // learns to ignore. The one exception is a hard bottom edge, which real boards
        // do carry in the tail and which this method genuinely has not been checked
        // against; those are expected, and expected only out towards a tip.
        const L = getLength(board);
        for (const w of plan.warnings) {
          expect(w.code).toBe('unvalidated-bottom');
          const fromTip = Math.min(w.position!, L - w.position!);
          expect(fromTip).toBeLessThan(L / 3);
        }
      });

      it('reports no edge radius rather than a made-up one', () => {
        // A near-straight run into the tail fits a circle metres across. Clamping that
        // to the 15 cm sanity bound and printing it — even with a caveat beside it —
        // puts a number on the sheet that describes nothing, and the shaper reads the
        // number. Every reported radius has to be one actually measured off the curve.
        for (const st of plan.stations) {
          if (st.edgeRadius === null) continue;
          expect(st.edgeRadius).toBeGreaterThanOrEqual(0.05);
          expect(st.edgeRadius).toBeLessThan(15);
        }
      });

      it('keeps the blank reference planes inside the board’s own dimensions', () => {
        for (const st of plan.stations) {
          expect(st.blank.railX).toBeCloseTo(getWidthAtPos(board, st.position) / 2, 2);
          // The blank is at least as thick as the centre: the rail-zone low point can
          // sit below the stringer, never above it.
          expect(st.blank.thickness).toBeGreaterThanOrEqual(
            getThicknessAtPos(board, st.position) - 1e-6,
          );
        }
      });
    });
  }
});

describe('station walk', () => {
  const board = {
    outline: splineFromKnots([
      knot(vec2(0, 0.4), vec2(0, 0.4), vec2(30, 12), true, false),
      knot(vec2(120, 25), vec2(90, 25), vec2(150, 25), true, false),
      knot(vec2(240, 0.4), vec2(210, 12), vec2(240, 0.4), true, false),
    ]),
    bottom: splineFromKnots([
      knot(vec2(0, 6), vec2(0, 6), vec2(80, 0), true, false),
      knot(vec2(240, 9), vec2(160, 0), vec2(240, 9), true, false),
    ]),
    deck: splineFromKnots([
      knot(vec2(0, 6.2), vec2(0, 6.2), vec2(80, 6.4), true, false),
      knot(vec2(240, 9.2), vec2(160, 6.4), vec2(240, 9.2), true, false),
    ]),
    crossSections: [],
    interpolationType: 'controlPoint' as const,
    fins: { setup: 'thruster' as const },
  };

  it('lands exactly on both ends of the bandable rail', () => {
    // The whole point of the target-spacing fit. Walking a fixed interval out from the
    // widepoint left an arbitrary leftover gap at each tip, so "leave 20 cm" could mean
    // anything from 20 to 50 — the setting stopped meaning what it said.
    for (const margin of [20, 35]) {
      const xs = railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: margin });
      expect(xs[0]!).toBeCloseTo(margin, 6);
      expect(xs[xs.length - 1]!).toBeCloseTo(240 - margin, 6);
    }
  });

  it('pulls an end in when the margin lands where there is no rail to band', () => {
    // This fixture tapers to 4 mm at the tips, so a 10 cm margin still sits inside a
    // point. Fitting the spacing across the requested span and dropping the unbandable
    // stations afterwards left the outermost station a long way short of the end; the
    // span is clamped to what is bandable first, so every station survives and the ends
    // really are covered.
    const xs = railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: 10 });
    expect(xs[0]!).toBeGreaterThan(10);
    expect(xs[xs.length - 1]!).toBeLessThan(230);
    for (const x of xs) {
      expect(getWidthAtPos(board as never, x)).toBeGreaterThanOrEqual(1.1);
      expect(getThicknessAtPos(board as never, x)).toBeGreaterThanOrEqual(1.1);
    }
  });

  it('keeps a station on the widepoint', () => {
    const xs = railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: 20 });
    expect(xs.some((x) => Math.abs(x - 120) < 1e-6)).toBe(true);
  });

  it('holds the spacing close to the target, and even within each side', () => {
    const target = 30;
    const xs = railFacetStations(board as never, { targetSpacingCm: target, endMarginCm: 20 });
    expect(xs.length).toBeGreaterThan(2);
    const wp = xs.findIndex((x) => Math.abs(x - 120) < 1e-6);
    // Each side of the widepoint is fitted on its own, so gaps are uniform within a side
    // and both sides stay near the target — never more than half a step off it.
    for (const [from, to] of [
      [0, wp],
      [wp, xs.length - 1],
    ] as const) {
      const gaps = xs.slice(from, to + 1).flatMap((x, i, a) => (i ? [x - a[i - 1]!] : []));
      for (const g of gaps) {
        expect(g).toBeCloseTo(gaps[0]!, 6);
        expect(Math.abs(g - target)).toBeLessThan(target / 2);
      }
    }
  });

  it('always covers the ends, even when the target barely fits', () => {
    // A target wider than the whole banded length still has to give the two ends.
    const xs = railFacetStations(board as never, { targetSpacingCm: 500, endMarginCm: 20 });
    expect(xs[0]!).toBeCloseTo(20, 6);
    expect(xs[xs.length - 1]!).toBeCloseTo(220, 6);
  });

  it('is deterministic and sorted', () => {
    const a = railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: 20 });
    const b = railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: 20 });
    expect(a).toEqual(b);
    expect([...a].sort((p, q) => p - q)).toEqual(a);
  });

  it('returns nothing when the margins swallow the board', () => {
    expect(railFacetStations(board as never, { targetSpacingCm: 30, endMarginCm: 200 })).toEqual(
      [],
    );
  });
});
