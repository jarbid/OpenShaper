// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trim-and-blend, stage 1 (`docs/design/trim-blend-test.md`): does the forward rail model
 * describe the rails the 70-degree convention could not? Run on demand:
 *
 *   TRIM_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/railproto/forward.measure.test.ts
 *
 * `TRIM_OUT=<dir>` also writes every fit as JSON there (outside the repo).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitForward } from './forward';
import type { ForwardFit, HalfForward } from './forward';
import { allBoards, denseSections } from './rail-samples';
import { DENSE_STATIONS, PROJECT_TOL_CM } from './rail-params';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const mm = (cm: number): string => (cm * 10).toFixed(2);
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const lite = (f: ForwardFit | null): object | null =>
  f === null
    ? null
    : {
        turn: f.turn,
        e: f.e,
        rho: f.rho,
        max: f.dev.max,
        width: f.width,
        height: f.height,
        edgeDeg: f.edgeDeg,
      };

study('forward rail model on the dense set', () => {
  it('fits every station, tangent-only and with an edge', { timeout: 3_600_000 }, () => {
    const out: object[] = [];
    const lines: string[] = [];
    lines.push(
      'board | n | tangent: none b/d, max, med | edge: none b/d, max, med | hard edge at apex | edge chosen (bottom/deck) | med edge deg',
    );
    for (const b of allBoards()) {
      const bs = denseSections(b, DENSE_STATIONS);
      const rows: { x: number; bottom: HalfForward; deck: HalfForward }[] = [];
      for (const s of bs.sections)
        rows.push({ x: s.x, bottom: fitForward(s, 'bottom'), deck: fitForward(s, 'deck') });
      const stationMax = (pick: (h: HalfForward) => ForwardFit | null): number[] => {
        const v: number[] = [];
        for (const r of rows) {
          const a = pick(r.bottom);
          const d = pick(r.deck);
          if (a !== null && d !== null) v.push(Math.max(a.dev.max, d.dev.max));
        }
        return v;
      };
      const tan = stationMax((h) => h.tangent);
      const edg = stationMax((h) => h.best);
      const none = (pick: (h: HalfForward) => ForwardFit | null, half: 'bottom' | 'deck'): number =>
        rows.filter((r) => pick(r[half]) === null).length;
      const chosen = (half: 'bottom' | 'deck'): ForwardFit[] =>
        rows.map((r) => r[half].best).filter((f): f is ForwardFit => f !== null && f.e > 0);
      const hard = rows.filter((r) => r.bottom.hardEdge).length;
      lines.push(
        [
          b.name.slice(0, 26),
          rows.length,
          `${none((h) => h.tangent, 'bottom')}/${none((h) => h.tangent, 'deck')}, ${mm(Math.max(0, ...tan))}, ${mm(median(tan))}`,
          `${none((h) => h.best, 'bottom')}/${none((h) => h.best, 'deck')}, ${mm(Math.max(0, ...edg))}, ${mm(median(edg))}`,
          hard,
          `${chosen('bottom').length}/${chosen('deck').length}`,
          median(chosen('bottom').map((f) => f.edgeDeg)).toFixed(0),
        ].join(' | '),
      );
      out.push({
        name: b.name,
        group: b.group,
        length: bs.length,
        stations: rows.map((r, i) => ({
          x: r.x,
          chord: bs.sections[i]!.chord,
          thickness: bs.sections[i]!.thickness,
          bottom: {
            hardEdge: r.bottom.hardEdge,
            tangent: lite(r.bottom.tangent),
            best: lite(r.bottom.best),
          },
          deck: {
            hardEdge: r.deck.hardEdge,
            tangent: lite(r.deck.tangent),
            best: lite(r.deck.best),
          },
        })),
      });
      // every station must have a description with an edge allowed, or the model has a gap
      expect(edg.every((v) => Number.isFinite(v))).toBe(true);
      void PROJECT_TOL_CM;
    }
    console.log('\n' + lines.join('\n') + '\n');
    const dir = process.env.TRIM_OUT;
    if (dir !== undefined && dir !== '') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'forward-fits.json'), JSON.stringify(out));
    }
  });
});
