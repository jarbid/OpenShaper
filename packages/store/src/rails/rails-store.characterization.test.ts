// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Characterization: rails-store actions on the test boards produce the same document.
 *
 * Each scenario loads a board, runs a sequence of actions, and snapshots (a) the readable parts of
 * the result (history labels, selection, knot counts, station places, corner radii) and (b) a hash
 * of the whole document with every number rounded to 8 significant digits, so any change to the
 * edit maths shows up without a multi-kilobyte snapshot per scenario.
 *
 * A changed snapshot here means an edit now produces a different board. That is a behaviour
 * change, not a refactor.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRailsStore } from './rails-store';
import { railsBoards } from './test-support/boards';
import { SCENARIOS } from './test-support/scenarios';

const round = (v: unknown): unknown => {
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(8)) : String(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  }
  return v;
};

type Store = ReturnType<typeof createRailsStore>;

const digest = (store: Store) => {
  const s = store.getState();
  const d = s.doc!;
  return {
    past: s.past.map((h) => h.label),
    future: s.future.map((h) => h.label),
    editing: s.editing,
    selection: s.selection,
    selectedFin: s.selectedFin,
    symmetry: d.symmetry,
    knots: {
      outline: d.outline.plus.knots.length,
      minusOutline: d.outline.minus?.knots.length ?? null,
      rocker: d.rocker.knots.length,
      deck: d.deck.knots.length,
      stations: d.stations.map((st) => [st.plus.bottom.knots.length, st.plus.deck.knots.length]),
    },
    stations: round(d.stations.map((st) => [st.id, st.x])),
    corners: round(d.corners),
    railKeys: [d.rails.plus.length, d.rails.minus?.length ?? null],
    features: d.features.map((f) => f.id),
    docHash: createHash('sha256')
      .update(JSON.stringify(round(d)))
      .digest('hex')
      .slice(0, 16),
  };
};

describe.each(railsBoards)('characterization: rails-store actions on the %s board', (_n, make) => {
  for (const [name, run] of SCENARIOS) {
    it(name, () => {
      const store = createRailsStore();
      store.getState().loadDoc(make());
      run(store.getState);
      expect(digest(store)).toMatchSnapshot();
    });
  }
});
