// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoNurbsCodeOutsideWorker,
  findNurbsCodeLeaks,
  NURBS_CODE_MARKERS,
} from './nurbs-bundle-guard';

const worker = { file: 'nurbs-worker-AbC123.js', text: `x("${NURBS_CODE_MARKERS[0]}")` };
const core = { file: 'nurbs-core-AbC123.js', text: `x("${NURBS_CODE_MARKERS[1]}")` };

describe('findNurbsCodeLeaks', () => {
  it('allows board2 code in the worker and its fallback core only', () => {
    expect(findNurbsCodeLeaks([worker, core, { file: 'App-x.js', text: 'no nurbs code' }])).toEqual(
      [],
    );
  });

  it('names a main chunk, the layer or a shared chunk that carries a marker', () => {
    for (const marker of NURBS_CODE_MARKERS) {
      for (const file of ['index-x.js', 'nurbs-layer-x.js', 'src-x.js']) {
        expect(findNurbsCodeLeaks([worker, { file, text: `a("${marker}")` }])).toEqual([file]);
      }
    }
  });

  it('ignores files that are not scripts', () => {
    expect(findNurbsCodeLeaks([{ file: 'app.css', text: NURBS_CODE_MARKERS[0] }])).toEqual([]);
    expect(() => assertNoNurbsCodeOutsideWorker([worker, core])).not.toThrow();
    expect(() =>
      assertNoNurbsCodeOutsideWorker([{ file: 'App-x.js', text: NURBS_CODE_MARKERS[2] }]),
    ).toThrow(/App-x\.js/);
  });
});

describe('the production build (when one exists)', () => {
  const assets = join(import.meta.dirname, '..', 'dist', 'assets');
  it.skipIf(!existsSync(assets))('keeps board2 code in the worker chunks only', () => {
    const chunks = readdirSync(assets)
      .filter((f) => f.endsWith('.js'))
      .map((file) => ({ file, text: readFileSync(join(assets, file), 'utf8') }));
    // the markers are really in the worker (so a rename cannot make the guard pass vacuously)
    expect(
      chunks.some(
        (c) => /^nurbs-worker-/.test(c.file) && NURBS_CODE_MARKERS.some((m) => c.text.includes(m)),
      ),
    ).toBe(true);
    expect(findNurbsCodeLeaks(chunks)).toEqual([]);
  });
});
