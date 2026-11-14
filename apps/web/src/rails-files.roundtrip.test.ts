// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board's file through save, reopen and save again (`rails-files.ts`): the second text is the first,
 * for every starter template, for a classic board converted, with fins, a bottom feature, both halves and
 * Board info in `meta.extra`; and how long its share link is against the limit the Share dialog applies.
 */
import type { RailsBoard } from '@openshaper/board2';
import { encodeShareText, parseBrd, SHARE_URL_MAX_CHARS } from '@openshaper/io';
import { createRailsStore } from '@openshaper/store/rails';
import { beforeAll, describe, expect, it } from 'vitest';
import { docText, readRails } from './rails-files';
import { metaOfDoc } from './section-files';
import { buildShareUrl, shareSize } from './share-url';
import funboardBrd from './funboard.brd?raw';
import longboardBrd from './longboard.brd?raw';
import fishDoc from './templates/fish-shortboard.board?raw';
import funboardDoc from './templates/funboard.board?raw';
import longboardDoc from './templates/longboard.board?raw';
import shortboardDoc from './templates/shortboard.board?raw';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import sampleBrd from './sample-board.brd?raw';

type Core = typeof import('./workers/nurbs-core');
let core: Core;
beforeAll(async () => {
  core = await import('./workers/nurbs-core');
}, 60_000);

const fromSections = (text: string): RailsBoard => {
  const d = core.docFromJson(JSON.parse(text));
  if (!d.ok) throw new Error(d.error);
  const r = core.toRails({ doc: d.doc });
  if (!r.ok) throw new Error(r.error);
  return r.board;
};
const fromClassic = (brd: string): RailsBoard => {
  const r = core.toRails({ classic: parseBrd(brd).board });
  if (!r.ok) throw new Error(r.error);
  return r.board;
};

/** Save (with the Board info the app reads from it), reopen, save again: both texts. */
async function twice(board: RailsBoard): Promise<[string, string]> {
  const first = await docText(board, metaOfDoc(board.meta));
  const back = await readRails(JSON.parse(first));
  if (!back.ok) throw new Error(back.error);
  return [first, await docText(back.board, metaOfDoc(back.board.meta))];
}

const SOURCES: readonly [string, () => RailsBoard][] = [
  ['Shortboard template', () => fromSections(shortboardDoc)],
  ['Funboard template', () => fromSections(funboardDoc)],
  ['Longboard template', () => fromSections(longboardDoc)],
  ['Swallow shortboard template', () => fromSections(swallowDoc)],
  ['Fish shortboard template', () => fromSections(fishDoc)],
  ['sample .brd converted', () => fromClassic(sampleBrd)],
  ['funboard .brd converted', () => fromClassic(funboardBrd)],
  ['longboard .brd converted', () => fromClassic(longboardBrd)],
];

describe('save, reopen, save again', () => {
  it.each(SOURCES)('%s: the same text', async (_, make) => {
    const [first, second] = await twice(make());
    expect(second).toBe(first);
  });

  it('a board edited to have a bottom feature, both halves and Board info in meta.extra', async () => {
    const store = createRailsStore();
    store.getState().loadDoc(fromSections(swallowDoc));
    store.getState().addFeature('double-concave');
    store.getState().setSymmetry('asymmetric');
    const edited = store.getState().doc!;
    expect(edited.features.length).toBe(1);
    expect(edited.outline.minus).toBeDefined();
    const withInfo: RailsBoard = {
      ...edited,
      meta: {
        ...edited.meta,
        author: 'A. Shaper',
        extra: { surfer: 'B', other: { kept: [1, 2] }, glassSchedule: '4+4' },
      },
    };
    const [first, second] = await twice(withInfo);
    expect(second).toBe(first);
    expect(JSON.parse(first).meta.extra).toEqual({
      surfer: 'B',
      other: { kept: [1, 2] },
      glassSchedule: '4+4',
    });
  });
});

describe('the share link', () => {
  it.each(SOURCES)('%s: fits under the limit', async (_, make) => {
    const board = make();
    const url = buildShareUrl(await encodeShareText(await docText(board, metaOfDoc(board.meta))));
    expect(url.length).toBeLessThan(SHARE_URL_MAX_CHARS);
    expect(shareSize(url)).toBe('ok');
  });
});
