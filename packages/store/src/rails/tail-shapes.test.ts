// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tail shapes (`tail-shapes.ts`): how the tails of the boards the project ships and makes read, applying every
 * shape to every one of them (the made boards and the starter templates) at the least, a typical and the greatest
 * width and, for a notch, the least and the greatest depth: the engine builds the result with no issue and it is
 * closed, the shape and its numbers read back, the tail is at x = 0, only the tail's own knots change, applying a shape
 * twice changes nothing (the same object), a point dragged reads Custom; the corners of the tail and their radii, held
 * to what the engine builds as asked; and a seeded sequence of random calls that keeps all of that.
 */
import type { Chain, ChainKnot, RailsBoard } from '@openshaper/board2';
import { RADIUS_CROTCH, RADIUS_TAIL } from '@openshaper/board2/defaults';
import { describe, expect, it } from 'vitest';
import { cornerKnots } from './edits';
import { createRailsStore } from './rails-store';
import { setTail } from './shape';
import {
  CORNER_MIN_TURN,
  CORNER_RADIUS_MIN,
  DIAMOND_DEPTH_SHARE,
  PIN_LEAD_SHARE,
  TAIL_READ_TOLERANCE,
  TAIL_SHAPES,
  TAIL_WIDTH_SHARE,
  TAIL_ZONE_SHARE,
  TIP_RADIUS_MIN,
  applyTailShape,
  cornerTurn,
  isNotchedShape,
  railKnotIndex,
  setCornerRadius,
  tailCorners,
  tailNotchRange,
  tailShapeAt,
  tailShapeOf,
  tailWidthPoint,
  tailWidthRange,
  type TailShapeId,
  type TailShapeName,
  type TailShapeRequest,
} from './tail-shapes';
import { arcAt, builtArcs } from './test-support/built-arcs';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';
import { between, deepFreeze, pick, seeded } from './test-support/zone-kit';

const board = (name: string): RailsBoard => everyBoard.find(([n]) => n === name)![1]();

/** The tail knots of one side. */
const own = (doc: RailsBoard, side: 'plus' | 'minus' = 'plus'): readonly ChainKnot[] => {
  const chain = side === 'minus' ? (doc.outline.minus ?? doc.outline.plus) : doc.outline.plus;
  return chain.knots.slice(0, railKnotIndex(chain));
};

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

describe("how the tails of the project's own boards read", () => {
  // What the boards measure (`tail-shapes.measure.test.ts` prints the knots): the golden shortboard and the
  // shortboard and longboard templates draw their tail end soft, in the curve of one smooth knot (no corner knot:
  // the corner knot of the shortboard, radius 0.6 cm, is the nose's), the funboard draws one curve from the tail
  // point to its widest point, the two made notched boards draw their walls by hand, and the swallow and fish
  // templates are what the section store's `setTail` writes, and the made asymmetric board leaves its tail point at a slant
  // (a pin). A shape is read by matching what is written, so what was drawn by hand reads Custom.
  const reads: readonly [string, TailShapeName][] = [
    ['mirror', 'custom'],
    ['asymmetric', 'pin'],
    ['swallow', 'custom'],
    ['fish', 'custom'],
    ['shortboard', 'custom'],
    ['longboard', 'custom'],
    ['funboard', 'round'],
    ['swallow-shortboard', 'swallow'],
    ['fish-shortboard', 'fish'],
  ];
  it.each(reads)('%s reads %s', (name, shape) => {
    expect(tailShapeOf(board(name)).shape).toBe(shape);
    // the two sides of the one asymmetric board are not the same width
    expect(tailShapeAt(board(name)).sidesDiffer).toBe(name === 'asymmetric');
  });

  it('gives the numbers of the three that read', () => {
    const round = tailShapeOf(board('funboard'));
    expect(round.width).toBeCloseTo(31.28, 1);
    const swallow = tailShapeOf(board('swallow-shortboard'));
    expect(swallow).toMatchObject({ shape: 'swallow', notch: expect.closeTo(11.28, 2) });
    expect(swallow.width).toBeCloseTo(19.74, 1);
    const fish = tailShapeOf(board('fish-shortboard'));
    expect(fish).toMatchObject({ shape: 'fish', notch: expect.closeTo(6.58, 2) });
    expect(fish.width).toBeCloseTo(23.49, 1);
  });

  it('takes the tail zone as the section store does', () => {
    // setTail keeps the first knot at or beyond its share of the length: the rail knot
    for (const [name, make] of everyBoard) {
      const doc = make();
      if (doc.outline.plus.knots[0]!.p[0] > 0) continue;
      const swallow = setTail(doc, 'swallow');
      const rail = doc.outline.plus.knots[railKnotIndex(doc.outline.plus)];
      expect(swallow.outline.plus.knots[2], name).toBe(rail);
    }
    expect(TAIL_ZONE_SHARE).toBe(0.08);
  });
});

/** The widths and depths a board is built at: the least, a typical (none asked: the shape's own) and the greatest. */
function requests(doc: RailsBoard, shape: TailShapeId): TailShapeRequest[] {
  const w = tailWidthRange(doc, shape);
  if (!isNotchedShape(shape)) {
    return [{ shape, width: w.min }, { shape }, { shape, width: w.max }];
  }
  const d = tailNotchRange(doc);
  return [
    { shape, width: w.min, notch: d.min },
    { shape, width: w.min, notch: d.max },
    { shape },
    { shape, width: w.max, notch: d.min },
    { shape, width: w.max, notch: d.max },
  ];
}

describe('every shape on every board', () => {
  for (const [name, make] of everyBoard) {
    describe(name, () => {
      it.each(TAIL_SHAPES)(
        '%s: built closed, read back, at x = 0, with the rest of the outline its own',
        (shape) => {
          const doc = deepFreeze(make());
          for (const request of requests(doc, shape)) {
            const next = applyTailShape(doc, request);
            const label = `${shape} ${JSON.stringify(request)}`;

            // the engine builds it, with no issue, and the mesh is closed
            const verdict = closedVerdict(next, true);
            expect(verdict, label).toEqual({ ok: true, why: '' });

            // it reads back as what was asked, at the numbers asked (held to the ranges)
            const read = tailShapeAt(next);
            expect(read.shape, label).toBe(shape);
            // (a board that already is the shape on both sides is returned as it is, whatever its sides' widths)
            if (request.width !== undefined || tailShapeAt(doc).shape !== shape) {
              expect(read.sidesDiffer, label).toBe(false);
            }
            const range = tailWidthRange(doc, shape);
            if (request.width !== undefined)
              expect(read.width, label).toBeCloseTo(request.width, 9);
            // (a tail that already is the shape is the board's own, and is not held to a range)
            if (next !== doc) {
              expect(read.width!, label).toBeGreaterThanOrEqual(range.min - 1e-9);
              expect(read.width!, label).toBeLessThanOrEqual(range.max + 1e-9);
            }
            if (request.notch !== undefined)
              expect(read.notch, label).toBeCloseTo(request.notch, 9);

            // the tail is at x = 0: the tip of a notch, or the point of a standard tail, and nothing is behind it
            for (const side of ['plus', 'minus'] as const) {
              const chain =
                side === 'minus' ? (next.outline.minus ?? next.outline.plus) : next.outline.plus;
              const tail = isNotchedShape(shape) ? chain.knots[1]! : chain.knots[0]!;
              expect(tail.p[0], label).toBe(0);
              expect(chain.knots[0]!.p[1], label).toBe(0);
              for (const k of chain.knots) {
                expect(Math.min(k.p[0], k.in[0], k.out[0]), label).toBeGreaterThanOrEqual(0);
                expect(Math.min(k.p[1], k.in[1], k.out[1]), label).toBeGreaterThanOrEqual(0);
              }
            }

            // a board never ends in a point: the tail's ball is at least the least a corner has
            expect(next.corners.tail, label).toBeGreaterThanOrEqual(
              isNotchedShape(shape) ? CORNER_RADIUS_MIN : TIP_RADIUS_MIN,
            );
            for (const side of ['plus', 'minus'] as const) {
              const c =
                side === 'minus' ? (next.outline.minus ?? next.outline.plus) : next.outline.plus;
              const radii =
                side === 'minus' ? (next.corners.minus ?? next.corners.plus) : next.corners.plus;
              expect(radii.length, label).toBe(cornerKnots(c).length);
            }

            // only the tail's own knots changed: the rail knot and what follows are the same objects
            const before = doc.outline.plus.knots;
            const after = next.outline.plus.knots;
            const rail = railKnotIndex(doc.outline.plus);
            expect(after.slice(after.length - (before.length - rail)), label).toEqual(
              before.slice(rail),
            );
            before
              .slice(rail)
              .forEach((k, i) =>
                expect(after[after.length - (before.length - rail) + i], label).toBe(k),
              );
            expect(next.rocker, label).toBe(doc.rocker);
            expect(next.deck, label).toBe(doc.deck);
            expect(next.rails, label).toBe(doc.rails);
            expect(next.meta, label).toBe(doc.meta);
            if (!isNotchedShape(shape) && doc.outline.plus.knots[0]!.p[0] === 0) {
              expect(next.stations, label).toBe(doc.stations);
            }
          }
        },
      );
    });
  }
});

describe('applying a shape twice changes nothing', () => {
  it.each(['mirror', 'asymmetric', 'swallow-shortboard', 'funboard'])('on the %s board', (name) => {
    const doc = board(name);
    for (const shape of TAIL_SHAPES) {
      const once = applyTailShape(doc, { shape });
      expect(applyTailShape(once, { shape }), shape).toBe(once);
      const read = tailShapeAt(once);
      // (the two sides of a board whose tails differ are not one width to ask for)
      if (!read.sidesDiffer)
        expect(applyTailShape(once, { shape, width: read.width! }), shape).toBe(once);
      if (read.notch !== null && !read.sidesDiffer)
        expect(applyTailShape(once, { shape, width: read.width!, notch: read.notch }), shape).toBe(
          once,
        );
      // a width the board cannot hold is the width it holds: asking for it again is no change either
      const range = tailWidthRange(once, shape);
      const widest = applyTailShape(once, { shape, width: range.max * 3 });
      expect(applyTailShape(widest, { shape, width: range.max * 5 }), shape).toBe(widest);
    }
  });

  it('keeps a hand-drawn tail that already reads the shape: the funboard is a round, and stays', () => {
    const doc = board('funboard');
    expect(applyTailShape(doc, { shape: 'round' })).toBe(doc);
    expect(applyTailShape(doc, { shape: 'round', width: tailShapeOf(doc).width! })).toBe(doc);
  });
});

describe('a tail edited point by point reads Custom', () => {
  /** `doc` with one coordinate of one of the tail's knots moved. */
  function moved(
    doc: RailsBoard,
    knot: number,
    part: 'p' | 'in' | 'out',
    axis: 0 | 1,
    by: number,
  ): RailsBoard {
    const knots = doc.outline.plus.knots.map((k, i) => {
      if (i !== knot) return k;
      const q: [number, number] = [k[part][0], k[part][1]];
      q[axis] += by;
      return { ...k, [part]: q };
    });
    return { ...doc, outline: { ...doc.outline, plus: { knots } } };
  }

  it.each(TAIL_SHAPES)('%s: any knot or handle dragged a millimetre or more', (shape) => {
    const doc = applyTailShape(board(isNotchedShape(shape) ? 'swallow-shortboard' : 'mirror'), {
      shape,
    });
    const tail = own(doc);
    tail.forEach((_, i) => {
      for (const part of ['p', 'in', 'out'] as const) {
        for (const axis of [0, 1] as const) {
          // the first knot's own point and its unused in handle, and the handle where the tail hands over to the rail, are not the tail's shape
          if ((i === 0 && part === 'in') || (i === tail.length - 1 && part === 'out' && i > 0))
            continue;
          // along its own line a round or a pin's lead only changes the width, and a pin's lean is its own number: a pin of another
          if (i === 0 && part === 'out' && axis === 1 && shape === 'round') continue;
          if (i === 0 && part === 'out' && shape === 'pin') continue;
          const read = tailShapeOf(moved(doc, i, part, axis, 0.1)).shape;
          expect(read, `${shape} knot ${i} ${part}[${axis}]`).toBe('custom');
          // the tail point's x is exact, not a tolerance: the engine takes a first knot past x = 0 for a notch's bottom
          if (i === 0 && part === 'p' && axis === 0 && !isNotchedShape(shape)) continue;
          // and within the tolerance it is still the shape
          const near = tailShapeOf(moved(doc, i, part, axis, TAIL_READ_TOLERANCE / 2)).shape;
          expect(near, `${shape} knot ${i} ${part}[${axis}] by a hair`).toBe(shape);
        }
      }
    });
  });

  it('keeps the shape when the shaper moves what a shape leaves theirs: the rail', () => {
    const doc = applyTailShape(board('mirror'), { shape: 'squash' });
    const rail = railKnotIndex(doc.outline.plus);
    for (const part of ['p', 'in', 'out'] as const) {
      expect(tailShapeOf(moved(doc, rail, part, 1, 2)).shape).toBe('squash');
    }
    // the corner's out handle is where the rail leaves it
    expect(tailShapeOf(moved(doc, 1, 'out', 1, 2)).shape).toBe('squash');
    // a round's lead dragged along its own line is a wider round
    const round = applyTailShape(board('mirror'), { shape: 'round' });
    const wider = tailShapeOf(moved(round, 0, 'out', 1, 3));
    expect(wider.shape).toBe('round');
    expect(wider.width!).toBeGreaterThan(tailShapeOf(round).width!);
  });

  it('reads a tail with other knots among the tail knots as Custom', () => {
    const doc = applyTailShape(board('mirror'), { shape: 'squash' });
    const extra: ChainKnot = { p: [1, 9], in: [1, 9], out: [2, 10], smooth: true };
    const knots = [
      doc.outline.plus.knots[0]!,
      doc.outline.plus.knots[1]!,
      extra,
      ...doc.outline.plus.knots.slice(2),
    ];
    expect(tailShapeOf({ ...doc, outline: { plus: { knots } } }).shape).toBe('custom');
  });
});

describe('a shape chosen after another', () => {
  // The corner of a squash, a diamond, a swallow and a fish leaves the tail the same way whatever was chosen before it: a flare carried
  // from the old corner would leave a diamond whose sides and rail run on in line, with no corner to round.
  const CORNERED: readonly TailShapeId[] = ['squash', 'diamond', 'swallow', 'fish'];
  it.each(TAIL_SHAPES)(
    'every shape chosen after %s is closed, has its corner, and is what it is from the start',
    (from) => {
      const doc = board('mirror');
      const first = applyTailShape(doc, { shape: from });
      for (const to of TAIL_SHAPES) {
        const next = applyTailShape(first, { shape: to });
        const label = `${from} then ${to}`;
        expect(closedVerdict(next, true), label).toEqual({ ok: true, why: '' });
        expect(tailShapeAt(next).shape, label).toBe(to);
        if (CORNERED.includes(to)) {
          const corner = tailCorners(next).find((c) => c.role === 'corner' || c.role === 'tip');
          expect(corner, label).toBeDefined();
          expect(corner!.turn, label).toBeGreaterThan(Math.PI / 6);
        }
        // the tail knots are those of the shape made from the board as it was, at the same width
        if (to === 'squash' || to === 'diamond') {
          const fresh = applyTailShape(doc, { shape: to, width: tailShapeOf(next).width! });
          expect(own(next), label).toEqual(own(fresh));
        }
      }
    },
  );

  it('keeps the lean of a pin and the depth of a diamond when the width is set, and the way the rail leaves a corner', () => {
    const pin = applyTailShape(board('mirror'), { shape: 'pin' });
    const wider = applyTailShape(pin, { shape: 'pin', width: tailShapeOf(pin).width! + 4 });
    expect(wider.outline.plus.knots[0]!.out[0]).toBe(pin.outline.plus.knots[0]!.out[0]);
    expect(tailShapeOf(wider).shape).toBe('pin');
    const diamond = applyTailShape(board('mirror'), { shape: 'diamond' });
    const bigger = applyTailShape(diamond, {
      shape: 'diamond',
      width: tailShapeOf(diamond).width! + 4,
    });
    expect(bigger.outline.plus.knots[1]!.p[0]).toBe(diamond.outline.plus.knots[1]!.p[0]);
    const leaves = (d: RailsBoard): readonly [number, number] => {
      const c = d.outline.plus.knots[1]!;
      return [c.out[0] - c.p[0], c.out[1] - c.p[1]];
    };
    expect(leaves(bigger)).toEqual(leaves(diamond));
    // a squash whose rail leaves its corner as the shaper drew it
    const squash = applyTailShape(board('mirror'), { shape: 'squash' });
    const knots = squash.outline.plus.knots.map((q, i) =>
      i === 1 ? { ...q, out: [q.out[0] + 2, q.out[1]] as [number, number] } : q,
    );
    const drawn = { ...squash, outline: { plus: { knots } } };
    expect(tailShapeOf(drawn).shape).toBe('squash');
    const wide = applyTailShape(drawn, { shape: 'squash', width: tailShapeOf(drawn).width! + 3 });
    expect(leaves(wide)[0]).toBeCloseTo(leaves(drawn)[0], 12);
  });
});

describe('choosing a shape', () => {
  it('replaces a custom tail, and the undo restores it exactly', () => {
    const store = createRailsStore();
    const doc = board('mirror');
    store.getState().loadDoc(doc);
    expect(tailShapeOf(doc).shape).toBe('custom');
    store.getState().setTailShape({ shape: 'squash' });
    const squash = store.getState().doc!;
    expect(tailShapeOf(squash).shape).toBe('squash');
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().past[0]!.label).toBe('Squash tail');
    store.getState().undo();
    expect(store.getState().doc).toBe(doc);
    store.getState().redo();
    expect(store.getState().doc).toBe(squash);
  });

  it('is one undo step for a drag of the width, from the document the drag began with', () => {
    const store = createRailsStore();
    store.getState().loadDoc(board('mirror'));
    store.getState().setTailShape({ shape: 'squash' });
    const squash = store.getState().doc!;
    const range = tailWidthRange(squash, 'squash');
    store.getState().beginEdit();
    for (const w of [range.min, range.max, (range.min + range.max) / 2, 12]) {
      store.getState().setTailShape({ shape: 'squash', width: w });
    }
    store.getState().endEdit();
    expect(store.getState().past).toHaveLength(2);
    expect(store.getState().past[1]!.label).toBe('Set tail width');
    expect(tailShapeOf(store.getState().doc!).width).toBeCloseTo(12, 9);
    store.getState().undo();
    expect(store.getState().doc).toBe(squash);
  });

  it('is one undo step for a drag of a notch, and a drag back to where it began leaves the board as it was', () => {
    const store = createRailsStore();
    store.getState().loadDoc(board('swallow-shortboard'));
    const was = store.getState().doc!;
    store.getState().beginEdit();
    store.getState().setTailShape({ shape: 'swallow', notch: 20 });
    store.getState().setTailShape({ shape: 'swallow', notch: tailShapeOf(was).notch! });
    store.getState().endEdit();
    expect(store.getState().doc).toBe(was);
    // the same call outside a drag records nothing
    const steps = store.getState().past.length;
    store.getState().setTailShape({ shape: 'swallow', notch: tailShapeOf(was).notch! });
    expect(store.getState().past).toHaveLength(steps);
    store.getState().undo();
    store.getState().beginEdit();
    store.getState().setTailShape({ shape: 'swallow', notch: 20 });
    store.getState().endEdit();
    expect(store.getState().past.at(-1)!.label).toBe('Set notch depth');
    expect(tailShapeOf(store.getState().doc!).notch).toBe(20);
  });
});

describe('holding a width and a depth', () => {
  it('holds a width past either end of its range at that end, and a number that is not a number is not asked', () => {
    const doc = board('mirror');
    for (const shape of TAIL_SHAPES) {
      const range = tailWidthRange(doc, shape);
      expect(tailShapeOf(applyTailShape(doc, { shape, width: -4 })).width, shape).toBeCloseTo(
        range.min,
        9,
      );
      expect(tailShapeOf(applyTailShape(doc, { shape, width: 1e9 })).width, shape).toBeCloseTo(
        range.max,
        9,
      );
      expect(applyTailShape(doc, { shape, width: Number.NaN }), shape).toEqual(
        applyTailShape(doc, { shape }),
      );
      expect(applyTailShape(doc, { shape, width: Infinity }), shape).toEqual(
        applyTailShape(doc, { shape }),
      );
    }
  });

  it('holds a notch depth between 0.5% and 30% of the length', () => {
    const doc = board('swallow-shortboard');
    const L = lengthOf(doc.outline.plus);
    expect(tailNotchRange(doc)).toEqual({ min: 0.005 * L, max: 0.3 * L });
    expect(tailShapeOf(applyTailShape(doc, { shape: 'fish', notch: 0 })).notch).toBeCloseTo(
      0.005 * L,
      9,
    );
    expect(tailShapeOf(applyTailShape(doc, { shape: 'fish', notch: 1e6 })).notch).toBeCloseTo(
      0.3 * L,
      9,
    );
  });

  it('holds the widest to the rail knot, so a tail never narrows again before the rail, on each side', () => {
    for (const [name, make] of everyBoard) {
      const doc = make();
      for (const side of ['plus', 'minus'] as const) {
        const chain = side === 'minus' ? (doc.outline.minus ?? doc.outline.plus) : doc.outline.plus;
        const rail = chain.knots[railKnotIndex(chain)]!;
        const widest = Math.max(...chain.knots.map((k) => k.p[1]));
        for (const shape of TAIL_SHAPES) {
          const range = tailWidthRange(doc, shape, side);
          expect(range.max, `${name} ${side} ${shape}`).toBeLessThanOrEqual(2 * rail.p[1] + 1e-9);
          expect(range.min, `${name} ${side} ${shape}`).toBeLessThanOrEqual(range.max);
          // the share's least, unless a round or a pin's curve cannot be that narrow
          if (shape !== 'round' && shape !== 'pin') {
            expect(range.min).toBeLessThanOrEqual(TAIL_WIDTH_SHARE[shape][0] * 2 * widest + 1e-9);
          }
        }
      }
      // the two sides together can hold what both can
      for (const shape of TAIL_SHAPES) {
        const both = tailWidthRange(doc, shape);
        expect(both.min).toBeLessThanOrEqual(both.max);
        if (doc.outline.minus !== undefined) {
          expect(both.max).toBeLessThanOrEqual(
            Math.min(
              tailWidthRange(doc, shape, 'plus').max,
              tailWidthRange(doc, shape, 'minus').max,
            ) + 1e-9,
          );
        }
      }
    }
  });
});

describe('a notch is one for the whole board, and a side is edited alone only where the tails can differ', () => {
  it('puts a notch on both sides of an asymmetric board whatever side is asked', () => {
    const doc = board('asymmetric');
    for (const side of ['plus', 'minus'] as const) {
      const next = applyTailShape(doc, { shape: 'swallow' }, side);
      expect(next.outline.plus.knots[0]!.p[0]).toBeGreaterThan(0);
      expect(next.outline.minus!.knots[0]!.p[0]).toBe(next.outline.plus.knots[0]!.p[0]);
      expect(tailShapeOf(next, 'plus').shape).toBe('swallow');
      expect(tailShapeOf(next, 'minus').shape).toBe('swallow');
      expect(closedVerdict(next, true).ok).toBe(true);
    }
  });

  it('writes a standard shape on one side of an asymmetric board, and the board then says its sides differ', () => {
    const doc = board('asymmetric');
    const next = applyTailShape(doc, { shape: 'squash' }, 'minus');
    expect(next.outline.plus).toBe(doc.outline.plus);
    expect(tailShapeOf(next, 'minus').shape).toBe('squash');
    expect(tailShapeOf(next, 'plus').shape).toBe('pin');
    expect(tailShapeAt(next)).toMatchObject({ shape: 'custom', sidesDiffer: true });
    expect(closedVerdict(next, true).ok).toBe(true);
    // both sides then
    const both = applyTailShape(next, { shape: 'squash' });
    expect(tailShapeAt(both)).toMatchObject({ shape: 'squash', sidesDiffer: false });
    expect(both.outline.minus).not.toBe(both.outline.plus);
  });

  it("keeps one object for both sides when an asymmetric board's sides are the same object and are written alike", () => {
    const swallow = board('swallow');
    const shared = {
      ...swallow,
      symmetry: 'asymmetric' as const,
      outline: { plus: swallow.outline.plus, minus: swallow.outline.plus },
      corners: { ...swallow.corners, minus: swallow.corners.plus },
    };
    const next = applyTailShape(shared, { shape: 'squash' });
    expect(next.outline.minus).toBe(next.outline.plus);
    expect(next.corners.minus).toBe(next.corners.plus);
  });

  it('has no minus side to name on a mirror board', () => {
    const doc = board('mirror');
    expect(applyTailShape(doc, { shape: 'squash' }, 'minus')).toEqual(
      applyTailShape(doc, { shape: 'squash' }),
    );
    expect(tailShapeAt(applyTailShape(doc, { shape: 'squash' }, 'minus')).sidesDiffer).toBe(false);
  });

  it("reads the two sides of a board together, Custom where their shapes differ and the plus side's otherwise", () => {
    const doc = applyTailShape(board('asymmetric'), { shape: 'squash' });
    const wider = applyTailShape(
      doc,
      { shape: 'squash', width: tailShapeOf(doc).width! + 5 },
      'minus',
    );
    expect(tailShapeAt(wider)).toMatchObject({ shape: 'squash', sidesDiffer: true });
    expect(tailShapeAt(wider).width).toBeCloseTo(tailShapeOf(doc).width!, 9);
  });
});

describe('the corners of the tail follow the shape', () => {
  it("gives every corner a shape makes the default radius and keeps the nose's", () => {
    const doc = board('mirror');
    const squash = applyTailShape(doc, { shape: 'squash' });
    expect(cornerKnots(squash.outline.plus)).toHaveLength(2);
    expect(squash.corners.plus).toEqual([RADIUS_TAIL, doc.corners.plus[0]]);
    expect(squash.corners.nose).toBe(doc.corners.nose);
    const round = applyTailShape(squash, { shape: 'round' });
    expect(round.corners.plus).toEqual([doc.corners.plus[0]]);
  });

  it('keeps the radius of the first corner of the old tail, and sets the crotch and the tail point to their defaults', () => {
    const swallow = board('swallow-shortboard');
    const rounder = setCornerRadius(swallow, 0, 1.4);
    expect(rounder.corners.plus[0]).toBe(1.4);
    const fish = applyTailShape(rounder, { shape: 'fish' });
    expect(fish.corners.plus[0]).toBe(1.4);
    const diamond = applyTailShape(fish, { shape: 'diamond' });
    expect(diamond.corners.plus[0]).toBe(1.4);
    expect(diamond.corners.tail).toBe(RADIUS_TAIL);
    expect(applyTailShape(board('mirror'), { shape: 'swallow' }).corners.tail).toBe(RADIUS_CROTCH);
    expect(applyTailShape(rounder, { shape: 'squash' }).corners.tail).toBe(RADIUS_TAIL);
  });

  it('keeps a crotch the shaper rounded when the shape stays notched', () => {
    const doc = setCornerRadius(board('swallow-shortboard'), 'tail', 1.1);
    expect(applyTailShape(doc, { shape: 'fish' }).corners.tail).toBe(1.1);
    expect(applyTailShape(doc, { shape: 'swallow', notch: 15 }).corners.tail).toBe(1.1);
  });
});

describe('the corners of the tail and their radii', () => {
  it("lists the notch crotch and the tips of a swallow, tail first, in a shaper's words", () => {
    const corners = tailCorners(board('swallow-shortboard'));
    expect(corners.map((c) => [c.label, c.role, c.side])).toEqual([
      ['tail tip', 'tip', 'plus'],
      ['notch crotch', 'crotch', 'tail'],
    ]);
    expect(corners[0]!.radius).toBe(0.6);
    expect(corners[1]!.radius).toBe(RADIUS_CROTCH);
    expect(corners.map((c) => c.point[0])).toEqual([
      0,
      tailShapeOf(board('swallow-shortboard')).notch,
    ]);
  });

  it('names the corners of an asymmetric board by side, and of a mirror board once', () => {
    const asym = applyTailShape(board('asymmetric'), { shape: 'squash' });
    expect(tailCorners(asym).map((c) => c.label)).toEqual([
      'tail corner, left',
      'tail corner, right',
    ]);
    const mirror = applyTailShape(board('mirror'), { shape: 'squash' });
    expect(tailCorners(mirror).map((c) => c.label)).toEqual(['tail corner']);
  });

  it('lists the tail point only where the two sides leave it at a slant, and never the nose', () => {
    for (const shape of TAIL_SHAPES) {
      const corners = tailCorners(applyTailShape(board('mirror'), { shape }));
      const point = corners.filter((c) => c.role === 'point');
      expect(point.length, shape).toBe(shape === 'pin' || shape === 'diamond' ? 1 : 0);
      expect(
        corners.every((c) => c.point[0] < 94),
        shape,
      ).toBe(true);
    }
    // a board whose tail is drawn soft has no corner in its tail at all
    expect(tailCorners(board('mirror'))).toEqual([]);
    expect(tailCorners(board('funboard'))).toEqual([]);
  });

  it('gives a corner the turn the outline makes there', () => {
    const squash = applyTailShape(board('mirror'), { shape: 'squash' });
    const [corner] = tailCorners(squash);
    expect(corner!.turn).toBeCloseTo(cornerTurn(squash.outline.plus, 1), 12);
    expect(corner!.turn).toBeGreaterThan(0.5);
    expect(cornerTurn(squash.outline.plus, 0)).toBe(0);
  });

  it('gives the direction from a corner to the arc the engine builds there: its middle lies that way', () => {
    // (the pieces beside a corner are curves, so the arc's own centre is where its tangent points put it; the direction is
    // the one the corner's own headings give; the test is that the arc's middle lies roughly that way from the corner, a quarter of a turn either side of it at most, which a flipped sign or a wrong side does not)
    const cases = [
      ['mirror', 'squash'],
      ['mirror', 'diamond'],
      ['mirror', 'pin'],
      ['swallow-shortboard', 'swallow'],
      ['fish-shortboard', 'fish'],
      ['asymmetric', 'squash'],
    ] as const;
    for (const [name, shape] of cases) {
      const doc = applyTailShape(board(name), { shape });
      for (const c of tailCorners(doc)) {
        const label = `${name} ${shape} ${c.label}`;
        const r = Math.min(4, c.range.max);
        const sized =
          c.side === 'tail'
            ? setCornerRadius(doc, 'tail', r)
            : setCornerRadius(doc, c.index, r, c.side);
        const sign = c.side === 'minus' ? -1 : 1;
        const y = sign * c.point[1];
        const { points } = arcAt(builtArcs(sized)!, c.point[0], y)!.arc;
        const n = points.length / 2;
        // the middle of the arc: the mean of its samples, which are spread evenly round it
        let mx = 0;
        let my = 0;
        for (let k = 0; k < points.length; k += 2) {
          mx += points[k]! / n;
          my += points[k + 1]! / n;
        }
        const mid: [number, number] = [mx - c.point[0], my - y];
        const toward: [number, number] = [c.toCenter[0], sign * c.toCenter[1]];
        expect(Math.hypot(c.toCenter[0], c.toCenter[1]), label).toBeCloseTo(1, 12);
        const cos = (mid[0] * toward[0] + mid[1] * toward[1]) / Math.hypot(mid[0], mid[1]);
        expect(Math.acos(Math.min(1, cos)), label).toBeLessThan(0.9);
      }
    }
  });

  it('takes a turn for a corner where the engine does: it rounds one whose sine is `CORNER_MIN_TURN` or more, and joins the pieces of a smaller one', () => {
    const doc = applyTailShape(board('mirror'), { shape: 'squash' });
    const corner = doc.outline.plus.knots[1]!;
    // the corner's rail leaves it at a given sine off the straight tail end that arrives there
    const leaving = (sine: number): RailsBoard => ({
      ...doc,
      outline: {
        plus: {
          knots: doc.outline.plus.knots.map((k, i) =>
            i === 1
              ? {
                  ...k,
                  out: [k.p[0] + 4 * sine, k.p[1] + 4 * Math.sqrt(1 - sine * sine)] as [
                    number,
                    number,
                  ],
                }
              : k,
          ),
        },
      },
    });
    const rounded = (d: RailsBoard): boolean => {
      const near = arcAt(builtArcs(d)!, corner.p[0], corner.p[1]);
      return near !== null && near.distance < 1;
    };
    expect(rounded(leaving(CORNER_MIN_TURN * 0.7))).toBe(false);
    expect(rounded(leaving(CORNER_MIN_TURN * 1.4))).toBe(true);
  });

  it('sets a radius held to its range, never refusing, and not at all for a number that is not one', () => {
    const doc = board('swallow-shortboard');
    const [tip, crotch] = tailCorners(doc);
    expect(setCornerRadius(doc, 0, 0.01).corners.plus[0]).toBe(TIP_RADIUS_MIN);
    expect(setCornerRadius(doc, 0, 99).corners.plus[0]).toBe(tip!.range.max);
    expect(setCornerRadius(doc, 'tail', 0).corners.tail).toBe(CORNER_RADIUS_MIN);
    expect(setCornerRadius(doc, 'tail', 99).corners.tail).toBe(crotch!.range.max);
    expect(setCornerRadius(doc, 0, 1.3).corners.plus[0]).toBe(1.3);
    expect(setCornerRadius(doc, 0, Number.NaN)).toBe(doc);
    expect(setCornerRadius(doc, 5, 1)).toBe(doc);
    expect(setCornerRadius(doc, -1, 1)).toBe(doc);
    expect(setCornerRadius(doc, 0, tip!.radius)).toBe(doc);
    expect(setCornerRadius(doc, 'tail', crotch!.radius)).toBe(doc);
  });

  it('changes only the radius it is given, by reference', () => {
    const doc = deepFreeze(board('fish-shortboard'));
    const next = setCornerRadius(doc, 0, 1.2);
    expect(next.outline).toBe(doc.outline);
    expect(next.stations).toBe(doc.stations);
    expect(next.corners.nose).toBe(doc.corners.nose);
    expect(next.corners.plus).toEqual([1.2, doc.corners.plus[1]]);
  });

  it('sets the one list a mirror board has, and a side of an asymmetric board alone or both', () => {
    const mirror = applyTailShape(board('mirror'), { shape: 'squash' });
    expect(setCornerRadius(mirror, 0, 1.5, 'minus').corners.plus[0]).toBe(1.5);
    const asym = applyTailShape(board('asymmetric'), { shape: 'squash' });
    const left = setCornerRadius(asym, 0, 1.5, 'plus');
    expect([left.corners.plus[0], left.corners.minus![0]]).toEqual([1.5, RADIUS_TAIL]);
    const right = setCornerRadius(asym, 0, 1.5, 'minus');
    expect([right.corners.plus[0], right.corners.minus![0]]).toEqual([RADIUS_TAIL, 1.5]);
    const both = setCornerRadius(asym, 0, 1.5);
    expect([both.corners.plus[0], both.corners.minus![0]]).toEqual([1.5, 1.5]);
    // a minus list that is the plus list, set on the minus side only, does not move the plus side
    const shared = { ...asym, corners: { ...asym.corners, minus: asym.corners.plus } };
    const one = setCornerRadius(shared, 0, 2, 'minus');
    expect([one.corners.plus[0], one.corners.minus![0]]).toEqual([RADIUS_TAIL, 2]);
  });

  it('is one undo step for a drag of a radius', () => {
    const store = createRailsStore();
    store.getState().loadDoc(board('swallow-shortboard'));
    const was = store.getState().doc!;
    store.getState().beginEdit();
    for (const r of [1, 2, 3, 1.5]) store.getState().setCornerRadius(0, r);
    store.getState().endEdit();
    expect(store.getState().past.map((p) => p.label)).toEqual(['Set corner radius']);
    expect(store.getState().doc!.corners.plus[0]).toBe(1.5);
    store.getState().undo();
    expect(store.getState().doc).toBe(was);
  });

  // The radius a corner is held to is the one the engine builds as asked: it rounds a corner with an arc and, where the arc does
  // not fit, retries a smaller one without saying so (the arc built is 0.6 of the radius asked), and builds no arc at all
  // for a radius of 0.3 mm or less.
  const ENGINE = ['mirror', 'swallow-shortboard', 'funboard', 'asymmetric'] as const;
  for (const name of ENGINE) {
    it.each(TAIL_SHAPES)(
      `builds every corner of the ${name} board with %s at the greatest radius it is held to, as asked`,
      (shape) => {
        const doc = applyTailShape(board(name), { shape });
        for (const c of tailCorners(doc)) {
          const label = `${name} ${shape} ${c.label}`;
          const at = (r: number): RailsBoard =>
            c.side === 'tail'
              ? setCornerRadius(doc, 'tail', r)
              : setCornerRadius(doc, c.index, r, c.side);
          const greatest = at(c.range.max);
          const arcs = builtArcs(greatest)!;
          expect(arcs, label).not.toBeNull();
          const y = c.side === 'minus' ? -c.point[1] : c.point[1];
          const hit = arcAt(arcs, c.point[0], y)!;
          expect(hit.arc.radius / c.range.max, label).toBeGreaterThan(0.97);
          expect(hit.arc.radius / c.range.max, label).toBeLessThan(1.03);
          expect(closedVerdict(greatest, true).ok, label).toBe(true);
          // and at the least it is rounded, if only by a hair
          const least = at(c.range.min);
          expect(arcAt(builtArcs(least)!, c.point[0], y)!.distance, label).toBeLessThan(0.6);
          expect(closedVerdict(least, true).ok, label).toBe(true);
        }
      },
    );
  }
});

describe('where the width is measured', () => {
  it('stands on the corner of a squash, a diamond, a swallow and a fish, and in the outline at the end of the zone on a round and a pin', () => {
    const doc = board('mirror');
    for (const shape of TAIL_SHAPES) {
      const next = applyTailShape(doc, { shape });
      const p = tailWidthPoint(next)!;
      expect(p[1] * 2, shape).toBeCloseTo(tailShapeOf(next).width!, 9);
      const zone = TAIL_ZONE_SHARE * lengthOf(next.outline.plus);
      if (shape === 'round' || shape === 'pin') expect(p[0], shape).toBeCloseTo(zone, 9);
      if (shape === 'squash' || isNotchedShape(shape)) expect(p[0], shape).toBe(0);
      if (shape === 'diamond') expect(p[0], shape).toBeCloseTo(DIAMOND_DEPTH_SHARE * zone, 9);
    }
    expect(tailWidthPoint(board('mirror'))).toBeNull();
  });

  it('leans a pin out by its share of the zone', () => {
    const pin = applyTailShape(board('mirror'), { shape: 'pin' });
    const k = pin.outline.plus.knots[0]!;
    expect(k.out[0]).toBeCloseTo(PIN_LEAD_SHARE * TAIL_ZONE_SHARE * lengthOf(pin.outline.plus), 9);
  });
});

describe('a seeded sequence of calls', () => {
  it.each([
    ['mirror', 11],
    ['asymmetric', 12],
    ['swallow-shortboard', 13],
  ] as const)(
    'on the %s board keeps every part of the contract',
    (name, seed) => {
      const rng = seeded(seed);
      let doc = deepFreeze(board(name));
      const sides = [undefined, 'plus', 'minus'] as const;
      for (let step = 0; step < 40; step++) {
        const was = doc;
        const shape = pick(rng, TAIL_SHAPES);
        const garbage = [undefined, Number.NaN, -3, 0, 1e9, Infinity];
        const range = tailWidthRange(doc, shape);
        const width =
          rng() < 0.3 ? pick(rng, garbage) : between(rng, range.min * 0.5, range.max * 1.2);
        const notch =
          rng() < 0.3 ? pick(rng, garbage) : between(rng, 0, 0.4 * lengthOf(doc.outline.plus));
        const side = pick(rng, sides);
        let next: RailsBoard;
        if (rng() < 0.25 && tailCorners(doc).length > 0) {
          const c = pick(rng, tailCorners(doc));
          next = setCornerRadius(
            doc,
            c.side === 'tail' ? 'tail' : c.index,
            between(rng, -1, 40),
            c.side === 'tail' ? undefined : side,
          );
        } else {
          next = applyTailShape(
            doc,
            {
              shape,
              ...(width === undefined ? {} : { width }),
              ...(isNotchedShape(shape) && notch !== undefined ? { notch } : {}),
            },
            side,
          );
          // it reads as the shape asked, unless the section store refused a notch that would leave fewer than two stations
          if (next !== was)
            expect(
              tailShapeOf(next, 'plus').shape === shape ||
                tailShapeOf(next, 'minus').shape === shape,
            ).toBe(true);
        }
        // the parts a tail does not touch are the board's own
        expect(next.rocker).toBe(was.rocker);
        expect(next.deck).toBe(was.deck);
        expect(next.meta).toBe(was.meta);
        expect(next.rails).toBe(was.rails);
        // every side has a radius for every corner knot, and a number
        for (const s of ['plus', 'minus'] as const) {
          const chain =
            s === 'minus' ? (next.outline.minus ?? next.outline.plus) : next.outline.plus;
          const radii =
            s === 'minus' ? (next.corners.minus ?? next.corners.plus) : next.corners.plus;
          expect(radii.length).toBe(cornerKnots(chain).length);
          expect(radii.every((r) => Number.isFinite(r) && r > 0)).toBe(true);
          expect(chain.knots[0]!.p[1]).toBe(0);
          expect(Math.min(...chain.knots.map((k) => k.p[0]))).toBe(0);
        }
        expect(Number.isFinite(next.corners.tail) && next.corners.tail > 0).toBe(true);
        // the sides of a notch agree on its depth
        if (next.outline.minus !== undefined) {
          expect(next.outline.minus.knots[0]!.p[0]).toBe(next.outline.plus.knots[0]!.p[0]);
        }
        if (step % 7 === 6) expect(closedVerdict(next, true)).toEqual({ ok: true, why: '' });
        doc = next;
      }
    },
    60000,
  );
});
