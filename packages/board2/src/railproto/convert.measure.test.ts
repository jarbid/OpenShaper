// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trim-and-blend, stage 2 (`docs/design/trim-blend-test.md`): the conversion. Each board's
 * deck and bottom are fitted as height fields, its rails are driven by laws along the board,
 * and the section that assembles is measured against the real one. Needs stage 1's fits:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/railproto/forward.measure.test.ts
 *   TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/railproto/convert.measure.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FWD_NO_BLEND, FWD_RHO_ITERS } from './forward';
import { assembleHalf, fitPanel, panelAt, panelEdge, panelSamples } from './panel';
import type { PanelEdge, PanelField, PanelSample } from './panel';
import type { RealSection } from './rail-geom';
import type { Half } from './rail-fit';
import { fitLaw, lawAt } from './rail-laws';
import { allBoards, denseSections } from './rail-samples';
import { DENSE_STATIONS, PROJECT_TOL_CM, RHO_MAX, RHO_MIN } from './rail-params';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const mm = (cm: number): string => (cm * 10).toFixed(2);
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Control grids tried for a panel, along the board by across it. */
const GRIDS: readonly (readonly [number, number])[] = [
  [8, 5],
  [12, 6],
  [16, 8],
  [24, 10],
];
/** The grid the laws are measured on. */
const LAW_GRID = 2;
const LAW_DOFS: readonly number[] = [5, 7, 9];
const E_GRID: readonly number[] = [0, 0.2, 0.4, 0.6, 0.8, 1];
const HALVES: readonly Half[] = ['bottom', 'deck'];

interface StoredFit {
  readonly f: number;
  readonly z1: number;
  readonly rho: number;
  readonly max: number;
  readonly width: number;
}
interface StoredHalf {
  readonly hardEdge: boolean;
  readonly best: StoredFit | null;
}
interface StoredBoard {
  readonly name: string;
  readonly stations: readonly {
    readonly x: number;
    readonly bottom: StoredHalf;
    readonly deck: StoredHalf;
  }[];
}

/** Best edge fraction and shape for a half whose panel and band width are already fixed. */
function refit(s: RealSection, half: Half, pe: PanelEdge): { e: number; rho: number; max: number } {
  if (pe.blendless) return { e: 0, rho: 0.5, max: assembleHalf(s, half, pe, 0, 0.5).dev.max };
  let best = { e: 0, rho: 0.5, max: Infinity };
  const g = (Math.sqrt(5) - 1) / 2;
  for (const e of E_GRID) {
    const cost = (r: number): number => assembleHalf(s, half, pe, e, r).dev.max;
    let a = RHO_MIN;
    let b = RHO_MAX;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = cost(c);
    let fd = cost(d);
    for (let i = 0; i < FWD_RHO_ITERS; i++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = cost(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = cost(d);
      }
    }
    const rho = fc < fd ? c : d;
    const max = Math.min(fc, fd);
    if (max < best.max) best = { e, rho, max };
  }
  return best;
}

study('trim-and-blend conversion on the dense set', () => {
  it('panels as height fields, rails from laws', { timeout: 3_600_000 }, () => {
    const dir = process.env.TRIM_OUT ?? '';
    const file = resolve(dir, 'forward-fits.json');
    if (dir === '' || !existsSync(file)) {
      console.log('stage 1 fits not found; run forward.measure.test.ts with TRIM_OUT first');
      return;
    }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredBoard[];
    const lines: string[] = [];
    const allB: number[] = [];
    const allC = new Map<number, number[]>();
    const dump: object[] = [];
    lines.push(
      'board | panel residual max mm, bottom/deck, per grid ' +
        GRIDS.map((g) => g.join('x')).join(' ') +
        ' | per-station rails + fitted panels: max, med, >0.5 (12x6) (16x8) | laws on 16x8, k=' +
        LAW_DOFS.join('/') +
        ': max, med, >0.5',
    );
    for (const b of allBoards()) {
      const sb = stored.find((x) => x.name === b.name);
      const bs = denseSections(b, DENSE_STATIONS);
      if (sb === undefined || sb.stations.length !== bs.sections.length) continue;
      const secs = bs.sections;
      const x0 = secs[0]!.x;
      const x1 = secs[secs.length - 1]!.x;
      const us = secs.map((s) => (s.x - x0) / (x1 - x0));
      // per-station band widths and blend numbers from stage 1
      const per = HALVES.map((half) =>
        secs.map((_, i) => {
          const h = sb.stations[i]![half];
          return h.hardEdge || h.best === null
            ? { edge: -1, width: 0, z1: 0, rho: 0.5 }
            : { edge: h.best.f, width: h.best.width, z1: h.best.z1, rho: h.best.rho };
        }),
      );
      // panels on every grid, and their own residual against the real panel
      const fields: PanelField[][] = [];
      const resid: string[] = [];
      for (const [nx, ny] of GRIDS) {
        const pair: PanelField[] = [];
        const worst: number[] = [];
        HALVES.forEach((half, hi) => {
          const samples: PanelSample[] = [];
          const real: PanelSample[] = [];
          secs.forEach((s, i) => {
            const ps = panelSamples(s, half, us[i]!, per[hi]![i]!.edge);
            samples.push(...ps);
            // the extension samples sit past the band edge; residual is judged on the real ones
            const cut = per[hi]![i]!.edge < 0 ? 1 : 1 - per[hi]![i]!.width / s.pts[2 * s.apex]!;
            for (const p of ps) if (p.eta <= cut + 1e-9) real.push(p);
          });
          const field = fitPanel(samples, nx, ny);
          pair.push(field);
          let w = 0;
          for (const p of real) w = Math.max(w, Math.abs(panelAt(field, p.u, p.eta) - p.z));
          worst.push(w);
        });
        fields.push(pair);
        resid.push(`${mm(worst[0]!)}/${mm(worst[1]!)}`);
      }
      // (B) stage 1's rails on fitted panels
      const stationB = (grid: number): number[] =>
        secs.map((s, i) =>
          Math.max(
            ...HALVES.map((half, hi) => {
              const p = per[hi]![i]!;
              const pe = panelEdge(s, fields[grid]![hi]!, us[i]!, p.width);
              // stage 1 stored the shoulder's height; turn it into this panel's own edge fraction
              const zA = s.pts[2 * s.apex + 1]!;
              const span = zA - pe.g1;
              const e = Math.abs(span) < 1e-9 ? 0 : Math.min(1, Math.max(0, (p.z1 - pe.g1) / span));
              return assembleHalf(s, half, pe, e, p.rho).dev.max;
            }),
          ),
        );
      const b12 = stationB(1);
      const b16 = stationB(LAW_GRID);
      allB.push(...b16);
      const over = (v: readonly number[]): number => v.filter((x) => x > PROJECT_TOL_CM).length;
      // (C) laws: band width first, then edge and shape refitted at the law's width
      const lawCols: string[] = [];
      for (const k of LAW_DOFS) {
        const stationC = new Array<number>(secs.length).fill(0);
        const laws: object[] = [];
        HALVES.forEach((half, hi) => {
          const field = fields[LAW_GRID]![hi]!;
          const wLaw = fitLaw(
            us,
            per[hi]!.map((p) => p.width),
            k,
          );
          const widths = us.map((u) => Math.max(0, lawAt(wLaw, u)));
          const edges = secs.map((s, i) => panelEdge(s, field, us[i]!, widths[i]!));
          const fits = secs.map((s, i) => refit(s, half, edges[i]!));
          const live = us.map((_, i) => i).filter((i) => widths[i]! >= FWD_NO_BLEND);
          const eLaw =
            live.length > 0
              ? fitLaw(
                  live.map((i) => us[i]!),
                  live.map((i) => fits[i]!.e),
                  k,
                )
              : null;
          const rLaw =
            live.length > 0
              ? fitLaw(
                  live.map((i) => us[i]!),
                  live.map((i) => fits[i]!.rho),
                  k,
                )
              : null;
          secs.forEach((s, i) => {
            const e = eLaw === null ? 0 : Math.min(1, Math.max(0, lawAt(eLaw, us[i]!)));
            const rho =
              rLaw === null ? 0.5 : Math.min(RHO_MAX, Math.max(RHO_MIN, lawAt(rLaw, us[i]!)));
            const d = assembleHalf(s, half, edges[i]!, e, rho).dev.max;
            stationC[i] = Math.max(stationC[i]!, d);
          });
          laws.push({ half, k, width: wLaw.coef, e: eLaw?.coef ?? null, rho: rLaw?.coef ?? null });
        });
        lawCols.push(`${mm(Math.max(...stationC))}, ${mm(median(stationC))}, ${over(stationC)}`);
        allC.set(k, [...(allC.get(k) ?? []), ...stationC]);
        dump.push({ board: b.name, k, laws, stationMax: stationC });
      }
      lines.push(
        [
          b.name.slice(0, 26),
          resid.join(' '),
          `${mm(Math.max(...b12))}, ${mm(median(b12))}, ${over(b12)}  |  ${mm(Math.max(...b16))}, ${mm(median(b16))}, ${over(b16)}`,
          lawCols.join('  |  '),
        ].join(' | '),
      );
      expect(b16.every((v) => Number.isFinite(v))).toBe(true);
    }
    const share = (v: readonly number[]): string =>
      `${v.length} stations, max ${mm(Math.max(...v))}, median ${mm(median(v))}, within 0.5 mm ${((100 * v.filter((x) => x <= PROJECT_TOL_CM).length) / v.length).toFixed(1)}%`;
    lines.push('', `ALL per-station rails + 16x8 panels: ${share(allB)}`);
    for (const k of LAW_DOFS)
      lines.push(`ALL laws k=${k} + 16x8 panels: ${share(allC.get(k) ?? [])}`);
    console.log('\n' + lines.join('\n') + '\n');
    writeFileSync(resolve(dir, 'convert.json'), JSON.stringify(dump));
    writeFileSync(resolve(dir, 'convert.txt'), lines.join('\n') + '\n');
  });
});
