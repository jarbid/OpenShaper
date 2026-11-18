// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail's zones and blends of a rails board, read once and shared: the 3D board colours its
 * rail from them, the rail map draws them and the rail panel names them, so all three hold the same
 * arrays and agree on which zone is number 2.
 *
 * A zone's colour is its index along its side taken from the Patches palette, here and on the
 * board. Both functions cache by the identity of what they read (the document's immutable `rails`,
 * a side's key list), so a render that did not change a rail costs a lookup.
 */
import type { RailsBoard } from '@openshaper/board2';
import { railZoneColor, type RailZone, type RailZones } from '@openshaper/render3d/patches';
import { railZones, sidesLinked, type Blend, type Zone } from '@openshaper/store/rails';
import { useSyncExternalStore } from 'react';
import { activeStore, docOf } from './store';

export type Rails = RailsBoard['rails'];
type Keys = Rails['plus'];

/** A side of the board: the plus side is the one on the left of someone on the board facing the nose. */
export type Side = 'plus' | 'minus';

/** One side's zones, tail to nose, and the blends between them. */
export interface SideZones {
  readonly zones: readonly Zone[];
  readonly blends: readonly Blend[];
}

const sideCache = new WeakMap<Keys, SideZones>();

/** The zones and blends of one side's keys (cached by the key list). */
export function zonesOfKeys(keys: Keys): SideZones {
  let held = sideCache.get(keys);
  if (held === undefined) {
    held = railZones(keys);
    sideCache.set(keys, held);
  }
  return held;
}

/** The zones and blends of `side`; a board with no minus side has its plus side's on both. */
export const zonesOfSide = (rails: Rails, side: Side): SideZones =>
  zonesOfKeys(side === 'minus' && rails.minus ? rails.minus : rails.plus);

/** Whether the board's two sides are one list: the rail map then draws one lane. */
export const isLinked = (rails: Rails): boolean => sidesLinked(rails);

const coloured = (side: SideZones): RailZone[] =>
  side.zones.map((z, i) => ({ from: z.from, to: z.to, color: railZoneColor(i) }));

const viewCache = new WeakMap<Rails, RailZones>();

/**
 * The zones as the 3D board takes them, both sides, each coloured by its index. A board whose
 * sides are one list gives the same array for both. Cached by `rails`, so the 3D view is handed
 * a new value only when a rail changed.
 */
export function railZonesForView(rails: Rails): RailZones {
  let held = viewCache.get(rails);
  if (held === undefined) {
    const plus = coloured(zonesOfKeys(rails.plus));
    held = { plus, minus: rails.minus ? coloured(zonesOfKeys(rails.minus)) : plus };
    viewCache.set(rails, held);
  }
  return held;
}

/** The board's length (cm): where its outline ends, the tail being at 0. */
export const boardLengthOf = (doc: RailsBoard): number =>
  doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];

/** The rails of the rails board being edited, or null when the document is not one. */
const railsOfActive = (): Rails | null => {
  const doc = docOf(activeStore.getState());
  return doc?.model === 'rails' ? doc.rails : null;
};

const lengthOfActive = (): number => {
  const doc = docOf(activeStore.getState());
  return doc?.model === 'rails' ? boardLengthOf(doc) : 0;
};

/** The rails board's rails: a new object only when a rail changed, so a drag of the outline does not re-render it. */
export const useBoardRails = (): Rails | null =>
  useSyncExternalStore(activeStore.subscribe, railsOfActive, () => null);

/** The board's length, cm (0 with no rails board): a number, so it re-renders only when the length changes. */
export const useBoardLength = (): number =>
  useSyncExternalStore(activeStore.subscribe, lengthOfActive, () => 0);

/** No zones: what the 3D board is given when no rails board is being edited. */
export const NO_RAIL_ZONES: RailZones = { plus: [], minus: [] };
