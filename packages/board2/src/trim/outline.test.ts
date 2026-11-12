// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The outline as a loop and the half width with a notch filled in: the loops of the made boards
 * are pinned to the samples the measurement bridge built them with, the half width agrees with
 * the surface's own chord function, and a standard outline is left as it is.
 */
import { describe, expect, it } from 'vitest';
import { createChordFn } from '../probe';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import { TRIM } from '../params';
import type { BoardDoc } from '../types';
import { defaultCorners, filledOutline, halfWidthOf, loopDefOf, loopOf } from './outline';
import { notchFreeTwin } from './test-support/bridge';

/** Sample count, perimeter and position-weighted sums of x and y of each board's loop, as first built. */
const PINNED: Record<string, { n: number; perimeter: number; sx: number; sy: number }> = {
  swallow: { n: 807, perimeter: 415.8380232006798, sx: 27054229.00293212, sy: -2936246.361706506 },
  fish: { n: 741, perimeter: 384.9474315341727, sx: 21114609.238855604, sy: -2564525.5056945 },
  asymmetric: { n: 716, perimeter: 387.3948181416435, sx: 22678544.361268, sy: -2421800.801733406 },
};
const BOARDS: Record<string, () => BoardDoc> = {
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};
const notched = (doc: BoardDoc): boolean => doc.tail.kind === 'notched';

describe('loopOf', () => {
  for (const [name, make] of Object.entries(BOARDS)) {
    it(`keeps the samples of the ${name}'s loop`, () => {
      const doc = make();
      const loop = loopOf(doc.outline, defaultCorners(doc.outline, notched(doc)));
      const want = PINNED[name]!;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < loop.n; i++) {
        sx += loop.x[i]! * (i + 1);
        sy += loop.y[i]! * (i + 1);
      }
      expect(loop.n).toBe(want.n);
      expect(loop.s[loop.n]!).toBeCloseTo(want.perimeter, 9);
      expect(sx).toBeCloseTo(want.sx, 6);
      expect(sy).toBeCloseTo(want.sy, 6);
    });
  }
});

describe('defaultCorners and loopDefOf', () => {
  it('gives the crotch the notch radius and every corner knot the tail radius', () => {
    const doc = swallowBoard();
    const c = defaultCorners(doc.outline, true);
    expect(c.nose).toBe(TRIM.radiusNose);
    expect(c.tail).toBe(TRIM.radiusCrotch);
    expect(c.plus).toEqual([TRIM.radiusTail]);
    expect(c.minus).toBeUndefined();
    expect(defaultCorners(asymmetricBoard().outline, false).tail).toBe(TRIM.radiusTail);
  });

  it('keeps a mirror board and the same board with its minus side given equal', () => {
    const doc = fishBoard();
    const a = loopOf(doc.outline, defaultCorners(doc.outline, true));
    const outline = { plus: doc.outline.plus, minus: doc.outline.plus };
    const b = loopOf(outline, defaultCorners(outline, true));
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
    expect(Array.from(b.y)).toEqual(Array.from(a.y));
  });

  it('puts the tail radius after the first piece and the nose radius after the last', () => {
    const doc = asymmetricBoard();
    const corners = { nose: 1.1, tail: 2.2, plus: [], minus: [] };
    const def = loopDefOf(doc.outline, corners);
    expect(def.pieces.length).toBe(2);
    expect(def.corners).toEqual([2.2, 1.1]);
  });
});

describe('filledOutline', () => {
  it('leaves a standard outline as the same object', () => {
    for (const doc of [asymmetricBoard()]) expect(filledOutline(doc.outline)).toBe(doc.outline);
  });

  it('fills a notched outline from (0, 0) to the tip', () => {
    const doc = fishBoard();
    const f = filledOutline(doc.outline);
    expect(f.plus.knots[0]!.p).toEqual([0, 0]);
    expect(f.plus.knots[1]!.p).toEqual(doc.outline.plus.knots[1]!.p);
    expect(f.plus.knots.length).toBe(doc.outline.plus.knots.length);
  });
});

describe('halfWidthOf', () => {
  for (const [name, make] of Object.entries(BOARDS)) {
    it(`equals the chord function on the ${name}`, () => {
      const doc = make();
      const ref = notched(doc) ? notchFreeTwin(doc) : doc;
      const L = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];
      const sides: (undefined | 'minus')[] =
        doc.outline.minus === undefined ? [undefined] : [undefined, 'minus'];
      for (const side of sides) {
        const mine = halfWidthOf(doc.outline, side);
        const chord = side === undefined ? createChordFn(ref) : createChordFn(ref, side);
        for (let i = 0; i < 50; i++) {
          const x = ((i + 0.5) / 50) * L;
          expect(Math.abs(mine(x) - chord(x))).toBeLessThan(1e-9);
        }
      }
    });
  }
});
