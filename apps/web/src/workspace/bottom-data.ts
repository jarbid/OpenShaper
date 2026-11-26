// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Bottom step reads of the rails board, as a hook: the board's contours as a list shows them, the
 * one that is chosen and its numbers with the ranges the board holds them to. Recomputed when the document
 * or the choice changes and not otherwise; the shell is not involved.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  contourDials,
  contoursOf,
  stationOfSlice,
  type Contour,
  type ContourDials,
} from '@openshaper/store/rails';
import { useMemo } from 'react';
import { resolveContour, useChosenContourId } from './bottom-choice';
import { useRailsDoc } from './deck-data';

export interface BottomContours {
  /** The rails board, or null with none. */
  readonly doc: RailsBoard | null;
  /** Every contour, in the document's order. */
  readonly contours: readonly Contour[];
  /** The contour that is chosen in fact (`resolveContour`), or null for a board with none. */
  readonly chosen: Contour | null;
  /** Its numbers with their ranges. */
  readonly dials: ContourDials | null;
}

/**
 * A contour's numbers for a document, made once however many components ask: the panel, the slice, the plan and
 * the step each read them for every edit of a drag, and each reading costs a pass over the board's stations.
 */
const dialsByDoc = new WeakMap<RailsBoard, Map<string, ContourDials | null>>();
function dialsOf(doc: RailsBoard, id: string): ContourDials | null {
  let byId = dialsByDoc.get(doc);
  if (byId === undefined) {
    byId = new Map();
    dialsByDoc.set(doc, byId);
  }
  if (!byId.has(id)) byId.set(id, contourDials(doc, id));
  return byId.get(id)!;
}

/** The list of contours for a document's features, made once for each. */
const listByFeatures = new WeakMap<object, readonly Contour[]>();
function listOf(features: RailsBoard['features']): readonly Contour[] {
  let list = listByFeatures.get(features);
  if (list === undefined) {
    list = contoursOf({ features });
    listByFeatures.set(features, list);
  }
  return list;
}

const NONE: readonly Contour[] = [];

export function useBottomContours(): BottomContours {
  const doc = useRailsDoc();
  const choice = useChosenContourId();
  const contours = doc ? listOf(doc.features) : NONE;
  const id = resolveContour(
    contours.map((c) => c.id),
    choice,
  );
  const dials = useMemo(() => (doc && id !== null ? dialsOf(doc, id) : null), [doc, id]);
  return { doc, contours, chosen: contours.find((c) => c.id === id) ?? null, dials };
}

/** The chosen station as the slice and the plan read it. */
export interface BottomStation {
  readonly doc: RailsBoard;
  /** The station's index in the document's stations. */
  readonly index: number;
  /** Where it is along the board, cm from the tail. */
  readonly x: number;
}

/** The station at classic slice index `slice`, or null for an end slice or with no board. */
export function useBottomStation(slice: number): BottomStation | null {
  const doc = useRailsDoc();
  return useMemo(() => {
    if (!doc) return null;
    const index = stationOfSlice(slice, doc.stations.length);
    return index === null ? null : { doc, index, x: doc.stations[index]!.x };
  }, [doc, slice]);
}
