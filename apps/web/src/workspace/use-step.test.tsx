// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The step is remembered under its own key and checked on the way back in; the Patches default is
 * claimed once, ever.
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimPatchesDefault,
  getWorkspaceStep,
  parseStep,
  PATCHES_STORAGE_KEY,
  resetWorkspaceStep,
  setWorkspaceStep,
  STEP_STORAGE_KEY,
  useWorkspaceStep,
} from './use-step';

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStep();
});

describe('parseStep', () => {
  it('keeps an id the workspace has and falls back to the outline for anything else', () => {
    expect(parseStep('rails')).toBe('rails');
    for (const v of ['specs', 'Deck', '', 7, null, undefined, {}, ['deck']]) {
      expect(parseStep(v), JSON.stringify(v)).toBe('outline');
    }
  });
});

describe('the stored step', () => {
  it('is the outline when nothing is stored', () => {
    expect(getWorkspaceStep()).toBe('outline');
  });

  it('is read from its own key', () => {
    localStorage.setItem(STEP_STORAGE_KEY, JSON.stringify('bottom'));
    resetWorkspaceStep();
    expect(getWorkspaceStep()).toBe('bottom');
  });

  it('reads an unknown id, a wrong type and broken JSON as the outline', () => {
    for (const raw of [JSON.stringify('nonsense'), JSON.stringify(4), '{not json', 'null']) {
      localStorage.setItem(STEP_STORAGE_KEY, raw);
      resetWorkspaceStep();
      expect(getWorkspaceStep(), raw).toBe('outline');
    }
  });

  it('is written when a step is chosen, and comes back after a reload', () => {
    setWorkspaceStep('fins');
    expect(JSON.parse(localStorage.getItem(STEP_STORAGE_KEY)!)).toBe('fins');
    resetWorkspaceStep();
    expect(getWorkspaceStep()).toBe('fins');
  });

  it('is kept out of the view state', () => {
    setWorkspaceStep('tail');
    expect(localStorage.getItem('bs.viewState')).toBeNull();
  });

  it('is not written again for the step it already is', () => {
    setWorkspaceStep('deck');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    setWorkspaceStep('deck');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('survives storage that refuses to be read or written', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    resetWorkspaceStep();
    expect(getWorkspaceStep()).toBe('outline');
    expect(() => setWorkspaceStep('rocker')).not.toThrow();
    expect(getWorkspaceStep()).toBe('rocker');
    read.mockRestore();
    write.mockRestore();
  });
});

describe('useWorkspaceStep', () => {
  it('returns the step and the setter, and the setter is the same function every render', () => {
    const { result, rerender } = renderHook(() => useWorkspaceStep());
    expect(result.current[0]).toBe('outline');
    const set = result.current[1];
    rerender();
    expect(result.current[1]).toBe(set);
  });

  it('re-renders every component that reads it when a step is chosen', () => {
    const Read = ({ id }: { id: string }) => <span data-testid={id}>{useWorkspaceStep()[0]}</span>;
    render(
      <>
        <Read id="a" />
        <Read id="b" />
      </>,
    );
    act(() => setWorkspaceStep('rails'));
    expect(screen.getByTestId('a').textContent).toBe('rails');
    expect(screen.getByTestId('b').textContent).toBe('rails');
  });

  it('chooses through the returned setter', () => {
    const { result } = renderHook(() => useWorkspaceStep());
    act(() => result.current[1]('tail'));
    expect(result.current[0]).toBe('tail');
    expect(getWorkspaceStep()).toBe('tail');
  });
});

describe('the Patches default', () => {
  it('is claimed the first time and never again', () => {
    expect(claimPatchesDefault()).toBe(true);
    expect(claimPatchesDefault()).toBe(false);
    expect(claimPatchesDefault()).toBe(false);
    expect(JSON.parse(localStorage.getItem(PATCHES_STORAGE_KEY)!)).toBe(true);
  });

  it('is read from storage every time, not remembered in memory', () => {
    expect(claimPatchesDefault()).toBe(true);
    localStorage.clear();
    expect(claimPatchesDefault()).toBe(true);
  });

  it('is not claimed by a step being chosen', () => {
    setWorkspaceStep('deck');
    expect(claimPatchesDefault()).toBe(true);
  });
});
