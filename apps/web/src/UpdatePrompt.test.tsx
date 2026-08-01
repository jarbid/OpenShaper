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

afterEach(() => {
  resetRegisterSWState();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
});

describe('UpdatePrompt', () => {
  it('renders nothing where service workers are unavailable', () => {
    setRegisterSWState({ needRefresh: true });
    const { container } = render(<UpdatePrompt />);
    expect(container.innerHTML).toBe('');
  });

  describe('with service worker support', () => {
    beforeEach(withServiceWorkerSupport);

    it('confirms offline readiness, then clears itself', () => {
      vi.useFakeTimers();
      setRegisterSWState({ offlineReady: true });
      render(<UpdatePrompt />);

      expect(screen.getByRole('alert').textContent).toMatch(/ready to work offline/i);

      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    // The whole point of the idle gate: a pending update must not interrupt an
    // edit in progress.
    it('withholds the update prompt until the editor goes quiet', () => {
      vi.useFakeTimers();
      setRegisterSWState({ needRefresh: true });
      render(<UpdatePrompt />);

      expect(screen.queryByRole('alert')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByRole('alert').textContent).toMatch(/new version is available/i);
    });

    it('applies the update only when the user asks for it', () => {
      vi.useFakeTimers();
      const updateServiceWorker = vi.fn(async () => {});
      setRegisterSWState({ needRefresh: true, updateServiceWorker });
      render(<UpdatePrompt />);

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
      render(<UpdatePrompt />);

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
