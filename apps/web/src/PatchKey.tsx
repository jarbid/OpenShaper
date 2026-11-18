// SPDX-License-Identifier: GPL-3.0-or-later
import type { RailZones } from '@openshaper/render3d/patches';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { patchKeyEntries } from './patch-text';
import { readStored, writeStored } from './persisted';

/** Where the key remembers whether it is open. */
export const PATCH_KEY_STORAGE = 'bs.patchKey';

const LIST_ID = 'patch-key-list';

/**
 * The key to the Patches look: a swatch and a name for each part of the board, along the bottom
 * edge of the 3D pane where it leaves the board clear. Its right end stops short of the view cube
 * and its flip button (the pane's own controls sit in that corner), it wraps onto more lines in a
 * narrow pane, and one click folds it to a single button; whether it is open is remembered.
 *
 * The box takes the pointer only where it is drawn, so orbiting or tapping the board past it
 * still reaches the canvas. It is memoised on `zones` (the view's own, stable between edits), so a
 * drag does not render it.
 */
export const PatchKey = memo(function PatchKey({ zones }: { zones: RailZones }) {
  const [open, setOpen] = useState(() =>
    readStored(PATCH_KEY_STORAGE, true, (v) => (typeof v === 'boolean' ? v : true)),
  );
  const entries = useMemo(() => patchKeyEntries(zones), [zones]);
  const toggle = () => {
    setOpen(!open);
    writeStored(PATCH_KEY_STORAGE, !open);
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div
      data-testid="patch-key"
      className="pointer-events-none absolute bottom-2 left-2 right-28 z-[2] flex text-xs"
    >
      <div className="pointer-events-auto flex max-w-full items-start gap-2 rounded-md border border-border bg-card/90 px-2 py-1 text-card-foreground shadow-lg">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={LIST_ID}
          aria-label={open ? 'Hide the key to the patches' : 'Show the key to the patches'}
          onClick={toggle}
          className="flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Chevron aria-hidden className="size-3.5" />
          Key
        </button>
        {open && (
          <ul id={LIST_ID} className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 shrink-0 rounded-sm border border-foreground/25"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
