// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS starter templates (docs/design/m2-editor.md §5): `.board` documents (version 3, the
 * section model) committed under `src/templates/`, so a template opens at once with no conversion.
 *
 * - the three classic templates (Shortboard, Funboard, Longboard) converted the way the app converts them
 *   when it opens the classic file with the engine on;
 * - a Swallow shortboard and a Fish shortboard: the shortboard with `setTail`.
 *
 * This module is pure (it returns the texts); `make-nurbs-templates.test.ts` compares them with the
 * committed files, so a change to the converter or to `setTail` that would change a template fails the
 * test instead of leaving the files stale. To write the files again:
 *
 *   NURBS_TEMPLATES_WRITE=1 pnpm --filter @openshaper/web exec vitest run tools/make-nurbs-templates.test.ts
 *
 * and commit the result. It runs under Vitest, not Node, because the workspace packages are consumed from
 * TypeScript source.
 */
import { boardDocToJson, createChordFn, type BoardDoc } from '@openshaper/board2';
import { convertClassic } from '@openshaper/board2/classic';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from '@openshaper/store';
import { setTail } from '@openshaper/store/sections';
import funboardBrd from '../src/funboard.brd?raw';
import longboardBrd from '../src/longboard.brd?raw';
import shortboardBrd from '../src/sample-board.brd?raw';

export interface MadeTemplate {
  /** The name the New menu and the docs registry use. */
  readonly name: string;
  /** The file under `src/templates/`. */
  readonly file: string;
  readonly text: string;
}

const SOURCE = 'starter template';

/** A classic template, loaded into a classic store (which enforces the junctions) and converted. */
function converted(name: string, brd: string): BoardDoc {
  const store = createBoardStore();
  store.getState().load(parseBrd(brd).board);
  const r = convertClassic(store.getState().board!, { name, source: SOURCE });
  if (!r.ok) throw new Error(`${name}: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.value.doc;
}

export function makeNurbsTemplates(): MadeTemplate[] {
  const shortboard = converted('Shortboard', shortboardBrd);
  type Made = { name: string; file: string; doc: BoardDoc };
  const named = (doc: BoardDoc, name: string): BoardDoc => ({
    ...doc,
    meta: { ...doc.meta, name },
  });
  const chords = (doc: BoardDoc, side?: 'minus') => createChordFn(doc, side);
  const docs: Made[] = [
    { name: 'Shortboard', file: 'shortboard.board', doc: shortboard },
    { name: 'Funboard', file: 'funboard.board', doc: converted('Funboard', funboardBrd) },
    { name: 'Longboard', file: 'longboard.board', doc: converted('Longboard', longboardBrd) },
    {
      name: 'Swallow shortboard',
      file: 'swallow-shortboard.board',
      doc: named(setTail(shortboard, 'swallow', undefined, chords), 'Swallow shortboard'),
    },
    {
      name: 'Fish shortboard',
      file: 'fish-shortboard.board',
      doc: named(setTail(shortboard, 'fish', undefined, chords), 'Fish shortboard'),
    },
  ];
  return docs.map(({ name, file, doc }) => ({ name, file, text: boardDocToJson(doc) }));
}
