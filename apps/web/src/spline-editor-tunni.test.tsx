import { act, fireEvent, screen } from '@testing-library/react';
import { board, knot, splineFromKnots, type Vec2 } from '@openshaper/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  MOUSE,
  TOUCH,
  removeLayoutStubs,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);
const p = (x: number, y: number): Vec2 => ({ x, y });
const setup = (mirrorY = false) => {
  const rig = mountEditor({ mirrorY });
  const s = splineFromKnots([
    knot(p(0, 0), p(-20, -40), p(20, 40)),
    knot(p(100, 0), p(80, 40), p(120, -40)),
  ]);
  act(() => {
    const b = rig.store.getState().board!;
    rig.store.getState().load(board(s, b.bottom, b.deck, b.crossSections));
  });
  const open = () => {
    const at = rig.screenOf(p(50, -5));
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, button: 2, ...at });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, button: 2, ...at });
    return screen.getByRole('menuitemcheckbox', { name: 'Show Tunni controls' });
  };
  const toggle = () => fireEvent.click(open());
  return { ...rig, open, toggle };
};
const near = (actual: Vec2, expected: Vec2) => {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
};

describe('Tunni controls in the 2D editor', () => {
  it('starts off and can be enabled and disabled in the right-click menu without editing', () => {
    const rig = setup();
    expect(rig.open().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show Tunni controls' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Show Tunni controls' })).toBeNull();
    expect(rig.open().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show Tunni controls' }));
    expect(rig.open().getAttribute('aria-checked')).toBe('false');
    expect(rig.store.getState().past).toHaveLength(0);
  });
  it.each([MOUSE, TOUCH])(
    'drags a Tunni point with $pointerType and undoes both handles together',
    (pointer) => {
      const rig = setup();
      rig.toggle();
      const original = rig.store.getState().board!;
      fireEvent.pointerDown(rig.canvas, { ...pointer, ...rig.screenOf(p(50, 60)) });
      fireEvent.pointerMove(rig.canvas, { ...pointer, ...rig.screenOf(p(60, 80)) });
      fireEvent.pointerUp(rig.canvas, { ...pointer, ...rig.screenOf(p(60, 80)) });
      const edited = rig.store.getState().board!;
      near(edited.outline.knots[0]!.tangentToNext, p(25, 50));
      near(edited.outline.knots[1]!.tangentToPrev, p(80, 40));
      expect(edited.outline.knots.map((k) => k.end)).toEqual(
        original.outline.knots.map((k) => k.end),
      );
      expect(rig.store.getState().past).toHaveLength(1);
      expect(rig.store.getState().editing).toBe(false);
      act(() => rig.store.getState().undo());
      expect(rig.store.getState().board).toBe(original);
      act(() => rig.store.getState().redo());
      expect(rig.store.getState().board).toBe(edited);
    },
  );
  it('drags the editable Tunni line while the outline is mirrored', () => {
    const rig = setup(true);
    rig.toggle();
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 40)) });
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 50)) });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 50)) });
    const s = rig.store.getState().board!.outline;
    near(s.knots[0]!.tangentToNext, p(25, 50));
    near(s.knots[1]!.tangentToPrev, p(75, 50));
  });
  it('does not expose draggable Tunni controls on the mirrored half', () => {
    const rig = setup(true);
    rig.toggle();
    const original = rig.store.getState().board;
    for (const [from, to] of [
      [p(50, -40), p(50, -50)],
      [p(50, -60), p(60, -80)],
    ]) {
      fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(from!) });
      fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(to!) });
      fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...rig.screenOf(to!) });
    }
    expect(rig.store.getState().board).toBe(original);
    expect(rig.store.getState().past).toHaveLength(0);
  });
  it('double-clicks the diamond to balance handles without adding a knot', () => {
    const rig = setup();
    act(() => rig.store.getState().moveTangent({ kind: 'outline' }, 0, 'next', p(10, 20)));
    rig.toggle();
    fireEvent.doubleClick(rig.canvas, rig.screenOf(p(30, 20)));
    const s = rig.store.getState().board!.outline;
    expect(s.knots).toHaveLength(2);
    near(s.knots[0]!.tangentToNext, p(15, 30));
    near(s.knots[1]!.tangentToPrev, p(85, 30));
  });
  it('stops at a handle reversal and closes its undo step', () => {
    const rig = setup();
    rig.toggle();
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 40)) });
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 50)) });
    const valid = rig.store.getState().board;
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, -10)) });
    expect(rig.store.getState().editing).toBe(false);
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 60)) });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 60)) });
    expect(rig.store.getState().board).toBe(valid);
    expect(rig.store.getState().past).toHaveLength(1);
  });
  it('closes the grouped edit when a Tunni drag is cancelled', () => {
    const rig = setup();
    rig.toggle();
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 40)) });
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 50)) });
    fireEvent.pointerCancel(rig.canvas, MOUSE);
    expect(rig.store.getState().editing).toBe(false);
    expect(rig.store.getState().past).toHaveLength(1);
  });
  it('does not change the board when a Tunni point is only clicked or controls are off', () => {
    const rig = setup();
    const original = rig.store.getState().board;
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 60)) });
    fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...rig.screenOf(p(60, 80)) });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...rig.screenOf(p(60, 80)) });
    expect(rig.store.getState().board).toBe(original);
    rig.toggle();
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 60)) });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...rig.screenOf(p(50, 60)) });
    expect(rig.store.getState().past).toHaveLength(0);
  });
});
