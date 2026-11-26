// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The editor's keyboard shortcuts, as data.
 *
 * These used to live only inside `use-keyboard-shortcuts.ts` as a `keydown`
 * if/else chain, which meant nothing could enumerate them: the docs page had to
 * transcribe them by hand, tooltips repeated the key strings independently, and
 * no test could tell when the three drifted apart.
 *
 * This table is now the single source of truth. The hook matches against it, the
 * `/docs/shortcuts` page renders it, and tooltips read their `shortcut` strings
 * from it — so a key can only change in one place.
 *
 * `keys` is the display form (using ⌘/⇧ symbols); `match` is what the handler
 * actually tests. Keep them describing the same chord.
 *
 * The arrow-key nudges are the exception: they act on whichever pane holds the
 * selection, so the pane header's point editor handles them, not the global hook.
 * Their rows carry no `match` and are here so `/docs/shortcuts` lists them; their
 * keys and steps live in {@link NUDGE}, which that handler reads too.
 */
import type { View } from './view-toolkit';
import { DESIGN_STEPS, type StepId } from './workspace/steps';

export type ShortcutGroup =
  | 'File'
  | 'Edit'
  | 'Nudging'
  | 'View'
  | 'Design steps'
  | 'Cross-sections';

/**
 * Where a chord is live, for a chord another layout reuses: the number keys choose a view in the
 * tabbed layout and a design step in the workspace. A chord with no scope is live everywhere.
 */
export type ShortcutScope = 'views' | 'workspace';

export interface ShortcutMatch {
  /** Lowercased `KeyboardEvent.key`, or one of several for an either/or binding. */
  keys: readonly string[];
  /** Requires Ctrl (Windows/Linux) or Cmd (macOS). */
  mod?: boolean;
  /** Requires Shift. */
  shift?: boolean;
  /** Requires Alt (Option on a Mac). */
  alt?: boolean;
  /**
   * Suppressed while a text field has focus. Only meaningful for bindings with no
   * modifier — `⌘S` should still save while a name field is focused, but `[`
   * must not page the cross-section while someone is typing a bracket.
   */
  notInField?: boolean;
  /**
   * Suppressed while the focus is somewhere text is typed, so the browser's own
   * text undo works there. Narrower than `notInField`: a focused checkbox or
   * slider still lets ⌘Z undo the board edit it just made.
   */
  notInTextEntry?: boolean;
}

export interface Shortcut {
  id: string;
  /** Human-readable chord, e.g. `⌘Z`. Shown in docs and tooltips. */
  keys: string;
  label: string;
  group: ShortcutGroup;
  /**
   * What the global handler tests. Omitted for a chord another listener owns (the
   * arrow-key nudges), which is listed only so the docs show it.
   */
  match?: ShortcutMatch;
  /** Where it is live. Omitted: in both layouts. */
  scope?: ShortcutScope;
}

/**
 * The arrow-key nudge (`SelectedPointEditor` in `ControlPointInspector.tsx`).
 *
 * The arrows move the selected point or handle by one step of the length unit.
 * Holding `rotateKey` turns them into a handle rotation, holding `lengthKey` into
 * a handle length change; Shift multiplies whichever step by `shiftFactor`.
 *
 * Held keys rather than modifiers, because both modifier chords are taken:
 * Ctrl+←/→ switches desktops on macOS, and Alt+←/→ is Back/Forward in browsers on
 * Windows and Linux. Lowercased `KeyboardEvent.key` values, like `ShortcutMatch`.
 */
export const NUDGE = {
  rotateKey: 'r',
  lengthKey: 't',
  /** Degrees a handle turns per press. */
  turnDegrees: 1,
  /** Shift multiplies a move, turn or length step by this. */
  shiftFactor: 10,
} as const;

const ARROWS = '←↑→↓';

/**
 * The views, in toolbar order — the single source for both the number keys and
 * the tab strip. The strip used to repeat this list as five hand-written
 * buttons, so gating a view by layout tier was two edits with nothing to keep
 * them honest. `label` names the shortcut on `/docs/shortcuts`; `tabLabel` is
 * the button.
 */
export const VIEW_KEYS: readonly { key: string; view: View; label: string; tabLabel: string }[] = [
  { key: '1', view: 'quad', label: 'Quad view', tabLabel: 'Quad' },
  { key: '2', view: 'outline', label: 'Outline view', tabLabel: 'Outline' },
  { key: '3', view: 'rocker', label: 'Rocker view', tabLabel: 'Rocker' },
  { key: '4', view: 'crossSection', label: 'Cross-section view', tabLabel: 'Cross-section' },
  { key: '5', view: '3d', label: '3D view', tabLabel: '3D' },
  // Appended rather than slotted in beside Quad: this list orders the tab strip
  // *and* numbers the keys, so giving Split the place its kinship with Quad
  // suggests would renumber four bindings people already have in their hands.
  { key: '6', view: 'split', label: 'Split view', tabLabel: 'Split' },
];

/**
 * The workspace's design steps, with the key that chooses each, in list order — derived from the
 * step table (`workspace/steps.ts`), which is the one place a step and its key are defined. The
 * keys are live only while the workspace shows: its numbers are the view tabs' numbers.
 */
export const STEP_KEYS: readonly { key: string; step: StepId; label: string }[] = DESIGN_STEPS.map(
  ({ key, id, label }) => ({ key, step: id, label: `${label} step` }),
);

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'undo',
    keys: '⌘Z',
    label: 'Undo',
    group: 'Edit',
    match: { keys: ['z'], mod: true, notInTextEntry: true },
  },
  {
    id: 'redo',
    keys: '⇧⌘Z',
    label: 'Redo',
    group: 'Edit',
    match: { keys: ['z'], mod: true, shift: true, notInTextEntry: true },
  },
  {
    id: 'redo-alt',
    keys: '⌘Y',
    label: 'Redo (alternative)',
    group: 'Edit',
    match: { keys: ['y'], mod: true, notInTextEntry: true },
  },
  {
    id: 'delete-point',
    keys: 'Delete',
    label: 'Delete the selected control point or reference point',
    group: 'Edit',
    match: { keys: ['delete', 'backspace'], notInField: true },
  },
  {
    id: 'select-next-point',
    keys: '⌥→',
    label: 'Select the next point (control point along the curve, or reference point)',
    group: 'Edit',
    // Alt, not Tab: Tab keeps moving keyboard focus between the canvas and the panels.
    match: { keys: ['arrowright'], alt: true, notInField: true },
  },
  {
    id: 'select-prev-point',
    keys: '⌥←',
    label: 'Select the previous point',
    group: 'Edit',
    match: { keys: ['arrowleft'], alt: true, notInField: true },
  },
  {
    id: 'toggle-lock',
    keys: 'L',
    label: "Lock or unlock the selected point's handle angles",
    group: 'Edit',
    match: { keys: ['l'], notInField: true },
  },
  {
    id: 'nudge',
    keys: ARROWS,
    label: 'Move the selected point or handle one step',
    group: 'Nudging',
  },
  {
    id: 'nudge-shift',
    keys: `⇧ ${ARROWS}`,
    label:
      `${NUDGE.shiftFactor}× the step, whether moving, turning ` +
      `(${NUDGE.shiftFactor * NUDGE.turnDegrees}°) or changing length`,
    group: 'Nudging',
  },
  {
    id: 'nudge-rotate',
    keys: `${NUDGE.rotateKey.toUpperCase()} + ${ARROWS}`,
    label:
      `Hold ${NUDGE.rotateKey.toUpperCase()}: turn the selected handle, or both handles of a ` +
      `selected point, ${NUDGE.turnDegrees}°: Left or Up counter-clockwise, Right or Down clockwise`,
    group: 'Nudging',
  },
  {
    id: 'nudge-length',
    keys: `${NUDGE.lengthKey.toUpperCase()} + ${ARROWS}`,
    label:
      `Hold ${NUDGE.lengthKey.toUpperCase()}: lengthen (Right or Up) or shorten (Left or Down) ` +
      'the selected handle, or both handles of a selected point, one step',
    group: 'Nudging',
  },
  {
    id: 'save',
    keys: '⌘S',
    label: 'Save the board',
    group: 'File',
    match: { keys: ['s'], mod: true },
  },
  {
    id: 'command-palette',
    keys: '⌘K',
    label: 'Open the command palette',
    group: 'File',
    match: { keys: ['k'], mod: true },
  },
  {
    id: 'cross-section-prev',
    keys: '[',
    label: 'Previous cross-section',
    group: 'Cross-sections',
    match: { keys: ['['], notInField: true },
  },
  {
    id: 'cross-section-next',
    keys: ']',
    label: 'Next cross-section',
    group: 'Cross-sections',
    match: { keys: [']'], notInField: true },
  },
  // The Deck step's strip of stations and its crown handle own these keys while they have focus
  // (`workspace/StationStrip.tsx`, `workspace/DeckSlice.tsx`), so they carry no `match`: they are listed
  // so `/docs/shortcuts` shows them, as it does the arrow-key nudges.
  {
    id: 'station-strip-choose',
    keys: '← →',
    label:
      'Deck step, with a station of the strip focused: choose the previous or next station (Home and End: the first and the last)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'station-strip-move',
    keys: '⇧ ← →',
    label:
      'Deck step, with a station of the strip focused: move the chosen station half a centimetre along the board (five with ⌘ too)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'station-strip-remove',
    keys: 'Delete',
    label: 'Deck step, with a station of the strip focused: remove the chosen station',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'crown-handle',
    keys: '↑ ↓',
    label:
      'Deck step, with the crown handle focused: ↓ is more crown and ↑ less, a step of the unit each press (⇧ ten times; Home and End: the least and the most)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  // The Bottom step's handles own these keys while they have focus (`workspace/ContourPlan.tsx`,
  // `ContourLaw.tsx`, `BottomSlice.tsx`), so they carry no `match`: listed so `/docs/shortcuts` shows them.
  {
    id: 'contour-handle',
    keys: '← →',
    label:
      'Bottom step, with the start, middle or end of a contour focused on the plan from below: move it a centimetre along the board (⇧ ten; Home and End: its least and its most)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'depth-handle',
    keys: '↑ ↓',
    label:
      'Bottom step, with the depth handle focused: ↑ is deeper and ↓ shallower, a fifth of a millimetre each press (⇧ ten times; Home and End: the least and the most)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'contour-law-key',
    keys: '← → ↑ ↓',
    label:
      'Bottom step, with a key of a contour’s law focused: ← → move it along the board a centimetre, ↑ ↓ set how deep it is there (⇧ ten times)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'plan-station',
    keys: '← →',
    label:
      'Bottom step, with a station of the plan from below focused: choose the previous or next station (Home and End: the first and the last)',
    group: 'Cross-sections',
    scope: 'workspace',
  },
  {
    id: 'tail-corner-handle',
    keys: '↑ ↓',
    label:
      'Tail step, with a corner’s round handle focused: ↑ is a larger radius and ↓ a smaller, a step of the unit each press (⇧ or Page Up and Page Down ten times; Home and End: the least and the most)',
    group: 'Edit',
    scope: 'workspace',
  },
  {
    id: 'tail-width-handle',
    keys: '↑ ↓',
    label:
      'Tail step, with the width handle focused: ↑ is a wider tail and ↓ a narrower one, a step of the unit each press (⇧ or Page Up and Page Down ten times; Home and End: the least and the most)',
    group: 'Edit',
    scope: 'workspace',
  },
  {
    id: 'cross-section-blur',
    keys: 'Esc',
    label: 'Clear the selected point, handle, reference point, or station marker',
    group: 'Edit',
    // Coordinate editors clear their own selection locally. Suppress the global
    // action in other fields so Escape can keep its field/dialog-specific meaning.
    match: { keys: ['escape'], notInField: true },
  },
  ...VIEW_KEYS.map(
    ({ key, label }): Shortcut => ({
      id: `view-${key}`,
      keys: key,
      label,
      group: 'View',
      scope: 'views',
      match: { keys: [key], notInField: true },
    }),
  ),
  ...STEP_KEYS.map(
    ({ key, label }): Shortcut => ({
      id: `step-${key}`,
      keys: key,
      label,
      group: 'Design steps',
      scope: 'workspace',
      match: { keys: [key], notInField: true },
    }),
  ),
];

/** Look up a shortcut's display chord, for tooltips. Throws on an unknown id. */
export function shortcutKeys(id: string): string {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown shortcut id: ${id}`);
  return found.keys;
}

/**
 * Whether a keyboard event matches this shortcut's chord. `workspace` says which layout is on
 * screen: a chord scoped to the other one never matches.
 */
export function matches(
  shortcut: Shortcut,
  e: KeyboardEvent,
  inField: boolean,
  inTextEntry = inField,
  workspace = false,
): boolean {
  if (!shortcut.match) return false;
  if (shortcut.scope === 'workspace' && !workspace) return false;
  if (shortcut.scope === 'views' && workspace) return false;
  const {
    keys,
    mod = false,
    shift = false,
    notInField = false,
    notInTextEntry = false,
    alt = false,
  } = shortcut.match;
  if (notInField && inField) return false;
  if (notInTextEntry && inTextEntry) return false;
  const hasMod = e.ctrlKey || e.metaKey;
  if (hasMod !== mod) return false;
  // Only assert Shift when the binding cares: `⌘Z` and `⇧⌘Z` are distinct, but
  // `Delete` should still fire with Shift held.
  if (shift && !e.shiftKey) return false;
  // Likewise Alt: asserted only by bindings that ask for it.
  if (alt && !e.altKey) return false;
  if (!shift && mod && e.shiftKey) return false;
  return keys.includes(e.key.toLowerCase());
}

/** Input types that take typed text (and so have the browser's own text undo). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/** Whether the element is somewhere text is typed: a text-like input, textarea or editable. */
export function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}
