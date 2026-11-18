// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace: the layout a rails board is edited in, in place of the tabbed views.
 *
 * ```
 * +----------+----------------------------------+--------------+
 * | design   |  the board in 3D (look controls) |  the sidebar |
 * | list     |----------------------------------|  (a sheet    |
 * |          |  the drawing for the chosen step |   below lg)  |
 * +----------+----------------------------------+--------------+
 * ```
 *
 * It owns the layout and what follows from the step: it holds the step, applies it to the sidebar
 * and chooses it when the board is tapped. It builds nothing of the editor: the shell gives it the
 * 3D pane, its controls, the function that makes the drawing for a step and the sidebar, already
 * made. None of them is rendered by anything that depends on the step but the drawing, so a step
 * change re-renders the list, the drawing and nothing else, and the 3D pane never remounts (it is in
 * the same place in the tree whatever the step and whatever the tier).
 */
import { Panel, PanelBody, PanelTitle } from '@openshaper/ui';
import { useCallback, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { SidebarState, TabId } from '../sidebar-sections';
import { ViewPaneHeader } from '../view-toolkit';
import { DesignList } from './DesignList';
import { sidebarForPanel, useStepSidebar } from './sidebar-for-step';
import { SplitPane } from './SplitPane';
import type { PanelId, StepId } from './steps';
import { useTapChoosesStep } from './tap-step';
import { useWorkspaceStep } from './use-step';

export interface RailsWorkspaceProps {
  /** The 3D board: the shell's `ThreeDPane`. */
  board: ReactNode;
  /** The 3D look controls, shown in the board's header. */
  looks: ReactNode;
  /** The drawing for a design step. */
  drawingFor: (step: StepId) => ReactNode;
  /**
   * The panel of the thing being edited (the rail panel), above the sidebar in the same column. It
   * decides for itself whether to show; absent below `lg`, where the shell's bottom sheet holds it.
   */
  panel?: ReactNode;
  /** The sidebar, beside the drawing. Absent below `lg`, where the shell's bottom sheet holds it. */
  sidebar?: ReactNode;
  /** Below `lg`: the design list is a column of icons. */
  compact: boolean;
  /** The shell's sidebar state setter: a step and a panel entry change the sidebar through it. */
  onSidebar: Dispatch<SetStateAction<SidebarState>>;
  /** The tab the sidebar is showing, or null when it is folded away: the list marks it. */
  sidebarTab: TabId | null;
  /** Below `lg`: bring the sheet up after a panel entry is chosen, which is a request to see it. */
  onShowSidebar?: () => void;
}

export function RailsWorkspace({
  board,
  looks,
  drawingFor,
  panel,
  sidebar,
  compact,
  onSidebar,
  sidebarTab,
  onShowSidebar,
}: RailsWorkspaceProps) {
  const [step, setStep] = useWorkspaceStep();
  useStepSidebar(step, onSidebar);
  useTapChoosesStep(setStep);

  const onPanel = useCallback(
    (panel: PanelId) => {
      onSidebar((s) => sidebarForPanel(s, panel));
      onShowSidebar?.();
    },
    [onSidebar, onShowSidebar],
  );

  return (
    <div className="flex h-full min-h-0 gap-3">
      <DesignList
        step={step}
        onStep={setStep}
        sidebarTab={sidebarTab}
        onPanel={onPanel}
        compact={compact}
      />
      <SplitPane
        className="min-h-0 min-w-0 flex-1"
        top={
          <Panel className="flex h-full min-h-0 flex-col">
            <ViewPaneHeader className="flex items-center justify-between gap-3">
              <PanelTitle>3D</PanelTitle>
              {looks}
            </ViewPaneHeader>
            <PanelBody className="min-h-0 flex-1 p-0">{board}</PanelBody>
          </Panel>
        }
        bottom={<div className="h-full min-h-0">{drawingFor(step)}</div>}
      />
      {sidebar ? (
        // the panel (when a step has one) over the sidebar: the column scrolls, and the sidebar keeps a
        // height it can be used at; with no panel it fills the column as it always has
        <div className="flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto">
          {panel}
          <div className="flex min-h-[22rem] flex-1">{sidebar}</div>
        </div>
      ) : null}
    </div>
  );
}
