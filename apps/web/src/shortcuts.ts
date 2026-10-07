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
 */
import type { View } from './view-toolkit';

export type ShortcutGroup = 'File' | 'Edit' | 'View' | 'Cross-sections';

export interface ShortcutMatch {
  /** Lowercased `KeyboardEvent.key`, or one of several for an either/or binding. */
  keys: readonly string[];
  /** Requires Ctrl (Windows/Linux) or Cmd (macOS). */
  mod?: boolean;
  /** Requires Shift. */
  shift?: boolean;
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
  match: ShortcutMatch;
}

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
    label: 'Delete the selected control point',
    group: 'Edit',
    match: { keys: ['delete', 'backspace'], notInField: true },
  },
  {
    id: 'toggle-lock',
    keys: 'L',
    label: "Lock or unlock the selected point's handle angles",
    group: 'Edit',
    match: { keys: ['l'], notInField: true },
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
  {
    id: 'cross-section-blur',
    keys: 'Esc',
    label: 'Clear the selected point, handle, or station marker',
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

/** Whether a keyboard event matches this shortcut's chord. */
export function matches(
  shortcut: Shortcut,
  e: KeyboardEvent,
  inField: boolean,
  inTextEntry = inField,
): boolean {
  const {
    keys,
    mod = false,
    shift = false,
    notInField = false,
    notInTextEntry = false,
  } = shortcut.match;
  if (notInField && inField) return false;
  if (notInTextEntry && inTextEntry) return false;
  const hasMod = e.ctrlKey || e.metaKey;
  if (hasMod !== mod) return false;
  // Only assert Shift when the binding cares: `⌘Z` and `⇧⌘Z` are distinct, but
  // `Delete` should still fire with Shift held.
  if (shift && !e.shiftKey) return false;
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
