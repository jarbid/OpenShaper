// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The saved document (docs/design/m2-editor.md §5, step 5): saving and opening give back the same text, byte
 * for byte, for the goldens, the swallow and fish boards, an asymmetric board and a board with bottom features,
 * and the share link carries the same text. The link sizes are measured here (and bounded: a link the app
 * would refuse as too long is a failure).
 */
import { boardDocToJson, createChordFn, reviveBoardDoc, type BoardDoc } from '@openshaper/board2';
import {
  SHARE_URL_WARN_CHARS,
  decodeShareFile,
  encodeShareText,
  readBoardText,
} from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import { addFeature, setFeatureDepth, setSymmetry, setTail } from './index';
import { GOLDEN_NAMES, goldenDoc, testDocs } from './test-support/docs';

const chords = (doc: BoardDoc, side?: 'minus') => createChordFn(doc, side);

/** The boards the step's checks name: the three goldens, swallow, fish, asymmetric, and one with features. */
const withFeatures = (): BoardDoc => {
  let doc = goldenDoc('shortboard');
  doc = addFeature(doc, 'double-concave', chords);
  doc = addFeature(doc, 'channels', chords);
  doc = addFeature(doc, 'vee', chords);
  return setFeatureDepth(doc, 'double-concave', 0.3);
};
const swallowOfShortboard = (): BoardDoc =>
  setTail(goldenDoc('shortboard'), 'swallow', undefined, chords);
const fishOfShortboard = (): BoardDoc =>
  setTail(goldenDoc('shortboard'), 'fish', undefined, chords);
const asymmetricShortboard = (): BoardDoc => setSymmetry(goldenDoc('shortboard'), 'asymmetric');

const boards: readonly [string, () => BoardDoc][] = [
  ...GOLDEN_NAMES.map((n): [string, () => BoardDoc] => [n, () => goldenDoc(n)]),
  ['swallow shortboard', swallowOfShortboard],
  ['fish shortboard', fishOfShortboard],
  ['asymmetric shortboard', asymmetricShortboard],
  ['shortboard with features', withFeatures],
  ...testDocs.filter(([n]) => ['swallow', 'fish', 'asymmetric'].includes(n)),
];

const revive = (json: unknown): BoardDoc => {
  const r = reviveBoardDoc(json);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

describe('save and open', () => {
  it.each(boards)('%s: the text is the same after open and save, byte for byte', (_n, make) => {
    const text = boardDocToJson(make());
    const file = readBoardText(text);
    expect(file.kind).toBe('sections');
    const back = revive(file.kind === 'sections' ? file.json : null);
    expect(boardDocToJson(back)).toBe(text);
  });

  it('carries what the classic projection dropped: the minus half, the tail and the features', () => {
    const text = boardDocToJson(asymmetricShortboard());
    expect(text).toContain('"minus"');
    expect(boardDocToJson(swallowOfShortboard())).toContain('"notched"');
    expect(boardDocToJson(withFeatures())).toContain('"double"');
  });
});

describe('share link', () => {
  const sizes: string[] = [];
  it.each(boards)('%s: encode then decode gives the same document', async (name, make) => {
    const text = boardDocToJson(make());
    const fragment = await encodeShareText(text);
    const file = await decodeShareFile(fragment);
    expect(file.kind).toBe('sections');
    expect(boardDocToJson(revive(file.kind === 'sections' ? file.json : null))).toBe(text);
    // the whole link, with an origin of the usual length
    const url = `https://openshaper.example/app#board=${fragment}`;
    sizes.push(`${name}: ${url.length}`);
    expect(url.length).toBeLessThan(SHARE_URL_WARN_CHARS);
  });

  it('reports the sizes', () => {
    console.info(`share link sizes (chars)\n${sizes.join('\n')}`);
    expect(sizes.length).toBeGreaterThan(0);
  });
});
