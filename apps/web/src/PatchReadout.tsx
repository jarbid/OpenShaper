// SPDX-License-Identifier: GPL-3.0-or-later
import type { PatchPick } from '@openshaper/render3d';
import type { LengthUnit } from './format';
import { patchPhrase } from './patch-text';
import { usePatchPick } from './patch-look';
import { useRailChoice, useRailPlace } from './rail-choice';

/**
 * Says what the Patches look has chosen, in words, in the 3D view's status stack; or how to choose.
 * A zone or blend the rail map chose is what is lit on the board, so it is what is said. It
 * subscribes to the choice itself, so a tap re-renders this line and nothing above it. `quiet` leaves
 * the box to the caller: the workspace puts it in one line with the build status.
 */
export function PatchReadout({ units, quiet = false }: { units: LengthUnit; quiet?: boolean }) {
  const tapped = usePatchPick();
  const choice = useRailChoice();
  const place = useRailPlace();
  const shown: Omit<PatchPick, 'y'> | null = choice
    ? {
        patch: 'rail',
        side: choice.side,
        x: place ?? 0,
        ...(choice.zone !== undefined ? { zone: choice.zone } : { blend: choice.blend }),
      }
    : tapped;
  return (
    <div
      role="status"
      data-testid="patch-readout"
      data-patch={shown?.patch}
      className={
        quiet
          ? 'text-muted-foreground'
          : 'rounded-md border border-border bg-card/90 px-2 py-1 text-muted-foreground shadow-lg'
      }
    >
      {shown ? patchPhrase(shown, units) : 'Tap the board to choose a patch'}
    </div>
  );
}
