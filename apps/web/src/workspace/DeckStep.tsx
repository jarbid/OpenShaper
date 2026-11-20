// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing for the Deck step: the deck at the chosen station, and under it the strip of the board's stations.
 *
 * - **The slice** (`DeckSlice`): the board's section there, to scale, with the deck curve and one handle, the
 *   crown. It is what the step shows while the deck is Flat or Domed.
 * - **The curve's own points**: the cross-section editor, with the deck curve forced, for Edit curve and for a
 *   Custom deck, whose points are all there is to it. The shell builds the editor (it owns the editor's many
 *   props) and hands in a function that makes it.
 * - **The strip** (`StationStrip`): every station tail to nose. A tap chooses one, a drag moves it, "+" adds
 *   one and Delete removes the chosen one; each is one undo step. The chosen station is the shell's own choice
 *   (the one `[` and `]` step through), so the slice, the panel, the editor and the keys all agree.
 *
 * The slice and the strip read the rails board themselves, so this component holds no board and its children
 * are not re-rendered by the shell while a drag is on.
 */
import { MIN_STATIONS, sliceOfStation, stationOfSlice } from '@openshaper/store/rails';
import { Panel, PanelBody, PanelTitle } from '@openshaper/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LengthUnit } from '../format';
import { activeStore, railsStore } from '../store';
import { ViewPaneHeader } from '../view-toolkit';
import { boardLengthOf } from '../rail-zones';
import { STATUS_MS, useDeckEditCurve } from './deck-choice';
import { useDeckStation, useRailsDoc, useStationMarks } from './deck-data';
import { EditCurveButton } from './DeckPanel';
import { DeckSlice } from './DeckSlice';
import { StationStrip } from './StationStrip';
import { useCoalescedEdit } from './use-coalesced-edit';

export interface DeckStepProps {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  station: number;
  /** Choose a station by its classic slice index. */
  onStation: (slice: number) => void;
  /** The cross-section editor for the deck curve, given the control that takes the drawing back to the shape. */
  renderEditor: (control: ReactNode) => ReactNode;
}

/** What the slice's header says under its title, by the shape of the deck. */
function hint(shape: string | undefined, handle: boolean): string {
  if (shape === 'flat')
    return 'Flat: level from the stringer to the rail. Choose Domed for a crown.';
  if (shape === 'domed' || handle) return 'Drag the handle up and down to set the crown.';
  return 'Nothing to shape at this station.';
}

export function DeckStep({ units, station, onStation, renderEditor }: DeckStepProps) {
  const doc = useRailsDoc();
  const deck = useDeckStation(station);
  const marks = useStationMarks(doc);
  const editCurve = useDeckEditCurve();
  const edit = useCoalescedEdit();
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string) => {
    clearTimeout(timer.current);
    setStatus(text);
    if (text !== '') timer.current = setTimeout(() => setStatus(''), STATUS_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const shape = deck?.reading?.shape;
  const custom = shape === 'custom';
  const showKnots = editCurve || custom;

  // a point selected in the editor is still selected in the store when the shape's handle is shown: the editor's
  // own arrow and Delete keys would act on it where it cannot be seen
  useEffect(() => {
    if (!showKnots) activeStore.getState().select(null);
  }, [showKnots]);

  const chosen = doc ? stationOfSlice(station, doc.stations.length) : null;

  const onChoose = useCallback((index: number) => onStation(sliceOfStation(index)), [onStation]);
  const onMove = useCallback((index: number, x: number) => {
    railsStore.getState().moveCrossSection(sliceOfStation(index), x);
  }, []);
  const onAdd = useCallback(
    (x: number) => {
      const slice = railsStore.getState().insertStation(x);
      if (slice > 0) {
        onStation(slice);
        say(`Added station ${slice}.`);
      } else {
        say('There is no room for a station here.');
      }
    },
    [onStation, say],
  );
  const onRemove = useCallback(
    (index: number) => {
      const before = railsStore.getState().doc?.stations.length ?? 0;
      railsStore.getState().deleteCrossSection(sliceOfStation(index));
      const after = railsStore.getState().doc?.stations.length ?? 0;
      if (after < before) {
        onStation(sliceOfStation(Math.min(index, after - 1)));
        say(`Removed station ${index + 1}.`);
      } else {
        say(`A board keeps at least ${MIN_STATIONS} stations.`);
      }
    },
    [onStation, say],
  );

  if (!doc) return null;

  const control = <EditCurveButton custom={custom} />;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
      <div className="min-h-[9rem] flex-1">
        {showKnots ? (
          renderEditor(control)
        ) : (
          <Panel className="flex h-full min-h-0 flex-col">
            <ViewPaneHeader className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <PanelTitle>Deck{chosen === null ? '' : `: station ${chosen + 1}`}</PanelTitle>
                <p className="truncate text-xs text-muted-foreground">
                  {hint(shape, deck?.range != null)}
                </p>
              </div>
              {control}
            </ViewPaneHeader>
            <PanelBody className="min-h-0 flex-1 p-2">
              <DeckSlice units={units} slice={station} />
            </PanelBody>
          </Panel>
        )}
      </div>
      <Panel className="shrink-0">
        <PanelBody className="px-2 py-1.5">
          <StationStrip
            stations={marks}
            chosen={chosen}
            length={boardLengthOf(doc)}
            units={units}
            minStations={MIN_STATIONS}
            onChoose={onChoose}
            onMove={onMove}
            onAdd={onAdd}
            onRemove={onRemove}
            onGestureStart={edit.begin}
            onGestureEnd={edit.end}
            status={status}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
