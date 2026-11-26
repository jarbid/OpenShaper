// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Tail step reads of the rails board, as hooks: the tail as the panel and the drawing both read it (its
 * shape, its numbers, the ranges they are held to, its corners). Recomputed when the document changes and not otherwise.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  tailCorners,
  tailNotchRange,
  tailShapeAt,
  tailWidthRange,
  type TailBoardReading,
  type TailCorner,
  type TailShapeId,
  type TailWidthRange,
} from '@openshaper/store/rails';
import { useMemo } from 'react';
import { useRailsDoc } from './deck-data';

/** The tail as the panel and the drawing read it. */
export interface TailView {
  readonly doc: RailsBoard;
  readonly reading: TailBoardReading;
  /** The widths the tail holds as its own shape (null for Custom). */
  readonly width: TailWidthRange | null;
  /** The notch depths a board holds. */
  readonly notch: { readonly min: number; readonly max: number };
  readonly corners: readonly TailCorner[];
}

/** The tail of a board. */
export function readTail(doc: RailsBoard): TailView {
  const reading = tailShapeAt(doc);
  return {
    doc,
    reading,
    width: reading.shape === 'custom' ? null : tailWidthRange(doc, reading.shape as TailShapeId),
    notch: tailNotchRange(doc),
    corners: tailCorners(doc),
  };
}

/** The tail of the board being edited, or null with none. */
export function useTail(): TailView | null {
  const doc = useRailsDoc();
  return useMemo(() => (doc ? readTail(doc) : null), [doc]);
}
