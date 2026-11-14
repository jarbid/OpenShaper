// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The saved rails board in the app: its text (with the Board info in its `meta`, as a sections document
 * has it: `section-files.ts`) and its reading. board2's code is the worker core's, loaded on demand, so
 * the main chunk stays free of it; only types of board2 are imported here.
 */
import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import type { BoardMeta } from './file-io';
import {
  loadedNurbsCore,
  loadNurbsCore,
  sectionsText,
  sectionsTextNow,
  withBoardMeta,
} from './section-files';

/** Whether parsed JSON is a rails board document (the sections reader would refuse it). */
export const isRailsJson = (json: unknown): boolean =>
  typeof json === 'object' && json !== null && (json as { model?: unknown }).model === 'rails';

/** Whether a document's text is a rails board (read from the text, no code needed). */
export const isRailsText = (text: string): boolean => {
  try {
    return isRailsJson(JSON.parse(text));
  } catch {
    return false;
  }
};

/** The canonical text of a rails board with `meta` as its Board info. */
export async function railsText(board: RailsBoard, meta: BoardMeta): Promise<string> {
  const { railsToText } = await loadNurbsCore();
  return railsToText(withBoardMeta(board, meta));
}

/** The same at once when the code has been loaded (null before), for the flush at `pagehide`. */
export function railsTextNow(board: RailsBoard, meta: BoardMeta): string | null {
  const core = loadedNurbsCore();
  return core ? core.railsToText(withBoardMeta(board, meta)) : null;
}

/** The text of a document of either kind. */
export const docText = (doc: BoardDoc | RailsBoard, meta: BoardMeta): Promise<string> =>
  doc.model === 'rails' ? railsText(doc, meta) : sectionsText(doc, meta);

/** The same at once when the code has been loaded (null before). */
export const docTextNow = (doc: BoardDoc | RailsBoard, meta: BoardMeta): string | null =>
  doc.model === 'rails' ? railsTextNow(doc, meta) : sectionsTextNow(doc, meta);

/** A rails board read from parsed JSON, or the reasons it is not one. */
export type ReadRails =
  | { readonly ok: true; readonly board: RailsBoard }
  | {
      readonly ok: false;
      readonly error: string;
      /** `unavailable`: the code would not load (offline, a stale app shell); the text may be fine. */
      readonly reason: 'unavailable' | 'invalid';
    };

/** Revive a parsed rails board (an opened file, a share link, a session). */
export async function readRails(json: unknown): Promise<ReadRails> {
  let core: Awaited<ReturnType<typeof loadNurbsCore>>;
  try {
    core = await loadNurbsCore();
  } catch {
    return {
      ok: false,
      error: 'The NURBS engine could not be loaded (offline, or the app was just updated).',
      reason: 'unavailable',
    };
  }
  const r = core.docFromAnyJson(json);
  if (!r.ok) return { ok: false, error: r.error, reason: 'invalid' };
  if (r.model !== 'rails') return { ok: false, error: 'Not a rails board.', reason: 'invalid' };
  return { ok: true, board: r.board };
}
