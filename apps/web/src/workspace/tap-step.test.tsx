// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tap on the board chooses a step: the mapping is a pure function, and the hook that acts on it
 * leaves the pick alone, ignores a pick that was there before, and does nothing for a tap on
 * nothing.
 */
import { board, crossSection, knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import type { PatchPick } from '@openshaper/render3d';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPatchPick, setPatchPick } from '../patch-look';
import { activeStore, boardStore, railsStore } from '../store';
import { showRails } from '../test/rails-board';
import { contoursOf } from '@openshaper/store/rails';
import { getChosenContour, resetBottomChoice } from './bottom-choice';
import { contourForPick, stationForPick, stepForPick, useTapChoosesStep } from './tap-step';

const pick = (patch: PatchPick['patch'], x = 50, extra: Partial<PatchPick> = {}): PatchPick => ({
  patch,
  side: 'plus',
  x,
  y: 3,
  ...extra,
});

describe('stepForPick', () => {
  const L = 100;

  it('maps the deck, the bottom, the rail and the tail edge to Deck, Bottom, Rails and Tail', () => {
    expect(stepForPick(pick('deck'), L)).toBe('deck');
    expect(stepForPick(pick('bottom'), L)).toBe('bottom');
    expect(stepForPick(pick('rail'), L)).toBe('rails');
    expect(stepForPick(pick('tailEdge', 3), L)).toBe('tail');
  });

  it('maps a rail to Rails whatever it is the zone or blend of, on either side', () => {
    expect(stepForPick(pick('rail', 20, { zone: 1 }), L)).toBe('rails');
    expect(stepForPick(pick('rail', 20, { blend: 0 }), L)).toBe('rails');
    expect(stepForPick(pick('rail', 80, { side: 'minus', y: -9 }), L)).toBe('rails');
  });

  it('maps a corner in the tail half to Tail and a corner in the nose half to Outline', () => {
    expect(stepForPick(pick('corner', 2), L)).toBe('tail');
    expect(stepForPick(pick('corner', 49.9), L)).toBe('tail');
    expect(stepForPick(pick('corner', 50.1), L)).toBe('outline');
    expect(stepForPick(pick('corner', 98), L)).toBe('outline');
  });

  it('puts the middle of the board in the nose half', () => {
    expect(stepForPick(pick('corner', 50), L)).toBe('outline');
  });

  it('measures the halves on the board it is given', () => {
    expect(stepForPick(pick('corner', 80), 200)).toBe('tail');
    expect(stepForPick(pick('corner', 80), 120)).toBe('outline');
  });

  it('chooses nothing for no pick, or a patch it does not know', () => {
    expect(stepForPick(null, L)).toBeNull();
    expect(stepForPick({ patch: 'fin' as never, x: 1 }, L)).toBeNull();
  });
});

describe('useTapChoosesStep', () => {
  const line = (y: number) =>
    splineFromKnots([
      knot(vec2(0, y), vec2(-5, y), vec2(5, y)),
      knot(vec2(100, y), vec2(95, y), vec2(105, y)),
    ]);

  beforeEach(() => {
    act(() => setPatchPick(null));
    act(() =>
      boardStore.getState().load(board(line(10), line(2), line(8), [crossSection(50, line(3))])),
    );
  });

  const mount = () => {
    const setStep = vi.fn();
    const view = renderHook(() => useTapChoosesStep(setStep));
    return { setStep, ...view };
  };

  it('chooses the step a tap names', () => {
    const { setStep } = mount();
    act(() => setPatchPick(pick('deck')));
    expect(setStep).toHaveBeenLastCalledWith('deck');
    act(() => setPatchPick(pick('bottom')));
    expect(setStep).toHaveBeenLastCalledWith('bottom');
    act(() => setPatchPick(pick('rail', 40, { zone: 0 })));
    expect(setStep).toHaveBeenLastCalledWith('rails');
    expect(setStep).toHaveBeenCalledTimes(3);
  });

  it('splits the corners at the middle of the board that is open', () => {
    const { setStep } = mount();
    act(() => setPatchPick(pick('corner', 10)));
    expect(setStep).toHaveBeenLastCalledWith('tail');
    act(() => setPatchPick(pick('corner', 90)));
    expect(setStep).toHaveBeenLastCalledWith('outline');
  });

  it('chooses again for a second tap on the same patch (a new pick), harmlessly', () => {
    const { setStep } = mount();
    act(() => setPatchPick(pick('deck', 30)));
    act(() => setPatchPick(pick('deck', 60)));
    expect(setStep).toHaveBeenCalledTimes(2);
    expect(setStep).toHaveBeenNthCalledWith(2, 'deck');
  });

  it('changes no step for a tap on nothing, or Escape, which clear the pick', () => {
    const { setStep } = mount();
    act(() => setPatchPick(pick('deck')));
    setStep.mockClear();
    act(() => setPatchPick(null));
    expect(setStep).not.toHaveBeenCalled();
  });

  it('leaves the pick where it is, so the patch stays lit', () => {
    mount();
    const tapped = pick('rail', 40, { zone: 1 });
    act(() => setPatchPick(tapped));
    expect(getPatchPick()).toBe(tapped);
  });

  it('does not act on a pick made before it mounted (in another layout)', () => {
    act(() => setPatchPick(pick('deck')));
    const { setStep } = mount();
    expect(setStep).not.toHaveBeenCalled();
    act(() => setPatchPick(pick('bottom')));
    expect(setStep).toHaveBeenCalledWith('bottom');
  });

  it('stops listening when it unmounts', () => {
    const { setStep, unmount } = mount();
    unmount();
    act(() => setPatchPick(pick('deck')));
    expect(setStep).not.toHaveBeenCalled();
  });
});

describe('stationForPick', () => {
  const stations = [{ x: 10 }, { x: 60 }, { x: 100 }, { x: 150 }];

  it('is the classic slice index of the station nearest a tap on the deck', () => {
    expect(stationForPick(pick('deck', 12), stations)).toBe(1);
    expect(stationForPick(pick('deck', 58), stations)).toBe(2);
    expect(stationForPick(pick('deck', 100), stations)).toBe(3);
    expect(stationForPick(pick('deck', 149), stations)).toBe(4);
  });

  it('goes to the first or the last station for a tap before the one or past the other', () => {
    expect(stationForPick(pick('deck', 0), stations)).toBe(1);
    expect(stationForPick(pick('deck', 187), stations)).toBe(4);
  });

  it('takes the earlier of two stations equally near', () => {
    expect(stationForPick(pick('deck', 35), stations)).toBe(1);
  });

  it('is the station nearest a tap on the bottom too', () => {
    expect(stationForPick(pick('bottom', 12), stations)).toBe(1);
    expect(stationForPick(pick('bottom', 149), stations)).toBe(4);
  });

  it('chooses no station for a tap on a rail, a tail edge or a corner, or on nothing, or a board with none', () => {
    for (const patch of ['rail', 'tailEdge', 'corner'] as const) {
      expect(stationForPick(pick(patch, 60), stations), patch).toBeNull();
    }
    expect(stationForPick(null, stations)).toBeNull();
    expect(stationForPick(pick('deck', 60), [])).toBeNull();
  });
});

describe('useTapChoosesStep and the station a tap on the deck is at', () => {
  beforeEach(async () => {
    act(() => setPatchPick(null));
    await showRails({ plus: [] as never });
  });

  afterEach(() => {
    act(() => setPatchPick(null));
    activeStore.use(boardStore);
  });

  const mount = () => {
    const setStep = vi.fn();
    const setStation = vi.fn();
    const view = renderHook(() => useTapChoosesStep(setStep, setStation));
    return { setStep, setStation, ...view };
  };
  const stationsNow = () => railsStore.getState().doc!.stations;

  it('chooses the deck step and the station nearest the tap, on the board that is open', () => {
    const { setStep, setStation } = mount();
    const target = stationsNow()[2]!;
    act(() => setPatchPick(pick('deck', target.x + 0.4)));
    expect(setStep).toHaveBeenLastCalledWith('deck');
    expect(setStation).toHaveBeenLastCalledWith(3);
    const last = stationsNow().length;
    act(() => setPatchPick(pick('deck', 1e6)));
    expect(setStation).toHaveBeenLastCalledWith(last);
  });

  it('moves the station again for a second tap on the deck, further along', () => {
    const { setStation } = mount();
    act(() => setPatchPick(pick('deck', stationsNow()[1]!.x)));
    act(() => setPatchPick(pick('deck', stationsNow()[3]!.x)));
    expect(setStation.mock.calls.map((c) => c[0])).toEqual([2, 4]);
  });

  it('chooses the station nearest a tap on the bottom, and none for a rail, though it chooses both steps', () => {
    const { setStep, setStation } = mount();
    act(() => setPatchPick(pick('bottom', stationsNow()[3]!.x)));
    act(() => setPatchPick(pick('rail', 80, { zone: 0 })));
    expect(setStep.mock.calls.map((c) => c[0])).toEqual(['bottom', 'rails']);
    expect(setStation.mock.calls.map((c) => c[0])).toEqual([4]);
  });

  it('chooses no station for a tap on nothing, or for a pick made before it mounted', () => {
    act(() => setPatchPick(pick('deck', 50)));
    const { setStation } = mount();
    expect(setStation).not.toHaveBeenCalled();
    act(() => setPatchPick(null));
    expect(setStation).not.toHaveBeenCalled();
  });

  it('is optional: a tap on the deck chooses its step with no station callback', () => {
    const setStep = vi.fn();
    renderHook(() => useTapChoosesStep(setStep));
    act(() => setPatchPick(pick('deck', 50)));
    expect(setStep).toHaveBeenCalledWith('deck');
  });
});

describe('a tap on the bottom and the contour it is over', () => {
  beforeEach(async () => {
    resetBottomChoice();
    act(() => setPatchPick(null));
    await showRails({ plus: [] as never });
  });
  afterEach(() => {
    resetBottomChoice();
    act(() => setPatchPick(null));
    activeStore.use(boardStore);
  });

  /** A board with a vee out of the tail and a single concave through the middle third. */
  const withContours = () => {
    act(() => {
      railsStore.getState().addContour('vee');
      railsStore.getState().addContour('single-concave');
    });
    return railsStore.getState().doc!;
  };

  it('names the narrowest contour that holds the tap, read on the side the tap is on', () => {
    const doc = withContours();
    const [vee, concave] = contoursOf(doc);
    const x =
      (vee!.from + vee!.to) / 2 > concave!.from ? (concave!.from + vee!.to) / 2 : concave!.from + 5;
    expect(contourForPick(pick('bottom', x, { y: 0 }), doc)).toBe(concave!.id);
    expect(contourForPick(pick('bottom', x, { y: 0, side: 'minus' }), doc)).toBe(concave!.id);
    expect(contourForPick(pick('bottom', vee!.from + 2, { y: 0 }), doc)).toBe(vee!.id);
    expect(contourForPick(pick('bottom', 1e5, { y: 0 }), doc)).toBeNull();
    expect(contourForPick(pick('deck', x, { y: 0 }), doc)).toBeNull();
    expect(contourForPick(null, doc)).toBeNull();
    expect(contourForPick(pick('bottom', x), null)).toBeNull();
  });

  it('chooses that contour, the Bottom step and the station nearest, and leaves the choice alone over none', () => {
    const doc = withContours();
    const [vee, concave] = contoursOf(doc);
    const setStep = vi.fn();
    const setStation = vi.fn();
    renderHook(() => useTapChoosesStep(setStep, setStation));
    const x = concave!.from + 5;
    act(() => setPatchPick(pick('bottom', x, { y: 0 })));
    expect(getChosenContour()).toBe(concave!.id);
    expect(setStep).toHaveBeenLastCalledWith('bottom');
    expect(setStation).toHaveBeenCalledTimes(1);
    act(() => setPatchPick(pick('bottom', vee!.from + 2, { y: 0 })));
    expect(getChosenContour()).toBe(vee!.id);
    // a tap on the bottom where no contour acts changes the contour no more than the step
    act(() => setPatchPick(pick('bottom', 1e5, { y: 0 })));
    expect(getChosenContour()).toBe(vee!.id);
    expect(setStation).toHaveBeenCalledTimes(3);
  });
});
