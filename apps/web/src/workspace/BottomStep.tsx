// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing for the Bottom step: the board's section at the chosen station with the relief of its contours,
 * and the bottom seen from below with each contour on it.
 *
 * - **The slice** (`BottomSlice`): the section to true scale, the station's bottom curve, and under it the
 *   contours' relief at this station, magnified, with the chosen contour's depth handle.
 * - **The plan from below** (`ContourPlan`): the board's bottom with each contour as a band along it, shaded by
 *   its depth. A tap chooses a contour, the ends and the middle of the chosen one are dragged, and the stations'
 *   ticks along its foot choose the station the slice is at. It takes the place of the Deck step's station
 *   strip: adding, moving and removing a station stay with the Deck step, where the slice is the deck's.
 * - **The bottom curve's own points**: the cross-section editor, with the bottom curve forced, for Edit curve.
 *   The shell builds the editor (it owns the editor's many props) and hands in a function that makes it.
 *
 * Side by side where the pane is wide, one above the other where it is not. The slice and the plan read the
 * rails board themselves, so this component holds no board and its children are not re-rendered by the shell
 * while a drag is on.
 */
import { stationOfSlice } from '@openshaper/store/rails';
import { Panel, PanelBody, PanelTitle } from '@openshaper/ui';
import { useEffect, type ReactNode } from 'react';
import type { LengthUnit } from '../format';
import { activeStore } from '../store';
import { ViewPaneHeader } from '../view-toolkit';
import { useBottomEditCurve } from './bottom-choice';
import { useBottomContours } from './bottom-data';
import { BottomEditCurveButton } from './BottomPanel';
import { BottomSlice } from './BottomSlice';
import { ContourPlan } from './ContourPlan';

export interface BottomStepProps {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  station: number;
  /** Choose a station by its classic slice index. */
  onStation: (slice: number) => void;
  /** The cross-section editor for the bottom curve, given the control that takes the drawing back to the slice. */
  renderEditor: (control: ReactNode) => ReactNode;
}

export function BottomStep({ units, station, onStation, renderEditor }: BottomStepProps) {
  const editCurve = useBottomEditCurve();
  const { doc, chosen } = useBottomContours();

  // a point selected in the editor is still selected in the store when the slice is shown: the editor's own
  // arrow and Delete keys would act on it where it cannot be seen
  useEffect(() => {
    if (!editCurve) activeStore.getState().select(null);
  }, [editCurve]);

  if (!doc) return null;
  const index = stationOfSlice(station, doc.stations.length);

  if (editCurve) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="min-h-[9rem] flex-1">{renderEditor(<BottomEditCurveButton />)}</div>
      </div>
    );
  }
  return (
    <div className="@container flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
      <div className="flex min-h-0 flex-1 flex-col gap-2 @3xl:flex-row">
        <Panel className="flex min-h-[15rem] flex-col @3xl:w-[38%] @3xl:shrink-0">
          <ViewPaneHeader className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <PanelTitle>Bottom{index === null ? '' : `: station ${index + 1}`}</PanelTitle>
              <p className="truncate text-xs text-muted-foreground">
                {chosen
                  ? 'Drag the handle to set the depth.'
                  : 'The bottom is flat. Add a contour in the panel.'}
              </p>
            </div>
            <BottomEditCurveButton />
          </ViewPaneHeader>
          <PanelBody className="min-h-0 flex-1 p-2">
            <BottomSlice units={units} slice={station} />
          </PanelBody>
        </Panel>
        <Panel className="flex min-h-[12rem] min-w-0 flex-1 flex-col">
          <ViewPaneHeader>
            <div className="min-w-0">
              <PanelTitle>Bottom seen from below</PanelTitle>
              <p className="truncate text-xs text-muted-foreground">
                Tail on the left. Tap a contour to choose it; drag its ends or its middle.
              </p>
            </div>
          </ViewPaneHeader>
          <PanelBody className="min-h-0 flex-1 overflow-y-auto p-2">
            <ContourPlan units={units} slice={station} onStation={onStation} />
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
