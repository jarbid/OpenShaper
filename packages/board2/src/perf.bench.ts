/**
 * Timings of the step 2 pipeline (docs/design/m1-model.md §6), run with
 * `pnpm --filter @openshaper/board2 bench` (not part of `pnpm test`; `timing.test.ts` holds
 * the same budgets behind a generous factor). Numbers go in the "As built (step 2)" note.
 *
 * For each board: the classic converter on a freshly loaded file (cold: no slice cached),
 * the first build after a convert (the section fits are cold), then in steady state the
 * build, the mesh with fresh and with reused ladders, and the same with curvature.
 * Medians of 20 runs after a warm-up.
 */
import { test } from 'vitest';
import { convertClassic } from './classic';
import { deriveLadders, meshBoard } from './mesh';
import { buildBoard } from './surface';
import { GOLDENS, classicNotched } from './test-support/classic-samples';
import { fishBoard, swallowBoard } from './testing';
import type { BoardDoc } from './types';

const RUNS = 20;
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!;
const ms = (t: number): string => t.toFixed(1).padStart(6);

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function row(
  name: string,
  load: (() => ReturnType<(typeof GOLDENS)[0]['load']>) | null,
  docOf: () => BoardDoc,
): string {
  const convert: number[] = [];
  const first: number[] = [];
  const build: number[] = [];
  const fresh: number[] = [];
  const reuse: number[] = [];
  const curvFresh: number[] = [];
  const curvReuse: number[] = [];
  let vertices = 0;
  for (let k = -2; k < RUNS; k++) {
    let doc: BoardDoc;
    if (load !== null) {
      const classic = load();
      let result: ReturnType<typeof convertClassic> | undefined;
      const t = time(() => (result = convertClassic(classic)));
      if (!result?.ok) throw new Error(`${name} did not convert`);
      doc = result.value.doc;
      if (k >= 0) convert.push(t);
    } else {
      doc = docOf();
    }
    let built: ReturnType<typeof buildBoard> | undefined;
    const tf = time(() => (built = buildBoard(doc, { check: false })));
    if (!built?.ok) throw new Error(`${name} did not build`);
    if (k >= 0) first.push(tf);
    const board = built.value;
    const tb = time(() => buildBoard(doc, { check: false }));
    let ladders = deriveLadders(board);
    const tm = time(() => (vertices = meshBoard(board).vertexCount));
    ladders = meshBoard(board).ladders;
    const tr = time(() => meshBoard(board, { ladders }));
    const tcf = time(() => meshBoard(board, { curvature: true }));
    const tcr = time(() => meshBoard(board, { ladders, curvature: true }));
    if (k >= 0) {
      build.push(tb);
      fresh.push(tm);
      reuse.push(tr);
      curvFresh.push(tcf);
      curvReuse.push(tcr);
    }
  }
  const conv = load !== null ? ms(median(convert)) : '     -';
  return `${name.padEnd(12)} ${String(vertices).padStart(6)} V | convert ${conv} | first build ${ms(median(first))} | build ${ms(median(build))} + mesh fresh ${ms(median(fresh))} reuse ${ms(median(reuse))} | curvature fresh ${ms(median(curvFresh))} reuse ${ms(median(curvReuse))}`;
}

test('step 2 timings', () => {
  const lines: string[] = ['', 'times in ms (median of 20, Node)'];
  for (const g of GOLDENS)
    lines.push(
      row(g.name.replace(/^.*\//, ''), g.load, () => {
        throw new Error();
      }),
    );
  const base = GOLDENS[0]!.load();
  lines.push(
    row(
      'classic swallow',
      () => classicNotched(base, swallowBoard()),
      () => {
        throw new Error();
      },
    ),
  );
  lines.push(
    row(
      'classic fish',
      () => classicNotched(base, fishBoard()),
      () => {
        throw new Error();
      },
    ),
  );
  process.stdout.write(lines.join('\n') + '\n');
}, 300_000);
