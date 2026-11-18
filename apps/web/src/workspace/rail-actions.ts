// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the rail map and the rail panel do to the rails board, in one place so each does it the same
 * way: add a zone and choose it, remove the chosen one, tidy, and which side or sides an edit reaches.
 * Every function reads the rails store when it is called and writes through its actions, each one
 * undo step (or part of the drag that is open).
 */
import {
  RAIL_LIMITS,
  TIDY_TOLERANCE as STORE_TIDY_TOLERANCE,
  ZONE_MIN_GAP,
  zoneIndexAt,
  type RailNumber,
  type RailRecipe,
  type RailSide,
} from '@openshaper/store/rails';
import { useSyncExternalStore } from 'react';
import { chooseRail } from '../patch-look';
import { getRailChoice, getRailPlace, getRailSides, type EditSides } from '../rail-choice';
import {
  boardLengthOf,
  isLinked,
  zonesOfKeys,
  zonesOfSide,
  type Rails,
  type Side,
} from '../rail-zones';
import { railsStore } from '../store';

/**
 * How far apart two neighbouring zones' rails may be for Tidy rails to call them one: a tenth of each
 * number's unit, which is 1 mm of band or tuck, a tenth of a degree of edge and a tenth of a ratio. That
 * is below what a shaper can see on a board or measure with a template, and above the hundredth or so by
 * which the stations of a converted board differ from one another.
 */
export const TIDY_TOLERANCE: number = STORE_TIDY_TOLERANCE;

/**
 * How far the rail of a zone added inside another is moved from it, in the unit of the number moved
 * (0.04 mm of band, a quarter of a hundredth of a ratio). The two parts of a split zone must differ for
 * the board to read them as two zones, and this is the least that survives the engine's limits and
 * stays under the tolerance a rail is named within (`NAME_TOLERANCE`, 0.01): the new zone keeps its
 * name, and the board's shape does not change until the shaper gives it a rail.
 */
export const NEW_ZONE_NUDGE = 0.004;

/** The numbers moved to make a copy of a rail that differs, in the order they are tried. */
const NUDGED: readonly RailNumber[] = ['hardness', 'tuckShape', 'apex', 'band', 'tuck'];

/**
 * A copy of `rail` with one number moved by {@link NEW_ZONE_NUDGE} towards the inside of its range, so
 * the engine's limits cannot hold it back to the same value.
 */
export function distinctCopy(rail: RailRecipe): RailRecipe {
  for (const name of NUDGED) {
    const [lo, hi] = RAIL_LIMITS[name];
    const v = rail[name];
    if (v + NEW_ZONE_NUDGE <= hi) return { ...rail, [name]: v + NEW_ZONE_NUDGE };
    if (v - NEW_ZONE_NUDGE >= lo) return { ...rail, [name]: v - NEW_ZONE_NUDGE };
  }
  return rail;
}

/** The keys of one side. */
const keysOf = (rails: Rails, side: RailSide) =>
  side === 'minus' && rails.minus ? rails.minus : rails.plus;

/**
 * The sides an edit made in a lane reaches: that lane's when the map shows two, both when it shows one.
 */
export const laneEditSide = (twoLanes: boolean, lane: Side): RailSide => (twoLanes ? lane : 'both');

/** The sides the panel's edits reach, as the store names them. */
export const editSidesOf = (sides: EditSides): RailSide => sides;

/**
 * Whether the map draws two lanes: the board's sides differ, or one side is being edited alone (so the
 * shaper sees the lane they are in).
 */
export const showsTwoLanes = (rails: Rails, sides: EditSides = getRailSides()): boolean =>
  !isLinked(rails) || sides !== 'both';

/**
 * Add a zone at `x` in the lane `lane` (the edit reaches `side`) and choose it, the place going to it.
 * Inside a zone of length the zone is split and the part after `x` is the new zone, holding a copy of
 * the rail that differs a little (see {@link NEW_ZONE_NUDGE}); in a blend or past the ends a zone of
 * no length is added holding the rail the board has there. A zone of no length cannot be split. Returns
 * the new zone's index, or null when nothing changed.
 */
export function addZoneAt(x: number, lane: Side, side: RailSide): number | null {
  const state = railsStore.getState();
  const doc = state.doc;
  if (!doc) return null;
  const length = boardLengthOf(doc);
  const keys = keysOf(doc.rails, lane);
  const inside = zonesOfKeys(keys).zones.find((z) => z.from <= x && x <= z.to);
  if (inside && inside.from === inside.to) return null;
  state.splitZoneAt(side, x, inside ? distinctCopy(inside.rail) : undefined);
  const next = railsStore.getState().doc;
  if (!next || next.rails === doc.rails) return null;
  // the new zone is the one at `x`; after a split it is the part that begins a gap after it
  const at = inside ? Math.min(length, x + ZONE_MIN_GAP * 0.75) : x;
  const zone = zoneIndexAt(keysOf(next.rails, lane), at);
  if (zone < 0) return null;
  chooseRail({ side: lane, zone }, x);
  return zone;
}

/** Remove the chosen zone from the side or sides `side` names. False when no zone is chosen or it cannot go. */
export function removeChosenZone(side: RailSide): boolean {
  const choice = getRailChoice();
  const state = railsStore.getState();
  if (!choice || choice.zone === undefined || !state.doc) return false;
  const before = state.doc.rails;
  state.removeZone(side, choice.zone);
  return railsStore.getState().doc?.rails !== before;
}

// --- what the last action said --------------------------------------------------------------------

let status = '';
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const statusListeners = new Set<() => void>();

/** Say something about the last action ("Joined 2 zones."); it goes after a few seconds. */
export function setRailStatus(text: string): void {
  clearTimeout(statusTimer);
  if (status !== text) {
    status = text;
    for (const l of [...statusListeners]) l();
  }
  if (text !== '') statusTimer = setTimeout(() => setRailStatus(''), 6000);
}

const subscribeStatus = (l: () => void): (() => void) => {
  statusListeners.add(l);
  return () => void statusListeners.delete(l);
};

/** What the last action said, or the empty string. */
export const useRailStatus = (): string =>
  useSyncExternalStore(
    subscribeStatus,
    () => status,
    () => '',
  );

/** What Tidy rails did. */
export interface Tidied {
  /** How many zones it joined, over the sides it tidied. */
  readonly joined: number;
  /** A sentence for the shaper. */
  readonly message: string;
}

const zoneCount = (rails: Rails): number =>
  zonesOfSide(rails, 'plus').zones.length +
  (rails.minus && rails.minus !== rails.plus ? zonesOfSide(rails, 'minus').zones.length : 0);

/** Tidy the rails of both sides: one undo step, and the number of zones it joined. */
export function tidyBoard(): Tidied {
  const state = railsStore.getState();
  const doc = state.doc;
  if (!doc) return { joined: 0, message: 'There is no board to tidy.' };
  const before = zoneCount(doc.rails);
  state.tidyRails('both', TIDY_TOLERANCE);
  const after = railsStore.getState().doc;
  const joined = Math.max(0, before - (after ? zoneCount(after.rails) : before));
  const message =
    joined === 0
      ? 'Nothing to join: neighbouring zones already differ.'
      : `Joined ${joined} ${joined === 1 ? 'zone' : 'zones'}.`;
  setRailStatus(message);
  return { joined, message };
}

/**
 * Add a zone at the map's cursor, in the lane that is chosen (the left one else), reaching the sides the
 * panel is editing. Says so when it cannot.
 */
export function addZoneAtCursor(): boolean {
  const doc = railsStore.getState().doc;
  if (!doc) return false;
  const sides = getRailSides();
  const choice = getRailChoice();
  const twoLanes = showsTwoLanes(doc.rails, sides);
  const at = getRailPlace() ?? boardLengthOf(doc) / 2;
  const made = addZoneAt(at, choice && twoLanes ? choice.side : 'plus', twoLanes ? editSidesOf(sides) : 'both'); // prettier-ignore
  if (made === null) {
    setRailStatus('There is no room for a zone here: a zone of no length cannot be split.');
  }
  return made !== null;
}

/** The rails of the board being edited, or null. */
export const currentRails = (): Rails | null => railsStore.getState().doc?.rails ?? null;
