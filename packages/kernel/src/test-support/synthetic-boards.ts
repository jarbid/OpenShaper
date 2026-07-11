// SPDX-License-Identifier: GPL-3.0-or-later
import { splineFromKnots, type Spline } from '../bezier-spline';
import { board, type BezierBoard } from '../board';
import { crossSection, type CrossSection } from '../cross-section';
import { knot } from '../knot';
import { vec2 } from '../vec2';

/** A straight bezier segment: handles at the 1/3 points of the chord. */
const line = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { after: ReturnType<typeof vec2>; before: ReturnType<typeof vec2> } => ({
  after: vec2(ax + (bx - ax) / 3, ay + (by - ay) / 3),
  before: vec2(ax + ((bx - ax) * 2) / 3, ay + ((by - ay) * 2) / 3),
});

/** Polyline spline through the given points, each segment an exact straight line. */
export const polylineSpline = (pts: readonly [number, number][]): Spline =>
  splineFromKnots(
    pts.map(([x, y], i) => {
      const prev = pts[i - 1] ?? pts[i]!;
      const next = pts[i + 1] ?? pts[i]!;
      return knot(
        vec2(x, y),
        line(prev[0], prev[1], x, y).before,
        line(x, y, next[0], next[1]).after,
      );
    }),
  );

/** Rectangular cross-section: bottom-centre (0,0) → rail (w,0)→(w,t) → deck-centre (0,t). */
export const rectSection = (position: number, w: number, t: number): CrossSection =>
  crossSection(
    position,
    polylineSpline([
      [0, 0],
      [w, 0],
      [w, t],
      [0, t],
    ]),
  );

export interface BoxBoardOptions {
  length?: number;
  halfWidth?: number;
  thickness?: number;
  /** Linear bottom-rocker slope: bottom(x) = slope·x (deck = bottom + thickness). */
  rockerSlope?: number;
}

/**
 * Analytic "box" board: constant half-width outline (a straight rail), rectangular
 * cross-sections, and an optional LINEAR rocker. Every surface quantity has a
 * closed-form value, so tests can assert exactly:
 *   bottomZ(x,y) = slope·x, deckZ(x,y) = slope·x + thickness,
 *   outline inset by d = the straight line y = halfWidth − d.
 */
export const boxBoard = (opts: BoxBoardOptions = {}): BezierBoard => {
  const { length = 100, halfWidth = 20, thickness = 5, rockerSlope = 0 } = opts;
  const outline = polylineSpline([
    [0, halfWidth],
    [length, halfWidth],
  ]);
  const bottom = polylineSpline([
    [0, 0],
    [length, rockerSlope * length],
  ]);
  const deck = polylineSpline([
    [0, thickness],
    [length, rockerSlope * length + thickness],
  ]);
  const sections: CrossSection[] = [
    rectSection(0, halfWidth, thickness),
    rectSection(length / 2, halfWidth, thickness),
    rectSection(length, halfWidth, thickness),
  ];
  return board(outline, bottom, deck, sections, 'controlPoint');
};

/**
 * A curvy but well-formed 100 cm board (same shape as the export package's
 * `makeTestBoard`): pointed outline, real rocker, rounded rail sections.
 */
export const curvyBoard = (): BezierBoard => {
  const length = 100;
  const halfWidth = 25;
  const deckCenter = 6;

  const outline = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(10, halfWidth * 0.6)),
    knot(vec2(50, halfWidth), vec2(30, halfWidth), vec2(70, halfWidth)),
    knot(vec2(100, 0), vec2(90, halfWidth * 0.6), vec2(100, 0)),
  ]);
  const bottom = splineFromKnots([
    knot(vec2(0, 4), vec2(0, 4), vec2(20, 1.2)),
    knot(vec2(50, 0), vec2(30, 0), vec2(70, 0)),
    knot(vec2(100, 4), vec2(80, 1.2), vec2(100, 4)),
  ]);
  const deck = splineFromKnots([
    knot(vec2(0, 4.5), vec2(0, 4.5), vec2(20, deckCenter)),
    knot(vec2(50, deckCenter), vec2(30, deckCenter), vec2(70, deckCenter)),
    knot(vec2(100, 4.5), vec2(80, deckCenter), vec2(100, 4.5)),
  ]);

  const profile = (w: number, thick: number): Spline =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(w * 0.5, 0)),
      knot(vec2(w, thick * 0.45), vec2(w, thick * 0.15), vec2(w, thick * 0.75)),
      knot(vec2(0, thick), vec2(w * 0.5, thick), vec2(0, thick)),
    ]);

  const sections: CrossSection[] = [
    crossSection(0, profile(halfWidth, deckCenter)),
    crossSection(50, profile(halfWidth, deckCenter)),
    crossSection(length, profile(halfWidth, deckCenter)),
  ];
  return board(outline, bottom, deck, sections, 'controlPoint');
};
