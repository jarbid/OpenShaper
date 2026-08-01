// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test stand-in for `virtual:pwa-register/react`.
 *
 * That module is synthesised by vite-plugin-pwa during a build, so it does not
 * resolve under Vitest. vitest.config.ts aliases it here; tests drive the hook
 * through {@link setRegisterSWState} instead of running a real service worker.
 */
import { useState } from 'react';

export interface RegisterSWState {
  offlineReady: boolean;
  needRefresh: boolean;
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
}

let state: RegisterSWState = {
  offlineReady: false,
  needRefresh: false,
  updateServiceWorker: async () => {},
};

/** Set what the next `useRegisterSW()` call reports. */
export function setRegisterSWState(next: Partial<RegisterSWState>): void {
  state = { ...state, ...next };
}

/** Reset to the "nothing has happened yet" baseline. */
export function resetRegisterSWState(): void {
  state = { offlineReady: false, needRefresh: false, updateServiceWorker: async () => {} };
}

export function useRegisterSW(_options?: unknown) {
  const [offlineReady, setOfflineReady] = useState(state.offlineReady);
  const [needRefresh, setNeedRefresh] = useState(state.needRefresh);
  return {
    offlineReady: [offlineReady, setOfflineReady] as const,
    needRefresh: [needRefresh, setNeedRefresh] as const,
    updateServiceWorker: state.updateServiceWorker,
  };
}
