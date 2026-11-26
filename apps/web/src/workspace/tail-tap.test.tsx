// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tap on the tail: a tap on a corner of the board chooses the Tail step and that corner, so the handle that is shown and
 * the row that is marked are the one tapped; a tap on the tail's edge, or on a notch's wall, chooses the tail with no
 * corner. The corner is the nearest the Tail step lists, on the side that was tapped.
 */
import type { RailsBoard } from '@openshaper/board2';
import type { PatchPick } from '@openshaper/render3d';
import { applyTailShape, tailCorners, tailShapeAt } from '@openshaper/store/rails';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPatchPick } from '../patch-look';
import { activeStore, boardStore, railsStore } from '../store';
import { sampleRailsBoard, showRails } from '../test/rails-board';
import { CORNER_PICK_REACH, cornerForPick, useTapChoosesStep } from './tap-step';
import { getChosenCorner, resetTailChoice, setChosenCorner } from './tail-choice';

const pick = (
  patch: PatchPick['patch'],
  x: number,
  y: number,
  side: PatchPick['side'] = 'plus',
): PatchPick => ({
  patch,
  side,
  x,
  y,
});

let sample: RailsBoard;
beforeEach(async () => {
  sample = await sampleRailsBoard();
  resetTailChoice();
  act(() => setPatchPick(null));
});
afterEach(() => {
  resetTailChoice();
  act(() => setPatchPick(null));
  activeStore.use(boardStore);
});

/** Show `shape` on the sample board, and mount the hook that acts on a tap. */
async function mountWith(shape: Parameters<typeof applyTailShape>[1]['shape']) {
  await showRails({ plus: sample.rails.plus });
  railsStore.getState().loadDoc(applyTailShape(railsStore.getState().doc!, { shape }));
  const setStep = vi.fn();
  const view = renderHook(() => useTapChoosesStep(setStep));
  return { setStep, doc: railsStore.getState().doc!, ...view };
}

describe('cornerForPick', () => {
  it('is the corner a tap lands on, on either side of a mirror board, and none for a tap far from every corner', async () => {
    const doc = applyTailShape(sample, { shape: 'squash' });
    const [corner] = tailCorners(doc);
    const [x, y] = corner!.point;
    expect(cornerForPick(doc, pick('corner', x + 0.4, y - 0.3))).toEqual({
      side: 'plus',
      index: 0,
    });
    expect(cornerForPick(doc, pick('corner', x + 0.4, -(y - 0.3), 'minus'))).toEqual({
      side: 'plus',
      index: 0,
    });
    expect(cornerForPick(doc, pick('corner', x + CORNER_PICK_REACH + 1, y))).toBeNull();
    expect(cornerForPick(doc, pick('corner', 80, 3))).toBeNull();
  });

  it('is the nearest of the tail’s corners: a tip, or the notch crotch', async () => {
    const doc = applyTailShape(sample, { shape: 'swallow' });
    const [tip, crotch] = tailCorners(doc);
    expect(tip!.role).toBe('tip');
    expect(cornerForPick(doc, pick('corner', tip!.point[0] + 0.2, tip!.point[1] - 0.2))).toEqual({
      side: 'plus',
      index: 0,
    });
    expect(cornerForPick(doc, pick('corner', crotch!.point[0] - 0.3, 0.4))).toEqual({
      side: 'tail',
      index: 0,
    });
    expect(cornerForPick(doc, pick('corner', crotch!.point[0] - 0.3, -0.4, 'minus'))).toEqual({
      side: 'tail',
      index: 0,
    });
  });

  it('gives each side of an asymmetric board its own corner', () => {
    const base = sample;
    const asym = applyTailShape(
      {
        ...base,
        symmetry: 'asymmetric' as const,
        outline: { plus: base.outline.plus, minus: base.outline.plus },
        corners: { ...base.corners, minus: base.corners.plus },
        stations: base.stations.map((s) => ({ ...s, minus: s.plus })),
        rails: { plus: base.rails.plus, minus: base.rails.plus },
      },
      { shape: 'squash' },
    );
    const [left, right] = tailCorners(asym);
    expect([left!.side, right!.side]).toEqual(['plus', 'minus']);
    expect(cornerForPick(asym, pick('corner', left!.point[0], left!.point[1]))).toEqual({
      side: 'plus',
      index: 0,
    });
    expect(cornerForPick(asym, pick('corner', right!.point[0], -right!.point[1], 'minus'))).toEqual(
      { side: 'minus', index: 0 },
    );
    // a tap on the left side is never the right side's corner
    expect(cornerForPick(asym, pick('corner', right!.point[0], right!.point[1] + 30))).toBeNull();
  });

  it('lists no corner for a tail that has none, so a tap there chooses none', () => {
    const doc = applyTailShape(sample, { shape: 'round' });
    expect(tailCorners(doc)).toEqual([]);
    expect(cornerForPick(doc, pick('corner', 1, 5))).toBeNull();
  });
});

describe('the tap on the board', () => {
  it('chooses the Tail step and the corner that was tapped', async () => {
    const { setStep, doc } = await mountWith('squash');
    const [corner] = tailCorners(doc);
    act(() => setPatchPick(pick('corner', corner!.point[0] + 0.3, corner!.point[1] - 0.2)));
    expect(setStep).toHaveBeenLastCalledWith('tail');
    expect(getChosenCorner()).toEqual({ side: 'plus', index: 0 });
  });

  it('chooses the other corner for a tap on the other side of the board, and the crotch for a tap in the notch', async () => {
    const { doc } = await mountWith('swallow');
    const [tip, crotch] = tailCorners(doc);
    act(() => setPatchPick(pick('corner', tip!.point[0], tip!.point[1])));
    expect(getChosenCorner()).toEqual({ side: 'plus', index: 0 });
    act(() => setPatchPick(pick('corner', crotch!.point[0] - 0.2, 0.2)));
    expect(getChosenCorner()).toEqual({ side: 'tail', index: 0 });
  });

  it('chooses the tail with no corner for a tap on the tail’s edge or a notch’s wall, forgetting one chosen before', async () => {
    const { setStep } = await mountWith('swallow');
    act(() => setChosenCorner({ side: 'plus', index: 0 }));
    act(() => setPatchPick(pick('tailEdge', 4, 6)));
    expect(setStep).toHaveBeenLastCalledWith('tail');
    expect(getChosenCorner()).toBeNull();
  });

  it('chooses the tail edge’s step on a squash whose end is a straight edge, and no corner', async () => {
    const { setStep, doc } = await mountWith('squash');
    expect(tailShapeAt(doc).shape).toBe('squash');
    act(() => setPatchPick(pick('tailEdge', 0.1, 2)));
    expect(setStep).toHaveBeenLastCalledWith('tail');
    expect(getChosenCorner()).toBeNull();
  });

  it('leaves the corner alone for a tap that is not on the tail, and for a corner in the nose half', async () => {
    const { setStep } = await mountWith('squash');
    act(() => setChosenCorner({ side: 'plus', index: 0 }));
    act(() => setPatchPick(pick('rail', 40, 10)));
    expect(setStep).toHaveBeenLastCalledWith('rails');
    expect(getChosenCorner()).toEqual({ side: 'plus', index: 0 });
    act(() => setPatchPick(pick('corner', 186, 0.4)));
    expect(setStep).toHaveBeenLastCalledWith('outline');
    expect(getChosenCorner()).toEqual({ side: 'plus', index: 0 });
  });
});
