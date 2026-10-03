/**
 * P13: ⌘Z inside a text field is the browser's text undo, not a board undo, and
 * global shortcuts stay quiet behind an open dialog.
 */
import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { board, crossSection, knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { boardStore } from './store';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';

function line(y: number) {
  return splineFromKnots([
    knot(vec2(0, y), vec2(-5, y), vec2(5, y)),
    knot(vec2(100, y), vec2(95, y), vec2(105, y)),
  ]);
}

const onCommandPalette = vi.fn();
const onSave = vi.fn();

function mount() {
  renderHook(() =>
    useKeyboardShortcuts({
      setView: () => {},
      setCsIndex: () => {},
      onSave,
      onCommandPalette,
      clearSectionFocus: () => false,
    }),
  );
}

/** Loads a board and makes one edit, so there is something to undo. */
function withOneEdit() {
  act(() => {
    boardStore.getState().load(board(line(10), line(2), line(8), [crossSection(50, line(3))]));
    boardStore.getState().scaleBoard(1.1, 1, 1);
  });
  expect(boardStore.getState().past).toHaveLength(1);
}

function add<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

const ctrl = (target: Element | Window, key: string) =>
  fireEvent.keyDown(target, { key, ctrlKey: true });

beforeEach(() => {
  onCommandPalette.mockClear();
  onSave.mockClear();
  withOneEdit();
  mount();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('undo and redo in text fields (P13)', () => {
  it('⌘Z in a text input is left to the browser', () => {
    const input = add('input', { type: 'text' });
    input.focus();
    const notPrevented = ctrl(input, 'z');
    expect(notPrevented).toBe(true);
    expect(boardStore.getState().past).toHaveLength(1);
  });

  it('⌘Y and ⇧⌘Z in a textarea are left to the browser', () => {
    act(() => boardStore.getState().undo());
    const area = add('textarea');
    area.focus();
    ctrl(area, 'y');
    fireEvent.keyDown(area, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(boardStore.getState().future).toHaveLength(1);
  });

  it('⌘Z on a focused checkbox still undoes the board', () => {
    const box = add('input', { type: 'checkbox' });
    box.focus();
    const notPrevented = ctrl(box, 'z');
    expect(notPrevented).toBe(false);
    expect(boardStore.getState().past).toHaveLength(0);
  });

  it('⌘Z outside any field undoes the board', () => {
    ctrl(window, 'z');
    expect(boardStore.getState().past).toHaveLength(0);
  });
});

describe('shortcuts behind an open dialog (P13)', () => {
  it('⌘Z does not undo the board behind a dialog', () => {
    add('div', { 'data-modal': 'settings' });
    ctrl(window, 'z');
    expect(boardStore.getState().past).toHaveLength(1);
  });

  it('⌘K does not open the palette over another dialog', () => {
    add('div', { 'data-modal': 'settings' });
    ctrl(window, 'k');
    expect(onCommandPalette).not.toHaveBeenCalled();
  });

  it('⌘K still closes the open palette', () => {
    add('div', { 'data-modal': 'command-palette' });
    ctrl(window, 'k');
    expect(onCommandPalette).toHaveBeenCalledOnce();
  });
});

describe('dialog marker (P13)', () => {
  // The guard above finds dialogs by `data-modal`, so a full-screen overlay
  // without it would let shortcuts through again.
  it('every full-screen dialog overlay carries data-modal', () => {
    const sources = import.meta.glob<string>('./**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const unmarked = Object.entries(sources)
      .filter(([path]) => !path.includes('.test.'))
      .flatMap(([path, src]) =>
        [...src.matchAll(/<div\b[^>]*?className="[^"]*\bfixed inset-0\b[^"]*"[^>]*>/gs)]
          .filter((m) => !m[0].includes('data-modal='))
          .map(() => path),
      );
    expect(unmarked).toEqual([]);
  });
});

describe('save (P11)', () => {
  it('⌘S goes through the app save path', () => {
    const notPrevented = ctrl(window, 's');
    expect(onSave).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(false); // the browser's own Save Page stays closed
  });

  it('⌘S still saves behind an open dialog', () => {
    add('div', { 'data-modal': 'settings' });
    ctrl(window, 's');
    expect(onSave).toHaveBeenCalledOnce();
  });
});
