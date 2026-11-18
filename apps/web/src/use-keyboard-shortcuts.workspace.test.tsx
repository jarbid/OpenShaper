// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The number keys are the view tabs' in the tabbed layout and the design steps' in the workspace: only the
 * table's rows for the layout on screen are live, and the handler follows the layout when it changes.
 */
import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { DESIGN_STEPS } from './workspace/steps';

const setView = vi.fn();
const setStep = vi.fn();

function mount(workspace: boolean, withStep = true) {
  return renderHook(
    ({ on }) =>
      useKeyboardShortcuts({
        setView,
        ...(withStep ? { setStep } : {}),
        workspace: on,
        setCsIndex: () => {},
        onSave: () => {},
        onCommandPalette: () => {},
        clearSectionFocus: () => false,
      }),
    { initialProps: { on: workspace } },
  );
}

afterEach(() => {
  setView.mockClear();
  setStep.mockClear();
  document.body.innerHTML = '';
});

describe('with the tabbed layout', () => {
  it('chooses a view with the keys 1 to 6, and nothing with 7', () => {
    mount(false);
    fireEvent.keyDown(window, { key: '1' });
    expect(setView).toHaveBeenLastCalledWith('quad');
    fireEvent.keyDown(window, { key: '6' });
    expect(setView).toHaveBeenLastCalledWith('split');
    const handled = !fireEvent.keyDown(window, { key: '7' });
    expect(handled).toBe(false);
    expect(setView).toHaveBeenCalledTimes(2);
    expect(setStep).not.toHaveBeenCalled();
  });

  it('is what it always was when no step setter is given at all', () => {
    mount(false, false);
    fireEvent.keyDown(window, { key: '3' });
    expect(setView).toHaveBeenLastCalledWith('rocker');
  });
});

describe('with the workspace', () => {
  it('chooses a design step with the keys 1 to 7 and chooses no view', () => {
    mount(true);
    DESIGN_STEPS.forEach((s, i) => {
      fireEvent.keyDown(window, { key: String(i + 1) });
      expect(setStep).toHaveBeenLastCalledWith(s.id);
    });
    expect(setStep).toHaveBeenCalledTimes(7);
    expect(setView).not.toHaveBeenCalled();
  });

  it('claims the keys it uses, so the browser and the nudge leave them', () => {
    mount(true);
    expect(fireEvent.keyDown(window, { key: '3' })).toBe(false);
    expect(fireEvent.keyDown(window, { key: '8' })).toBe(true);
    expect(fireEvent.keyDown(window, { key: '0' })).toBe(true);
  });

  it('does not claim a number key when there is nobody to take it', () => {
    mount(true, false);
    expect(fireEvent.keyDown(window, { key: '3' })).toBe(true);
    expect(setView).not.toHaveBeenCalled();
  });

  it('is quiet in a text field', () => {
    mount(true);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '3' });
    expect(setStep).not.toHaveBeenCalled();
  });

  it('is quiet behind an open dialog', () => {
    mount(true);
    const modal = document.createElement('div');
    modal.dataset.modal = 'settings';
    document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: '3' });
    expect(setStep).not.toHaveBeenCalled();
  });
});

describe('when the layout changes', () => {
  it('hands the number keys from the views to the steps and back', () => {
    const view = mount(false);
    fireEvent.keyDown(window, { key: '2' });
    expect(setView).toHaveBeenLastCalledWith('outline');
    view.rerender({ on: true });
    fireEvent.keyDown(window, { key: '2' });
    expect(setStep).toHaveBeenLastCalledWith('rocker');
    expect(setView).toHaveBeenCalledTimes(1);
    view.rerender({ on: false });
    fireEvent.keyDown(window, { key: '2' });
    expect(setView).toHaveBeenCalledTimes(2);
    expect(setStep).toHaveBeenCalledTimes(1);
  });

  it('keeps every other shortcut as it was in both layouts', () => {
    const onSave = vi.fn();
    for (const workspace of [false, true]) {
      const view = renderHook(() =>
        useKeyboardShortcuts({
          setView,
          setStep,
          workspace,
          setCsIndex: () => {},
          onSave,
          onCommandPalette: () => {},
          clearSectionFocus: () => false,
        }),
      );
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      view.unmount();
    }
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});
