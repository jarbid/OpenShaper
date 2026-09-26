import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  board,
  crossSection,
  getLength,
  getRockerAtPos,
  getWidthAtPos,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { parseBrd } from './brd-reader';
import { writeBrd } from './brd-writer';
import { ensureTailAtZero, isNoseFirst, mirrorLengthwise } from './orientation';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, '../../../docs/specs/golden');
const BOARDS = ['shortboard', 'funboard', 'longboard'] as const;
const readBrd = (name: string) => readFileSync(resolve(GOLDEN_DIR, `${name}.brd`), 'utf8');

/** Width and rocker along the board — what "the same shape" means here. */
const profile = (b: BezierBoard) => {
  const length = getLength(b);
  return Array.from({ length: 11 }, (_, i) => {
    const x = (length * i) / 10;
    return { width: getWidthAtPos(b, x), rocker: getRockerAtPos(b, x) };
  });
};

describe('ensureTailAtZero', () => {
  it.each(BOARDS)('leaves the %s — already tail-first — exactly as read', (name) => {
    const { board: b, warnings } = parseBrd(readBrd(name));
    expect(isNoseFirst(b)).toBe(false);
    expect(warnings.some((w) => /nose-first/.test(w.message))).toBe(false);
    const again: typeof warnings = [];
    expect(ensureTailAtZero(b, again)).toBe(b);
    expect(again).toEqual([]);
  });

  it.each(BOARDS)('turns a nose-first %s .brd around on import, with a notice', (name) => {
    const tailFirst = parseBrd(readBrd(name)).board;
    const noseFirst = mirrorLengthwise(tailFirst);
    expect(isNoseFirst(noseFirst)).toBe(true);

    // Through the real pipeline: written out nose-first, read back in.
    const { board: read, warnings } = parseBrd(writeBrd(noseFirst));

    expect(warnings.filter((w) => /nose-first/.test(w.message))).toHaveLength(1);
    expect(isNoseFirst(read)).toBe(false);
    const want = profile(tailFirst);
    profile(read).forEach((p, i) => {
      expect(p.width).toBeCloseTo(want[i]!.width, 3);
      expect(p.rocker).toBeCloseTo(want[i]!.rocker, 3);
    });
    expect(read.crossSections.map((cs) => cs.position)).toEqual(
      tailFirst.crossSections.map((cs) => expect.closeTo(cs.position, 3)),
    );
  });

  it('does not flip a near-symmetric rocker on a coin toss', () => {
    const flat = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0)),
      knot(vec2(200, 0), vec2(195, 0), vec2(205, 0)),
    ]);
    const lift = (tail: number, nose: number) =>
      splineFromKnots([
        knot(vec2(0, tail), vec2(-5, tail), vec2(20, tail)),
        knot(vec2(100, 0), vec2(70, 0), vec2(130, 0)),
        knot(vec2(200, nose), vec2(180, nose), vec2(205, nose)),
      ]);
    const prof = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(1, 0)),
      knot(vec2(1, 1), vec2(1, 0.5), vec2(1, 1)),
    ]);
    const make = (tail: number, nose: number) =>
      board(flat, lift(tail, nose), lift(tail + 6, nose + 6), [
        crossSection(0, prof),
        crossSection(200, prof),
      ]);

    // Half a centimetre more lift at x=0: inside the margin, so trusted as written.
    expect(isNoseFirst(make(8.5, 8))).toBe(false);
    // Five more: that end is the nose.
    expect(isNoseFirst(make(13, 8))).toBe(true);
  });
});

describe('mirrorLengthwise', () => {
  it.each(BOARDS)('reflects the %s: the shape at x is the original at length − x', (name) => {
    // The round trip above flips twice, which a wrong flip would survive — this
    // checks a single one against the shape it came from.
    const b = parseBrd(readBrd(name)).board;
    const m = mirrorLengthwise(b);
    const length = getLength(b);
    expect(getLength(m)).toBeCloseTo(length, 9);
    for (let i = 1; i < 20; i++) {
      const x = (length * i) / 20;
      expect(getWidthAtPos(m, x)).toBeCloseTo(getWidthAtPos(b, length - x), 6);
      expect(getRockerAtPos(m, x)).toBeCloseTo(getRockerAtPos(b, length - x), 6);
    }
  });

  it('is its own inverse', () => {
    const b = parseBrd(readBrd('funboard')).board;
    const back = mirrorLengthwise(mirrorLengthwise(b));
    for (const key of ['outline', 'bottom', 'deck'] as const) {
      back[key].knots.forEach((k, i) => {
        const o = b[key].knots[i]!;
        for (const p of ['end', 'tangentToPrev', 'tangentToNext'] as const) {
          expect(k[p].x).toBeCloseTo(o[p].x, 9);
          expect(k[p].y).toBeCloseTo(o[p].y, 9);
        }
      });
    }
  });
});
