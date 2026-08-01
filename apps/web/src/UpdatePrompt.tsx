// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Registers the service worker and surfaces its one user-visible moment:
 * "a new version is available".
 *
 * The first install is deliberately silent. Caching an app's own code is
 * ordinary PWA behaviour that users neither ask for nor expect to be told about
 * — announcing it reads as the app doing something unrequested. (The opt-in
 * "work offline" switches in Google Docs and Gmail are about caching a user's
 * *documents*; OpenShaper's boards were already local in IndexedDB, and this
 * worker caches app code only.) Discoverability comes from the browser's own
 * install affordance instead.
 *
 * Mounted from EditorPage so registration only ever happens on /app — see
 * pwa.ts and docs/design/offline.md for why the marketing pages stay
 * network-served.
 *
 * The update is never applied on its own. `registerType: 'prompt'` keeps the new
 * worker waiting, and it only activates when the user presses Reload, so a
 * half-finished board is never yanked out from under them. The reload itself is
 * safe regardless: App.tsx flushes the session to IndexedDB on `pagehide`, and
 * loadSession() restores it on the way back.
 */
import { useEffect, useState } from 'react';
import { Button, Toast } from '@openshaper/ui';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { canUseServiceWorker, createIdleGate } from './pwa';
import { boardStore } from './store';

export function UpdatePrompt() {
  const supported = canUseServiceWorker();

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError(error) {
      // A failed registration must never break the editor — it just means no
      // offline support this session.
      console.error('Service worker registration failed', error);
    },
  });

  // Hold the update prompt back until the user stops editing.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!needRefresh) return;
    setSettled(false);
    const gate = createIdleGate({ subscribe: (cb) => boardStore.subscribe(cb) });
    return gate.onSettled(() => setSettled(true));
  }, [needRefresh]);

  if (!supported) return null;

  if (needRefresh && settled) {
    return (
      <Toast className="flex items-center gap-3">
        <span>A new version is available.</span>
        <Button size="sm" onClick={() => void updateServiceWorker(true)}>
          Reload
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setNeedRefresh(false)}
        >
          ×
        </button>
      </Toast>
    );
  }

  return null;
}
