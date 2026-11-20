// SPDX-License-Identifier: GPL-3.0-or-later
/** The station strip's arithmetic: ticks, what is under a point, where a "+" adds, and the keys. */
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { MAP_PAD, NUDGE, NUDGE_BIG, xToPx, type Frame } from './rail-map';
import {
  LABEL_GAP,
  TICK_SLOP,
  canAddAt,
  choiceAfterKey,
  movedByKey,
  nearestStation,
  numbersFit,
  placeAfter,
  stationLabel,
  tickAt,
  tickPositions,
} from './station-strip';

/** A strip 640 px wide over a board 180 cm long: 3 px a centimetre between the margins. */
const F: Frame = { width: 640, length: 180 };
const S = [{ x: 10 }, { x: 60 }, { x: 100 }, { x: 150 }];
const px = (x: number) => xToPx(x, F);

describe('the ticks', () => {
  it('stand where the rail map puts the same place, margins and all', () => {
    expect(tickPositions(S, F)).toEqual(S.map((s) => xToPx(s.x, F)));
    expect(px(0)).toBe(MAP_PAD);
    expect(px(180)).toBe(640 - MAP_PAD);
  });

  it('take the point within the slop of their centre, the nearer of two, the earlier on a tie', () => {
    expect(tickAt(S, F, px(60))).toBe(1);
    expect(tickAt(S, F, px(60) + TICK_SLOP - 0.5)).toBe(1);
    expect(tickAt(S, F, px(60) + TICK_SLOP + 0.5)).toBeNull();
    // two ticks 12 px apart: a point between them goes to the nearer, and the middle to the earlier
    const close = [{ x: 90 }, { x: 94 }];
    expect(tickAt(close, F, px(90) + 2)).toBe(0);
    expect(tickAt(close, F, px(90) + 10)).toBe(1);
    expect(tickAt(close, F, (px(90) + px(94)) / 2)).toBe(0);
    expect(tickAt([], F, 100)).toBeNull();
  });

  it('are named for their number, their place in the display unit and where they are from', () => {
    expect(stationLabel(2, 4, 100, lengthUnitByKey('cm'))).toBe(
      'Station 3 of 4, 100.00 cm from the tail',
    );
    expect(stationLabel(0, 4, 10, lengthUnitByKey('mm'))).toBe(
      'Station 1 of 4, 100.0 mm from the tail',
    );
    expect(stationLabel(0, 1, 91.44, lengthUnitByKey('ftin'))).toBe(
      'Station 1 of 1, 36" from the tail',
    );
  });

  it('carry their numbers only while they stand far enough apart', () => {
    expect(numbersFit(S, F)).toBe(true);
    expect(numbersFit([{ x: 10 }, { x: 10 + (LABEL_GAP - 1) / 3.2 }], F)).toBe(false);
    expect(numbersFit([], F)).toBe(true);
    expect(numbersFit([{ x: 50 }], F)).toBe(true);
  });
});

describe('the station nearest a place', () => {
  it('is the one at the least distance, the earlier on a tie', () => {
    expect(nearestStation(S, 0)).toBe(0);
    expect(nearestStation(S, 58)).toBe(1);
    expect(nearestStation(S, 80)).toBe(1);
    expect(nearestStation(S, 120)).toBe(2);
    expect(nearestStation(S, 1000)).toBe(3);
    expect(nearestStation(S, -50)).toBe(0);
    expect(nearestStation([], 5)).toBeNull();
  });
});

describe('where a station is added', () => {
  it('may be on the board and off a tick', () => {
    expect(canAddAt(S, F, px(30))).toBe(true);
    expect(canAddAt(S, F, px(60))).toBe(false);
    expect(canAddAt(S, F, px(60) + TICK_SLOP + 1)).toBe(true);
    expect(canAddAt(S, F, px(0) - 1)).toBe(false);
    expect(canAddAt(S, F, px(180) + 1)).toBe(false);
  });

  it('after the chosen one is midway to the next, or to the nose after the last', () => {
    expect(placeAfter(S, 0, 180)).toBe(35);
    expect(placeAfter(S, 2, 180)).toBe(125);
    expect(placeAfter(S, 3, 180)).toBe(165);
    expect(placeAfter(S, null, 180)).toBeNull();
    expect(placeAfter(S, 9, 180)).toBeNull();
    expect(placeAfter(S, 3, 0)).toBeNull();
    // a station on the very end of the board has no room after it
    expect(placeAfter([{ x: 100 }, { x: 180 }], 1, 180)).toBeNull();
  });
});

describe('the keys', () => {
  it('move the choice along and back, to the ends, held there', () => {
    expect(choiceAfterKey('ArrowRight', 1, 4)).toBe(2);
    expect(choiceAfterKey('ArrowLeft', 1, 4)).toBe(0);
    expect(choiceAfterKey('ArrowLeft', 0, 4)).toBe(0);
    expect(choiceAfterKey('ArrowRight', 3, 4)).toBe(3);
    expect(choiceAfterKey('Home', 2, 4)).toBe(0);
    expect(choiceAfterKey('End', 2, 4)).toBe(3);
    expect(choiceAfterKey('ArrowRight', null, 4)).toBe(1);
    expect(choiceAfterKey('a', 1, 4)).toBeNull();
    expect(choiceAfterKey('Home', 0, 0)).toBeNull();
  });

  it('move a station by half a centimetre, five with the big step, held to the board', () => {
    expect(movedByKey(50, 'ArrowRight', false, 180)).toBe(50 + NUDGE);
    expect(movedByKey(50, 'ArrowLeft', false, 180)).toBe(50 - NUDGE);
    expect(movedByKey(50, 'ArrowRight', true, 180)).toBe(50 + NUDGE_BIG);
    expect(movedByKey(1, 'ArrowLeft', true, 180)).toBe(0);
    expect(movedByKey(179, 'ArrowRight', true, 180)).toBe(180);
    expect(movedByKey(50, 'Enter', false, 180)).toBeNull();
  });
});
