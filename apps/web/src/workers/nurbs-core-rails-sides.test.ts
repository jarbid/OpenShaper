// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section the worker probes for a rails board: one side for a mirror board whose rail is one list, and
 * both when the right side has rail keys of its own, though the outline is a mirror's (the rail panel's
 * Right side). Without it the slice of such a board would not change when the right rail does.
 */
import * as board2 from '@openshaper/board2';
import { swallowBoard } from '@openshaper/board2/testing';
import { describe, expect, it } from 'vitest';
import { probeDocument } from './nurbs-core';

const mirror = (): board2.RailsBoard => {
  const c = board2.convertSections(swallowBoard());
  if (!c.ok) throw new Error('not convertible');
  return c.value.board;
};

const probe = (doc: board2.RailsBoard, x: number) => {
  const out = probeDocument(doc, [x]);
  if (!out.ok) throw new Error(out.error);
  return out.probes[0]!;
};

describe('a rails board’s probe', () => {
  const doc = mirror();
  const mid = doc.rails.plus[Math.floor(doc.rails.plus.length / 2)]!.x;

  it('has one side for a mirror board whose rails are one list', () => {
    expect(doc.symmetry).toBe('mirror');
    expect(doc.rails.minus).toBeUndefined();
    expect(probe(doc, mid).minus).toBeNull();
  });

  it('has the right side too when the board has rail keys of its own for it, and it is its own rail', () => {
    // the right side's rail: the same keys with a much bigger apex and tuck
    const minus = doc.rails.plus.map((k) => ({
      x: k.x,
      rail: { ...k.rail, apex: 0.25, tuck: k.rail.tuck + 1.5 },
    }));
    const own: board2.RailsBoard = { ...doc, rails: { plus: doc.rails.plus, minus } };
    const p = probe(own, mid);
    expect(p.minus).not.toBeNull();
    expect(p.minus!.length).toBe(p.plus.length);
    // the left side is what it was
    expect(p.plus).toEqual(probe(doc, mid).plus);
    // the right is not the left
    expect(p.minus).not.toEqual(p.plus);
  });

  it('has the same right side as left when the two lists are the same', () => {
    const same: board2.RailsBoard = {
      ...doc,
      rails: { plus: doc.rails.plus, minus: doc.rails.plus },
    };
    const p = probe(same, mid);
    expect(p.minus).toEqual(p.plus);
  });
});
