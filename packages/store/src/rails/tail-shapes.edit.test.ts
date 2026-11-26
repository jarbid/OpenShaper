// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tail through the edits the editor makes. Every outline edit goes through the classic projection, the spline action
 * and its junction rules, and is written back as new knots (`applyRailsEdit`), so a shape that is read by matching
 * must survive that round trip: an edit that is not of the tail leaves the tail the shape it was, a tail knot dragged
 * reads Custom, and the notch bottom, which the store takes for the notch depth, moves the depth and nothing else.
 */
import type { RailsBoard } from '@openshaper/board2';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import type { SplineTarget } from '../edits';
import { createRailsStore } from './rails-store';
import {
  TAIL_SHAPES,
  isNotchedShape,
  railKnotIndex,
  tailShapeOf,
  applyTailShape,
  type TailShapeId,
} from './tail-shapes';
import { everyBoard } from './test-support/real-boards';

const board = (name: string): RailsBoard => everyBoard.find(([n]) => n === name)![1]();

/** A store with `shape` applied to the golden shortboard. */
function withShape(shape: TailShapeId) {
  const store = createRailsStore();
  store.getState().loadDoc(applyTailShape(board('mirror'), { shape }));
  return store;
}

/** The outline of the board the store shows (the classic projection), knot by knot. */
const outline = (store: ReturnType<typeof createRailsStore>) =>
  store.getState().board!.outline.knots;

describe.each(TAIL_SHAPES)('a %s tail through the editor', (shape) => {
  it('is still the shape after an edit of the rail, the nose, the rocker and the deck', () => {
    const store = withShape(shape);
    const g = store.getState;
    const before = tailShapeOf(g().doc!);
    expect(before.shape).toBe(shape);
    const rail = railKnotIndex(g().doc!.outline.plus);
    const move = (target: SplineTarget, index: number, dx: number, dy: number): void => {
      const list =
        target.kind === 'outline'
          ? outline(store)
          : target.kind === 'bottom'
            ? g().board!.bottom.knots
            : g().board!.deck.knots;
      const k = list[index]!;
      g().beginEdit();
      g().moveControlPoint(target, index, vec2(k.end.x + dx, k.end.y + dy));
      g().endEdit();
    };
    // the first knot at or past the tail zone: the rail's, which is not the tail's to hold
    move({ kind: 'outline' }, rail, 0, 1.5);
    expect(tailShapeOf(g().doc!), 'the rail knot').toMatchObject({ shape });
    // the nose: the length changes, and with it the end of the tail zone
    move({ kind: 'outline' }, outline(store).length - 1, 4, 0);
    expect(tailShapeOf(g().doc!), 'the nose').toMatchObject({ shape });
    move({ kind: 'bottom' }, 1, 0, 0.3);
    expect(tailShapeOf(g().doc!), 'the rocker').toMatchObject({ shape });
    move({ kind: 'deck' }, 1, 0, 0.3);
    expect(tailShapeOf(g().doc!), 'the deck').toMatchObject({ shape });
    // and the numbers are those of the tail, not of the edit
    expect(tailShapeOf(g().doc!).notch).toBeCloseTo(before.notch ?? 0, 6);
    if (isNotchedShape(shape) || shape === 'squash' || shape === 'diamond') {
      expect(tailShapeOf(g().doc!).width).toBeCloseTo(before.width!, 6);
    }
  });

  it('reads Custom when a point of the tail is dragged, in one undo step that restores the shape', () => {
    const store = withShape(shape);
    const g = store.getState;
    const was = g().doc!;
    // a round and a pin have one tail knot, the point on the stringer, which holds still: drag its handle
    const own = railKnotIndex(was.outline.plus) - 1;
    const knot = shape === 'round' || shape === 'pin' ? 0 : own;
    g().beginEdit();
    if (knot === 0) {
      const k = outline(store)[0]!;
      g().moveTangent(
        { kind: 'outline' },
        0,
        'next',
        vec2(
          k.tangentToNext.x + (shape === 'round' ? 0.5 : 0),
          k.tangentToNext.y + (shape === 'round' ? 0 : 0),
        ),
      );
    } else {
      const k = outline(store)[knot]!;
      g().moveControlPoint({ kind: 'outline' }, knot, vec2(k.end.x + 0.5, k.end.y + 0.5));
    }
    g().endEdit();
    if (shape === 'pin') {
      // a pin's lean is its own number: dragged along x it is a pin of another lean
      expect(tailShapeOf(g().doc!).shape).toBe('pin');
    } else {
      expect(tailShapeOf(g().doc!).shape).toBe('custom');
    }
    g().undo();
    expect(g().doc).toBe(was);
    expect(tailShapeOf(g().doc!).shape).toBe(shape);
  });
});

describe('the notch bottom', () => {
  it.each(['swallow', 'fish'] as const)(
    'of a %s is the notch depth: dragged along the stringer it is the same shape, deeper',
    (shape) => {
      const store = withShape(shape);
      const g = store.getState;
      const was = tailShapeOf(g().doc!);
      const k = outline(store)[0]!;
      g().beginEdit();
      g().moveControlPoint({ kind: 'outline' }, 0, vec2(k.end.x + 2, 0));
      g().endEdit();
      const now = tailShapeOf(g().doc!);
      expect(now.shape).toBe(shape);
      expect(now.notch!).toBeCloseTo(was.notch! + 2, 6);
      expect(now.width).toBeCloseTo(was.width!, 6);
    },
  );
});
