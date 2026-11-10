// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Writes the dense as-built sections of every study board to `TRIM_OUT/sections.json`, for
 * plotting outside the repo. Run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/railproto/dump.measure.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allBoards, denseSections } from './rail-samples';
import { DENSE_STATIONS } from './rail-params';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');

study('dense sections, for plotting', () => {
  it('writes them', { timeout: 600_000 }, () => {
    const dir = process.env.TRIM_OUT ?? '';
    expect(dir).not.toBe('');
    mkdirSync(dir, { recursive: true });
    const round = (v: number): number => Math.round(v * 1e4) / 1e4;
    const out = allBoards().map((b) => {
      const bs = denseSections(b, DENSE_STATIONS);
      return {
        name: b.name,
        group: b.group,
        length: bs.length,
        sections: bs.sections.map((s) => ({
          x: s.x,
          chord: s.chord,
          thickness: s.thickness,
          apex: s.apex,
          pts: Array.from(s.pts, round),
        })),
      };
    });
    writeFileSync(resolve(dir, 'sections.json'), JSON.stringify(out));
  });
});
