// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Making the board the New board gallery asks for: a starter template, as the rails board the engine makes
 * of it, at the size chosen.
 *
 * The template is loaded from its chunk of its own and revived (board2's file code, loaded on demand), the
 * conversion to a rails board runs in the NURBS worker as it does when a template is opened from the File
 * menu (`rails-engine.ts`), and only the scaling, which is a handful of multiplications, is done here
 * (`board-sizing.ts`). Building and meshing the board is the engine's job as ever, once it is open.
 */
import type { RailsBoard } from '@openshaper/board2';
import { sizeRailsBoard } from './board-sizing';
import type { BoardSize, BoardType } from './board-types';
import { readSections } from './section-files';
import { NURBS_TEMPLATES } from './templates';

/**
 * The rails board of the starter template `type` is, made at `size`. Rejects, with the reason in the
 * message, when the template cannot be loaded or the engine refuses it. The size is not held to the type's
 * ranges here: that is the caller's.
 */
export async function makeBoardOfType(type: BoardType, size: BoardSize): Promise<RailsBoard> {
  const template = NURBS_TEMPLATES.find((t) => t.name === type.name);
  if (template === undefined) throw new Error(`There is no ${type.name} template.`);
  let text: string;
  try {
    text = await template.load();
  } catch {
    // the template's chunk would not load: offline, or the app was just updated
    throw new Error(
      `The ${type.name} template could not be loaded (offline, or the app was just updated).`,
    );
  }
  const read = await readSections(JSON.parse(text) as unknown);
  if (!read.ok) throw new Error(read.error);
  const { createNurbsClient } = await import('./nurbs-client');
  const client = createNurbsClient();
  try {
    const made = await client.toRails(read.doc);
    if (!made.ok) throw new Error(made.error);
    return sizeRailsBoard(made.board, size);
  } finally {
    client.dispose();
  }
}
