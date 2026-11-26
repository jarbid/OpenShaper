// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace's steps, as data: the design list, the keys that choose a step, what each step
 * draws and what each step does to the sidebar.
 *
 * This is the one place a step is defined. The list (`DesignList.tsx`), the keys (`shortcuts.ts`
 * derives `STEP_KEYS` from it), the drawing (`App.tsx` builds the pane a step names), the sidebar
 * (`sidebar-for-step.ts`) and the tap on the board (`tap-step.ts`) all read it, so adding a step is
 * one entry here.
 *
 * Two kinds of entry share the list, in order: the design steps, which choose what the drawing
 * shows, and the panel entries (Specs, Build, Compare), which are not steps: they choose a tab of
 * the sidebar and leave the drawing as it is.
 *
 * Icons are here, unlike the sidebar's registry, because the list is the only thing that draws
 * them and a step without one would be half defined.
 */
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Fish,
  GitCompare,
  Layers,
  PenTool,
  Ruler,
  Triangle,
  Waves,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import type { SectionId, TabId } from '../sidebar-sections';
import type { EditorKind, View } from '../view-toolkit';

export type StepId = 'outline' | 'rocker' | 'deck' | 'bottom' | 'rails' | 'tail' | 'fins';

/** The sidebar's own tabs the list also offers, by the name the list gives them. */
export type PanelId = 'specs' | 'build' | 'compare';

/**
 * The curve of a station the cross-section drawing edits for a step: the deck's, the bottom's, or
 * none (the closed section alone, nothing editable).
 */
export type StepCurve = 'deck' | 'bottom' | null;

/** What a step's drawing shows. */
export interface StepDrawing {
  /**
   * The editor that draws it (`EditorPane`'s `kind`), or the rail map (`RailsStep`), which is not an
   * editor pane: it is the Rails step's own drawing.
   */
  readonly editor: EditorKind | 'railMap';
  /** The drawing's heading. */
  readonly title: string;
  /** Cross-section drawings only: the curve it edits, in place of the saved Deck | Bottom choice. */
  readonly curve?: StepCurve;
}

/** What a step does to the sidebar. */
export interface StepSidebar {
  /**
   * The view the sidebar is for. It goes to `applyViewChange`, so sections open and shut as they do
   * for that view in the tabbed layout, and never against the user's own toggles.
   */
  readonly view: View;
  /** A tab to show. */
  readonly tab?: TabId;
  /** Sections to open besides what the view opens. They are not marked as the user's own. */
  readonly open?: readonly SectionId[];
  /**
   * Sections to shut that the view opens, because the step has a panel of its own that does their work. A
   * section the user has opened or shut by hand is theirs and is left as they have it.
   */
  readonly shut?: readonly SectionId[];
}

export interface DesignStep {
  readonly kind: 'design';
  readonly id: StepId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The key that chooses it while the workspace shows. */
  readonly key: string;
  readonly drawing: StepDrawing;
  readonly sidebar: StepSidebar;
}

export interface PanelEntry {
  readonly kind: 'panel';
  readonly id: PanelId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The sidebar tab it shows. */
  readonly tab: TabId;
  /** Sections it opens (not marked as the user's own). */
  readonly open?: readonly SectionId[];
}

export type WorkspaceEntry = DesignStep | PanelEntry;

/** The design steps, in the order a shaper works. */
export const DESIGN_STEPS: readonly DesignStep[] = [
  {
    kind: 'design',
    id: 'outline',
    label: 'Outline',
    icon: PenTool,
    key: '1',
    drawing: { editor: 'outline', title: 'Outline' },
    sidebar: { view: 'outline' },
  },
  {
    kind: 'design',
    id: 'rocker',
    label: 'Rocker and foil',
    icon: Waves,
    key: '2',
    drawing: { editor: 'rocker', title: 'Rocker and foil' },
    sidebar: { view: 'rocker' },
  },
  {
    kind: 'design',
    id: 'deck',
    label: 'Deck',
    icon: ArrowUpToLine,
    key: '3',
    drawing: { editor: 'crossSection', title: 'Cross-section: deck', curve: 'deck' },
    sidebar: { view: 'crossSection' },
  },
  {
    kind: 'design',
    id: 'bottom',
    label: 'Bottom',
    icon: ArrowDownToLine,
    key: '4',
    drawing: { editor: 'crossSection', title: 'Cross-section: bottom', curve: 'bottom' },
    // the Shape tab, for the control point of a knot in Edit curve; the contours are in the panel above it, so
    // the old Bottom features section, which the cross-section view opens, is shut
    sidebar: { view: 'crossSection', tab: 'shape', shut: ['bottomFeatures'] },
  },
  {
    kind: 'design',
    id: 'rails',
    label: 'Rails',
    icon: Waypoints,
    key: '5',
    drawing: { editor: 'railMap', title: 'Rail map' },
    sidebar: { view: 'crossSection' },
  },
  {
    kind: 'design',
    id: 'tail',
    label: 'Tail',
    icon: Fish,
    key: '6',
    drawing: { editor: 'outline', title: 'Outline: tail' },
    sidebar: { view: 'outline', tab: 'shape', open: ['boardShape'] },
  },
  {
    kind: 'design',
    id: 'fins',
    label: 'Fins',
    icon: Triangle,
    key: '7',
    drawing: { editor: 'outline', title: 'Outline: fins' },
    sidebar: { view: 'outline', tab: 'build', open: ['fins'] },
  },
];

/**
 * Under the design steps: not shaping. Each shows the sidebar tab that holds it. Compare is the
 * section of the Reference tab that measures against a ghost board, so it shows that tab with the
 * section open.
 */
export const PANEL_ENTRIES: readonly PanelEntry[] = [
  { kind: 'panel', id: 'specs', label: 'Specs', icon: Ruler, tab: 'specs' },
  { kind: 'panel', id: 'build', label: 'Build', icon: Layers, tab: 'build' },
  {
    kind: 'panel',
    id: 'compare',
    label: 'Compare',
    icon: GitCompare,
    tab: 'reference',
    open: ['compare'],
  },
];

/** The whole list, in order. */
export const WORKSPACE_ENTRIES: readonly WorkspaceEntry[] = [...DESIGN_STEPS, ...PANEL_ENTRIES];

export const DEFAULT_STEP: StepId = 'outline';

const STEP_IDS: readonly string[] = DESIGN_STEPS.map((s) => s.id);

export const isStepId = (v: unknown): v is StepId => typeof v === 'string' && STEP_IDS.includes(v);

export function stepById(id: StepId): DesignStep {
  const found = DESIGN_STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown workspace step: ${id}`);
  return found;
}

export function panelById(id: PanelId): PanelEntry {
  const found = PANEL_ENTRIES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown workspace panel: ${id}`);
  return found;
}
