// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The editor sidebar's tabs and sections, as data.
 *
 * The sidebar used to be eleven panels hard-coded in render order inside one
 * `overflow-y-auto` column. Nothing could enumerate them, so nothing could reason
 * about them: which tools matter in the rocker view, what is open right now, what
 * to persist. A tool was discoverable only by scrolling past it.
 *
 * Collapsing them into an accordion made every tool *nameable* without scrolling, but
 * only while they were all shut: Specs alone is nineteen rows, so opening it pushed
 * everything below it off-screen again. So the sections now live in four tabs down a
 * permanent strip at the sidebar's edge — the tool list can no longer be displaced by
 * the tool you happen to have open. This is the edge tab strip / tool-window bar
 * pattern (JetBrains, Blender's sidebar, Photoshop's docks).
 *
 * This file is the single source of truth for what the sidebar contains, which tab
 * each tool sits in, and which views each section is relevant to. `Sidebar.tsx` renders
 * in this order; the reducers below decide what is open, and are pure — no React, no
 * DOM — so the behaviour can be tested without mounting anything. Icons deliberately
 * live in `Sidebar.tsx` rather than here, so that stays true.
 *
 * Modelled on `shortcuts.ts`, which solved the same "nothing can enumerate these"
 * problem for key bindings.
 */
import type { View } from './view-toolkit';

export type SectionId =
  | 'specs'
  | 'resize'
  | 'controlPoint'
  | 'analysis'
  | 'boardInfo'
  | 'fins'
  | 'weight'
  | 'trace'
  | 'history'
  | 'compare';

/** The four tabs, one per group of tools. */
export type TabId = 'specs' | 'shape' | 'build' | 'reference';

export interface SidebarTab {
  id: TabId;
  /**
   * Caption under the strip icon. Short because the strip is 64px wide and the
   * caption renders at 9px — "REFERENCE" does not fit, "REF" does.
   */
  label: string;
  /**
   * Full name, for the panel header and the tab button's accessible name. A strip
   * abbreviation is a rendering constraint, not what the tab is called.
   *
   * Not "Board" for the build tab: the menubar already has a Board menu, and two
   * different things under one word on the same screen is a question the user has to
   * stop and answer.
   */
  title: string;
}

export const SIDEBAR_TABS: readonly SidebarTab[] = [
  { id: 'specs', label: 'Specs', title: 'Specs' },
  { id: 'shape', label: 'Shape', title: 'Shape' },
  { id: 'build', label: 'Build', title: 'Build' },
  { id: 'reference', label: 'Ref', title: 'Reference' },
];

const TAB_IDS: readonly TabId[] = SIDEBAR_TABS.map((t) => t.id);

export function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
}

export function tabById(id: TabId): SidebarTab {
  const found = SIDEBAR_TABS.find((t) => t.id === id);
  if (!found) throw new Error(`Unknown sidebar tab: ${id}`);
  return found;
}

/** The sections in a tab, in registry order. */
export function sectionsInTab(id: TabId): readonly SidebarSection[] {
  return SIDEBAR_SECTIONS.filter((s) => s.tab === id);
}

/**
 * The four bands of the spec readout.
 *
 * Collapsible because the readout is nineteen rows: open, it fills the sidebar on a
 * laptop, which is the whole reason the tabs exist. Shut, each header still carries the
 * one number that band is usually consulted for.
 */
export type SpecGroupId = 'nose' | 'center' | 'tail' | 'overall';

export const SPEC_GROUPS: readonly { id: SpecGroupId; title: string }[] = [
  { id: 'nose', title: 'Nose' },
  { id: 'center', title: 'Center' },
  { id: 'tail', title: 'Tail' },
  { id: 'overall', title: 'Overall' },
];

const SPEC_GROUP_IDS: readonly SpecGroupId[] = SPEC_GROUPS.map((g) => g.id);

export function isSpecGroupId(v: unknown): v is SpecGroupId {
  return typeof v === 'string' && (SPEC_GROUP_IDS as readonly string[]).includes(v);
}

export function specGroupIds(): readonly SpecGroupId[] {
  return SPEC_GROUP_IDS;
}

export interface SidebarSection {
  id: SectionId;
  title: string;
  /** Which tab this tool lives in. */
  tab: TabId;
  /**
   * Views this section is relevant to. On a view change, a section the user has not
   * touched opens here and closes elsewhere.
   *
   * `'all'` is always relevant; `[]` is never auto-opened — reference material you
   * reach for deliberately (Board info, Weight, History) rather than tools a view
   * implies.
   */
  relevantTo: readonly View[] | 'all';
  /** Open on a first-ever visit, before any view change or manual toggle. */
  defaultOpen: boolean;
}

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
  { id: 'specs', title: 'Specs', tab: 'specs', relevantTo: 'all', defaultOpen: true },
  { id: 'resize', title: 'Resize', tab: 'shape', relevantTo: [], defaultOpen: false },
  {
    id: 'controlPoint',
    title: 'Control point',
    tab: 'shape',
    // Not 3D: there is no control point to inspect in a view you cannot edit in.
    relevantTo: ['outline', 'rocker', 'crossSection', 'quad'],
    defaultOpen: false,
  },
  {
    id: 'analysis',
    title: 'Analysis',
    tab: 'shape',
    // Not pre-opened in the cross-section: CoM and volume distribution draw only on the
    // outline and rocker. Grid and comb draw there too, toggled from the View menu.
    relevantTo: ['outline', 'rocker', '3d', 'quad'],
    defaultOpen: false,
  },

  { id: 'boardInfo', title: 'Board info', tab: 'build', relevantTo: [], defaultOpen: false },
  {
    id: 'fins',
    title: 'Fins',
    tab: 'build',
    // Fins are only drawn in 3D, so that is where changing them shows something.
    relevantTo: ['3d', 'quad'],
    defaultOpen: false,
  },
  { id: 'weight', title: 'Weight estimate', tab: 'build', relevantTo: [], defaultOpen: false },

  {
    id: 'trace',
    title: 'Trace image',
    tab: 'reference',
    // The two views that can hold a trace at all.
    relevantTo: ['outline', 'rocker'],
    defaultOpen: false,
  },
  { id: 'history', title: 'History', tab: 'reference', relevantTo: [], defaultOpen: false },
  {
    id: 'compare',
    title: 'Compare (Δ vs ghost)',
    tab: 'reference',
    // Rendered only while a ghost board is loaded, so "always relevant" here means
    // "whenever it exists at all".
    relevantTo: 'all',
    defaultOpen: true,
  },
];

const ALL_IDS: readonly SectionId[] = SIDEBAR_SECTIONS.map((s) => s.id);

/** Section ids in registry order, for rendering and for iterating the reducers. */
export function sectionIds(): readonly SectionId[] {
  return ALL_IDS;
}

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (ALL_IDS as readonly string[]).includes(v);
}

export interface SidebarState {
  /** Desktop only: folded to the tab strip alone, with no panel beside it. */
  collapsed: boolean;
  /** The tab whose panel is the one being worked in. */
  activeTab: TabId;
  /**
   * A tab held open above the active one, so a readout can stay on screen while you
   * edit elsewhere — Specs beside Shape being the case that motivated it.
   *
   * May equal `activeTab`, and then only one panel renders. Allowing that is what keeps
   * this simple: an invariant that the two always differ would force an answer to
   * "which tab becomes active when I pin the one I am in", and there is no good one.
   * Pinning the current tab just lights its pin; walk to another and it appears above.
   */
  pinnedTab: TabId | null;
  /** Ids currently expanded. */
  open: readonly SectionId[];
  /**
   * Ids the user has opened or closed by hand, which the per-view automation must
   * never override again.
   *
   * Persisted rather than session-scoped on purpose: "I opened Fins, stop closing it"
   * is a preference, and it should survive a reload. The automation therefore decays
   * as preferences accumulate, which is the right shape for a default — it helps
   * until you have an opinion, then gets out of the way.
   */
  touched: readonly SectionId[];
  /** Expanded bands of the spec readout. */
  specGroups: readonly SpecGroupId[];
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  collapsed: false,
  activeTab: 'specs',
  pinnedTab: null,
  open: SIDEBAR_SECTIONS.filter((s) => s.defaultOpen).map((s) => s.id),
  touched: [],
  // Only Overall: it holds length, volume and centre of mass, which is what the readout
  // is usually consulted for. All four open is nineteen rows again — available, but the
  // user's choice to make rather than the default that undoes the point of the tabs.
  specGroups: ['overall'],
};

function isRelevant(section: SidebarSection, views: readonly View[]): boolean {
  return section.relevantTo === 'all' || views.some((v) => section.relevantTo.includes(v));
}

/**
 * Re-open the sections the new view implies and close the ones it does not —
 * skipping anything the user has touched.
 *
 * Takes the views actually on screen, not the tab that was clicked: the split
 * layout shows two panes at once, and a section is relevant there whenever
 * *either* half makes it so. Passing one view is the ordinary case; `quad` names
 * itself, because what it implies is a property of the layout rather than of the
 * four panes inside it.
 *
 * Deliberately never *removes* a section: every tool stays present and one click
 * away in every view, so switching view can never be the reason a control cannot be
 * found. It only changes what starts expanded.
 */
export function applyViewChange(state: SidebarState, view: View | readonly View[]): SidebarState {
  const views = typeof view === 'string' ? [view] : view;
  const touched = new Set(state.touched);
  const wasOpen = new Set(state.open);
  const open = SIDEBAR_SECTIONS.filter((s) =>
    touched.has(s.id) ? wasOpen.has(s.id) : isRelevant(s, views),
  ).map((s) => s.id);
  // Identity matters: the shell runs this on every view change including the first
  // render, and a fresh object there would re-render and re-persist for nothing.
  return sameIds(open, state.open) ? state : { ...state, open };
}

const sameIds = (a: readonly SectionId[], b: readonly SectionId[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Open or close every section at once — the sidebar's master control.
 *
 * Marks everything touched. Without that the next view change would silently
 * re-open half of what was just collapsed, and the button would read as broken:
 * the user made a wholesale statement about the sidebar, so the automation has to
 * yield wholesale.
 */
export function setAll(
  state: SidebarState,
  open: boolean,
  ids: readonly SectionId[] = ALL_IDS,
): SidebarState {
  const scope = new Set(ids);
  const next = new Set(state.open);
  for (const id of scope) {
    if (open) next.add(id);
    else next.delete(id);
  }
  const touched = new Set(state.touched);
  for (const id of scope) touched.add(id);
  return {
    ...state,
    open: ALL_IDS.filter((id) => next.has(id)),
    touched: ALL_IDS.filter((id) => touched.has(id)),
  };
}

/**
 * Switch tabs. Deliberately touches nothing but `activeTab`: which sections are open
 * inside a tab is a separate question, and re-deriving it here would undo the user's
 * own toggles every time they walked past a tab.
 */
export function selectTab(state: SidebarState, tab: TabId): SidebarState {
  // Picking a tab while folded is a request to see it, not just to select it.
  return state.activeTab === tab && !state.collapsed
    ? state
    : { ...state, activeTab: tab, collapsed: false };
}

/** Pin a tab's panel open above the active one, or unpin it. Capped at one. */
export function togglePin(state: SidebarState, tab: TabId): SidebarState {
  return { ...state, pinnedTab: state.pinnedTab === tab ? null : tab };
}

/** The tabs whose panels render, in order: the pinned one first when it is a second tab. */
export function shownTabs(state: SidebarState): readonly TabId[] {
  const { pinnedTab, activeTab } = state;
  return pinnedTab && pinnedTab !== activeTab ? [pinnedTab, activeTab] : [activeTab];
}

/** Expand or collapse one band of the spec readout. */
export function toggleSpecGroup(state: SidebarState, id: SpecGroupId, open: boolean): SidebarState {
  const next = new Set(state.specGroups);
  if (open) next.add(id);
  else next.delete(id);
  return { ...state, specGroups: SPEC_GROUP_IDS.filter((g) => next.has(g)) };
}

/** Expand or collapse every band of the spec readout. */
export function setAllSpecGroups(state: SidebarState, open: boolean): SidebarState {
  return { ...state, specGroups: open ? [...SPEC_GROUP_IDS] : [] };
}

/** Toggle one section, recording that its state is now the user's to own. */
export function toggleSection(state: SidebarState, id: SectionId, open: boolean): SidebarState {
  const next = new Set(state.open);
  if (open) next.add(id);
  else next.delete(id);
  const touched = new Set(state.touched).add(id);
  return {
    ...state,
    open: ALL_IDS.filter((s) => next.has(s)),
    touched: ALL_IDS.filter((s) => touched.has(s)),
  };
}

/**
 * Whether the master toggle should read "collapse all" (something is open) or
 * "expand all", for the rows it actually governs.
 *
 * Scoped to the active tab: a toggle that reported on tabs you cannot see would light
 * up "collapse all" over an already-empty panel.
 */
export function anyOpen(state: SidebarState, ids: readonly SectionId[] = ALL_IDS): boolean {
  const open = new Set(state.open);
  return ids.some((id) => open.has(id));
}
