// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hold R / hold T. A held-key mode that outlives its key is the failure to fear: the
 * arrows would go on turning handles after the user let go. So every way a keyup can
 * be missed must end the mode, and a letter typed into a field must never start one.
 */
import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useNudgeMode } from './use-nudge-mode';

const mount = () => renderHook(() => useNudgeMode()).result.current;

describe('useNudgeMode', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('moves until R or T is held, and goes back to moving on release', () => {
    const mode = mount();
    expect(mode.current).toBe('move');

    fireEvent.keyDown(window, { key: 'r' });
    expect(mode.current).toBe('rotate');
    fireEvent.keyUp(window, { key: 'r' });
    expect(mode.current).toBe('move');

    fireEvent.keyDown(window, { key: 't' });
    expect(mode.current).toBe('length');
    fireEvent.keyUp(window, { key: 't' });
    expect(mode.current).toBe('move');
  });

  it('holds with Shift down, whichever order the keys go in', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    fireEvent.keyDown(window, { key: 'R', shiftKey: true });
    expect(mode.current).toBe('rotate');
    fireEvent.keyUp(window, { key: 'Shift' });
    expect(mode.current).toBe('rotate');
    fireEvent.keyUp(window, { key: 'r' });
    expect(mode.current).toBe('move');

    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    // Released while Shift is still down, the key reads upper case.
    fireEvent.keyUp(window, { key: 'T', shiftKey: true });
    expect(mode.current).toBe('move');
  });

  it('with both held, the last pressed wins and letting it go hands back', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'r' });
    expect(mode.current).toBe('rotate');
    fireEvent.keyUp(window, { key: 'r' });
    expect(mode.current).toBe('length');
    fireEvent.keyUp(window, { key: 't' });
    expect(mode.current).toBe('move');
  });

  it('ends when the window loses focus', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.blur(window);
    expect(mode.current).toBe('move');
  });

  it('ends when the tab is hidden', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 't' });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(mode.current).toBe('move');
  });

  it('ends when Cmd is released, which on macOS swallows the keyup of a key let go under it', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
    fireEvent.keyUp(window, { key: 'Meta' });
    expect(mode.current).toBe('move');
  });

  it('ignores an R or T typed into a text field, and a release anywhere still ends it', () => {
    const mode = mount();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: 'r' });
    expect(mode.current).toBe('move');

    // Held outside a field, the mode still ends on a keyup that lands in one.
    fireEvent.keyDown(window, { key: 't' });
    expect(mode.current).toBe('length');
    fireEvent.keyUp(field, { key: 't' });
    expect(mode.current).toBe('move');
  });

  it('leaves Ctrl, Cmd and Alt chords alone', () => {
    const mode = mount();
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(window, { key: 't', altKey: true });
    expect(mode.current).toBe('move');
  });

  it('does not cancel the key: R or T on its own does nothing', () => {
    mount();
    expect(fireEvent.keyDown(window, { key: 'r', cancelable: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: 't', cancelable: true })).toBe(true);
  });

  it('stops listening on unmount', () => {
    const { result, unmount } = renderHook(() => useNudgeMode());
    fireEvent.keyDown(window, { key: 'r' });
    unmount();
    expect(result.current.current).toBe('move');
    fireEvent.keyDown(window, { key: 't' });
    expect(result.current.current).toBe('move');
  });
});
