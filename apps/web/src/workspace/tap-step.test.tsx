// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tap on the board chooses a step: the mapping is a pure function, and the hook that acts on it
 * leaves the pick alone, ignores a pick that was there before, and does nothing for a tap on
 * nothing.
 */
import { board, crossSection, knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import type { PatchPick } from '@openshaper/render3d';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPatchPick, setPatchPick } from '../patch-look';
import { boardStore } from '../store';
import { stepForPick, useTapChoosesStep } from './tap-step';

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
