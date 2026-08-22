// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The cross-sections the DXF and the 1:1 PDF draw must be the board's actual surface.
 *
 * These are cut files. A 1:1 template is printed, pinned to a blank and cut against, so a
 * section curve that disagrees with the model it was exported from is worse than no
 * template at all — the builder has no way to tell. Until 2026-08-22 they came off
 * `getInterpolatedCrossSection`, whose control-point blend pairs the two neighbouring
 * stations' knots by array index and can put curvature in a section that neither station
 * has; `loft.ts` has the account. They now come off `loftCrossSection`, the same surface
 * the 3D view and the STL are built from.
 *
 * The first two tests are identities rather than tolerances, deliberately. How far apart
 * the two models land depends entirely on the board — on a fixture whose stations happen
 * to be similar the difference is microns, so a tolerance test would quietly stop
 * guarding anything. Which curve was asked for does not depend on the board.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRailProfile,
  crossSection,
  loftCrossSection,
  loftPoint,
  loftSection,
  pointByTT,
  RAIL_PRESETS,
  type BezierBoard,
} from '@openshaper/kernel';
import { crossSectionBeziers, crossSectionRing, type Pt } from './board-curves';
import { makeTestBoard } from './fixture.test-helper';

/**
 * The shared test board, refoiled: four real stations, each with a different rail.
 *
 * `makeTestBoard` carries a single real station, so every interpolation on it collapses
 * to that one profile and no blend ever happens. A hard tail running to a full nose is
 * both a real foil and the case a blend can get wrong.
 */
const mixedRails = (b: BezierBoard): BezierBoard => {
  const ids = ['80-20-hard', '70-30-tucked', '50-50-soft', 'egg'];
  const middle = b.crossSections[1]!;
  const stations = [20, 40, 60, 80].map((position, i) => {
    const preset = RAIL_PRESETS.find((p) => p.id === ids[i]!)!;
    return crossSection(position, applyRailProfile(middle, preset.params).spline);
  });
  return {
    ...b,
    crossSections: [b.crossSections[0]!, ...stations, b.crossSections[b.crossSections.length - 1]!],
  };
};

/** Closest approach of `p` to a polyline, measured to its segments. */
const nearest = (poly: readonly Pt[], p: Pt): number => {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
};

describe('exported cross-sections trace the lofted surface', () => {
  const board = mixedRails(makeTestBoard());
  const stations = [25, 35, 50, 65, 75];

  it('draws the DXF section as exactly the lofted curve, segment for segment', () => {
    for (const x of stations) {
      const expected = loftCrossSection(board, x)!.spline;
      const segs = crossSectionBeziers(board, x)!;
      // The ring is the mirrored half followed by the half itself.
      const half = segs.slice(segs.length / 2);
      expect(half).toHaveLength(expected.curves.length);
      half.forEach((s, i) => {
        const c = expected.curves[i]!;
        expect(s.p0).toEqual({ x: c.p0.x, y: c.p0.y });
        expect(s.c1).toEqual({ x: c.c1.x, y: c.c1.y });
        expect(s.c2).toEqual({ x: c.c2.x, y: c.c2.y });
        expect(s.p3).toEqual({ x: c.p3.x, y: c.p3.y });
      });
    }
  });

  it('draws the PDF/SVG section ring off the same curve', () => {
    for (const x of stations) {
      const expected = loftCrossSection(board, x)!.spline;
      const steps = 96;
      const ring = crossSectionRing(board, x, steps)!;
      expect(ring).toHaveLength(2 * steps + 2);
      for (let r = 0; r <= steps; r++) {
        const p = pointByTT(expected, r / steps);
        expect(ring[steps + 1 + r]).toEqual({ x: p.x, y: p.y });
        expect(ring[steps - r]).toEqual({ x: -p.x, y: p.y });
      }
    }
  });

  /**
   * ...and end to end, that curve really is the board's surface — not just whatever
   * `loftCrossSection` happened to return. 0.1 mm is the loft's own arc-length table
   * resolution, well under a printer's.
   */
  it('puts that curve on the surface the 3D view and the STL show', () => {
    for (const x of stations) {
      const surface = loftSection(board, x)!;
      const ring = crossSectionRing(board, x, 200)!;
      for (let i = 0; i <= 200; i++) {
        const p = loftPoint(surface, i / 200);
        expect(nearest(ring, { x: p.x, y: p.y })).toBeLessThan(0.01);
      }
    }
  });
});
