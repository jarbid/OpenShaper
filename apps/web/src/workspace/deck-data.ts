// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Deck step reads of the rails board, as hooks: the document and its classic projection, kept
 * current without the shell, and a station's deck as the panel and the slice both read it (its shape, and the
 * crowns it can hold). Each is recomputed when the document changes and not otherwise.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  deckCrownRangeAt,
  deckShapeAt,
  stationOfSlice,
  type DeckCrownRange,
  type DeckStationReading,
  type RailsProjection,
} from '@openshaper/store/rails';
import { useMemo, useSyncExternalStore } from 'react';
import { railsStore } from '../store';
import type { StationMark } from './station-strip';

const docNow = (): RailsBoard | null => railsStore.getState().doc;
const boardNow = (): RailsProjection | null => railsStore.getState().board;

/** The rails board being edited (null with none): a new object for every edit. */
export const useRailsDoc = (): RailsBoard | null =>
  useSyncExternalStore(railsStore.subscribe, docNow, () => null);

/** The classic projection of that board, with its station curves and the engine's sections. */
export const useRailsProjection = (): RailsProjection | null =>
  useSyncExternalStore(railsStore.subscribe, boardNow, () => null);

/** A station's deck as the panel and the slice read it. */
export interface DeckStation {
  readonly doc: RailsBoard;
  /** The station's index in the document's stations. */
  readonly index: number;
  /** What its deck is; null for a station with no width or no thickness. */
  readonly reading: DeckStationReading | null;
  /** The crowns it can hold; null where none. */
  readonly range: DeckCrownRange | null;
}

/** The deck of the station at classic slice index `slice`, or null for an end slice or with no board. */
export function useDeckStation(slice: number): DeckStation | null {
  const doc = useRailsDoc();
  return useMemo(() => {
    if (!doc) return null;
    const index = stationOfSlice(slice, doc.stations.length);
    if (index === null) return null;
    return { doc, index, reading: deckShapeAt(doc, index), range: deckCrownRangeAt(doc, index) };
  }, [doc, slice]);
}

/**
 * The stations as marks on the strip: their places and nothing else. The array is new only when a place changes,
 * so a crown dragged, which rewrites the stations' curves and not where they stand, leaves the strip as it is.
 */
export function useStationMarks(doc: RailsBoard | null): readonly StationMark[] {
  const places = doc ? doc.stations.map((s) => s.x).join(',') : '';
  return useMemo(
    () => (places === '' ? [] : places.split(',').map((x) => ({ x: Number(x) }))),
    [places],
  );
}
