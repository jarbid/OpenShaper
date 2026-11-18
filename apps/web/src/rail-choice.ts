// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Rails step has chosen: one small store shared by the rail map, the rail panel, the
 * slice and the 3D board (a tap on the board's rail, and the zone or blend the board lights).
 * It is module-level state, like the patch a tap chose (`patch-look.ts`), so a choice re-renders
 * the parts that read it and not the shell.
 *
 * Three values:
 *
 * - **the choice**: a zone or a blend of one side, by its index in that side's zones
 *   (`rail-zones.ts`), or nothing;
 * - **the place**: where the map's cursor line and the slice are, cm from the tail. It is not part
 *   of the choice: a click on bare ruler moves it and chooses nothing;
 * - **the sides**: whether the panel's edits reach both sides, or the left (plus) or right (minus)
 *   alone.
 *
 * ## Keeping the choice true as the rails change
 *
 * A choice is an index, and an edit can change how many zones there are (a zone added, removed,
 * or joined to its neighbour by a dial). So this store watches the rails board: a new document
 * clears everything; another change to its rails that leaves the zone count of the chosen side
 * alone keeps the choice; one that changes it moves the choice to the zone (or blend) that holds
 * the place, or clears it when none does. While a drag is open (`editing`) the choice is held
 * where it is, because a dial passing through a neighbour's numbers can join two zones for a few
 * moves and the drag must keep the zone it began on; it is settled when the drag ends.
 */
import { useSyncExternalStore } from 'react';
import { zonesOfSide, type Rails, type Side, type SideZones } from './rail-zones';
import { railsStore } from './store';

/** A zone or a blend of one side: exactly one of `zone` and `blend` is set. */
export interface RailChoice {
  readonly side: Side;
  /** Index into the side's zones. */
  readonly zone?: number;
  /** Index into the side's blends: the blend between zone `blend` and the next. */
  readonly blend?: number;
}

/** Which side or sides the panel's edits reach. */
export type EditSides = 'both' | Side;

let choice: RailChoice | null = null;
let place: number | null = null;
let sides: EditSides = 'both';
/** The rails the choice was last held true against. */
let seen: Rails | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const getRailChoice = (): RailChoice | null => choice;
export const getRailPlace = (): number | null => place;
export const getRailSides = (): EditSides => sides;

export const useRailChoice = (): RailChoice | null =>
  useSyncExternalStore(subscribe, getRailChoice, () => null);
export const useRailPlace = (): number | null =>
  useSyncExternalStore(subscribe, getRailPlace, () => null);
export const useRailSides = (): EditSides =>
  useSyncExternalStore(subscribe, getRailSides, () => 'both' as const);

const sameChoice = (a: RailChoice | null, b: RailChoice | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.side === b.side && a.zone === b.zone && a.blend === b.blend);

/** The rails being edited, or null. */
const currentRails = (): Rails | null => railsStore.getState().doc?.rails ?? null;

/**
 * Choose a zone or a blend (or nothing, with null) and, when `at` is given, move the place to it.
 * On a board whose sides are being edited one at a time (`plus` or `minus`), choosing in a lane
 * makes that lane the side being edited; `both` is kept.
 */
export function setRailChoice(next: RailChoice | null, at?: number): void {
  let changed = false;
  const rails = currentRails();
  // a board with one side list has one lane: the choice is on its plus side whichever was tapped
  const normal = next !== null && rails && !rails.minus && next.side === 'minus' ? { ...next, side: 'plus' as const } : next; // prettier-ignore
  if (!sameChoice(choice, normal)) {
    choice = normal;
    changed = true;
  }
  if (at !== undefined && Number.isFinite(at) && at !== place) {
    place = at;
    changed = true;
  }
  if (normal !== null && sides !== 'both' && rails?.minus && sides !== normal.side) {
    sides = normal.side;
    changed = true;
  }
  if (changed) emit();
}

/** Move the place (the cursor line and the slice) without choosing anything. */
export function setRailPlace(at: number): void {
  if (!Number.isFinite(at) || at === place) return;
  place = at;
  emit();
}

/**
 * Edit both sides, or the left or right alone. Left and right make that side the choice's, since
 * the panel is then showing that side's rail.
 */
export function setRailSides(next: EditSides): void {
  let changed = false;
  if (sides !== next) {
    sides = next;
    changed = true;
  }
  if (next !== 'both' && choice !== null && choice.side !== next) {
    choice = { ...choice, side: next };
    changed = true;
  }
  if (changed) emit();
}

/** Choose nothing; the place stays. */
export function clearRailChoice(): void {
  if (choice === null) return;
  choice = null;
  emit();
}

/** Forget everything: a new board, and tests. */
export function resetRailChoice(): void {
  if (choice === null && place === null && sides === 'both') return;
  choice = null;
  place = null;
  sides = 'both';
  emit();
}

/**
 * The choice after the rails changed from `before` to `after`, held true: the same choice when the
 * chosen side has as many zones and blends as it had; else the zone (or blend) that holds `at`, or
 * null when none does or there is no place. A whole-side choice (neither zone nor blend) is kept.
 */
export function reconcileChoice(
  current: RailChoice,
  at: number | null,
  before: SideZones,
  after: SideZones,
): RailChoice | null {
  if (current.zone === undefined && current.blend === undefined) return current;
  if (before.zones.length === after.zones.length) {
    const index = current.zone ?? current.blend ?? 0;
    const room = current.zone !== undefined ? after.zones.length : after.blends.length;
    return index < room ? current : null;
  }
  if (at === null) return null;
  if (current.zone !== undefined) {
    const zone = after.zones.findIndex((z) => z.from <= at && at <= z.to);
    return zone < 0 ? null : { side: current.side, zone };
  }
  const blend = after.blends.findIndex((b) => b.from < at && at < b.to);
  return blend < 0 ? null : { side: current.side, blend };
}

/** Hold the choice true against the rails now, given the rails it was last true against. */
function settle(after: Rails | null): void {
  const before = seen;
  seen = after;
  if (after === null) {
    if (choice !== null) {
      choice = null;
      emit();
    }
    return;
  }
  let changed = false;
  if (!after.minus && sides !== 'both') {
    sides = 'both';
    changed = true;
  }
  if (choice !== null) {
    // a board with one side list has no minus lane to be on
    const side: Side = after.minus ? choice.side : 'plus';
    const held = side === choice.side ? choice : { ...choice, side };
    const next =
      before === null
        ? held
        : reconcileChoice(held, place, zonesOfSide(before, side), zonesOfSide(after, side));
    if (!sameChoice(choice, next)) {
      choice = next;
      changed = true;
    }
  }
  if (changed) emit();
}

/** Follow a rails store: see the module comment. Returns the function that stops following. */
export function watchRails(store: typeof railsStore): () => void {
  seen = store.getState().doc?.rails ?? null;
  return store.subscribe((state, prev) => {
    if (state.loadCount !== prev.loadCount) {
      seen = state.doc?.rails ?? null;
      resetRailChoice();
      return;
    }
    if (state.editing) return;
    const rails = state.doc?.rails ?? null;
    if (rails !== seen) settle(rails);
  });
}

watchRails(railsStore);
