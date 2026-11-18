// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Rails step's choice, place and sides: set, shared, and held true as the rails board changes.
 * The rails store is the real one with a rails document stood in by its rails alone, which is all
 * this store reads.
 */
import type { RailsBoard } from '@openshaper/board2';
import type { RailKey } from '@openshaper/store/rails';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRailChoice,
  getRailChoice,
  getRailPlace,
  getRailSides,
  reconcileChoice,
  resetRailChoice,
  setRailChoice,
  setRailPlace,
  setRailSides,
  useRailChoice,
} from './rail-choice';
import { zonesOfKeys, type Rails } from './rail-zones';
import { railsStore } from './store';

const key = (x: number, apex: number): RailKey => ({
  x,
  rail: { band: 2, hardness: 0.5, tuck: 1.4, tuckShape: 0.45, bottomEdge: 0, deckEdge: 0, apex },
});
/** Four zones: a tick at 10, a zone 30-50, a tick at 80, a zone 100-120. */
const FOUR: RailKey[] = [
  key(10, 0.1),
  key(30, 0.2),
  key(50, 0.2),
  key(80, 0.3),
  key(100, 0.4),
  key(120, 0.4),
];
const doc = (rails: Rails) => ({ model: 'rails', rails }) as unknown as RailsBoard;

/** Show these rails as a new document. */
function load(rails: Rails) {
  railsStore.setState({ doc: doc(rails), loadCount: railsStore.getState().loadCount + 1 });
}
/** Change the rails of the document being edited (not a new document). */
function edit(rails: Rails, editing = false) {
  railsStore.setState({ doc: doc(rails), editing });
}

beforeEach(() => load({ plus: FOUR }));
afterEach(() => {
  railsStore.setState({ editing: false });
  resetRailChoice();
});

describe('the choice, the place and the sides', () => {
  it('start empty, with both sides', () => {
    expect(getRailChoice()).toBeNull();
    expect(getRailPlace()).toBeNull();
    expect(getRailSides()).toBe('both');
  });

  it('are set together by a choice with a place, and the place alone moves without choosing', () => {
    setRailChoice({ side: 'plus', zone: 1 }, 40);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    expect(getRailPlace()).toBe(40);
    setRailPlace(95);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    expect(getRailPlace()).toBe(95);
    clearRailChoice();
    expect(getRailChoice()).toBeNull();
    expect(getRailPlace()).toBe(95);
  });

  it('ignores a place that is not a number', () => {
    setRailPlace(40);
    setRailPlace(Number.NaN);
    expect(getRailPlace()).toBe(40);
  });

  it('puts a tap on the right of a board with one side list on the plus side', () => {
    setRailChoice({ side: 'minus', zone: 0 }, 10);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
  });

  it('tells a component, once per change', () => {
    const { result } = renderHook(() => useRailChoice());
    expect(result.current).toBeNull();
    act(() => setRailChoice({ side: 'plus', blend: 0 }, 20));
    expect(result.current).toEqual({ side: 'plus', blend: 0 });
  });

  it('clears everything for a new document', () => {
    setRailChoice({ side: 'plus', zone: 2 }, 80);
    load({ plus: FOUR });
    expect(getRailChoice()).toBeNull();
    expect(getRailPlace()).toBeNull();
    expect(getRailSides()).toBe('both');
  });
});

describe('the sides', () => {
  const TWO: Rails = { plus: FOUR, minus: [...FOUR] };

  it('follow a choice in a lane when one side is being edited, and stay Both when Both', () => {
    load(TWO);
    setRailSides('plus');
    setRailChoice({ side: 'minus', zone: 1 }, 40);
    expect(getRailSides()).toBe('minus');
    setRailSides('both');
    setRailChoice({ side: 'plus', zone: 1 }, 40);
    expect(getRailSides()).toBe('both');
  });

  it('make the lane they name the choice’s side', () => {
    load(TWO);
    setRailChoice({ side: 'plus', zone: 1 }, 40);
    setRailSides('minus');
    expect(getRailChoice()).toEqual({ side: 'minus', zone: 1 });
  });

  it('go back to Both when the board has one side list again (an undo of the unlock, or a link)', () => {
    load(TWO);
    setRailSides('plus');
    edit({ plus: FOUR });
    expect(getRailSides()).toBe('both');
  });
});

describe('reconcileChoice', () => {
  const before = zonesOfKeys(FOUR);

  it('keeps a choice while the zones are as many as they were', () => {
    const after = zonesOfKeys(FOUR.map((k) => ({ x: k.x + 1, rail: k.rail })));
    expect(reconcileChoice({ side: 'plus', zone: 2 }, 80, before, after)).toEqual({
      side: 'plus',
      zone: 2,
    });
    expect(reconcileChoice({ side: 'plus', blend: 1 }, 60, before, after)).toEqual({
      side: 'plus',
      blend: 1,
    });
  });

  it('moves a zone choice to the zone that holds the place when the count changed', () => {
    // the first key is dropped: zones are now [30-50] [80] [100-120]
    const after = zonesOfKeys(FOUR.slice(1));
    expect(after.zones).toHaveLength(3);
    expect(reconcileChoice({ side: 'plus', zone: 2 }, 110, before, after)).toEqual({
      side: 'plus',
      zone: 2,
    });
    expect(reconcileChoice({ side: 'plus', zone: 3 }, 110, before, after)).toEqual({
      side: 'plus',
      zone: 2,
    });
    expect(reconcileChoice({ side: 'plus', zone: 1 }, 40, before, after)).toEqual({
      side: 'plus',
      zone: 0,
    });
  });

  it('clears a zone choice whose place is now in a blend, or that has no place', () => {
    const after = zonesOfKeys(FOUR.slice(1));
    expect(reconcileChoice({ side: 'plus', zone: 0 }, 15, before, after)).toBeNull();
    expect(reconcileChoice({ side: 'plus', zone: 0 }, null, before, after)).toBeNull();
  });

  it('moves a blend choice to the blend that holds the place', () => {
    const after = zonesOfKeys(FOUR.slice(1));
    // blends are now 50-80 and 80-100; the place 60 is in the first
    expect(reconcileChoice({ side: 'plus', blend: 1 }, 60, before, after)).toEqual({
      side: 'plus',
      blend: 0,
    });
    expect(reconcileChoice({ side: 'plus', blend: 1 }, 40, before, after)).toBeNull();
  });

  it('clears a choice whose index is past the end', () => {
    expect(reconcileChoice({ side: 'plus', zone: 9 }, 80, before, before)).toBeNull();
  });
});

describe('following the rails', () => {
  it('keeps the choice for an edit that leaves the zones as they were', () => {
    setRailChoice({ side: 'plus', zone: 1 }, 40);
    edit({ plus: FOUR.map((k) => (k.x === 30 ? { x: 32, rail: k.rail } : k)) });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
  });

  it('moves the choice to the zone that holds the place when an edit changes the count', () => {
    setRailChoice({ side: 'plus', zone: 3 }, 110);
    edit({ plus: FOUR.slice(1) });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
  });

  it('clears it when no zone holds the place', () => {
    setRailChoice({ side: 'plus', zone: 0 }, 10);
    edit({ plus: FOUR.slice(1) });
    expect(getRailChoice()).toBeNull();
  });

  it('holds the choice while a drag is open, and settles it when the drag ends', () => {
    setRailChoice({ side: 'plus', zone: 3 }, 110);
    // the dial passes through a neighbour's numbers: two zones are one for a few moves
    edit({ plus: FOUR.slice(1) }, true);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 3 });
    edit({ plus: FOUR }, true);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 3 });
    // the drag ends with the zones as they began: nothing to move
    edit({ plus: FOUR }, false);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 3 });
    // and a drag that ends with fewer zones is settled by the place
    setRailChoice({ side: 'plus', zone: 3 }, 110);
    edit({ plus: FOUR.slice(1) }, true);
    edit({ plus: FOUR.slice(1) }, false);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
  });
});
