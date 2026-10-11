// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Synthetic boards for the render3d tests. Test fixtures only — nothing in the
 * package's source imports this.
 */
import {
  board,
  crossSection,
  knot,
  knotFromArray,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';

const LENGTH = 100;
const HALF_WIDTH = 25;
const DECK = 6;

const bottom = () =>
  splineFromKnots([
    knot(vec2(0, 4), vec2(0, 4), vec2(20, 1.2)),
    knot(vec2(50, 0), vec2(30, 0), vec2(70, 0)),
    knot(vec2(LENGTH, 4), vec2(80, 1.2), vec2(LENGTH, 4)),
  ]);

const deck = () =>
  splineFromKnots([
    knot(vec2(0, 4.5), vec2(0, 4.5), vec2(20, DECK)),
    knot(vec2(50, DECK), vec2(30, DECK), vec2(70, DECK)),
    knot(vec2(LENGTH, 4.5), vec2(80, DECK), vec2(LENGTH, 4.5)),
  ]);

/** A rounded rail with its apex at `apex` of the thickness. */
const profile = (apex: number): Spline =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(HALF_WIDTH * 0.5, 0)),
    knot(
      vec2(HALF_WIDTH, DECK * apex),
      vec2(HALF_WIDTH, DECK * apex * 0.35),
      vec2(HALF_WIDTH, DECK * (apex + (1 - apex) * 0.6)),
    ),
    knot(vec2(0, DECK), vec2(HALF_WIDTH * 0.5, DECK), vec2(0, DECK)),
  ]);

/**
 * Five stations whose rail apex rides at a different height at each, so the loft
 * has a genuine tangent break at the three interior ones.
 */
const sections = () => [
  crossSection(0, profile(0.4)),
  crossSection(20, profile(0.3)),
  crossSection(45, profile(0.5)),
  crossSection(75, profile(0.35)),
  crossSection(LENGTH, profile(0.45)),
];

/** A 100 cm board with a pointed outline, real rocker and three real stations. */
export const stationBoard = (): BezierBoard =>
  board(
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, HALF_WIDTH * 0.6)),
      knot(vec2(50, HALF_WIDTH), vec2(30, HALF_WIDTH), vec2(70, HALF_WIDTH)),
      knot(vec2(LENGTH, 0), vec2(90, HALF_WIDTH * 0.6), vec2(LENGTH, 0)),
    ]),
    bottom(),
    deck(),
    sections(),
    'controlPoint',
  );

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/** The same board with a swallow tail: notch bottom at (12, 0), tips at (0, ±8). */
export const swallowBoard = (): BezierBoard =>
  board(
    splineFromKnots([
      knotFromArray([12, 0, 12, 0, ...third(12, 0, 0, 8)], false, false),
      knotFromArray([0, 8, ...third(0, 8, 12, 0), ...third(0, 8, 50, HALF_WIDTH)], false, false),
      knotFromArray(
        [50, HALF_WIDTH, ...third(50, HALF_WIDTH, 0, 8), ...third(50, HALF_WIDTH, LENGTH, 0)],
        false,
        false,
      ),
      knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 50, HALF_WIDTH), LENGTH, 0], false, false),
    ]),
    bottom(),
    deck(),
    sections(),
    'controlPoint',
  );
