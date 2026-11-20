// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station strip's arithmetic, with no React and no DOM: where each station's tick stands, what is
 * under a point, where a station is added, how a key moves the choice or a station, and how a tick is
 * named. `StationStrip.tsx` draws what these give.
 *
 * Places are cm from the tail (the tail is always at 0, the nose at the board's length) and pixels are
 * across the strip. The strip has the rail map's scale and margins (`rail-map.ts`), so a place is at the
 * same pixel on both and the Deck and Rails steps line up when the shaper moves between them.
 */
import { fmtLen, type LengthUnit } from '../format';
import { NUDGE, NUDGE_BIG, xToPx, type Frame } from './rail-map';

/** A station on the strip: where it is along the board, cm from the tail. */
export interface StationMark {
  readonly x: number;
}

/** How far from a tick's centre a point still takes it, px. */
export const TICK_SLOP = 10;

/** The least gap, px, between two neighbouring ticks for their numbers to be written: narrower, they run together. */
export const LABEL_GAP = 18;

/** The pixel of each station's tick across the strip, in board order. */
export const tickPositions = (stations: readonly StationMark[], f: Frame): number[] =>
  stations.map((s) => xToPx(s.x, f));

/**
 * The station whose tick is at pixel `px`: the nearest within {@link TICK_SLOP}, the earlier of two
 * equally near, or null.
 */
export function tickAt(stations: readonly StationMark[], f: Frame, px: number): number | null {
  let best: number | null = null;
  let bestAway = TICK_SLOP + 1e-9;
  tickPositions(stations, f).forEach((at, i) => {
    const away = Math.abs(px - at);
    if (away < bestAway) {
      best = i;
      bestAway = away;
    }
  });
  return best;
}

/** The station nearest to the place `x` (cm): the earlier of two equally near; null on a board with none. */
export function nearestStation(stations: readonly StationMark[], x: number): number | null {
  let best: number | null = null;
  let bestAway = Infinity;
  stations.forEach((s, i) => {
    const away = Math.abs(s.x - x);
    if (away < bestAway) {
      best = i;
      bestAway = away;
    }
  });
  return best;
}

/**
 * Whether a "+" at pixel `px` would add a station: on the board and not on a tick, which would take
 * the drag.
 */
export function canAddAt(stations: readonly StationMark[], f: Frame, px: number): boolean {
  if (px < xToPx(0, f) || px > xToPx(f.length, f)) return false;
  return tickAt(stations, f, px) === null;
}

/**
 * The place a station added after the chosen one goes: midway to the next station, or midway to the
 * nose after the last. Null when nothing is chosen or the board has no length.
 */
export function placeAfter(
  stations: readonly StationMark[],
  chosen: number | null,
  length: number,
): number | null {
  const here = chosen === null ? undefined : stations[chosen];
  if (here === undefined || !(length > 0)) return null;
  const next = stations[chosen! + 1]?.x ?? length;
  return next > here.x ? (here.x + next) / 2 : null;
}

/**
 * The station chosen after a key: the arrows go one station along or back, Home and End to the first
 * and last, held to the ends. Null for any other key, and for a board with no station.
 */
export function choiceAfterKey(key: string, chosen: number | null, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = chosen ?? 0;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, at - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(last, at + 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/**
 * Where a station is moved to by an arrow key held with Shift: half a centimetre along or back,
 * {@link NUDGE_BIG} with Ctrl or Cmd too, held to the board. Null for any other key.
 */
export function movedByKey(x: number, key: string, big: boolean, length: number): number | null {
  const dir = key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : key === 'ArrowRight' || key === 'ArrowUp' ? 1 : 0; // prettier-ignore
  if (dir === 0) return null;
  return Math.min(length, Math.max(0, x + dir * (big ? NUDGE_BIG : NUDGE)));
}

/** A tick's name, for its accessible name and its tooltip: "Station 3 of 5, 92.7 cm from the tail". */
export const stationLabel = (index: number, count: number, x: number, units: LengthUnit): string =>
  `Station ${index + 1} of ${count}, ${fmtLen(x, units)} from the tail`;

/** Whether the ticks stand far enough apart for each to carry its number. */
export function numbersFit(stations: readonly StationMark[], f: Frame): boolean {
  const at = tickPositions(stations, f);
  return at.every((p, i) => i === 0 || p - at[i - 1]! >= LABEL_GAP);
}
