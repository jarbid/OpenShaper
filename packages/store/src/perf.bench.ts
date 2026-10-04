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
import { test } from 'vitest';
import { tessellateBoard, vec2, type BezierBoard } from '@openshaper/kernel';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from './board-store';
import { selectSpecs } from './selectors';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): BezierBoard =>
  parseBrd(readFileSync(resolve(here, `../../../docs/specs/golden/${name}.brd`), 'utf8')).board;

const shortboard = load('shortboard');
const longboard = load('longboard');

type Case = [name: string, fn: () => void];

/**
 * Run each case in turn and print one table per group: Vitest 5 benchmarks are a
 * test fixture, its own table is not printed in a non-interactive run, and
 * `console` is swallowed in bench mode, so this writes straight to stdout.
 */
const runGroup = async (
  bench: (name: string, fn: () => void) => { run: () => Promise<BenchRun> },
  title: string,
  cases: Case[],
): Promise<void> => {
  const rows: string[][] = [['', 'mean ms', 'p50 ms', 'p99 ms', 'ops/s', '±%']];
  for (const [name, fn] of cases) {
    const r = await bench(name, fn).run();
    const l = r.latency;
    rows.push([
      name,
      l.mean.toFixed(3),
      l.p50.toFixed(3),
      l.p99.toFixed(3),
      r.throughput.mean.toFixed(1),
      l.rme.toFixed(2),
    ]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  const line = (row: string[]) =>
    row
      .map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ');
  process.stdout.write(`\n${title}\n${rows.map(line).join('\n')}\n`);
};

interface BenchRun {
  latency: { mean: number; p50: number; p99: number; rme: number };
  throughput: { mean: number };
}

test('tessellate (3D rebuild)', async ({ bench }) => {
  const qualities = [
    ['draft', 1.5],
    ['standard', 0.9],
    ['fine', 0.5],
  ] as const;
  await runGroup(
    bench,
    'tessellate (3D rebuild)',
    qualities.flatMap(([q, face]): Case[] => [
      [
        `shortboard ${q} (${face} cm)`,
        () => void tessellateBoard(shortboard, { targetFaceSize: face }),
      ],
      [
        `longboard ${q} (${face} cm)`,
        () => void tessellateBoard(longboard, { targetFaceSize: face }),
      ],
    ]),
  );
});

test('specs (volume/area/…)', async ({ bench }) => {
  // selectSpecs memoizes by board identity; a shallow copy defeats the cache so
  // this measures the real compute, as after an edit.
  await runGroup(bench, 'specs (volume/area/…)', [
    ['shortboard selectSpecs (uncached)', () => void selectSpecs({ ...shortboard })],
    ['longboard selectSpecs (uncached)', () => void selectSpecs({ ...longboard })],
    [
      'shortboard selectSpecs, S-blend (uncached)',
      () => void selectSpecs({ ...shortboard, interpolationType: 'sLinear' }),
    ],
  ]);
});

test('store drag step', async ({ bench }) => {
  const store = createBoardStore();
  store.getState().load(shortboard);
  store.getState().beginEdit('Drag');
  const k = shortboard.outline.knots[2]!;
  let i = 0;
  await runGroup(bench, 'store drag step', [
    [
      'moveControlPoint (outline, adjust on)',
      () => {
        i = (i + 1) % 100;
        store
          .getState()
          .moveControlPoint({ kind: 'outline' }, 2, vec2(k.end.x + i * 0.01, k.end.y));
      },
    ],
  ]);
});
