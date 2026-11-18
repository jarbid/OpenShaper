// SPDX-License-Identifier: GPL-3.0-or-later
import { NAME_TOLERANCE, RAIL_LIMITS, railDistance, railName } from '@openshaper/store/rails';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRailChoice, resetRailChoice } from '../rail-choice';
import { zonesOfKeys } from '../rail-zones';
import { activeStore, boardStore, railsStore } from '../store';
import { key, rail, showRails } from '../test/rails-board';
import {
  addZoneAt,
  distinctCopy,
  laneEditSide,
  NEW_ZONE_NUDGE,
  removeChosenZone,
  showsTwoLanes,
  tidyBoard,
  TIDY_TOLERANCE,
} from './rail-actions';

afterEach(() => {
  resetRailChoice();
  activeStore.use(boardStore);
});

describe('a copy of a rail that differs', () => {
  it('moves one number by a little, under the tolerance a rail is named within', () => {
    const r = rail(0.5);
    const copy = distinctCopy(r);
    expect(copy).not.toEqual(r);
    expect(railDistance(copy, r)).toBeCloseTo(NEW_ZONE_NUDGE, 12);
    expect(NEW_ZONE_NUDGE).toBeLessThan(NAME_TOLERANCE);
    expect(railName(copy)).toBe(railName(r));
  });

  it('moves a number that is at the top of its range down, and one at the bottom up', () => {
    const top = rail(0.5, { hardness: RAIL_LIMITS.hardness[1] });
    expect(distinctCopy(top).hardness).toBeLessThan(top.hardness);
    const bottom = rail(0.5, { hardness: RAIL_LIMITS.hardness[0] });
    expect(distinctCopy(bottom).hardness).toBeGreaterThan(bottom.hardness);
  });

  it('moves another number when the first cannot move either way', () => {
    // a range this narrow cannot be nudged both ways: both ends of hardness are within a nudge of the value
    const squeezed = rail(0.5, { hardness: 0.5 });
    const [lo, hi] = RAIL_LIMITS.hardness;
    expect(hi - lo).toBeGreaterThan(2 * NEW_ZONE_NUDGE);
    expect(distinctCopy(squeezed).hardness).not.toBe(squeezed.hardness);
  });
});

describe('the lanes', () => {
  it('reach the lane’s side when the map has two lanes, both when it has one', () => {
    expect(laneEditSide(true, 'minus')).toBe('minus');
    expect(laneEditSide(true, 'plus')).toBe('plus');
    expect(laneEditSide(false, 'minus')).toBe('both');
  });

  it('are two when the sides differ or one side is edited alone', () => {
    const keys = [key(20, 0.5), key(100, 0.3)];
    expect(showsTwoLanes({ plus: keys }, 'both')).toBe(false);
    expect(showsTwoLanes({ plus: keys, minus: [...keys] }, 'both')).toBe(false);
    expect(showsTwoLanes({ plus: keys, minus: [key(50, 0.5)] }, 'both')).toBe(true);
    expect(showsTwoLanes({ plus: keys }, 'minus')).toBe(true);
  });
});

describe('the actions on the store', () => {
  beforeEach(() => showRails({ plus: [key(20, 0.5), key(60, 0.5), key(100, 0.3)] }));

  it('add a zone and choose it, naming where it went', () => {
    expect(addZoneAt(80, 'plus', 'both')).toBe(1);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    expect(zonesOfKeys(railsStore.getState().doc!.rails.plus).zones).toHaveLength(3);
  });

  it('add nothing on a zone of no length, or when the board has none', () => {
    expect(addZoneAt(100, 'plus', 'both')).toBeNull();
    expect(railsStore.getState().past).toHaveLength(0);
    railsStore.setState({ doc: null });
    expect(addZoneAt(80, 'plus', 'both')).toBeNull();
  });

  it('remove the chosen zone, and only a zone', () => {
    expect(removeChosenZone('both')).toBe(false);
    addZoneAt(80, 'plus', 'both');
    expect(removeChosenZone('both')).toBe(true);
    expect(zonesOfKeys(railsStore.getState().doc!.rails.plus).zones).toHaveLength(2);
  });

  it('tidy with the documented tolerance, and report', () => {
    expect(TIDY_TOLERANCE).toBe(0.1);
    expect(tidyBoard()).toEqual({
      joined: 0,
      message: 'Nothing to join: neighbouring zones already differ.',
    });
  });
});
