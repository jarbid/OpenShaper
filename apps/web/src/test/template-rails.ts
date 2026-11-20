// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: a starter template as the rails board the app opens it as, converted by the engine's own code
 * (`toRails`, what the NURBS worker runs) and kept, since a board is never changed.
 */
import type { RailsBoard } from '@openshaper/board2';
import { NURBS_TEMPLATES } from '../templates';

const made = new Map<string, Promise<RailsBoard>>();

/** The rails board of the template called `name`. */
export function templateRails(name: string): Promise<RailsBoard> {
  let board = made.get(name);
  if (board === undefined) {
    board = (async () => {
      const template = NURBS_TEMPLATES.find((t) => t.name === name);
      if (template === undefined) throw new Error(`no template called ${name}`);
      const core = await import('../workers/nurbs-core');
      const doc = core.docFromAnyJson(JSON.parse(await template.load()));
      if (!doc.ok || doc.model !== 'sections')
        throw new Error(`${name} is not a sections template`);
      const rails = core.toRails({ doc: doc.doc });
      if (!rails.ok) throw new Error(rails.error);
      return rails.board;
    })();
    made.set(name, board);
  }
  return board;
}
