// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: every board the project ships or makes, as rails boards: the made boards of
 * `boards.ts` and the starter templates (`apps/web/src/templates/*.board`, converted from their
 * sections as the app converts a file it opens). Each call returns the same object.
 */
import type { RailsBoard } from '@openshaper/board2';
import { convertSections, reviveBoardDoc } from '@openshaper/board2';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { railsBoards } from './boards';

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../apps/web/src/templates',
);

const cache = new Map<string, RailsBoard>();

function template(file: string): RailsBoard {
  let b = cache.get(file);
  if (b === undefined) {
    const read = reviveBoardDoc(JSON.parse(readFileSync(join(TEMPLATES, file), 'utf8')));
    if (!read.ok) throw new Error(`${file}: ${read.issues.map((i) => i.message).join('; ')}`);
    const r = convertSections(read.value);
    if (!r.ok) throw new Error(`${file}: ${r.issues.map((i) => i.message).join('; ')}`);
    b = r.value.board;
    cache.set(file, b);
  }
  return b;
}

/** The starter templates, by file name without its extension. */
export const templateBoards: readonly [string, () => RailsBoard][] = readdirSync(TEMPLATES)
  .filter((f) => f.endsWith('.board'))
  .sort()
  .map((f): [string, () => RailsBoard] => [f.replace(/\.board$/, ''), () => template(f)]);

/** The made boards and the starter templates: nine boards, mirror and asymmetric, with and without a notch. */
export const everyBoard: readonly [string, () => RailsBoard][] = [
  ...railsBoards,
  ...templateBoards,
];
