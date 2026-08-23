// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Do the rail-band numbers describe the BOARD, or the way its curves happen to be drawn?
 *
 * A station between two cross-sections has to get its section from somewhere. The
 * obvious source, `getInterpolatedCrossSection`, blends the two neighbours' control
 * points — and pairs their knots by array index, so tangent handles get lerped between
 * knots that sit at unrelated places on the profile. `loft.ts` documents why that puts a
 * near-cusp in the blended curve that neither station has, and why no amount of sampling
 * removes it: the curve itself is malformed.
 *
 * The mesh and the STL were moved off that blend. The rail-band sheet was not, and it is
 * the caller with the least tolerance for invented curvature, because it does not merely
 * DRAW the section — it fits a facet to the point where the section's own slope reaches
 * an angle. A curve that bends where the board does not therefore does not blur a
 * printed number, it fabricates one. Measured on a longboard carrying a different rail
 * preset at each station, the first band came out
 *
 *     26.0  27.0  25.5  23.0  17.0  65.5  41.5  21.5  17.5   degrees
 *
 * on a rail whose fitted angle actually walks 24.0 -> 17.5 the whole way down, with
 * `unvalidated-bottom` warned at four stations whose bottoms are perfectly ordinary.
 * A shaper reads consecutive stations against each other to judge whether a number looks
 * right; a 65.5 next to a 17.0 is not a small error, it is a template that cannot be
 * used.
 *
 * These tests pin the property rather than the numbers: the bands must depend on the
 * surface and on nothing else about how it is described.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arcLengthTable, pointAtArcFraction, splineFromKnots } from './bezier-spline';
import { crossSection } from './cross-section';
import { loftCrossSection, loftPoint, loftSection } from './loft';
import { railFacetPlan, railFacetsAt, railFacetStations } from './rail-facets';
import { applyRailProfile, RAIL_PRESETS } from './rail-profile';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { reslice } from './test-support/reslice';
import type { BezierBoard } from './board';
import type { RailStationFacets } from './rail-facets';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = ['shortboard.brd', 'funboard.brd', 'longboard.brd'] as const;
const golden = (file: string): BezierBoard =>
  parseBrdGeometry(readFileSync(resolve(here, `../../../docs/specs/golden/${file}`), 'utf8'));

/** Give every station its own rail, cycling `ids`. */
const rails = (b: BezierBoard, ids: readonly string[]): BezierBoard => {
  const list = [...b.crossSections];
  for (let i = 1; i < list.length - 1; i++) {
    const preset = RAIL_PRESETS.find((p) => p.id === ids[i % ids.length]!)!;
    list[i] = applyRailProfile(list[i]!, preset.params);
  }
  return { ...b, crossSections: list };
};

/**
 * Every station a different rail — full in the middle, tucked toward the tips — the way
 * a shaper actually foils one, and the case the stock golden boards do not cover: they
 * carry the same profile at every station, so a blend has next to nothing to get wrong.
 *
 * All five are round-bottomed on purpose. `knifey` and `pinched` have a genuinely hard
 * bottom edge, which `unvalidated-bottom` is right to warn about — including them would
 * make the crease test unable to tell a real edge from an invented one.
 */
const mixedRails = (b: BezierBoard): BezierBoard =>
  rails(b, ['50-50-soft', 'egg', '60-40-tucked', '70-30-tucked', 'boxy']);

/**
 * The same idea with the hard rails left in — a tail that is knifey and pinched under a
 * boxy middle, which is a real foil and not a torture test.
 *
 * This is the board the numbers in this file's header were measured on. Its bottoms are
 * genuinely hard in places, so it is no use to the crease test; it is the one that makes
 * the angle sequence fall apart, so it is the right board for the one below.
 */
const hardRails = (b: BezierBoard): BezierBoard =>
  rails(b, ['80-20-hard', '50-50-soft', 'pinched', 'boxy', 'knifey', 'egg']);

const OPTS = { deckBands: 3, bottomAngle: 30 } as const;

/** Every number a station prints, flattened — what a shaper would read off the sheet. */
const printed = (st: RailStationFacets): number[] => [
  st.halfWidth,
  st.apex.x,
  st.apex.y,
  st.blank.deckY,
  st.blank.bottomY,
  st.blank.railX,
  st.blank.thickness,
  st.residualSideHeight,
  ...[...st.deckFacets, ...st.bottomFacets].flatMap((f) => [
    f.angle,
    f.touch.x,
    f.touch.y,
    f.cutFrom.x,
    f.cutFrom.y,
    f.cutTo.x,
    f.cutTo.y,
    f.width,
    f.step,
    ...f.marks.map((m) => m.distance),
  ]),
];

describe('rail bands describe the surface, not the curve description', () => {
  /**
   * Re-slicing a station inserts a knot by exact de Casteljau split: the spline traces
   * the IDENTICAL curve, in one more piece. Nothing about the board has changed, so
   * nothing a shaper is handed may change either.
   *
   * This is the sharpest form of the bug. Under the control-point blend an extra knot on
   * one neighbour re-pairs every knot on both, and the blended section — a section of a
   * board nobody edited — moves.
   */
  it.each(GOLDEN)('is unmoved by re-knotting a neighbouring station on %s', (file) => {
    const board = mixedRails(golden(file));
    const real = board.crossSections.length - 2;
    let worst = 0;

    for (let i = 1; i <= real; i++) {
      const list = [...board.crossSections];
      const target = list[i]!;
      if (target.spline.knots.length < 3) continue;
      // Split two different segments, so the knot count and the pairing both shift.
      list[i] = crossSection(
        target.position,
        splineFromKnots(
          reslice(target.spline.knots, [
            { seg: 0, t: 0.37 },
            { seg: 1, t: 0.61 },
          ]),
        ),
      );
      const resliced: BezierBoard = { ...board, crossSections: list };

      for (const x of railFacetStations(board)) {
        const before = railFacetsAt(board, x, OPTS);
        const after = railFacetsAt(resliced, x, OPTS);
        expect(after === null).toBe(before === null);
        if (!before || !after) continue;
        const a = printed(before);
        const b = printed(after);
        expect(b).toHaveLength(a.length);
        for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(b[k]! - a[k]!));
      }
    }
    // 0.02 mm on a length, 0.002 deg on an angle, against a sheet printed to a tenth of
    // a millimetre — and the residual is not float noise. `arcLengthTable` samples a
    // fixed number of points PER SEGMENT, so a spline cut into more pieces samples the
    // same curve more finely and the polyline the loft reads shifts; worst measured
    // across the three boards is 0.0092 mm. That resolution is the mesh's, shared here
    // on purpose. What this pins is that nothing above it survives — the control-point
    // blend moved these same numbers by millimetres.
    expect(worst).toBeLessThan(2e-3);
  });

  /**
   * Band angles walk down the board; they do not jump.
   *
   * A rail is foiled continuously, so consecutive stations ~30 cm apart differ by a few
   * degrees. The threshold is not a taste judgement about how much a rail may change —
   * it is set well above what the fixed path produces (worst measured step 4.5 deg,
   * on the funboard) and well below the 48.5 deg the control-point blend produced
   * between two neighbouring stations of the longboard.
   */
  it.each(GOLDEN)('walks the band angles smoothly down %s', (file) => {
    const board = hardRails(golden(file));
    const plan = railFacetPlan(board, OPTS);
    expect(plan.stations.length).toBeGreaterThan(3);

    for (let band = 0; band < 3; band++) {
      const angles = plan.stations
        .map((st) => st.deckFacets[band]?.angle)
        .filter((a): a is number => a !== undefined);
      expect(angles.length).toBe(plan.stations.length);
      for (let i = 1; i < angles.length; i++) {
        expect(Math.abs(angles[i]! - angles[i - 1]!)).toBeLessThan(10);
      }
    }
  });

  /**
   * The blend must not invent a shape the board does not have.
   *
   * `unvalidated-bottom` fires when the bottom of the rail zone stops being a simple
   * convex turn — a vee, a channel, a hard edge. Every rail on this board is round, so
   * any such warning is a crease the blend put there rather than one the shaper drew.
   * The control-point path raised three on the longboard.
   *
   * That the warning survives at all is `rail-facets.test.ts`'s job — "caveats only the
   * bottoms the method has not been proven on" still finds the genuine hard edges in the
   * stock boards' tails and noses. Silence here means the creases were imaginary, not
   * that the check was blunted.
   */
  it.each(GOLDEN)('invents no creases in the rail zone of %s', (file) => {
    const board = mixedRails(golden(file));
    const codes = railFacetPlan(board, OPTS).warnings.map((w) => w.code);
    expect(codes).not.toContain('unvalidated-bottom');
    expect(codes).not.toContain('non-convex-rail-zone');
  });

  /**
   * The section drawn behind the facets is the surface, not a near miss of it. The sheet
   * prints this curve as the ghost outline the marks are read against, so if it and the
   * 3D view disagreed, the shaper would be checking their cuts against a shape the board
   * does not have.
   */
  it('draws the ghost section on the surface the 3D view shows', () => {
    const board = mixedRails(golden('longboard.brd'));
    for (const x of railFacetStations(board)) {
      const st = railFacetsAt(board, x, OPTS)!;
      const surface = loftSection(board, x)!;
      const table = arcLengthTable(st.section.spline);
      const curve = Array.from({ length: 2001 }, (_, i) => pointAtArcFraction(table, i / 2000));
      for (let i = 0; i <= 200; i++) {
        const p = loftPoint(surface, i / 200);
        let best = Infinity;
        for (const q of curve) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
        expect(best).toBeLessThan(0.01); // 0.1 mm
      }
    }
  });

  it('takes its section straight from the loft', () => {
    const board = mixedRails(golden('funboard.brd'));
    const x = railFacetStations(board)[2]!;
    const st = railFacetsAt(board, x, OPTS)!;
    expect(st.section.spline.knots).toEqual(loftCrossSection(board, x)!.spline.knots);
  });
});
