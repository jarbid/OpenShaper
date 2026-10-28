// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The step 2 time budgets of docs/design/m1-model.md §6, on the shortboard, behind a generous
 * factor so that CI noise cannot fail the suite: convert <= 50 ms, build + mesh <= 15 ms (<= 30 ms
 * with curvature). The real numbers come from `pnpm --filter @openshaper/board2 bench`
 * (`perf.bench.ts`). This test only catches an order-of-magnitude regression.
 */
import { describe, expect, it } from 'vitest';
import { convertClassic } from './classic';
import { meshBoard } from './mesh';
import { buildBoard } from './surface';
import { GOLDENS } from './test-support/classic-samples';

/** Budgets (ms) times this factor. */
const FACTOR = 8;
const BUDGET = { convert: 50, mesh: 15, curvature: 30 } as const;

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!;

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('the shortboard within the step 2 budgets (x8)', () => {
  const sample = GOLDENS[0]!;

  it('converts a freshly loaded file', () => {
    const times: number[] = [];
    for (let k = 0; k < 9; k++) {
      const classic = sample.load();
      times.push(time(() => convertClassic(classic)));
    }
    expect(median(times)).toBeLessThan(BUDGET.convert * FACTOR);
  });

  it('builds and meshes, with warm section fits, with and without curvature', () => {
    const converted = convertClassic(sample.load());
    if (!converted.ok) throw new Error('did not convert');
    const doc = converted.value.doc;
    buildBoard(doc, { check: false }); // the first build fits the sections
    const plain: number[] = [];
    const curved: number[] = [];
    for (let k = 0; k < 9; k++) {
      plain.push(
        time(() => {
          const b = buildBoard(doc, { check: false });
          if (b.ok) meshBoard(b.value);
        }),
      );
      curved.push(
        time(() => {
          const b = buildBoard(doc, { check: false });
          if (b.ok) meshBoard(b.value, { curvature: true });
        }),
      );
    }
    expect(median(plain)).toBeLessThan(BUDGET.mesh * FACTOR);
    expect(median(curved)).toBeLessThan(BUDGET.curvature * FACTOR);
  });
});
