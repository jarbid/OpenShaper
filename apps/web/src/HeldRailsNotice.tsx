// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a restored session says when the rails board saved in it would not read (`held-text.ts`): the
 * classic board is shown, the saved text is kept as it was, and how to go on.
 *
 * It is a notice of its own, dismissed by a click, and not the single transient toast: a later toast
 * would replace it, and this is the one that says a board is being kept out of reach. It goes when
 * another board is opened or started (the hold ends with that load).
 */
import { Toast } from '@openshaper/ui';
import { memo, useState, useSyncExternalStore } from 'react';
import { useKeptRails, type Held, type HeldReason } from './held-text';
import { boardStore } from './store';

const SHOWN =
  'It is kept unchanged and the classic board is shown, so saving writes a classic file.';

/**
 * The words, by why the text was not read. Fixed text, never the reader's own message: that one is
 * written for a developer and can quote the document.
 */
export const heldRailsNotice = (reason: HeldReason | null): string =>
  reason === 'unavailable'
    ? `The rails board saved in this browser could not be loaded — the NURBS engine did not load (offline, or the app was just updated). ${SHOWN} Reload to try again, or open or start another board to replace the saved one.`
    : `The rails board saved in this browser could not be read — it may be from a newer OpenShaper. ${SHOWN} Reload to get the latest OpenShaper, or open or start another board to replace the saved one.`;

// The shell re-renders on every move of a drag; this one reads its own stores and has no props.
export const HeldRailsNotice = memo(function HeldRailsNotice() {
  const loadCount = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().loadCount,
  );
  const held = useKeptRails(loadCount);
  // The text that was dismissed, so the next one to be held is told again.
  const [dismissed, setDismissed] = useState<Held | null>(null);
  if (!held || held === dismissed) return null;
  return (
    <Toast onClick={() => setDismissed(held)} data-testid="rails-held">
      {heldRailsNotice(held.reason)}
    </Toast>
  );
});
