// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deck-shape action of the rails store (`setDeckShape`): one undo step that undo and redo
 * restore exactly, nothing recorded when nothing changes, a drag (a dial, a held key) one step
 * computed from the document the drag began with so a crown is a function of the pointer, a knot
 * dragged afterwards reads Custom, and choosing a shape again replaces that curve and undoes back to
 * it exactly.
 */
import type { RailsBoard } from '@openshaper/board2';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { applyDeckShape, deckShapeAt, deckCrownRangeAt } from './deck-shapes';
import { createRailsStore } from './rails-store';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';

const storeWith = (doc: RailsBoard) => {
  const store = createRailsStore();
  store.getState().loadDoc(doc);
  return store;
};

describe.each(everyBoard)('setDeckShape on the %s board', (_name, make) => {
  const doc = make();
  const station = Math.floor(doc.stations.length / 2);
  const scope = { station, all: true };

  it('is one undo step that undo and redo restore exactly', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'domed', crown: 1.2 }, scope);
    const after = s.getState().doc!;
    expect(after).not.toBe(doc);
    expect(s.getState().past).toHaveLength(1);
    expect(s.getState().past[0]!.label).toBe('Deck crown');
    s.getState().undo();
    expect(s.getState().doc).toBe(doc);
    expect(s.getState().past).toHaveLength(0);
    s.getState().redo();
    expect(s.getState().doc).toBe(after);
  });

  it('records nothing when it changes nothing', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'domed', crown: 1.2 }, scope);
    const once = s.getState().doc;
    s.getState().setDeckShape({ shape: 'domed', crown: 1.2 }, scope);
    expect(s.getState().doc).toBe(once);
    expect(s.getState().past).toHaveLength(1);
  });

  it('names the step for what was done', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'flat' }, scope);
    s.getState().setDeckShape({ shape: 'domed' }, scope);
    s.getState().setDeckShape({ shape: 'domed', crown: 1 }, scope);
    expect(s.getState().past.map((p) => p.label)).toEqual([
      'Flat deck',
      'Domed deck',
      'Deck crown',
    ]);
    expect(deckShapeAt(s.getState().doc!, station)!.crown).toBeCloseTo(1, 9);
  });

  it('is one step for a drag, and the crown follows the pointer from where the drag began', () => {
    const s = storeWith(doc);
    // from a flat deck: the crown of each station is then a share of its thickness
    s.getState().setDeckShape({ shape: 'flat' }, scope);
    const origin = s.getState().doc!;
    const range = deckCrownRangeAt(origin, station)!;
    s.getState().beginEdit();
    // up past what the station can hold, and back to a crown in between
    for (const crown of [0.3, range.max * 2, range.max * 3, 0.9]) {
      s.getState().setDeckShape({ shape: 'domed', crown }, scope);
    }
    s.getState().endEdit();
    expect(s.getState().past).toHaveLength(2);
    expect(s.getState().doc).toEqual(applyDeckShape(origin, { shape: 'domed', crown: 0.9 }, scope));
    expect(deckShapeAt(s.getState().doc!, station)!.crown).toBeCloseTo(0.9, 9);
    s.getState().undo();
    expect(s.getState().doc).toBe(origin);
  });

  it('builds a closed board at the greatest crown', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'domed', crown: 1e9 }, scope);
    expect(closedVerdict(s.getState().doc!, true).ok).toBe(true);
  });
});

describe('a deck that is drawn stays the shaper’s', () => {
  const doc = everyBoard.find(([n]) => n === 'mirror')![1]();
  const station = 2;
  const target = { kind: 'stationDeck', index: station } as const;

  it('reads Custom after a knot is dragged, and choosing a shape replaces it, undoably', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'domed', crown: 1.5 }, { station, all: false });
    const domed = s.getState().doc!;
    expect(deckShapeAt(domed, station)!.shape).toBe('domed');

    // drag the end knot down by a millimetre: the curve is no longer an arc
    const knots = s.getState().board!.stationCurves[station]!.deck.knots;
    const end = knots[knots.length - 1]!.end;
    s.getState().moveControlPoint(target, knots.length - 1, vec2(end.x, end.y - 0.1));
    const drawn = s.getState().doc!;
    expect(drawn).not.toBe(domed);
    expect(deckShapeAt(drawn, station)!.shape).toBe('custom');

    // a shape chosen again replaces what was drawn, with no question asked
    s.getState().setDeckShape({ shape: 'domed' }, { station, all: false });
    const replaced = s.getState().doc!;
    expect(replaced).not.toBe(drawn);
    expect(deckShapeAt(replaced, station)!.shape).toBe('domed');

    // and the undo brings the drawn curve back, exactly
    s.getState().undo();
    expect(s.getState().doc).toBe(drawn);
    expect(deckShapeAt(s.getState().doc!, station)!.shape).toBe('custom');
  });

  it('keeps the shaper’s curve at the stations a shape was not applied to', () => {
    const s = storeWith(doc);
    s.getState().setDeckShape({ shape: 'flat' }, { station, all: false });
    const next = s.getState().doc!;
    next.stations.forEach((st, i) => {
      if (i !== station) expect(st.plus.deck).toBe(doc.stations[i]!.plus.deck);
    });
  });

  it('drops a selected knot that the new curve no longer has, and keeps one it still has', () => {
    const s = storeWith(doc);
    const last = s.getState().board!.stationCurves[station]!.deck.knots.length - 1;
    s.getState().select({ target, index: last });
    s.getState().setDeckShape({ shape: 'flat' }, { station, all: false });
    expect(s.getState().selection).toBeNull();
    // a station other than the one chosen: the selection stands
    const t2 = { kind: 'stationDeck', index: 1 } as const;
    s.getState().select({ target: t2, index: 1 });
    s.getState().setDeckShape({ shape: 'domed' }, { station, all: false });
    expect(s.getState().selection).toEqual({ target: t2, index: 1 });
  });
});
