// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Board info a NURBS document carries, and the saved text: open then save gives the same text for
 * every board a file can start from (docs/design/m2-editor.md §5, step 5).
 */
import { parseBrd } from '@openshaper/io';
import { createBoardStore, selectSpecs } from '@openshaper/store';
import { describe, expect, it } from 'vitest';
import sampleBrd from './sample-board.brd?raw';
import shortboardDoc from './templates/shortboard.board?raw';
import { asymmetricBoard, fishBoard, swallowBoard } from '@openshaper/board2/testing';
import {
  metaOfDoc,
  readSections,
  sectionsName,
  sectionsText,
  withBoardMeta,
} from './section-files';
import { measureDocument, meshDocument, meshCentreX } from './workers/nurbs-core';
import type { BoardMeta } from './file-io';

const full: BoardMeta = {
  model: 'My fish',
  designer: 'Me',
  surfer: 'You',
  comments: 'For summer',
  finType: 'twin',
  foamType: 'pu',
  glassSchedule: '6oz',
};

describe('Board info in the document', () => {
  it('round-trips every field through meta, and keeps the source and unknown extra keys', () => {
    const base = swallowBoard();
    const doc = withBoardMeta(
      { ...base, meta: { name: 'x', source: 'classic', extra: { other: [1, 2], surfer: 'old' } } },
      full,
    );
    expect(metaOfDoc(doc.meta)).toEqual(full);
    expect(doc.meta.source).toBe('classic');
    expect((doc.meta.extra as Record<string, unknown>).other).toEqual([1, 2]);
    // clearing a field removes it
    const cleared = withBoardMeta(doc, { model: 'My fish' });
    expect(metaOfDoc(cleared.meta)).toEqual({ model: 'My fish' });
    expect((cleared.meta.extra as Record<string, unknown>).surfer).toBeUndefined();
    expect((cleared.meta.extra as Record<string, unknown>).other).toEqual([1, 2]);
  });

  it('is the same document when nothing changes', () => {
    const doc = swallowBoard();
    expect(withBoardMeta(doc, metaOfDoc(doc.meta))).toBe(doc);
  });

  it('reads the name without reviving the document', () => {
    expect(sectionsName({ meta: { name: 'Fish' } })).toBe('Fish');
    expect(sectionsName({ meta: { name: ' ' } })).toBeUndefined();
    expect(sectionsName(null)).toBeUndefined();
  });
});

describe('save and open through the app path', () => {
  it.each([
    ['swallow', swallowBoard],
    ['fish', fishBoard],
    ['asymmetric', asymmetricBoard],
  ] as const)('%s: open, then save with its own Board info, is the same text', async (_n, make) => {
    const text = await sectionsText(withBoardMeta(make(), full), full);
    const read = await readSections(JSON.parse(text));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(await sectionsText(read.doc, metaOfDoc(read.doc.meta))).toBe(text);
  });

  it('reports why a document is not one', async () => {
    const r = await readSections({ format: 'openshaper', version: 3, model: 'sections' });
    expect(r.ok).toBe(false);
  });
});

describe('the specs from the mesh', () => {
  it('measureDocument is the mesh the viewer shows: same volume and plan area, a centroid inside the board', () => {
    const doc = asymmetricBoard();
    const m = measureDocument(doc);
    const shown = meshDocument(doc, null, {
      curvature: false,
      deviation: false,
      reuseLadders: false,
    });
    expect(m.ok && shown.ok).toBe(true);
    if (!m.ok || !shown.ok) return;
    expect(m.volume).toBe(shown.summary.volume);
    expect(m.planArea).toBe(shown.summary.planArea);
    const length = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];
    expect(m.centreX).toBeGreaterThan(0.3 * length);
    expect(m.centreX).toBeLessThan(0.7 * length);
    expect(meshCentreX(shown.mesh.positions, shown.mesh.indices)).toBe(m.centreX);
  });

  it('agrees with the classic specs of the same board: volume within 2%, plan area 1%, centre of mass 1.5 cm', async () => {
    const store = createBoardStore();
    store.getState().load(parseBrd(sampleBrd).board);
    const classic = selectSpecs(store.getState().board!);
    const read = await readSections(JSON.parse(shortboardDoc));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const m = measureDocument(read.doc);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(Math.abs(m.volume / classic.volume - 1)).toBeLessThan(0.02);
    expect(Math.abs(m.planArea / classic.area - 1)).toBeLessThan(0.01);
    expect(Math.abs(m.centreX - classic.centerOfMass)).toBeLessThan(1.5);
  });
});
