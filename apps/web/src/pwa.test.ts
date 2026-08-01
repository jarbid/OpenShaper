// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { canUseServiceWorker, createIdleGate } from './pwa';

describe('canUseServiceWorker', () => {
  // The premise of the capability check, mirroring use-specs-worker.test.ts:
  // jsdom has no service worker, so the editor must degrade rather than throw.
  it('is false in this test environment', () => {
    expect('serviceWorker' in navigator).toBe(false);
    expect(canUseServiceWorker()).toBe(false);
  });

  it('is false when there is no navigator at all', () => {
    expect(canUseServiceWorker(undefined, '/')).toBe(false);
  });

  it('is false when the navigator lacks serviceWorker', () => {
    expect(canUseServiceWorker({} as Navigator, '/')).toBe(false);
  });

  // The Tauri desktop shell builds with a relative base and serves over a custom
  // protocol, where registration cannot work.
  it('is false for a relative base (the Tauri build)', () => {
    expect(canUseServiceWorker({ serviceWorker: {} } as Navigator, './')).toBe(false);
  });

  it('is true for a supported browser on the site root', () => {
    expect(canUseServiceWorker({ serviceWorker: {} } as Navigator, '/')).toBe(true);
  });
});

describe('createIdleGate', () => {
  /** Minimal store stub: `fire()` simulates a board edit landing in the store. */
  function fakeStore() {
    const listeners = new Set<() => void>();
    return {
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      fire: () => listeners.forEach((cb) => cb()),
      get count() {
        return listeners.size;
      },
    };
  }

  it('runs the callback once the editor has been quiet', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const cb = vi.fn();

    createIdleGate({ subscribe: store.subscribe, quietMs: 1000 }).onSettled(cb);

    vi.advanceTimersByTime(999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // The point of the gate: an update prompt must never appear mid-drag.
  it('withholds the callback while edits keep arriving', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const cb = vi.fn();

    createIdleGate({ subscribe: store.subscribe, quietMs: 1000 }).onSettled(cb);

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(800);
      store.fire();
    }
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fires at most once', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const cb = vi.fn();

    createIdleGate({ subscribe: store.subscribe, quietMs: 500 }).onSettled(cb);
    vi.advanceTimersByTime(500);
    store.fire();
    vi.advanceTimersByTime(5000);

    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('unsubscribes and cancels on cleanup', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const cb = vi.fn();

    const cleanup = createIdleGate({ subscribe: store.subscribe, quietMs: 500 }).onSettled(cb);
    expect(store.count).toBe(1);

    cleanup();
    vi.advanceTimersByTime(5000);

    expect(cb).not.toHaveBeenCalled();
    expect(store.count).toBe(0);
    vi.useRealTimers();
  });
});
