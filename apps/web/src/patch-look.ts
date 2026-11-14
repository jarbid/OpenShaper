// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Patches look's state in the app: the patch a tap chose, held apart from the editor's state
 * (the editor re-renders on every drag move; a tap does not need to), and the hook that hands the
 * 3D view what the look needs from it.
 *
 * - The chosen patch ({@link PatchPick}) is one module-level value, read with {@link usePatchPick}.
 * - {@link usePatchLook} gives the view the rail's zones (the document's rail keys, until the
 *   document has zones of its own), the selection, and the callback a tap reports to. Only while the
 *   look is on and the surface has patches; otherwise it gives nothing and clears the choice. Escape
 *   clears it too, as does a tap on nothing.
 */
import type { Board3DViewProps, ExternalSurface, PatchPick } from '@openshaper/render3d';
import { zonesFromRailKeys } from '@openshaper/render3d/patches';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

let chosen: PatchPick | null = null;
const listeners = new Set<() => void>();

export const getPatchPick = (): PatchPick | null => chosen;

/** Chooses a patch, or clears the choice with null. */
export function setPatchPick(next: PatchPick | null): void {
  if (next === chosen) return;
  chosen = next;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The patch the last tap chose, or null. */
export const usePatchPick = (): PatchPick | null =>
  useSyncExternalStore(subscribe, getPatchPick, () => null);

/** What the Patches look needs of the 3D view's props. */
export type PatchLookProps = Pick<Board3DViewProps, 'railZones' | 'patchSelection' | 'onPatchPick'>;

const NONE: PatchLookProps = {};

/**
 * The props for the 3D view for the look chosen: the zones, the selection and the tap callback
 * with the Patches look on a surface that has patches, nothing otherwise.
 */
export function usePatchLook(
  analysis: Board3DViewProps['analysis'],
  surface: ExternalSurface | null,
): PatchLookProps {
  const on = analysis === 'patches' && !!surface?.patch;
  const railKeys = surface?.railKeys ?? null;
  const zones = useMemo(() => zonesFromRailKeys(railKeys), [railKeys]);
  const pick = usePatchPick();

  useEffect(() => {
    if (!on) {
      setPatchPick(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setPatchPick(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  return useMemo(
    () => (on ? { railZones: zones, patchSelection: pick, onPatchPick: setPatchPick } : NONE),
    [on, zones, pick],
  );
}
