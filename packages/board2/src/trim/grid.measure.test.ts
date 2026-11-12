// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How coarse the panels can be cut: three boards meshed with the panel grid at 0.7, 1.0, 1.4
 * and 2.0 cm (strip rows 14 and 10), with the vertices, the time to mesh, the volume against
 * the 0.7 cm grid, the open edges, and the worst gap to today's engine at the board's own gated
 * stations (`native.measure.test.ts`); a slice reads each panel from its height field between
 * the band edges, so that gap does not see the grid. Nothing is changed by it. Run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/trim/grid.measure.test.ts
 *
 * Writes `grid.txt` under TRIM_OUT.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { allBoards } from '../railproto/test-support/rail-samples';
import { buildTrimMesh, checkClosed } from './solid';
import { gatedStations, median, prepare, sectionGap } from './test-support/native-study';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const BOARDS = ['shortboard', 'MLC', 'long_classico'];
const GRIDS = [0.7, 1.0, 1.4, 2.0];
const ROWS = { deckRows: 14, tuckRows: 10 } as const;

study('the panel grid', () => {
  it('measures four grids on three boards', { timeout: 3_600_000 }, () => {
    const lines = [
      'board | grid cm | vertices | ms to mesh (median of 5) | volume vs 0.7 % | open edges | worst gap at own gated stations mm',
    ];
    for (const b of allBoards()) {
      if (!BOARDS.some((n) => b.name.includes(n))) continue;
      const p = prepare(b.name, { ...b.doc, features: [] });
      const { loop, laws, panels } = p.built;
      const gated = gatedStations(p);
      let base = 0;
      for (const grid of GRIDS) {
        const make = () => buildTrimMesh(loop, laws, panels, grid, ROWS);
        make();
        const ms: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          make();
          ms.push(performance.now() - t0);
        }
        const mesh = make();
        const closed = checkClosed(mesh);
        if (grid === GRIDS[0]) base = closed.volume;
        const worst = Math.max(...gated.map((s) => sectionGap(p, mesh, s.x, s.side).gap));
        lines.push(
          [
            b.name.slice(0, 28),
            grid.toFixed(1),
            mesh.positions.length / 3,
            median(ms).toFixed(0),
            (((closed.volume - base) / base) * 100).toFixed(3),
            closed.openEdges,
            (worst * 10).toFixed(2),
          ].join(' | '),
        );
      }
    }
    const dir = process.env.TRIM_OUT ?? '';
    if (dir !== '') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'grid.txt'), lines.join('\n') + '\n');
    }
  });
});
