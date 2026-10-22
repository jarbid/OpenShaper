import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReferencePointSelection } from '@openshaper/render2d';
import {
  installLayoutStubs,
  removeLayoutStubs,
  mountEditor,
  MOUSE,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

const tab = (shiftKey = false, target: HTMLElement | Window = window) => {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return event;
};

it('cycles the active curve through handles and points in both directions without editing', () => {
  const rig = mountEditor();
  const state = () => rig.store.getState();
  act(() => state().select({ target: { kind: 'outline' }, index: 1 }));
  const board = state().board;
  expect(tab().defaultPrevented).toBe(true);
  expect(state().selection).toMatchObject({ index: 1, kind: 'next' });
  tab();
  expect(state().selection).toMatchObject({ index: 2, kind: 'prev' });
  tab(true);
  expect(state().selection).toMatchObject({ index: 1, kind: 'next' });
  tab(true);
  expect(state().selection).toMatchObject({ index: 1, kind: 'end' });
  tab(true);
  expect(state().selection).toMatchObject({ index: 1, kind: 'prev' });
  act(() => state().select({ target: { kind: 'outline' }, index: 2, kind: 'next' }));
  tab();
  expect(state().selection).toMatchObject({ index: 0, kind: 'prev' });
  tab(true);
  expect(state().selection).toMatchObject({ index: 2, kind: 'next' });
  expect(state().board).toBe(board);
  expect(state().past).toHaveLength(0);
});

it('cycles reference points spatially, rather than in creation order', () => {
  const onSelection = vi.fn();
  const rig = mountEditor({ onReferencePointSelectionChange: onSelection });
  act(() => {
    for (const x of [60, 20, 40]) rig.store.getState().addReferencePoint('outline', { x, y: -15 });
  });
  const at = rig.screenOf({ x: 40, y: -15 });
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at });
  fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at });
  const selected = () => (onSelection.mock.lastCall![0] as ReferencePointSelection).point.x;
  expect(tab().defaultPrevented).toBe(true);
  expect(selected()).toBe(60);
  tab();
  expect(selected()).toBe(20);
  tab(true);
  expect(selected()).toBe(60);
  expect(rig.store.getState().past).toHaveLength(3);
});

it('leaves Tab alone when nothing is selected, a field is being edited, or a dialog is open', () => {
  const rig = mountEditor();
  expect(tab().defaultPrevented).toBe(false);
  act(() => rig.store.getState().select({ target: { kind: 'outline' }, index: 1 }));
  const selection = rig.store.getState().selection;
  const input = document.createElement('input');
  document.body.append(input);
  try {
    expect(tab(false, input).defaultPrevented).toBe(false);
    expect(tab(true, input).defaultPrevented).toBe(false);
    expect(rig.store.getState().selection).toBe(selection);
    input.setAttribute('data-modal', 'test');
    expect(tab().defaultPrevented).toBe(false);
    expect(rig.store.getState().selection).toBe(selection);
  } finally {
    input.remove();
  }
});

it('only cycles the reference selection in the focused pane', () => {
  const first = vi.fn();
  const second = vi.fn();
  const a = mountEditor({ onReferencePointSelectionChange: first });
  const b = mountEditor({ onReferencePointSelectionChange: second });
  for (const rig of [a, b]) {
    act(() => {
      rig.store.getState().addReferencePoint('outline', { x: 20, y: -15 });
      rig.store.getState().addReferencePoint('outline', { x: 40, y: -15 });
    });
    const at = rig.screenOf({ x: 20, y: -15 });
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at });
  }
  tab();
  expect((first.mock.lastCall![0] as ReferencePointSelection).point.x).toBe(20);
  expect((second.mock.lastCall![0] as ReferencePointSelection).point.x).toBe(40);
});
