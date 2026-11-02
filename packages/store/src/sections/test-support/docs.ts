// SPDX-License-Identifier: GPL-3.0-or-later
/** Test-only: the golden boards converted to section documents, and board2's test boards. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardDoc } from '@openshaper/board2';
import { convertClassic } from '@openshaper/board2/classic';
import { asymmetricBoard, fishBoard, swallowBoard } from '@openshaper/board2/testing';
import { parseBrdFile } from '@openshaper/io';
import { enforceJunctions } from '../../edits';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export const GOLDEN_NAMES = ['shortboard', 'funboard', 'longboard'] as const;

/** A golden board, converted the way the app does: loaded (junctions enforced) and then converted. */
export function goldenDoc(name: (typeof GOLDEN_NAMES)[number]): BoardDoc {
  const { board } = parseBrdFile(
    new Uint8Array(readFileSync(resolve(repo, `docs/specs/golden/${name}.brd`))),
  );
  const r = convertClassic(enforceJunctions(board), { name });
  if (!r.ok) throw new Error(`${name}: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.value.doc;
}

export const testDocs: readonly [string, () => BoardDoc][] = [
  ...GOLDEN_NAMES.map((n): [string, () => BoardDoc] => [n, () => goldenDoc(n)]),
  ['swallow', swallowBoard],
  ['fish', fishBoard],
  ['asymmetric', asymmetricBoard],
];
