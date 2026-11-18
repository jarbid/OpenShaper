// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Patches look's state in the app: the patch a tap chose, held apart from the editor's state
 * (the editor re-renders on every drag move; a tap does not need to), and the hook that hands the
 * 3D view what the look needs from it.
 *
 * - The chosen patch ({@link PatchPick}) is one module-level value, read with {@link usePatchPick}.
 * - The rail's zone or blend that is chosen is the Rails step's own store (`rail-choice.ts`), shared
 *   with the rail map and panel: a tap on the board's rail sets it, and what the map chooses lights
 *   the same span on the board. {@link chooseRail} sets it from the map, and clears the pick so one
 *   thing is chosen at a time.
 * - {@link usePatchLook} gives the view the rail's zones (the rails board's, coloured by index), the
 *   selection, and the callback a tap reports to. Only while the look is on and the surface has
 *   patches; otherwise it gives nothing and clears the pick (the rail's choice stays: it is what the
 *   rail panel is editing). Escape clears the choice too, as does a tap on nothing.
 */
import type {
  Board3DViewProps,
  ExternalSurface,
  PatchPick,
  PatchSelection,
} from '@openshaper/render3d';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  clearRailChoice,
  setRailChoice,
  useRailChoice,
  useRailSides,
  type RailChoice,
} from './rail-choice';
import { isLinked, NO_RAIL_ZONES, railZonesForView, useBoardRails } from './rail-zones';
import { railsStore } from './store';

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

/**
 * A tap on the board reports here: the pick is kept, and a tap on a rail's zone or blend is also the
 * Rails step's choice, with the place moved to the tap. Any other tap, or a tap on nothing, chooses
 * no zone or blend.
 */
export function pickOnBoard(next: PatchPick | null): void {
  setPatchPick(next);
  if (next?.patch === 'rail' && next.zone !== undefined) {
    setRailChoice({ side: next.side, zone: next.zone }, next.x);
  } else if (next?.patch === 'rail' && next.blend !== undefined) {
    setRailChoice({ side: next.side, blend: next.blend }, next.x);
  } else {
    clearRailChoice();
  }
}

/** The rail map and panel choose a zone or blend, and the place: the pick a tap made is dropped. */
export function chooseRail(next: RailChoice | null, at?: number): void {
  setPatchPick(null);
  setRailChoice(next, at);
}

const isEditing = (): boolean => railsStore.getState().editing;

/**
 * `zones` as the 3D board should have them: the live ones, except while a drag is open, when they are held
 * until a new mesh arrives (`surface` changes) and then taken together with it. The board is redrawn once for
 * a mesh and its zones, not once for the pointer and again for the mesh a moment later, which doubles the
 * drawing of a drag for a colour that is a mesh behind at most. The drag's end takes the live ones at once.
 */
function useZonesWithSurface<Z>(live: Z, surface: unknown): Z {
  const editing = useSyncExternalStore(railsStore.subscribe, isEditing, () => false);
  const shown = useRef({ zones: live, surface });
  if (!editing || shown.current.surface !== surface) shown.current = { zones: live, surface };
  return shown.current.zones;
}

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
  const rails = useBoardRails();
  const liveZones = useMemo(() => (rails ? railZonesForView(rails) : NO_RAIL_ZONES), [rails]);
  const zones = useZonesWithSurface(liveZones, surface);
  const pick = usePatchPick();
  const choice = useRailChoice();
  const sides = useRailSides();
  // a zone of a board whose two sides are one list is on both; once one side is edited alone it is not
  const both = rails !== null && sides === 'both' && isLinked(rails);

  useEffect(() => {
    if (!on) {
      setPatchPick(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setPatchPick(null);
      clearRailChoice();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  const selection = useMemo((): PatchSelection | null => {
    if (!choice) return pick;
    const part = choice.zone !== undefined ? { zone: choice.zone } : { blend: choice.blend };
    return { patch: 'rail', side: choice.side, ...part, ...(both ? { both } : {}) };
  }, [choice, pick, both]);

  return useMemo(
    () => (on ? { railZones: zones, patchSelection: selection, onPatchPick: pickOnBoard } : NONE),
    [on, zones, selection],
  );
}
