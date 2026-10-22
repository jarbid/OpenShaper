// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A board with a swallow tail, for tests of what a concave tail turns off. The
 * bundled sample's rocker, deck and sections under an outline that folds back into
 * a notch (bottom at x = 18, tips at (0, ±9)).
 */
import { parseBrd } from '@openshaper/io';
import {
  board,
  getLength,
  knotFromArray,
  splineFromKnots,
  type BezierBoard,
} from '@openshaper/kernel';
import sampleBrd from '../sample-board.brd?raw';

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

export const swallowBoard = (): BezierBoard => {
  const sample = parseBrd(sampleBrd).board;
  const L = getLength(sample);
  return board(
    splineFromKnots([
      knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
      knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, L, 0)], false, false),
      knotFromArray([L, 0, ...third(L, 0, 90, 23.5), L, 0], false, false),
    ]),
    sample.bottom,
    sample.deck,
    sample.crossSections,
    sample.interpolationType,
    sample.fins,
  );
};
