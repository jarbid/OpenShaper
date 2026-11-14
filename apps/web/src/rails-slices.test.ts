// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The closed sections of a rails board: which places the worker is asked for, and how its answer reaches
 * the rails store (keyed by station id, merged, ignored when stale). The answers are the worker core's own.
 */
import { parseBrd } from '@openshaper/io';
import { createRailsStore, sliceOfStation } from '@openshaper/store/rails';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ViewerProbes } from './nurbs-viewer';
import { feedRailsSlices, railsProbePlaces, slicesOfProbes } from './rails-slices';
import sampleBrd from './sample-board.brd?raw';

type Core = typeof import('./workers/nurbs-core');
let core: Core;
beforeAll(async () => {
  core = await import('./workers/nurbs-core');
}, 60_000);

const board = () => {
  const made = core.toRails({ classic: parseBrd(sampleBrd).board });
  if (!made.ok) throw new Error(made.error);
  return made.board;
};
const answer = (doc: ReturnType<typeof board>, xs: readonly number[]) => {
  const out = core.meshDocument(
    doc,
    null,
    { curvature: false, deviation: false, reuseLadders: false },
    undefined,
    xs,
  );
  if (!out.ok) throw new Error(out.error);
  return out.probes;
};

describe('which places are asked for', () => {
  let doc: ReturnType<typeof board>;
  let xs: number[];
  beforeAll(() => {
    doc = board();
    xs = doc.stations.map((s) => s.x);
  });

  it('every station when settled, with what the tab shows, once each', () => {
    expect(railsProbePlaces(doc, false, null, [])).toEqual(xs);
    expect(railsProbePlaces(doc, false, null, [xs[1]!, 7])).toEqual([...xs, 7]);
  });

  it('only the edited station and what the tab shows while dragging', () => {
    expect(railsProbePlaces(doc, true, xs[2]!, [xs[0]!])).toEqual([xs[2], xs[0]]);
    expect(railsProbePlaces(doc, true, null, [xs[0]!])).toEqual([xs[0]]);
    expect(railsProbePlaces(doc, true, xs[2]!, [xs[2]!])).toEqual([xs[2]]);
  });
});

describe('from probes to slices', () => {
  it('keys each probe by the id of the station at its place; a place with no station is dropped', () => {
    const doc = board();
    const items = answer(doc, [doc.stations[1]!.x, doc.stations[3]!.x]);
    const slices = slicesOfProbes(doc, [...items, { xi: -4, plus: [0, 0], minus: null }]);
    expect(Object.keys(slices).sort()).toEqual([doc.stations[1]!.id, doc.stations[3]!.id].sort());
    expect(slices[doc.stations[1]!.id]!.plus).toEqual(items[0]!.plus);
    expect(slices[doc.stations[1]!.id]!.minus).toBeUndefined();
  });

  it('carries the minus side of an asymmetric board', () => {
    const doc = board();
    const slices = slicesOfProbes(doc, [
      { xi: doc.stations[0]!.x, plus: [0, 0, 1, 1], minus: [0, 0, 2, 2] },
    ]);
    expect(slices[doc.stations[0]!.id]).toEqual({ plus: [0, 0, 1, 1], minus: [0, 0, 2, 2] });
  });
});

describe('feeding the rails store', () => {
  const probes = (
    doc: ReturnType<typeof board>,
    loadCount: number,
    xs: number[],
  ): ViewerProbes => ({
    items: answer(doc, xs),
    generation: loadCount,
    rails: true,
  });

  it('draws the engine’s closed section at the station, from the answer, and merges a later one', () => {
    const doc = board();
    const store = createRailsStore();
    store.getState().loadDoc(doc);
    const load = store.getState().loadCount;
    const slice = sliceOfStation(1);
    const standIn = store.getState().board!.crossSections[slice]!.spline;

    feedRailsSlices(store, probes(doc, load, [doc.stations[1]!.x]));
    const first = store.getState().board!.crossSections[slice]!.spline;
    expect(first).not.toBe(standIn);
    expect(Object.keys(store.getState().slices!)).toEqual([doc.stations[1]!.id]);

    feedRailsSlices(store, probes(doc, load, [doc.stations[2]!.x]));
    expect(Object.keys(store.getState().slices!).sort()).toEqual(
      [doc.stations[1]!.id, doc.stations[2]!.id].sort(),
    );
    // station 1's section is the one it had
    expect(store.getState().board!.crossSections[slice]!.spline).toBe(first);
  });

  it('follows a drag: the edited station’s section changes with its curve', () => {
    const doc = board();
    const store = createRailsStore();
    store.getState().loadDoc(doc);
    const load = store.getState().loadCount;
    feedRailsSlices(store, probes(doc, load, [doc.stations[1]!.x]));
    const before = store.getState().slices![doc.stations[1]!.id]!.plus;
    store.getState().beginEdit();
    const k = store.getState().board!.stationCurves[1]!.deck.knots[1]!.end;
    store
      .getState()
      .moveControlPoint({ kind: 'stationDeck', index: 1 }, 1, { x: k.x, y: k.y + 0.4 });
    const dragged = store.getState().doc!;
    expect(dragged).not.toBe(doc);
    feedRailsSlices(store, probes(dragged, load, [dragged.stations[1]!.x]));
    store.getState().endEdit();
    expect(store.getState().slices![doc.stations[1]!.id]!.plus).not.toEqual(before);
  });

  it('ignores an answer for another document, or one that is not a rails board’s', () => {
    const doc = board();
    const store = createRailsStore();
    store.getState().loadDoc(doc);
    const load = store.getState().loadCount;
    const items = answer(doc, [doc.stations[1]!.x]);
    feedRailsSlices(store, { items, generation: load + 1, rails: true });
    feedRailsSlices(store, { items, generation: load, rails: false });
    feedRailsSlices(store, null);
    expect(store.getState().slices).toBeNull();
  });
});
