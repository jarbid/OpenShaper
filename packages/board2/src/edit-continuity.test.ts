// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The surface moves continuously with the shaper's edits (review of M1, finding 2). A blend that chose
 * between two interpolants on a 1e-12 overshoot test moved the funboard's surface by 1.3 mm for a single
 * 1 mm step of a station while its neighbours moved it by 0.04 mm, and a 0.1 mm edit of a tail slice
 * moved the shortboard's surface by 0.96 mm against 1.6 mm for ten times the edit.
 *
 * Distances are Hausdorff distances between the rings of the two surfaces (`surfaceMove`).
 */
import { describe, expect, it } from 'vitest';
import {
  boardSet,
  buildOrThrow,
  convertOrThrow,
  editSlice,
  surfaceMove,
} from './test-support/board-set';

const MM = 0.1;

describe.each(
  boardSet()
    .filter((b) => b.classic !== undefined)
    .map((b) => [b.name, b] as const),
)('%s', (_name, b) => {
  const classic = b.classic!;
  const base = buildOrThrow(b.doc);
  const slices = classic.crossSections.length - 2;
  const built = (edit: Parameters<typeof editSlice>[2], index: number) =>
    buildOrThrow(convertOrThrow(editSlice(classic, index, edit)));

  it('moves by no more than 3.5x a 1 mm or 0.1 mm edit of an interior section, in proportion to it', () => {
    // (the first and last real slices sit near the tips, where a section is normalised by a very small
    // chord and thickness and its neighbours are 5 to 10 times larger: the edit is amplified there by design)
    for (let index = 2; index <= slices - 1; index++) {
      const one = surfaceMove(base, built({ knot: 1, dh: MM }, index));
      const tenth = surfaceMove(base, built({ knot: 1, dh: MM / 10 }, index));
      expect(one, `slice ${index}: 1 mm`).toBeLessThan(3.5 * MM);
      expect(tenth, `slice ${index}: 0.1 mm`).toBeLessThan(0.35 * MM);
      // proportional, with room for the section fit's rung (a few 0.01 mm)
      expect(tenth * 10, `slice ${index}: 0.1 mm x 10 against 1 mm`).toBeGreaterThan(0.5 * one);
      expect(tenth * 10, `slice ${index}: 0.1 mm x 10 against 1 mm`).toBeLessThan(2 * one);
    }
  });

  it('moves smoothly as a station is moved along the board in 1 mm steps', () => {
    const steps: number[] = [];
    let prev = base;
    for (let k = 1; k <= 10; k++) {
      const cur = built({ dx: MM * k }, 2);
      steps.push(surfaceMove(prev, cur));
      prev = cur;
    }
    const median = [...steps].sort((p, q) => p - q)[steps.length >> 1]!;
    // (a rung of the section fit may change, at most the fit tolerance, 0.5 mm, in the surface)
    const fit = 0.5 * MM;
    for (const s of steps)
      expect(s, `steps ${steps.map((v) => v.toFixed(4)).join(' ')}`).toBeLessThan(3 * median + fit);
  });
});
