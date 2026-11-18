// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing for the Rails step: the rail map over the slice of the board at the map's cursor.
 *
 * It also asks the engine for the sections the slice and the panel's zone slice draw: the cursor's place
 * and, while a zone is chosen, the zone's two ends (`nurbs-probes.ts`). While a drag is open (a zone's end
 * or a dial), the ends stay where they were when it began, so the request does not change on every move; the
 * new ends are asked for when it ends.
 *
 * The map and the slice read the rails board and the shared choice themselves, so this component holds no
 * state and, given the same display unit, is not re-rendered by the shell.
 */
import { Panel, PanelBody, PanelTitle } from '@openshaper/ui';
import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { LengthUnit } from '../format';
import { setWantedProbesFor } from '../nurbs-probes';
import { useRailChoice, useRailPlace } from '../rail-choice';
import { useBoardLength, useBoardRails, zonesOfSide } from '../rail-zones';
import { activeStore, railsStore } from '../store';
import { ViewPaneHeader } from '../view-toolkit';
import { RailMap, RailMapActions } from './RailMap';
import { useRailStatus } from './rail-actions';
import { RailSlice } from './RailSlice';
import { wantedPlaces } from './rail-slice';

/** The name the Rails step's places go by in `nurbs-probes.ts`. */
export const PROBE_OWNER = 'rails-step';

const isEditing = (): boolean => railsStore.getState().editing;

/** Ask for the cursor's section and the chosen zone's two ends; withdraw them when the step goes. */
function useRailProbes(): void {
  const rails = useBoardRails();
  const length = useBoardLength();
  const place = useRailPlace();
  const choice = useRailChoice();
  const editing = useSyncExternalStore(railsStore.subscribe, isEditing, () => false);
  const zone =
    rails && choice?.zone !== undefined ? zonesOfSide(rails, choice.side).zones[choice.zone] : null;
  const ends = zone ? { from: zone.from, to: zone.to } : null;
  // held while a drag is open
  const held = useRef(ends);
  if (!editing) held.current = ends;
  const places = rails ? wantedPlaces(place ?? length / 2, held.current) : [];
  const key = places.join(',');
  useEffect(() => {
    setWantedProbesFor(PROBE_OWNER, key === '' ? [] : key.split(',').map(Number));
  }, [key]);
  useEffect(() => () => setWantedProbesFor(PROBE_OWNER, []), []);
}

export const RailsStep = memo(function RailsStep({ units }: { units: LengthUnit }) {
  // a point picked in another step is still selected in the store: the editor's own arrow and Delete
  // keys would act on it while the map is being worked
  useEffect(() => {
    activeStore.getState().select(null);
  }, []);
  useRailProbes();
  const status = useRailStatus();
  return (
    <Panel className="flex h-full min-h-0 flex-col">
      <ViewPaneHeader className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <PanelTitle>Rail map</PanelTitle>
          {/* the hint, until an action has something to say */}
          <p role="status" aria-live="polite" className="truncate text-xs text-muted-foreground">
            {status || 'Tail to nose. Point at the strip and press + to add a zone.'}
          </p>
        </div>
        <RailMapActions />
      </ViewPaneHeader>
      <PanelBody className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        <RailMap units={units} />
        <RailSlice units={units} />
      </PanelBody>
    </Panel>
  );
});
