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
import {
  adjustCrossSectionsToThicknessAndWidth,
  board as makeBoard,
  knotFromArray,
  splineFromKnots,
} from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
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

/** A section drag: one knot of one slice of the shortboard moves 40 times (one section is refitted per move). */
test('step 4 section drag', () => {
  const base = GOLDENS[0]!.load();
  const cs = base.crossSections[2]!;
  const build: number[] = [];
  const total: number[] = [];
  const b0 = convertClassic(base);
  if (!b0.ok) throw new Error('did not convert');
  const built0 = buildBoard(b0.value.doc, { check: false });
  if (!built0.ok) throw new Error('did not build');
  const ladders = meshBoard(built0.value).ladders;
  for (let k = 0; k < 40; k++) {
    const dy = 0.01 * (k + 1) * (k % 2 === 0 ? 1 : -1);
    const spline = splineFromKnots(
      cs.spline.knots.map((kn, i) =>
        i === 1
          ? knotFromArray(
              [
                kn.end.x,
                kn.end.y + dy,
                kn.tangentToPrev.x,
                kn.tangentToPrev.y + dy,
                kn.tangentToNext.x,
                kn.tangentToNext.y + dy,
              ],
              kn.continuous,
              kn.other,
            )
          : kn,
      ),
    );
    const classic = makeBoard(
      base.outline,
      base.bottom,
      base.deck,
      base.crossSections.map((c, i) => (i === 2 ? { ...c, spline } : c)),
      base.interpolationType,
      base.fins,
    );
    let result: ReturnType<typeof convertClassic> | undefined;
    const tc = time(() => (result = convertClassic(classic)));
    if (!result?.ok) throw new Error('did not convert');
    let built: ReturnType<typeof buildBoard> | undefined;
    const doc = result.value.doc;
    const tb = time(() => (built = buildBoard(doc, { check: false })));
    if (!built?.ok) throw new Error('did not build');
    const board = built.value;
    const tm = time(() => meshBoard(board, { ladders }));
    build.push(tb);
    total.push(tc + tb + tm);
  }
  const pct = (a: number[], p: number): number =>
    [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
  process.stdout.write(
    `\nsection drag, shortboard, 40 moves: build median ${ms(median(build))} (p95 ${ms(pct(build, 0.95))}) | total median ${ms(median(total))} p95 ${ms(pct(total, 0.95))}\n`,
  );
}, 300_000);

/**
 * A drag (M1 step 4): the wide outline knot of each golden moves 40 times, the sections are resized
 * with it (the editor's default "resize cross-sections"), and each move is converted, built (no
 * validation) and meshed with the ladders of the first mesh. Per move, in ms: convert, build, mesh,
 * their sum (median and 95th percentile), and the section spans the fits used.
 */
test('step 4 drag', () => {
  const lines: string[] = ['', 'drag of the wide outline knot, 40 moves (ms)'];
  const pct = (a: number[], p: number): number =>
    [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
  for (const g of GOLDENS) {
    const base = g.load();
    const knots = base.outline.knots;
    let widest = 0;
    knots.forEach((k, i) => (widest = k.end.y > knots[widest]!.end.y ? i : widest));
    const moved = (dy: number): BezierBoard =>
      adjustCrossSectionsToThicknessAndWidth(
        makeBoard(
          splineFromKnots(
            knots.map((k, i) =>
              i === widest
                ? knotFromArray(
                    [
                      k.end.x,
                      k.end.y + dy,
                      k.tangentToPrev.x,
                      k.tangentToPrev.y + dy,
                      k.tangentToNext.x,
                      k.tangentToNext.y + dy,
                    ],
                    k.continuous,
                    k.other,
                  )
                : k,
            ),
          ),
          base.bottom,
          base.deck,
          base.crossSections,
          base.interpolationType,
          base.fins,
        ),
      );
    const first = convertClassic(moved(0));
    if (!first.ok) throw new Error('did not convert');
    const b0 = buildBoard(first.value.doc, { check: false });
    if (!b0.ok) throw new Error('did not build');
    const ladders = meshBoard(b0.value).ladders;
    const conv: number[] = [];
    const build: number[] = [];
    const mesh: number[] = [];
    const total: number[] = [];
    let spans = 0;
    for (let k = 0; k < 40; k++) {
      const dy = 0.15 * (k + 1) * (k % 2 === 0 ? 1 : -0.5);
      const classic = moved(dy);
      let result: ReturnType<typeof convertClassic> | undefined;
      const tc = time(() => (result = convertClassic(classic)));
      if (!result?.ok) throw new Error('did not convert');
      let built: ReturnType<typeof buildBoard> | undefined;
      const doc = result.value.doc;
      const tb = time(() => (built = buildBoard(doc, { check: false })));
      if (!built?.ok) throw new Error('did not build');
      const board = built.value;
      spans = board.report.sectionSpans[0];
      const tm = time(() => meshBoard(board, { ladders }));
      conv.push(tc);
      build.push(tb);
      mesh.push(tm);
      total.push(tc + tb + tm);
    }
    lines.push(
      `${g.name.replace(/^.*\//, '').padEnd(14)} convert ${ms(median(conv))} | build ${ms(median(build))} (p95 ${ms(pct(build, 0.95))}) | mesh ${ms(median(mesh))} | total median ${ms(median(total))} p95 ${ms(pct(total, 0.95))} | spans ${spans}`,
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}, 300_000);

/** A section drag: one knot of one slice of the shortboard moves 40 times (one section is refitted per move). */
test('step 4 section drag', () => {
  const base = GOLDENS[0]!.load();
  const cs = base.crossSections[2]!;
  const build: number[] = [];
  const total: number[] = [];
  const b0 = convertClassic(base);
  if (!b0.ok) throw new Error('did not convert');
  const built0 = buildBoard(b0.value.doc, { check: false });
  if (!built0.ok) throw new Error('did not build');
  const ladders = meshBoard(built0.value).ladders;
  for (let k = 0; k < 40; k++) {
    const dy = 0.01 * (k + 1) * (k % 2 === 0 ? 1 : -1);
    const spline = splineFromKnots(
      cs.spline.knots.map((kn, i) =>
        i === 1
          ? knotFromArray(
              [
                kn.end.x,
                kn.end.y + dy,
                kn.tangentToPrev.x,
                kn.tangentToPrev.y + dy,
                kn.tangentToNext.x,
                kn.tangentToNext.y + dy,
              ],
              kn.continuous,
              kn.other,
            )
          : kn,
      ),
    );
    const classic = makeBoard(
      base.outline,
      base.bottom,
      base.deck,
      base.crossSections.map((c, i) => (i === 2 ? { ...c, spline } : c)),
      base.interpolationType,
      base.fins,
    );
    let result: ReturnType<typeof convertClassic> | undefined;
    const tc = time(() => (result = convertClassic(classic)));
    if (!result?.ok) throw new Error('did not convert');
    let built: ReturnType<typeof buildBoard> | undefined;
    const doc = result.value.doc;
    const tb = time(() => (built = buildBoard(doc, { check: false })));
    if (!built?.ok) throw new Error('did not build');
    const board = built.value;
    const tm = time(() => meshBoard(board, { ladders }));
    build.push(tb);
    total.push(tc + tb + tm);
  }
  const pct = (a: number[], p: number): number =>
    [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
  process.stdout.write(
    `\nsection drag, shortboard, 40 moves: build median ${ms(median(build))} (p95 ${ms(pct(build, 0.95))}) | total median ${ms(median(total))} p95 ${ms(pct(total, 0.95))}\n`,
  );
}, 300_000);
