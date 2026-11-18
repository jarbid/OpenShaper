// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The saved rails in a document: written into `meta.extra.myRails` for the ones the board uses, merged into
 * the browser's list when a board is opened, and the text of a board that was only opened and saved again
 * left exactly as it was.
 */
import type { RailsBoard } from '@openshaper/board2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMyRails,
  myRailsOfMeta,
  myRailsToJson,
  resetMyRails,
  setMyRails,
  type SavedRail,
} from './my-rails';
import { railsText, readRails } from './rails-files';
import { metaOfDoc, withBoardMeta } from './section-files';
import { activeStore, boardStore, railsStore } from './store';
import { key, rail, sampleRailsBoard } from './test/rails-board';

const surf: SavedRail = { name: 'Surf', rail: rail(0.3, { band: 3 }) };
/** Zone 1 20-60 and a tick at 100, which has Surf's numbers. */
const KEYS = [key(20, 0.5), key(60, 0.5), key(100, 0.3, { band: 3 }), key(150, 0.4)];

let base: RailsBoard;
const withRails = (rails: RailsBoard['rails'], extra?: Record<string, unknown>): RailsBoard => ({
  ...base,
  rails,
  meta: { ...base.meta, ...(extra ? { extra: extra as RailsBoard['meta']['extra'] } : {}) },
});
/** A board opened: the store loads it (which is what merges its rails into the list). */
const open = (doc: RailsBoard): RailsBoard => {
  railsStore.getState().loadDoc(doc);
  return doc;
};
const text = (doc: RailsBoard) => railsText(doc, metaOfDoc(doc.meta));
const extraOf = (t: string): Record<string, unknown> =>
  ((JSON.parse(t) as RailsBoard).meta.extra ?? {}) as Record<string, unknown>;
const myRailsIn = (t: string): unknown => extraOf(t).myRails;

beforeEach(async () => {
  localStorage.clear();
  resetMyRails();
  base = await sampleRailsBoard();
  activeStore.use(railsStore);
});
afterEach(() => {
  activeStore.use(boardStore);
  localStorage.clear();
  resetMyRails();
});

describe('a board that uses none of my rails', () => {
  it('saves to the text it always did, opened and saved again, and after an edit', async () => {
    const { railsToText } = await import('./workers/nurbs-core');
    const doc = open(withRails({ plus: KEYS }));
    const before = railsToText(withBoardMeta(doc, metaOfDoc(doc.meta)));
    expect(await text(doc)).toBe(before);
    // edited: still no myRails key where there was none
    railsStore.getState().moveZoneEnd('both', 0, 'to', 70);
    const edited = railsStore.getState().doc!;
    expect(edited).not.toBe(doc);
    expect(myRailsIn(await text(edited))).toBeUndefined();
  });
});

describe('a board that uses a rail of mine', () => {
  it('has it written into meta.extra.myRails, and brings it to another machine', async () => {
    setMyRails([surf]);
    const doc = open(withRails({ plus: KEYS }));
    const written = await text(doc);
    expect(myRailsIn(written)).toEqual(myRailsToJson([surf]));
    // another machine: nothing saved, the board is read and opened
    resetMyRails();
    localStorage.clear();
    expect(getMyRails()).toEqual([]);
    const read = await readRails(JSON.parse(written));
    if (!read.ok) throw new Error(read.error);
    open(read.board);
    expect(getMyRails()).toEqual([surf]);
    // and saved again unedited it is the same text
    expect(await text(read.board)).toBe(written);
  });

  it('writes only the rails the board uses', async () => {
    setMyRails([surf, { name: 'Unused', rail: rail(0.9) }]);
    const doc = open(withRails({ plus: KEYS }));
    expect(myRailsOfMeta(JSON.parse(await text(doc)).meta).map((r) => r.name)).toEqual(['Surf']);
  });

  it('takes it away again when an edit leaves the board not using it', async () => {
    setMyRails([surf]);
    const doc = open(withRails({ plus: KEYS }, { myRails: myRailsToJson([surf]) }));
    expect(myRailsIn(await text(doc))).toBeDefined();
    railsStore.getState().removeZone('both', 1);
    expect(myRailsIn(await text(railsStore.getState().doc!))).toBeUndefined();
  });

  it('keeps the other keys of the board’s extra, and its place among them', async () => {
    setMyRails([surf]);
    const doc = open(withRails({ plus: KEYS }, { surfer: 'Pat', glassSchedule: 'x' }));
    expect(Object.keys(extraOf(await text(doc)))).toEqual(['surfer', 'glassSchedule', 'myRails']);
  });
});

describe('a board whose rail has the name of another of mine', () => {
  const theirs = { name: 'Surf', rail: rail(0.4, { band: 2.6 }) };
  const KEYS_THEIRS = [key(20, 0.5), key(60, 0.5), key(100, 0.4, { band: 2.6 }), key(150, 0.4)];

  it('is merged as Surf (2), and the board’s own file keeps the name it had when saved unedited', async () => {
    setMyRails([surf]);
    const file = withRails({ plus: KEYS_THEIRS }, { myRails: myRailsToJson([theirs]) });
    const before = await railsText(file, metaOfDoc(file.meta));
    open(file);
    expect(getMyRails().map((r) => r.name)).toEqual(['Surf', 'Surf (2)']);
    // the unedited save is the file as it was: no rewrite, no rename
    expect(await text(file)).toBe(before);
    expect(myRailsOfMeta(JSON.parse(await text(file)).meta).map((r) => r.name)).toEqual(['Surf']);
  });

  it('keeps the file’s own name after an edit too, not the local one', async () => {
    setMyRails([surf]);
    const file = open(withRails({ plus: KEYS_THEIRS }, { myRails: myRailsToJson([theirs]) }));
    railsStore.getState().moveZoneEnd('both', 0, 'to', 70);
    const written = await text(railsStore.getState().doc!);
    expect(myRailsOfMeta(JSON.parse(written).meta).map((r) => r.name)).toEqual(['Surf']);
    expect(file).not.toBe(railsStore.getState().doc);
  });

  it('opening it twice adds nothing more', () => {
    setMyRails([surf]);
    const file = withRails({ plus: KEYS_THEIRS }, { myRails: myRailsToJson([theirs]) });
    open(file);
    open(file);
    expect(getMyRails().map((r) => r.name)).toEqual(['Surf', 'Surf (2)']);
  });
});

describe('a rail saved from a zone of a board just opened', () => {
  it('is added to the board’s own list when the board is saved, though its rails are as they were', async () => {
    const doc = open(withRails({ plus: KEYS }));
    expect(myRailsIn(await text(doc))).toBeUndefined();
    setMyRails([surf]);
    expect(myRailsOfMeta(JSON.parse(await text(doc)).meta)).toEqual([surf]);
  });
});
