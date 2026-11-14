// SPDX-License-Identifier: GPL-3.0-or-later
import type { LengthUnit } from './format';
import { patchPhrase } from './patch-text';
import { usePatchPick } from './patch-look';

/**
 * Says what the Patches look has chosen, in words, in the 3D view's status stack; or how to choose.
 * It subscribes to the chosen patch itself, so a tap re-renders this line and nothing above it.
 */
export function PatchReadout({ units }: { units: LengthUnit }) {
  const pick = usePatchPick();
  return (
    <div
      role="status"
      data-testid="patch-readout"
      data-patch={pick?.patch}
      className="rounded-md border border-border bg-card/90 px-2 py-1 text-muted-foreground shadow-lg"
    >
      {pick ? patchPhrase(pick, units) : 'Tap the board to choose a patch'}
    </div>
  );
}
