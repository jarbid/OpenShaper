// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail-zone actions of the rails store: each is one undo step that undo and redo restore
 * exactly, does nothing when it changes nothing, is part of the open drag (and is then a function
 * of the pointer), reaches one side or both, and leaves a board the engine builds closed.
 */
import type { RailsBoard } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { createRailsStore } from './rails-store';
import { railsBoards } from './test-support/boards';
import { closedVerdict } from './test-support/closed';
import { rail } from './test-support/zone-kit';
import type { RailKey } from './types';
import * as zones from './zones';

const storeWith = (doc: RailsBoard) => {
  const store = createRailsStore();
  store.getState().loadDoc(doc);
  return store;
};

const HARD = rail({
  band: 1,
  hardness: 0.6,
  tuck: 0.3,
  tuckShape: 0.8,
  bottomEdge: 35,
  deckEdge: 0,
  apex: 0.35,
});

const lengthOf = (b: RailsBoard): number => b.outline.plus.knots.at(-1)!.p[0];

/** Every part of the document but its rails is the object it was. */
function expectOnlyRailsChanged(next: RailsBoard, was: RailsBoard): void {
  for (const k of Object.keys(was) as (keyof RailsBoard)[]) {
    if (k !== 'rails') expect(next[k], k).toBe(was[k]);
  }
}

describe.each(railsBoards)('the rail zone actions on the %s board', (_name, make) => {
  const doc = make();
  const length = lengthOf(doc);
  const keys = doc.rails.plus;
  /** A zone in the middle of the board with room either side: every key is its own zone here. */
  const mid = Math.floor(keys.length / 2);
  const between = (keys[mid]!.x + keys[mid + 1]!.x) / 2;

  type Store = ReturnType<typeof storeWith>;
  const run: [string, string, (s: Store) => void, RailsBoard['rails']][] = [
    [
      'setZoneRail',
      'Edit rail',
      (s) => s.getState().setZoneRail('plus', mid, HARD),
      zones.editSides(doc.rails, 'plus', (k) => zones.setZoneRail(k, mid, HARD)),
    ],
    [
      'setZoneNumber',
      'Edit rail',
      (s) => s.getState().setZoneNumber('plus', mid, 'bottomEdge', 40),
      zones.editSides(doc.rails, 'plus', (k) => zones.setZoneNumber(k, mid, 'bottomEdge', 40)),
    ],
    [
      'moveZoneEnd',
      'Move rail zone',
      (s) => s.getState().moveZoneEnd('plus', mid, 'to', keys[mid]!.x + 10),
      zones.editSides(doc.rails, 'plus', (k) =>
        zones.moveZoneEnd(k, mid, 'to', keys[mid]!.x + 10, length),
      ),
    ],
    [
      'moveZone',
      'Move rail zone',
      (s) => s.getState().moveZone('plus', mid, 5),
      zones.editSides(doc.rails, 'plus', (k) => zones.moveZone(k, mid, 5, length)),
    ],
    [
      'splitZoneAt',
      'Add rail zone',
      (s) => s.getState().splitZoneAt('plus', between, HARD),
      zones.editSides(doc.rails, 'plus', (k) => zones.splitZoneAt(k, between, length, HARD)),
    ],
    [
      'removeZone',
      'Remove rail zone',
      (s) => s.getState().removeZone('plus', mid),
      zones.editSides(doc.rails, 'plus', (k) => zones.removeZone(k, mid)),
    ],
    [
      'tidyRails',
      'Tidy rails',
      (s) => s.getState().tidyRails('plus', 50),
      zones.editSides(doc.rails, 'plus', (k) => zones.tidyRails(k, 50, length)),
    ],
  ];

  it.each(run)(
    '%s is one named undo step that undo and redo restore exactly, and leaves a closed board',
    (_action, label, act, expected) => {
      const store = storeWith(doc);
      const g = store.getState;
      act(store);
      const next = g().doc!;
      expect(g().past.map((p) => p.label)).toEqual([label]);
      expect(next).not.toBe(doc);
      expect(next.rails).toEqual(expected);
      expect(next.rails).not.toEqual(doc.rails);
      expectOnlyRailsChanged(next, doc);
      // the other side's keys are the objects they were
      if (doc.rails.minus !== undefined) expect(next.rails.minus).toBe(doc.rails.minus);
      expect(closedVerdict(next, true)).toEqual({ ok: true, why: '' });
      g().undo();
      expect(g().doc).toBe(doc);
      g().redo();
      expect(g().doc).toBe(next);
      expect(g().past).toHaveLength(1);
    },
    30_000,
  );

  it('does nothing, and records no step, when an action changes nothing', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const own = keys[mid]!;
    g().setZoneRail('plus', mid, own.rail);
    g().setZoneRail('plus', 99, HARD);
    g().setZoneRail('plus', -1, HARD);
    g().setZoneNumber('plus', mid, 'apex', own.rail.apex);
    g().setZoneNumber('plus', mid, 'apex', Number.NaN);
    g().moveZoneEnd('plus', mid, 'from', own.x);
    g().moveZoneEnd('plus', mid, 'from', Number.NaN);
    g().moveZone('plus', mid, 0);
    g().splitZoneAt('plus', own.x);
    g().removeZone('plus', 99);
    g().tidyRails('plus', 0);
    // sides that are one already stay one (on an asymmetric board linking is a real change)
    if (doc.rails.minus === undefined) g().linkRailSides('plus');
    // an edit of the minus side that changes nothing does not unlock the board
    g().setZoneRail('minus', 99, HARD);
    g().setZoneNumber('both', 99, 'apex', 0.3);
    expect(g().past).toHaveLength(0);
    expect(g().doc).toBe(doc);
    if (doc.rails.minus === undefined) expect(g().doc!.rails.minus).toBeUndefined();
    if (doc.rails.minus !== undefined) {
      // an asymmetric board is unlocked already
      g().unlockRailSide();
      expect(g().past).toHaveLength(0);
    }
  });

  it('is part of the open drag: many moves of a zone end are one step, a function of the pointer', () => {
    const store = storeWith(doc);
    const g = store.getState;
    g().beginEdit();
    const at = (i: number) => keys[mid]!.x + 2 + i * 1.5;
    for (let i = 0; i < 12; i++) g().moveZoneEnd('plus', mid, 'to', at(i));
    // back towards the start, so a move that only ever extended would be caught
    g().moveZoneEnd('plus', mid, 'to', at(5));
    g().endEdit();
    expect(g().past.map((p) => p.label)).toEqual(['Move rail zone']);
    const expected = zones.moveZoneEnd(keys, mid, 'to', at(5), length);
    expect(g().doc!.rails.plus).toEqual(expected);
    expect(g().doc!.rails.plus).toHaveLength(keys.length + 1);
    g().undo();
    expect(g().doc).toBe(doc);
  });

  it('measures a slide from where the drag began, so a slide that hits a limit and returns follows the pointer', () => {
    const store = storeWith(doc);
    const g = store.getState;
    g().beginEdit();
    for (const dx of [3, 8, 400, -400, 2, 5]) g().moveZone('plus', mid, dx);
    g().endEdit();
    expect(g().past).toHaveLength(1);
    expect(g().doc!.rails.plus[mid]!.x).toBe(keys[mid]!.x + 5);
    expect(g().doc!.rails.plus.filter((_, i) => i !== mid)).toEqual(
      keys.filter((_, i) => i !== mid),
    );
  });

  it('keeps a zone apart from its neighbour when a dial passes through the neighbour numbers', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const neighbour = keys[mid - 1]!.rail;
    // the middle zone is the neighbour's rail but for its apex
    g().setZoneRail('plus', mid, { ...neighbour, apex: neighbour.apex - 0.15 });
    const before = g().doc!;
    expect(zones.railZones(before.rails.plus).zones).toHaveLength(keys.length);
    g().beginEdit();
    for (const apex of [
      neighbour.apex - 0.1,
      neighbour.apex - 0.02,
      neighbour.apex,
      neighbour.apex + 0.1,
    ]) {
      g().setZoneNumber('plus', mid, 'apex', apex);
    }
    g().endEdit();
    const after = g().doc!;
    expect(after.rails.plus[mid]!.rail.apex).toBeCloseTo(neighbour.apex + 0.1, 12);
    // the neighbour kept its own apex, and there are still as many zones
    expect(after.rails.plus[mid - 1]!.rail.apex).toBe(neighbour.apex);
    expect(zones.railZones(after.rails.plus).zones).toHaveLength(keys.length);
    expect(g().past.map((p) => p.label)).toEqual(['Edit rail', 'Edit rail']);
  });

  it('lets a different action carry on inside a drag: add a zone, then drag its end, is one step', () => {
    const store = storeWith(doc);
    const g = store.getState;
    g().beginEdit();
    g().splitZoneAt('plus', between, HARD);
    const added = zones.zoneIndexAt(g().doc!.rails.plus, between);
    expect(g().doc!.rails.plus).toHaveLength(keys.length + 1);
    for (const dx of [1, 2, 3]) g().moveZoneEnd('plus', added, 'to', between + dx);
    g().endEdit();
    expect(g().past).toHaveLength(1);
    expect(g().doc!.rails.plus).toHaveLength(keys.length + 2);
    g().undo();
    expect(g().doc).toBe(doc);
  });

  it('does not undo another edit made inside a drag', () => {
    const store = storeWith(doc);
    const g = store.getState;
    g().beginEdit();
    g().moveZoneEnd('plus', mid, 'to', keys[mid]!.x + 4);
    const renamed = { ...g().doc!, meta: { ...g().doc!.meta, name: 'renamed' } };
    g().commitDoc(renamed, 'Rename');
    g().moveZoneEnd('plus', mid, 'to', keys[mid]!.x + 6);
    g().endEdit();
    expect(g().doc!.meta.name).toBe('renamed');
    expect(g().doc!.rails.plus[mid + 1]!.x).toBe(keys[mid]!.x + 6);
  });

  it('takes the length of the board from the document: its outline, not its last station', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const last = zones.railZones(keys).zones.length - 1;
    g().moveZoneEnd('plus', last, 'to', 1e9);
    expect(g().doc!.rails.plus.at(-1)!.x).toBe(length);
    g().moveZoneEnd('plus', 0, 'from', -1e9);
    expect(g().doc!.rails.plus[0]!.x).toBe(0);
  });
});

describe('the rail zone actions and the two sides', () => {
  const mirror = railsBoards.find(([n]) => n === 'mirror')![1]();
  const asym = railsBoards.find(([n]) => n === 'asymmetric')![1]();

  it('unlockRailSide gives a mirror board a minus side that is the plus list, as one step', () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().unlockRailSide();
    expect(g().doc!.rails.plus).toBe(mirror.rails.plus);
    expect(g().doc!.rails.minus).toBe(mirror.rails.plus);
    expect(g().past.map((p) => p.label)).toEqual(['Unlock rail sides']);
    expect(closedVerdict(g().doc!, true).ok).toBe(true);
    g().undo();
    expect(g().doc).toBe(mirror);
  });

  it('an edit of the minus side after that leaves the plus keys the object they were', () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().unlockRailSide();
    const plus = g().doc!.rails.plus;
    g().setZoneRail('minus', 1, HARD);
    expect(g().doc!.rails.plus).toBe(plus);
    expect(g().doc!.rails.minus).not.toBe(plus);
    expect(g().doc!.rails.minus![1]!.rail).toEqual(HARD);
    expect(zones.sidesLinked(g().doc!.rails)).toBe(false);
    expect(closedVerdict(g().doc!, true).ok).toBe(true);
  });

  it('an edit of the minus side of a board with no minus keys unlocks it first, in the same step', () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().setZoneRail('minus', 1, HARD);
    expect(g().past).toHaveLength(1);
    expect(g().doc!.rails.plus).toBe(mirror.rails.plus);
    expect(g().doc!.rails.minus![1]!.rail).toEqual(HARD);
    expect(g().doc!.rails.minus![0]).toBe(mirror.rails.plus[0]);
  });

  it('linkRailSides drops the minus side of a mirror board, keeping the side named', () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().setZoneRail('minus', 1, HARD);
    const minus = g().doc!.rails.minus!;
    g().linkRailSides('minus');
    expect(g().doc!.rails.minus).toBeUndefined();
    expect(g().doc!.rails.plus).toBe(minus);
    g().undo();
    expect(g().doc!.rails.minus).toBe(minus);
    g().linkRailSides('plus');
    expect(g().doc!.rails.minus).toBeUndefined();
    expect(g().doc!.rails.plus).toBe(mirror.rails.plus);
    expect(g().past.map((p) => p.label)).toEqual(['Edit rail', 'Link rail sides']);
  });

  it('linkRailSides on an asymmetric board shares the kept keys, which the engine needs, and builds', () => {
    const store = storeWith(asym);
    const g = store.getState;
    g().linkRailSides('minus');
    const rails = g().doc!.rails;
    expect(rails.plus).toBe(asym.rails.minus);
    expect(rails.minus).toBe(asym.rails.minus);
    expect(closedVerdict(g().doc!, true).ok).toBe(true);
    // linking again changes nothing, as the sides are one already
    g().linkRailSides('plus');
    expect(g().past).toHaveLength(1);
  });

  it("'both' on a board with one side edits that side", () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().setZoneRail('both', 1, HARD);
    expect(g().doc!.rails.minus).toBeUndefined();
    expect(g().doc!.rails.plus[1]!.rail).toEqual(HARD);
    expect(g().past).toHaveLength(1);
  });

  it("'both' on sides that share one list edits that list once and keeps it shared", () => {
    const store = storeWith(mirror);
    const g = store.getState;
    g().unlockRailSide();
    g().setZoneRail('both', 1, HARD);
    const rails = g().doc!.rails;
    expect(rails.plus).toBe(rails.minus);
    expect(rails.plus[1]!.rail).toEqual(HARD);
  });

  it("'both' on sides that differ edits the zone of that index on each", () => {
    const store = storeWith(asym);
    const g = store.getState;
    g().setZoneRail('both', 2, HARD);
    const rails = g().doc!.rails;
    expect(rails.plus[2]!.rail).toEqual(HARD);
    expect(rails.minus![2]!.rail).toEqual(HARD);
    expect(rails.plus[1]).toBe(asym.rails.plus[1]);
    expect(rails.minus![1]).toBe(asym.rails.minus![1]);
    expect(closedVerdict(g().doc!, true).ok).toBe(true);
  });

  it("'plus' and 'minus' on an asymmetric board leave the other side the list it was", () => {
    const store = storeWith(asym);
    const g = store.getState;
    g().setZoneRail('plus', 2, HARD);
    expect(g().doc!.rails.minus).toBe(asym.rails.minus);
    g().setZoneNumber('minus', 2, 'apex', 0.3);
    expect(g().doc!.rails.plus[2]!.rail).toEqual(HARD);
    expect(g().doc!.rails.minus![2]!.rail.apex).toBe(0.3);
    expect(g().past).toHaveLength(2);
  });

  it('an action on a store with no document does nothing and does not throw', () => {
    const store = createRailsStore();
    const g = store.getState;
    expect(() => {
      g().setZoneRail('plus', 0, HARD);
      g().setZoneNumber('both', 0, 'apex', 0.3);
      g().moveZoneEnd('plus', 0, 'to', 5);
      g().moveZone('minus', 0, 5);
      g().splitZoneAt('plus', 5);
      g().removeZone('plus', 0);
      g().tidyRails('plus');
      g().unlockRailSide();
      g().linkRailSides('plus');
    }).not.toThrow();
    expect(g().past).toHaveLength(0);
    expect(g().doc).toBeNull();
  });

  it('tidyRails with no tolerance joins the mid-board stations of the swallow board', () => {
    const swallow = railsBoards.find(([n]) => n === 'swallow')![1]();
    const store = storeWith(swallow);
    const g = store.getState;
    g().tidyRails('plus');
    const tidied: readonly RailKey[] = g().doc!.rails.plus;
    expect(tidied.length).toBeLessThan(swallow.rails.plus.length);
    expect(g().past.map((p) => p.label)).toEqual(['Tidy rails']);
    expect(tidied).toEqual(
      zones.tidyRails(swallow.rails.plus, zones.TIDY_TOLERANCE, lengthOf(swallow)),
    );
    expect(closedVerdict(g().doc!, true).ok).toBe(true);
  });
});

describe('a mirror board whose sides differ in rail alone, made asymmetric', () => {
  it('keeps the minus side its own rails', () => {
    const store = createRailsStore();
    store.getState().loadDoc(railsBoards[0]![1]());
    store.getState().unlockRailSide();
    store.getState().setZoneNumber('minus', 0, 'apex', 0.3);
    const own = store.getState().doc!.rails.minus;
    expect(own).toBeDefined();
    store.getState().setSymmetry('asymmetric');
    expect(store.getState().doc!.rails.minus).toBe(own);
  });
});
