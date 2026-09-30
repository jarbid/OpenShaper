/**
 * Compute benchmarks for the editing hot paths, run with `pnpm --filter
 * @openshaper/store bench` (not part of `pnpm test`).
 *
 *  - tessellateBoard at the three 3D-view mesh qualities (what the 3D worker does
 *    on every settled edit);
 *  - selectSpecs (volume, area, …: what the specs worker does on every edit);
 *  - one control-point drag step through the store: moveControlPoint inside a
 *    grouped edit, including junction pinning and the cross-section adjust pass.
 *
 * Numbers go in QUALITY_REPORT.md; re-run after a perf change and compare.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bench, describe } from 'vitest';
import { tessellateBoard, vec2, type BezierBoard } from '@openshaper/kernel';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from './board-store';
import { selectSpecs } from './selectors';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): BezierBoard =>
  parseBrd(readFileSync(resolve(here, `../../../docs/specs/golden/${name}.brd`), 'utf8')).board;

const shortboard = load('shortboard');
const longboard = load('longboard');

describe('tessellate (3D rebuild)', () => {
  for (const [q, face] of [
    ['draft', 1.5],
    ['standard', 0.9],
    ['fine', 0.5],
  ] as const) {
    bench(
      `shortboard ${q} (${face} cm)`,
      () => void tessellateBoard(shortboard, { targetFaceSize: face }),
    );
    bench(
      `longboard ${q} (${face} cm)`,
      () => void tessellateBoard(longboard, { targetFaceSize: face }),
    );
  }
});

describe('specs (volume/area/…)', () => {
  // selectSpecs memoizes by board identity; a shallow copy defeats the cache so
  // this measures the real compute, as after an edit.
  bench('shortboard selectSpecs (uncached)', () => void selectSpecs({ ...shortboard }));
  bench('longboard selectSpecs (uncached)', () => void selectSpecs({ ...longboard }));
});

describe('store drag step', () => {
  const store = createBoardStore();
  store.getState().load(shortboard);
  store.getState().beginEdit('Drag');
  const k = shortboard.outline.knots[2]!;
  let i = 0;
  bench('moveControlPoint (outline, adjust on)', () => {
    i = (i + 1) % 100;
    store.getState().moveControlPoint({ kind: 'outline' }, 2, vec2(k.end.x + i * 0.01, k.end.y));
  });
});
