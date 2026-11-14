// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The cross-section tab with the rails store active.
 *
 * A rails board does not store a station's closed section: it stores two curves per side, a deck curve and
 * a bottom curve, and the engine builds the section from them and the rail. The tab therefore draws
 *
 * - the **editable curve**, one of the two chosen by the tab's Deck | Bottom control: the target
 *   `{ kind: 'stationDeck' | 'stationBottom', index, side? }`, where `index` counts the document's stations
 *   (the tab's slice index converted with `stationOfSlice`, never by hand), and
 * - read-only **guides**: the closed section (the projection's `crossSections[slice]`, the engine's slice)
 *   and the other curve.
 *
 * A dummy end slice has no station: its only target is the read-only closed section (the rails store
 * ignores spline actions on it), so there is nothing to edit.
 */
import { reflectSpline } from '@openshaper/render2d';
import { minusHalf, stationCurvesOf, type SplineTarget } from '@openshaper/store';
import type { BezierBoard, Spline } from '@openshaper/kernel';
import { stationOfSlice } from '@openshaper/store/rails';

/** The curve of a station the tab edits. */
export type RailsCurve = 'deck' | 'bottom';

export const RAILS_CURVES: readonly { readonly value: RailsCurve; readonly label: string }[] = [
  { value: 'deck', label: 'Deck' },
  { value: 'bottom', label: 'Bottom' },
];

export const isRailsCurve = (v: unknown): v is RailsCurve => v === 'deck' || v === 'bottom';

/**
 * The tab's targets for slice `slice` of a board with `stations` stations: the editable curve (and its
 * minus side on an asymmetric board), or the read-only closed section for an end slice.
 */
export function railsSectionTargets(
  slice: number,
  stations: number,
  curve: RailsCurve,
  asymmetric: boolean,
): SplineTarget[] {
  const index = stationOfSlice(slice, stations);
  const plus: SplineTarget =
    index === null
      ? { kind: 'crossSection', index: slice }
      : { kind: curve === 'deck' ? 'stationDeck' : 'stationBottom', index };
  if (!asymmetric) return [plus];
  return [plus, { ...plus, side: 'minus' } as SplineTarget];
}

/**
 * The read-only splines drawn with the editable curve: the closed section and the other curve of the
 * station. On an asymmetric board the minus half's are reflected to the far side, as the tab draws its
 * halves (a symmetric board's are mirrored by the editor).
 */
export function railsSectionGuides(
  board: BezierBoard,
  slice: number,
  curve: RailsCurve,
  asymmetric: boolean,
): Spline[] {
  const out: Spline[] = [];
  const half = minusHalf(board);
  const add = (plus: Spline | undefined, minus: Spline | undefined) => {
    if (plus) out.push(plus);
    if (asymmetric && minus) out.push(reflectSpline(minus, 'x'));
  };
  add(board.crossSections[slice]?.spline, half?.crossSections[slice]?.spline);
  const curves = stationCurvesOf(board);
  const index = stationOfSlice(slice, curves?.length ?? 0);
  if (curves && index !== null) {
    const other = curve === 'deck' ? 'bottom' : 'deck';
    add(curves[index]?.[other], half && stationCurvesOf(half)?.[index]?.[other]);
  }
  return out;
}
