// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only loaders of the classic sample boards through `@openshaper/io` (docs/design/m1-model.md
 * §6, step 2): the three golden boards and every other sample file the io package pins, and a
 * classic swallow or fish made by giving a golden board a notched outline.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBrdFile, parseS3dx } from '@openshaper/io';
import { board, getLength, knotFromArray, splineFromKnots } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import type { BoardDoc } from '../types';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface Sample {
  readonly name: string;
  readonly load: () => BezierBoard;
}

const brd = (path: string): Sample => ({
  name: path,
  load: () => parseBrdFile(new Uint8Array(readFileSync(resolve(repo, path)))).board,
});

const s3dx = (name: string): Sample => ({
  name: `packages/io/src/__fixtures__/${name}.s3dx`,
  load: () =>
    parseS3dx(readFileSync(resolve(repo, `packages/io/src/__fixtures__/${name}.s3dx`), 'utf8'))
      .board,
});

/** The three golden boards (docs/specs/golden). */
export const GOLDENS: readonly Sample[] = ['shortboard', 'funboard', 'longboard'].map((n) =>
  brd(`docs/specs/golden/${n}.brd`),
);

/** Every classic sample file of the io package's round-trip test. */
export const SAMPLES: readonly Sample[] = [
  ...GOLDENS,
  brd('apps/web/src/sample-board.brd'),
  brd('apps/web/src/funboard.brd'),
  brd('apps/web/src/longboard.brd'),
  brd('packages/io/src/__fixtures__/self-authored-shortboard.brd'),
  ...[
    'synthetic-clean-6x22x2-75',
    'synthetic-degenerate-section',
    'synthetic-fallback-outline-5x10',
    'synthetic-rocker-absolute-deck',
    'synthetic-rocker-thickness-deck',
    'synthetic-stringer-fold-a',
    'synthetic-stringer-fold-b',
  ].map(s3dx),
];

/**
 * The classic board with the shortboard's rocker, deck and slices and the outline of a
 * notched test board (its plus half), stretched in x to the shortboard's length: a classic
 * swallow or fish.
 */
export function classicNotched(base: BezierBoard, doc: BoardDoc): BezierBoard {
  const length = getLength(base);
  const knots = doc.outline.plus.knots;
  const sc = length / knots[knots.length - 1]!.p[0];
  const outline = splineFromKnots(
    knots.map((k) =>
      knotFromArray(
        [k.p[0] * sc, k.p[1], k.in[0] * sc, k.in[1], k.out[0] * sc, k.out[1]],
        false,
        false,
      ),
    ),
  );
  return board(
    outline,
    base.bottom,
    base.deck,
    base.crossSections,
    base.interpolationType,
    base.fins,
  );
}
