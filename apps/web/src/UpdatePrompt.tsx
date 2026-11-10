// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Registers the service worker and surfaces its one user-visible moment:
 * "a new version is available".
 *
 * The first install is deliberately silent. Caching an app's own code is
 * ordinary PWA behaviour that users neither ask for nor expect to be told about
 * — announcing it reads as the app doing something unrequested. (The opt-in
 * "work offline" switches in Google Docs and Gmail are about caching a user's
 * *documents*; designs were already kept locally in IndexedDB, and this
 * worker caches app code only.) Discoverability comes from the browser's own
 * install affordance instead.
 *
 * Mounted from the designer's page (FinPage), so registration only happens there —
 * see pwa.ts and docs/design/offline.md.
 *
 * The update is never applied on its own. `registerType: 'prompt'` keeps the new
 * worker waiting, and it only activates when the user presses Reload, so a
 * half-finished design is never yanked out from under them. The prompt waits until
 * the store passed as `subscribe` has been quiet for a while — the designer passes
 * its own document store, so the gate hears its edits.
 */
import { useEffect, useState } from 'react';
import { Button, Toast } from '@openshaper/ui';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { captureError } from './analytics';
import { canUseServiceWorker, createIdleGate } from './pwa';

export interface UpdatePromptProps {
  /** Subscribe to the document being edited; the prompt waits until it goes quiet. */
  subscribe: (listener: () => void) => () => void;
}

export function UpdatePrompt({ subscribe }: UpdatePromptProps) {
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
      // Reported because the consequence is invisible: the offline mode and
      // the update prompt both quietly stop existing, and nothing on screen
      // says so.
      captureError('sw_register', error);
    },
  });

  // Hold the update prompt back until the user stops editing.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!needRefresh) return;
    setSettled(false);
    const gate = createIdleGate({ subscribe });
    return gate.onSettled(() => setSettled(true));
  }, [needRefresh, subscribe]);

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
