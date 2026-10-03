// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { board, getWidthAtPos } from './board';
import { sampleHalfRing } from './board-surface';
import { crossSection } from './cross-section';
import { loftPoint, loftSection } from './loft';
import { polylineSpline } from './test-support/synthetic-boards';

/**
 * Neighboring profiles with the same true width but very different rail heights.
 * Their widest points occur on opposite sides of the whole-profile arc midpoint,
 * reproducing the 3D rail pulling inside an otherwise correct 2D outline.
 */
const shiftedRails = () => {
  const length = 100;
  const halfWidth = 20;
  const thickness = 10;
  const outline = polylineSpline([
    [0, halfWidth],
    [length, halfWidth],
  ]);
  const bottom = polylineSpline([
    [0, 0],
    [length, 0],
  ]);
  const deck = polylineSpline([
    [0, thickness],
    [length, thickness],
  ]);
  const lowRail = polylineSpline([
    [0, 0],
    [halfWidth, 1],
    [0, thickness],
  ]);
  const highRail = polylineSpline([
    [0, 0],
    [halfWidth, 9],
    [0, thickness],
  ]);
  return board(outline, bottom, deck, [
    crossSection(0, lowRail),
    crossSection(25, lowRail),
    crossSection(75, highRail),
    crossSection(length, highRail),
  ]);
};

describe('loft outline width', () => {
  it('anchors the blended rail to the 2D outline when profile apex heights differ', () => {
    const b = shiftedRails();
    const x = 50;
    const section = loftSection(b, x)!;

    expect(loftPoint(section, 0.5).x).toBeCloseTo(getWidthAtPos(b, x) / 2, 9);
  });

  it('puts the rail anchor in every generated mesh ring', () => {
    const b = shiftedRails();
    const x = 50;
    const ring = sampleHalfRing(b, x, 24)!;

    expect(Math.max(...ring.map((point) => point.y))).toBeCloseTo(getWidthAtPos(b, x) / 2, 9);
  });
});
