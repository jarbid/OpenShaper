// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fourteen classic sample files (docs/design/board2.md §2.3, §11.1
 * `classic/test-support/`): the list of `packages/io/src/roundtrip.characterization.test.ts`,
 * loaded through the io readers. Test-only: this directory may import
 * `@openshaper/io` and `node:*` (ESLint exempts `test-support/`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBrdFile, parseS3dx } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../..');
const fixtures = resolve(repo, 'packages/io/src/__fixtures__');

/** A sample file: its repository path and a loader (each call parses the file afresh). */
export interface ClassicSample {
  readonly name: string;
  readonly load: () => BezierBoard;
}

const brd = (path: string): ClassicSample => ({
  name: path,
  load: () => parseBrdFile(new Uint8Array(readFileSync(resolve(repo, path)))).board,
});

const s3dx = (file: string): ClassicSample => ({
  name: `packages/io/src/__fixtures__/${file}`,
  load: () => parseS3dx(readFileSync(resolve(fixtures, file), 'utf8')).board,
});

/** Every sample file, in the order of the io characterization test. */
export const CLASSIC_SAMPLES: readonly ClassicSample[] = Object.freeze([
  brd('docs/specs/golden/shortboard.brd'),
  brd('docs/specs/golden/funboard.brd'),
  brd('docs/specs/golden/longboard.brd'),
  brd('apps/web/src/sample-board.brd'),
  brd('apps/web/src/funboard.brd'),
  brd('apps/web/src/longboard.brd'),
  brd('packages/io/src/__fixtures__/self-authored-shortboard.brd'),
  ...readdirSync(fixtures)
    .filter((f) => f.endsWith('.s3dx'))
    .sort()
    .map(s3dx),
]);

/** The sample whose path ends with `suffix` (throws when there is none or several). */
export function classicSample(suffix: string): ClassicSample {
  const hits = CLASSIC_SAMPLES.filter((s) => s.name.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`classicSample: ${hits.length} samples match '${suffix}'`);
  return hits[0]!;
}
