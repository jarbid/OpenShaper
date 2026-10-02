/**
 * Characterization: round-trip every sample board file in the repo.
 *
 * import → export (.brd) → import → export must be stable, and the exported text
 * is pinned to a file snapshot so any change to what we write — number
 * formatting, field order, a dropped field — shows up as a diff. The same boards
 * are round-tripped through the .board.json document and the share-link codec.
 *
 * A changed snapshot here means the saved-file format changed. That is a
 * behaviour change (and a compatibility risk), not a refactor.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BezierBoard } from '@openshaper/kernel';
import { parseBrd, parseBrdFile } from './brd-reader';
import { writeBrd } from './brd-writer';
import { readBoardJson, writeBoardJson } from './board-json';
import { parseS3dx } from './s3d-reader';
import { decodeShareFragment, encodeShareFragment, shareCodecSupported } from './share-link';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const fixtures = resolve(here, '__fixtures__');

interface Sample {
  name: string;
  load: () => BezierBoard;
}

const brd = (path: string): Sample => ({
  name: path,
  load: () => parseBrdFile(new Uint8Array(readFileSync(resolve(repo, path)))).board,
});

const SAMPLES: Sample[] = [
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
    .map(
      (f): Sample => ({
        name: `packages/io/src/__fixtures__/${f}`,
        load: () => parseS3dx(readFileSync(resolve(fixtures, f), 'utf8')).board,
      }),
    ),
];

/**
 * JSON has no negative zero, so `-0` coordinates (the funboard has some) come back
 * as `0` from .board.json and share links. Geometrically identical; recorded as a
 * known property of the JSON formats, not asserted away silently.
 */
const noNegZero = (v: unknown): unknown => {
  if (Object.is(v, -0)) return 0;
  if (Array.isArray(v)) return v.map(noNegZero);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNegZero(x)]));
  }
  return v;
};

const snapName = (name: string): string => name.replace(/[/\\]/g, '__');

describe('characterization: sample-file round trips', () => {
  for (const { name, load } of SAMPLES) {
    describe(name, () => {
      it('.brd export is lossless, pinned and stable across a re-import', async () => {
        const b = load();
        const first = writeBrd(b);
        const reread = parseBrd(first).board;
        expect(reread).toEqual(b);
        const second = writeBrd(reread);
        expect(second).toBe(first);
        await expect(first).toMatchFileSnapshot(`__snapshots__/roundtrip/${snapName(name)}.brd`);
      });

      it('.board.json round-trips to an identical board (up to -0)', () => {
        const b = load();
        const again = readBoardJson(writeBoardJson(b)).board;
        expect(again).toEqual(noNegZero(b));
        expect(writeBoardJson(again)).toBe(writeBoardJson(b));
      });

      it.runIf(shareCodecSupported())('share link round-trips to an identical board', async () => {
        const b = load();
        const { board } = await decodeShareFragment(await encodeShareFragment(b));
        expect(board).toEqual(noNegZero(b));
      });
    });
  }
});
