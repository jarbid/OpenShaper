// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The gate of the rails engine's step (docs/design/trim-blend-engine.md, "As built"):
 * each of the study's boards, with its features off, goes through `convertSections`,
 * `buildRails` and the kernel mesh, is sliced, and is measured against today's engine. Run on
 * demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> [TRIM_ONLY=<part of a board's name>] \
 *     pnpm --filter @openshaper/board2 exec vitest run src/trim/native.measure.test.ts
 *
 * The reference is today's engine (`buildBoard`, `createEvaluator`). For a notched board the
 * reference for sections is today's engine on the notch-free twin (`notchFreeTwin` in the
 * bridge): a rails board reads its stations as plane sections, and today's notched engine fans
 * its stations inside its notch zone. The volume of a notched board is compared with the real
 * notched board's `meshBoard` volume.
 *
 * Gated: at the board's own usable stations away from the tips, both sides of an asymmetric
 * board, the kernel's slice is within 1 mm of the reference section, and the mesh is closed.
 * Every failure is collected and reported at the end, and written to `native-fail.txt` with
 * where on the section the worst point is. Reported, not gated: the same gap at 41 even
 * stations, the volume, the thinnest wall, the times, the vertex counts, the halves the
 * converter flagged as not a function of u, and the gap with the board's features on.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIM } from '../params';
import { allBoards } from '../railproto/test-support/rail-samples';
import { convertSections } from './convert';
import { buildRails, meshRails } from './native';
import { buildTrimMesh, checkClosed } from './solid';
import {
  GATE,
  MEASURE_ROWS,
  evenStations,
  gatedStations,
  median,
  prepare,
  realVolume,
  sectionGap,
  sectionShares,
  thinnestWall,
} from './test-support/native-study';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const mm = (cm: number): string => (cm * 10).toFixed(2);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Milliseconds of `f`, the median of `runs` runs after one warm-up when `warm`. */
function time(f: () => unknown, runs: number, warm: boolean): number {
  if (warm) f();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    f();
    t.push(performance.now() - t0);
  }
  return median(t);
}

interface Stat {
  readonly stations: number;
  readonly maxMm: number;
  readonly medianMm: number;
  readonly within05Percent: number;
  readonly within10Percent: number;
}

function stat(gaps: readonly number[]): Stat {
  const within = (lim: number): number =>
    gaps.length === 0
      ? 0
      : Math.round((1000 * gaps.filter((g) => g <= lim).length) / gaps.length) / 10;
  return {
    stations: gaps.length,
    maxMm: r2(Math.max(0, ...gaps) * 10),
    medianMm: r2(median(gaps) * 10),
    within05Percent: within(0.05),
    within10Percent: within(GATE),
  };
}

const statText = (s: Stat): string =>
  `${s.stations} stations, worst ${s.maxMm.toFixed(2)} mm, median ${s.medianMm.toFixed(2)} mm, within 0.5 mm ${s.within05Percent.toFixed(1)}%, within 1 mm ${s.within10Percent.toFixed(1)}%`;

study('the rails engine on real boards', () => {
  it(
    'builds closed and stays within 1 mm of the current engine at its own stations',
    {
      timeout: 7_200_000,
    },
    () => {
      const only = process.env.TRIM_ONLY ?? '';
      const lines: string[] = [
        'board | gated (n: worst, median mm) | 41 even (n: worst, median mm) | volume % | open | thinnest wall mm | ms convert / build / rebuild / mesh view / mesh draft | vertices view / draft | flagged halves | features on, worst mm at the 41',
      ];
      const fails: string[] = [];
      const boards: unknown[] = [];
      const allGated: number[] = [];
      const allEven: number[] = [];
      for (const b of allBoards()) {
        if (only !== '' && !b.name.includes(only)) continue;
        const doc = { ...b.doc, features: [] };
        const p = prepare(b.name, doc);
        const built = p.built;
        const mesh = buildTrimMesh(
          built.loop,
          built.laws,
          built.panels,
          TRIM.viewGrid,
          MEASURE_ROWS,
        );
        const closed = checkClosed(mesh);
        expect.soft(closed.openEdges, `${b.name}: open edges`).toBe(0);

        // gated: the board's own usable stations away from the tips
        const gated = gatedStations(p);
        const gatedRows = gated.map((s) => ({ ...s, ...sectionGap(p, mesh, s.x, s.side) }));
        for (const r of gatedRows) {
          expect
            .soft(r.gap, `${b.name}: x ${r.x.toFixed(2)} side ${r.side}`)
            .toBeLessThanOrEqual(GATE);
          if (r.gap > GATE) {
            const sh = sectionShares(p, r.x, r.y, r.z);
            fails.push(
              `${b.name} | x ${r.x.toFixed(2)} | side ${r.side} | gap ${mm(r.gap)} mm | worst point y ${r.y.toFixed(3)} z ${r.z.toFixed(3)} (u ${sh.u.toFixed(3)}, v ${sh.v.toFixed(3)})`,
            );
          }
        }
        const gatedGaps = gatedRows.map((r) => r.gap);
        allGated.push(...gatedGaps);

        // reported: the 41 even stations, tips left out
        const even = evenStations(p).filter((s) => !s.tip);
        const sides: (0 | 1)[] = doc.symmetry === 'asymmetric' ? [0, 1] : [0];
        const evenGaps = even.map((s) =>
          Math.max(...sides.map((side) => sectionGap(p, mesh, s.x, side).gap)),
        );
        allEven.push(...evenGaps);

        const volume = ((closed.volume + mesh.panelGap - realVolume(p)) / realVolume(p)) * 100;

        // times
        const msConvert = time(() => convertSections(doc), 3, true);
        const board = p.built.board;
        const msBuild = time(() => buildRails(board), 3, false);
        const edited = { ...board, deck: { knots: [...board.deck.knots] } };
        const msRebuild = time(() => buildRails(edited, { previous: built }), 3, false);
        const msView = time(() => meshRails(built), 5, true);
        const msDraft = time(() => meshRails(built, { draft: true }), 5, true);
        const vView = meshRails(built).vertexCount;
        const vDraft = meshRails(built, { draft: true }).vertexCount;

        // features on, against today's engine with its features on: a number only
        const on = prepare(b.name, b.doc);
        const onMesh = buildTrimMesh(
          on.built.loop,
          on.built.laws,
          on.built.panels,
          TRIM.viewGrid,
          MEASURE_ROWS,
        );
        const onGaps = evenStations(on)
          .filter((s) => !s.tip)
          .map((s) => Math.max(...sides.map((side) => sectionGap(on, onMesh, s.x, side).gap)));
        const featuresWorst = Math.max(0, ...onGaps);

        const flagged = p.report.foldedHalves;
        const wall = thinnestWall(mesh);
        const g = stat(gatedGaps);
        const e = stat(evenGaps);
        boards.push({
          board: b.name,
          notched: p.notched,
          gated: g,
          gatedStations: gatedRows.map((r) => ({
            x: r2(r.x),
            side: r.side,
            gapMm: r2(r.gap * 10),
          })),
          even41: e,
          volumePercent: r2(volume),
          openEdges: closed.openEdges,
          thinnestWallMm: r2(wall * 10),
          ms: {
            convert: r2(msConvert),
            build: r2(msBuild),
            rebuild: r2(msRebuild),
            meshView: r2(msView),
            meshDraft: r2(msDraft),
          },
          vertices: { view: vView, draft: vDraft },
          flaggedHalves: flagged,
          featuresOnWorstMm: r2(featuresWorst * 10),
        });
        lines.push(
          [
            b.name.slice(0, 28),
            `${g.stations}: ${g.maxMm.toFixed(2)}, ${g.medianMm.toFixed(2)}`,
            `${e.stations}: ${e.maxMm.toFixed(2)}, ${e.medianMm.toFixed(2)}`,
            `${volume.toFixed(2)}%`,
            closed.openEdges,
            mm(wall),
            [msConvert, msBuild, msRebuild, msView, msDraft].map((v) => v.toFixed(0)).join(' / '),
            `${vView} / ${vDraft}`,
            flagged,
            mm(featuresWorst),
          ].join(' | '),
        );
      }
      lines.push(
        '',
        `ALL, gated stations: ${statText(stat(allGated))}`,
        `ALL, 41 even stations: ${statText(stat(allEven))}`,
      );
      const dir = process.env.TRIM_OUT ?? '';
      if (dir !== '') {
        mkdirSync(dir, { recursive: true });
        const stem = only === '' ? 'native' : `native-${only}`;
        writeFileSync(resolve(dir, `${stem}.txt`), lines.join('\n') + '\n');
        writeFileSync(
          resolve(dir, `${stem}.json`),
          JSON.stringify(
            { boards, ALL: { gated: stat(allGated), even41: stat(allEven) } },
            null,
            2,
          ) + '\n',
        );
        writeFileSync(
          resolve(dir, `${stem}-fail.txt`),
          fails.join('\n') + (fails.length > 0 ? '\n' : ''),
        );
      }
    },
  );
});
