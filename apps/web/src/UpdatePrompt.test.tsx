// SPDX-License-Identifier: GPL-3.0-or-later
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdatePrompt } from './UpdatePrompt';
import { resetRegisterSWState, setRegisterSWState } from './test/pwa-register-stub';

/**
 * jsdom has no `navigator.serviceWorker`, and `canUseServiceWorker()` reads it
 * live, so tests that want the prompt visible install a stub first.
 */
function withServiceWorkerSupport() {
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
}

/** A document store stand-in the test can poke: `edit()` notifies every listener. */
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const edit = () => listeners.forEach((l) => l());

afterEach(() => {
  resetRegisterSWState();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
});

describe('UpdatePrompt', () => {
  it('renders nothing where service workers are unavailable', () => {
    setRegisterSWState({ needRefresh: true });
    const { container } = render(<UpdatePrompt subscribe={subscribe} />);
    expect(container.innerHTML).toBe('');
  });

  describe('with service worker support', () => {
    beforeEach(withServiceWorkerSupport);

    // Caching the app's own code is ordinary PWA behaviour; announcing it reads
    // as the app doing something unrequested. The first install must stay silent.
    it('says nothing when the worker finishes its first install', () => {
      vi.useFakeTimers();
      setRegisterSWState({ offlineReady: true, needRefresh: false });
      const { container } = render(<UpdatePrompt subscribe={subscribe} />);

      expect(container.innerHTML).toBe('');

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(container.innerHTML).toBe('');
    });

    // The whole point of the idle gate: a pending update must not interrupt an
    // edit in progress.
    it('withholds the update prompt until the editor goes quiet', () => {
      vi.useFakeTimers();
      setRegisterSWState({ needRefresh: true });
      render(<UpdatePrompt subscribe={subscribe} />);

      expect(screen.queryByRole('alert')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByRole('alert').textContent).toMatch(/new version is available/i);
    });

    // The gate listens to the document it is given: the fin designer passes its own
    // store, so its edits (not the unused board store's) hold the prompt back.
    it('keeps waiting while the document is being edited', () => {
      vi.useFakeTimers();
      setRegisterSWState({ needRefresh: true });
      render(<UpdatePrompt subscribe={subscribe} />);

      act(() => {
        vi.advanceTimersByTime(15_000);
        edit();
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.queryByRole('alert')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByRole('alert').textContent).toMatch(/new version is available/i);
    });

    it('applies the update only when the user asks for it', () => {
      vi.useFakeTimers();
      const updateServiceWorker = vi.fn(async () => {});
      setRegisterSWState({ needRefresh: true, updateServiceWorker });
      render(<UpdatePrompt subscribe={subscribe} />);

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(updateServiceWorker).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /reload/i }));
      expect(updateServiceWorker).toHaveBeenCalledTimes(1);
      expect(updateServiceWorker).toHaveBeenCalledWith(true);
    });

    it('can be dismissed', () => {
      vi.useFakeTimers();
      setRegisterSWState({ needRefresh: true });
      render(<UpdatePrompt subscribe={subscribe} />);

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
