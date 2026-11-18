// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a step does to the sidebar, and what choosing Specs, Build or Compare in the list does.
 *
 * The sidebar already knows how to open and shut its sections for a view (`applyViewChange`) and
 * how to show a tab (`selectTab`); a step names the view the sidebar is for and adds, where it
 * needs them, a tab and some sections. Nothing here decides which sections a view implies.
 *
 * Sections a step opens are not marked as the user's own: the next step shuts them again, and a
 * section the user has opened or shut by hand keeps the state they gave it. (`revealSection`
 * marks its section as the user's, which is right for a menu command that names a tool and wrong
 * here: after one visit to each of Bottom, Tail and Fins those three would stay open for good.)
 *
 * Each reducer returns the state it was given when nothing changes, so the shell neither
 * re-renders nor re-saves the view state for a step it has already applied.
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  applyViewChange,
  sectionIds,
  selectTab,
  type SectionId,
  type SidebarState,
  type TabId,
} from '../sidebar-sections';
import { panelById, stepById, type PanelId, type StepId } from './steps';

/** Open the sections the user has not taken over, in registry order. */
function openUntouched(state: SidebarState, ids: readonly SectionId[]): SidebarState {
  const touched = new Set(state.touched);
  const add = ids.filter((id) => !touched.has(id) && !state.open.includes(id));
  if (add.length === 0) return state;
  const open = new Set([...state.open, ...add]);
  return { ...state, open: sectionIds().filter((id) => open.has(id)) };
}

/**
 * Make a tab the one being worked in, leaving a folded sidebar folded: a step changes what the
 * sidebar shows, it does not ask to see it.
 */
function showTab(state: SidebarState, tab: TabId): SidebarState {
  return state.activeTab === tab ? state : { ...state, activeTab: tab };
}

/**
 * `after` unless it says what `before` already said. A step shuts what the view does not want and
 * opens its extras again, which makes a new object holding the same answer; the only fields these
 * reducers move are compared.
 */
function unlessSame(before: SidebarState, after: SidebarState): SidebarState {
  const same =
    before.activeTab === after.activeTab &&
    before.collapsed === after.collapsed &&
    before.open.length === after.open.length &&
    before.open.every((id, i) => id === after.open[i]);
  return same ? before : after;
}

/** The sidebar for a design step. */
export function sidebarForStep(state: SidebarState, id: StepId): SidebarState {
  const { view, tab, open } = stepById(id).sidebar;
  let next = applyViewChange(state, view);
  if (open) next = openUntouched(next, open);
  if (tab) next = showTab(next, tab);
  return unlessSame(state, next);
}

/** The sidebar for a panel entry: its tab, shown even if the sidebar was folded. */
export function sidebarForPanel(state: SidebarState, id: PanelId): SidebarState {
  const { tab, open } = panelById(id);
  return unlessSame(state, selectTab(open ? openUntouched(state, open) : state, tab));
}

/**
 * Apply a step to the sidebar when the step changes, and when the workspace opens (the step
 * restored from the last visit is then the one the sidebar is for).
 */
export function useStepSidebar(step: StepId, setSidebar: Dispatch<SetStateAction<SidebarState>>) {
  useEffect(() => {
    setSidebar((state) => sidebarForStep(state, step));
  }, [step, setSidebar]);
}
