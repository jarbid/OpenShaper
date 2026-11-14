// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The closed sections the rails store draws, from the engine's probes.
 *
 * The rails store cannot compute a station's closed section (that is the engine's, in a worker), so the
 * app asks the worker for it and hands it over (`setSlices`, keyed by station id):
 *
 * - **Settled.** Every build also asks for the section at every station, so the store has them all.
 * - **Dragging.** Each draft build asks only for the station being edited (the one whose curve is
 *   selected) and the one the cross-section tab shows, so the section follows the drag at the cost of one
 *   or two probes; the other stations' sections are as of the last settled build until the drag ends.
 *
 * A probe answer is for the board it was asked of: it is used only if it is for the rails store's current
 * document (`ViewerProbes.rails`, `generation`), and a station that has moved since is not matched.
 */
import type { RailsBoard } from '@openshaper/board2';
import type { RailsSlices, RailsState } from '@openshaper/store/rails';
import type { StoreApi } from 'zustand/vanilla';
import type { ViewerProbes } from './nurbs-viewer';
import type { SectionProbe } from './workers/nurbs-protocol';

/**
 * The places along the board to ask sections at: while dragging (`editedX` is the edited station's place,
 * or null for a drag of something else) that station and `wanted` (what the cross-section tab shows);
 * settled, every station and `wanted`. No place twice.
 */
export function railsProbePlaces(
  doc: RailsBoard,
  editing: boolean,
  editedX: number | null,
  wanted: readonly number[],
): readonly number[] {
  const places = editing
    ? editedX === null
      ? [...wanted]
      : [editedX, ...wanted]
    : [...doc.stations.map((s) => s.x), ...wanted];
  return [...new Set(places)];
}

/** The slices of the stations `doc` has at the places `items` were taken: a station whose place no longer matches has none. */
export function slicesOfProbes(doc: RailsBoard, items: readonly SectionProbe[]): RailsSlices {
  const out: Record<string, { plus: readonly number[]; minus?: readonly number[] }> = {};
  for (const station of doc.stations) {
    const probe = items.find((p) => p.xi === station.x);
    if (!probe) continue;
    out[station.id] = probe.minus ? { plus: probe.plus, minus: probe.minus } : { plus: probe.plus };
  }
  return out;
}

/**
 * Give the rails store the sections of an answer: merged over the ones it has (a drag's answer holds one
 * station), and ignored when it is not for the store's current document.
 */
export function feedRailsSlices(store: StoreApi<RailsState>, probes: ViewerProbes | null): void {
  if (!probes || !probes.rails) return;
  const { doc, loadCount, slices } = store.getState();
  if (!doc || probes.generation !== loadCount) return;
  const fresh = slicesOfProbes(doc, probes.items);
  const ids = Object.keys(fresh);
  if (ids.length === 0) return;
  const same =
    slices !== null &&
    ids.every((id) => {
      const had = slices[id];
      const now = fresh[id]!;
      return (
        had !== undefined &&
        had.plus.length === now.plus.length &&
        had.plus.every((v, k) => v === now.plus[k]) &&
        (had.minus?.length ?? -1) === (now.minus?.length ?? -1) &&
        (had.minus ?? []).every((v, k) => v === now.minus![k])
      );
    });
  if (same) return;
  store.getState().setSlices({ ...slices, ...fresh });
}
