// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * My rails: a rail a shaper dialled in and saved under a name. A saved rail is that name and the
 * rail's seven numbers, nothing else.
 *
 * Two homes, one meaning:
 *
 * - **The browser** (`bs.myRails`, via `readStored`/`writeStored`): the list every board on this
 *   machine can pick from. {@link useMyRails} reads it; the rail map names zones by it and the rail
 *   panel's menu lists it.
 * - **The document** (`meta.extra.myRails`, written by `withBoardMeta` through {@link usedRails}): the
 *   saved rails a board uses, so a board opened on another machine brings them. Opening a board
 *   merges its list into the local one ({@link mergeRails}).
 *
 * Everything but the store at the bottom is a pure function of its arguments.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  BUILT_IN_RAILS,
  NAME_TOLERANCE,
  RAIL_NUMBERS,
  railDistance,
  railName,
  type NamedRail,
  type RailRecipe,
} from '@openshaper/store/rails';
import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from './persisted';
import { zonesOfSide, type Rails } from './rail-zones';
import { railsStore } from './store';

/** A saved rail: a name and the seven numbers. */
export type SavedRail = NamedRail;

export const MY_RAILS_KEY = 'bs.myRails';

/** The longest a name may be: it is the label on a block of the rail map. */
export const MAX_NAME = 32;

/** A name as it is kept: trimmed, runs of spaces made one, cut to {@link MAX_NAME}. */
export const cleanName = (name: string): string =>
  name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether a rail has the numbers of another, as `railName` reads two rails as one. */
const sameRail = (a: RailRecipe, b: RailRecipe): boolean => railDistance(a, b) <= NAME_TOLERANCE;

/**
 * Why `name` cannot be a saved rail's, or null: it is empty, it is "Custom" or a built-in rail's
 * name (the menu would then list two of one name), or another saved rail has it (`except` is the
 * name of the rail being renamed, which may keep it).
 */
export function nameProblem(
  name: string,
  list: readonly SavedRail[],
  except?: string,
): string | null {
  const clean = cleanName(name);
  if (clean === '') return 'Give the rail a name.';
  if (sameName(clean, 'Custom') || BUILT_IN_RAILS.some((b) => sameName(b.name, clean))) {
    return `“${clean}” is the name of a built-in rail. Choose another.`;
  }
  if (list.some((r) => sameName(r.name, clean) && !(except && sameName(r.name, except)))) {
    return `You already have a rail called “${clean}”.`;
  }
  return null;
}

export type Saved =
  | { readonly ok: true; readonly list: readonly SavedRail[]; readonly name: string }
  | { readonly ok: false; readonly error: string };

/** `list` with the rail saved under `name` (added at the end). */
export function saveRail(list: readonly SavedRail[], name: string, rail: RailRecipe): Saved {
  const problem = nameProblem(name, list);
  if (problem) return { ok: false, error: problem };
  const clean = cleanName(name);
  return { ok: true, list: [...list, { name: clean, rail: roundTrip(rail) }], name: clean };
}

/** `list` without the rail called `name`. The list itself when it has none. */
export function removeRail(list: readonly SavedRail[], name: string): readonly SavedRail[] {
  const kept = list.filter((r) => r.name !== name);
  return kept.length === list.length ? list : kept;
}

/** `list` with the rail called `from` called `to` instead, keeping its place in the list. */
export function renameRail(list: readonly SavedRail[], from: string, to: string): Saved {
  if (!list.some((r) => r.name === from)) return { ok: false, error: 'That rail is not saved.' };
  const problem = nameProblem(to, list, from);
  if (problem) return { ok: false, error: problem };
  const clean = cleanName(to);
  return {
    ok: true,
    list: list.map((r) => (r.name === from ? { name: clean, rail: r.rail } : r)),
    name: clean,
  };
}

/** The first of `Name (2)`, `Name (3)`, … that is free. */
function freeName(name: string, list: readonly SavedRail[]): string {
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    const candidate = `${name.slice(0, MAX_NAME - tail.length).trimEnd()}${tail}`;
    if (nameProblem(candidate, list) === null) return candidate;
  }
}

/**
 * `list` with the rails of `incoming` (a board's own) added. A rail whose numbers a saved rail already
 * has is not added again, whatever it is called there, so merging the same board twice changes nothing;
 * one whose name is taken by a rail with other numbers (or by a built-in rail) is kept as `Name (2)`.
 * The list itself when nothing is added.
 */
export function mergeRails(
  list: readonly SavedRail[],
  incoming: readonly SavedRail[],
): readonly SavedRail[] {
  let out = list;
  for (const r of incoming) {
    if (out.some((have) => sameRail(have.rail, r.rail))) continue;
    const name = cleanName(r.name) || 'My rail';
    const unique = nameProblem(name, out) === null ? name : freeName(name, out);
    out = [...out, { name: unique, rail: r.rail }];
  }
  return out;
}

/**
 * The saved rails of `candidates` a board uses: those whose numbers a zone of either side has, in
 * the order they are first met (plus side tail to nose, then minus). A rail that is also a built-in
 * rail's numbers is the built-in, not a saved one, and is left out.
 */
export function usedRails(rails: Rails, candidates: readonly SavedRail[]): SavedRail[] {
  const used: SavedRail[] = [];
  for (const side of ['plus', 'minus'] as const) {
    if (side === 'minus' && !rails.minus) break;
    for (const zone of zonesOfSide(rails, side).zones) {
      const name = railName(zone.rail, candidates);
      const found = candidates.find((c) => c.name === name);
      if (found && !used.includes(found) && !BUILT_IN_RAILS.some((b) => b.name === name)) {
        used.push(found);
      }
    }
  }
  return used;
}

// --- JSON: the browser's list and the document's -------------------------------------------------

/** A rail's numbers as plain numbers, in the order the engine and the file list them. */
const roundTrip = (rail: RailRecipe): RailRecipe => {
  const out = {} as { -readonly [K in keyof RailRecipe]: number };
  for (const n of RAIL_NUMBERS) out[n] = rail[n];
  return out;
};

/** The saved rails as the JSON the document and the browser keep. */
export const myRailsToJson = (list: readonly SavedRail[]): { name: string; rail: RailRecipe }[] =>
  list.map((r) => ({ name: r.name, rail: roundTrip(r.rail) }));

/**
 * The saved rails in parsed JSON: an array of `{ name, rail }` whose seven numbers are all finite. An
 * entry that is not one is dropped, a name is cleaned, and a name already seen (in the file) is dropped
 * as a duplicate: a file written elsewhere cannot break the list.
 */
export function myRailsFromJson(value: unknown): SavedRail[] {
  if (!Array.isArray(value)) return [];
  const out: SavedRail[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, rail } = item as { name?: unknown; rail?: unknown };
    if (typeof name !== 'string' || typeof rail !== 'object' || rail === null) continue;
    const numbers = rail as Record<string, unknown>;
    if (!RAIL_NUMBERS.every((n) => typeof numbers[n] === 'number' && Number.isFinite(numbers[n]))) {
      continue;
    }
    const clean = cleanName(name);
    if (clean === '' || out.some((r) => sameName(r.name, clean))) continue;
    out.push({ name: clean, rail: roundTrip(numbers as unknown as RailRecipe) });
  }
  return out;
}

/** The saved rails a document carries in `meta.extra.myRails`, as the file wrote them. */
export function myRailsOfMeta(meta: { readonly extra?: unknown } | undefined): SavedRail[] {
  const extra = meta?.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return [];
  return myRailsFromJson((extra as { myRails?: unknown }).myRails);
}

// --- the browser's list --------------------------------------------------------------------------

const NO_RAILS: readonly SavedRail[] = [];
let held: readonly SavedRail[] | undefined;
const listeners = new Set<() => void>();

/** The list in this browser, read once. */
export function getMyRails(): readonly SavedRail[] {
  held ??= readStored(MY_RAILS_KEY, [] as SavedRail[], myRailsFromJson);
  return held;
}

/** Keep `next` as the list: remembered, and told to everything that shows it. */
export function setMyRails(next: readonly SavedRail[]): void {
  if (next === getMyRails()) return;
  held = next;
  writeStored(MY_RAILS_KEY, myRailsToJson(next));
  for (const l of [...listeners]) l();
}

/** Forget what was read, so the next read comes from storage again (tests). */
export function resetMyRails(): void {
  held = undefined;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The saved rails in this browser. */
export const useMyRails = (): readonly SavedRail[] =>
  useSyncExternalStore(subscribe, getMyRails, () => NO_RAILS);

// --- a board's own list --------------------------------------------------------------------------

/** The rails of the document most recently loaded, as they were then: an edit of the rails makes new ones. */
let opened: Rails | null = null;

/**
 * A rails board was opened (a file, a share link, a session, a conversion): the saved rails it carries are
 * merged into this browser's list, and its rails are remembered as the ones it came with.
 */
export function adoptDocument(doc: RailsBoard): void {
  opened = doc.rails;
  const own = myRailsOfMeta(doc.meta);
  if (own.length === 0) return;
  const merged = mergeRails(getMyRails(), own);
  if (merged !== getMyRails()) setMyRails(merged);
}

/**
 * What to write as the document's `meta.extra.myRails`, or `undefined` to leave the key as the file had it.
 *
 * - While the board's rails are still the ones it was opened with, the file's own list is kept exactly (so a
 *   board that was opened and saved again is the same text), and only a saved rail that the board uses and
 *   the file lacks is added: the shaper saved one from a zone and then saved the board.
 * - Once the rails have been edited, the saved rails the board uses now: the file's own, in its order and by
 *   its names, then any other. An empty list when it uses none.
 */
export function myRailsToWrite(doc: RailsBoard): readonly SavedRail[] | undefined {
  const file = myRailsOfMeta(doc.meta);
  const wanted = usedRails(doc.rails, [...file, ...getMyRails()]);
  if (doc.rails === opened) {
    const missing = wanted.filter((w) => !file.some((f) => sameRail(f.rail, w.rail)));
    return missing.length > 0 ? [...file, ...missing] : undefined;
  }
  return [...file.filter((f) => wanted.includes(f)), ...wanted.filter((w) => !file.includes(w))];
}

/** Follow the rails store: a document loaded is adopted. */
railsStore.subscribe((state, prev) => {
  if (state.loadCount !== prev.loadCount && state.doc) adoptDocument(state.doc);
});
