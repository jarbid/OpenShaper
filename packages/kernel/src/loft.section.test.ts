// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Does {@link loftCrossSection} describe the same surface as the loft it is built from,
 * and is the curve it returns a FAIR one?
 *
 * Two separate questions, and the second is the one that matters. A rebuilt curve that
 * sits within a hair of the right place but carries a kink is useless to every caller
 * that exists for this function: they read SLOPE off it. So position is pinned against
 * an oracle, and curvature is pinned against the same fairness property
 * `loft.pinch.test.ts` uses on the mesh — a blend must never be sharper than the sharper
 * of the two stations it blends.
 *
 * The oracle is the **exact** blend: the two bracketing profiles sampled by true
 * arc length (`pointByS`, adaptive, no table) and lerped. That is what `loftPoint`
 * approximates with its fixed-resolution table, so measuring the rebuilt curve against
 * it prices the table and the rebuild together, which is what a caller actually gets.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arcLengthTable, pointAtArcFraction, pointByS } from './bezier-spline';
import {
  getDeckAtPos,
  getNearestCrossSectionIndex,
  getRockerAtPos,
  getThicknessAtPos,
  getWidthAtPos,
  type BezierBoard,
} from './board';
import { scaleCrossSection } from './cross-section';
import { loftCrossSection, loftPoint, loftSection, MIN_DIM } from './loft';
import { railFacetStations } from './rail-facets';
import { applyRailProfile, RAIL_PRESETS } from './rail-profile';
import { bottomZAt, deckZAt } from './surface';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { curvyBoard } from './test-support/synthetic-boards';
import { vec2, type Vec2 } from './vec2';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILES = ['shortboard.brd', 'funboard.brd', 'longboard.brd'] as const;
const golden = (file: string): BezierBoard =>
  parseBrdGeometry(readFileSync(resolve(here, `../../../docs/specs/golden/${file}`), 'utf8'));

/**
 * A board whose every station carries a DIFFERENT rail preset.
 *
 * The stock golden boards are the easy case — every station is the same shape with the
 * same knot count, so a blend has almost nothing to get wrong. Giving each station its
 * own rail is what a shaper does (hard in the tail, full in the nose) and it is where
 * the control-point blend this function replaces goes visibly wrong.
 */
const mixedRails = (b: BezierBoard): BezierBoard => {
  const ids = ['80-20-hard', '50-50-soft', 'pinched', 'boxy', 'knifey', 'egg'];
  const list = [...b.crossSections];
  for (let i = 1; i < list.length - 1; i++) {
    const preset = RAIL_PRESETS.find((p) => p.id === ids[i % ids.length]!)!;
    list[i] = applyRailProfile(list[i]!, preset.params);
  }
  return { ...b, crossSections: list };
};

/**
 * The blend the loft approximates, computed exactly: no arc-length table, no rebuild.
 *
 * Deliberately a second implementation of the bracketing rather than a call into
 * `loftSection` — an oracle that shares the code under test proves nothing.
 */
const exactBlendPoint = (b: BezierBoard, x: number, f: number): Vec2 => {
  const cs = b.crossSections;
  let index = getNearestCrossSectionIndex(b, x);
  if (cs[index]!.position > x) index -= 1;
  let nextIndex = index + 1;
  const raw = (x - cs[index]!.position) / (cs[nextIndex]!.position - cs[index]!.position);
  let d = Number.isFinite(raw) ? raw : 0;
  if (index < 1) index = 1;
  if (nextIndex > cs.length - 2) {
    index = cs.length - 2;
    nextIndex = index;
  }
  if (index === nextIndex) d = 0;

  const thickness = Math.max(MIN_DIM, getThicknessAtPos(b, x));
  const width = Math.max(MIN_DIM, getWidthAtPos(b, x));
  const a = pointByS(scaleCrossSection(cs[index]!, thickness, width).spline, f);
  const c = pointByS(scaleCrossSection(cs[nextIndex]!, thickness, width).spline, f);
  return vec2(a.x + (c.x - a.x) * d, a.y + (c.y - a.y) * d);
};

/** Densely sampled points of a rebuilt section, for nearest-point comparison. */
const denseCurve = (b: BezierBoard, x: number, n = 3000): Vec2[] => {
  const cs = loftCrossSection(b, x);
  expect(cs).not.toBeNull();
  const table = arcLengthTable(cs!.spline);
  return Array.from({ length: n + 1 }, (_, i) => pointAtArcFraction(table, i / n));
};

/** Closest approach of `p` to a polyline's vertices. */
const nearest = (curve: readonly Vec2[], p: Vec2): number => {
  let best = Infinity;
  for (const q of curve) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  return best;
};

/** Discrete curvature: turn angle per unit arc length, as `loft.pinch.test.ts` measures it. */
const peakCurvature = (pts: readonly Vec2[]): number => {
  let peak = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    let turn = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    const len = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    if (len > 1e-9) peak = Math.max(peak, Math.abs(turn) / len);
  }
  return peak;
};

describe('loftCrossSection', () => {
  /**
   * 0.1 mm, and it is generous on purpose: measured worst case is 0.076 mm on the
   * longboard, of which the loft's own table accounts for 0.068 mm — the rebuild
   * contributes under 0.01 mm. Tightening this would pin the TABLE's resolution from
   * the wrong file. What it guards is the thing that would actually break: a rebuild
   * that stops tracking the surface at all.
   */
  const POSITION_TOL_CM = 0.01;

  it.each(GOLDEN_FILES)(
    'traces the exact blend on %s, with a different rail at every station',
    (file) => {
      const board = mixedRails(golden(file));
      for (const x of railFacetStations(board)) {
        const curve = denseCurve(board, x);
        for (let i = 0; i <= 200; i++) {
          const p = exactBlendPoint(board, x, i / 200);
          expect(nearest(curve, p)).toBeLessThan(POSITION_TOL_CM);
        }
      }
    },
  );

  it('agrees with the points the mesh and the STL are built from', () => {
    const board = mixedRails(golden('longboard.brd'));
    for (const x of railFacetStations(board)) {
      const surface = loftSection(board, x)!;
      const curve = denseCurve(board, x);
      for (let i = 0; i <= 200; i++) {
        expect(nearest(curve, loftPoint(surface, i / 200))).toBeLessThan(POSITION_TOL_CM);
      }
    }
  });

  /**
   * The pinch property, on the curve rather than on the mesh.
   *
   * A section between two stations must not be MORE curved than the sharper of the two:
   * interpolating a soft rail toward a hard one passes through intermediate rails, never
   * through something sharper than either end. Extra curvature belongs to no station,
   * and a facet fitted to it is a facet fitted to nothing.
   */
  it('never blends a section sharper than the stations either side of it', () => {
    const board = mixedRails(golden('longboard.brd'));
    const real = board.crossSections.slice(1, -1);
    for (let i = 0; i < real.length - 1; i++) {
      const lo = real[i]!.position;
      const hi = real[i + 1]!.position;
      const ends = [lo, hi].map((x) => peakCurvature(denseCurve(board, x, 800)));
      const sharpest = Math.max(...ends);
      for (let k = 1; k < 8; k++) {
        const x = lo + ((hi - lo) * k) / 8;
        // 1% of headroom for the discrete curvature estimate itself, no more.
        expect(peakCurvature(denseCurve(board, x, 800))).toBeLessThan(sharpest * 1.01);
      }
    }
  });

  /**
   * Both ends of a profile sit on the centreline, and "nearly" is not good enough: a
   * lateral of exactly 0 has to fall INSIDE the rebuilt spline's x range, or
   * `valueAtReverse` finds no segment and answers 0. That is not a rounding error in the
   * result, it is the wrong number entirely — `deckZAt` at the stringer came back as the
   * bare rocker, a whole board thickness low.
   */
  it('lands both ends exactly on the centreline', () => {
    for (const file of GOLDEN_FILES) {
      const board = mixedRails(golden(file));
      for (const x of railFacetStations(board)) {
        const knots = loftCrossSection(board, x)!.spline.knots;
        expect(knots[0]!.end.x).toBe(0);
        expect(knots[knots.length - 1]!.end.x).toBe(0);
      }
    }
    // ...and on the synthetic board that first exposed it, where the deck centreline
    // has to read back as the deck curve rather than as the rocker.
    const b = curvyBoard();
    for (const x of [20, 50, 80]) {
      expect(deckZAt(b, x, 0)).toBeCloseTo(getDeckAtPos(b, x), 6);
      expect(bottomZAt(b, x, 0)).toBeCloseTo(getRockerAtPos(b, x), 6);
    }
  });

  /**
   * `deckZAt` / `bottomZAt` answer "how high is the board at this plan point", and
   * `rail-band.ts` measures a wooden board's rail strips with them — a cut part. They
   * used to read the control-point blend while the 3D view read the loft, so the two
   * could disagree by millimetres on a board whose rail changes along its length.
   *
   * Probed away from the centreline and the rail edge, where a lateral maps
   * unambiguously onto one branch of the profile.
   */
  it('answers surface heights off the same loft the mesh uses', () => {
    const board = mixedRails(golden('longboard.brd'));
    for (const x of railFacetStations(board)) {
      const surface = loftSection(board, x)!;
      const half = Math.max(...Array.from({ length: 401 }, (_, i) => loftPoint(surface, i / 400).x));
      for (const frac of [0.15, 0.35, 0.55, 0.75, 0.88, 0.95]) {
        const y = half * frac;
        // Where the lofted profile crosses this lateral, interpolated between samples:
        // the lowest crossing is the bottom, the highest the deck. Both read off the
        // surface, never off a blend.
        let lo = Infinity;
        let hi = -Infinity;
        let prev = loftPoint(surface, 0);
        for (let i = 1; i <= 4000; i++) {
          const p = loftPoint(surface, i / 4000);
          if ((prev.x - y) * (p.x - y) <= 0 && prev.x !== p.x) {
            const t = (y - prev.x) / (p.x - prev.x);
            const h = prev.y + (p.y - prev.y) * t;
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
          prev = p;
        }
        expect(Number.isFinite(lo)).toBe(true);
        expect(bottomZAt(board, x, y) - surface.rocker).toBeCloseTo(lo, 2);
        expect(deckZAt(board, x, y) - surface.rocker).toBeCloseTo(hi, 2);
      }
    }
  });

  it('has no section past either tip', () => {
    const board = golden('shortboard.brd');
    expect(loftCrossSection(board, -1)).toBeNull();
    expect(loftCrossSection(board, 1e6)).toBeNull();
  });
});
