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
  [12, 6],
  [16, 8],
  [24, 10],
];
/** The grid the zone breakdown and the laws are measured on. */
const MAIN_GRID = 1;
const LAW_DOFS: readonly number[] = [7, 9];
const E_GRID: readonly number[] = [0, 0.2, 0.4, 0.6, 0.8, 1];
const HALVES: readonly Half[] = ['bottom', 'deck'];
/**
 * How the band edge is chosen from stage 1's candidates. `tight` takes the blend that fits
 * best, which is usually the narrowest; `wide` takes the widest band whose blend still fits
 * within {@link WIDE_TOL}, so the blend carries the rail's whole turn and the panel is left
 * smooth.
 */
type Rule = 'tight' | 'wide' | 'mixed';
const RULES: readonly Rule[] = ['tight', 'wide', 'mixed'];
/** The blend's own share of the 0.5 mm budget under the `wide` rule, cm. */
const WIDE_TOL = 0.02;
/** Width of the zone at the band edge that the panel residual is reported for separately, cm. */
const EDGE_ZONE = 0.5;

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
  readonly cands: readonly StoredFit[];
}
interface StoredBoard {
  readonly name: string;
  readonly stations: readonly {
    readonly x: number;
    readonly bottom: StoredHalf;
    readonly deck: StoredHalf;
  }[];
}

function pick(h: StoredHalf, rule: Rule, half: Half): StoredFit | null {
  if (h.hardEdge || h.best === null) return null;
  // `mixed`: the bottom turns in its last centimetre or two, so its band is the whole tuck;
  // the deck turns across the whole dome, so its band stays the narrow one
  if (rule === 'tight' || (rule === 'mixed' && half === 'deck')) return h.best;
  let wide: StoredFit | null = null;
  for (const c of h.cands) {
    if (c.max <= WIDE_TOL && (wide === null || c.width > wide.width)) wide = c;
  }
  return wide ?? h.best;
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
    const withLaws = process.env.TRIM_LAWS === '1';
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredBoard[];
    const lines: string[] = [];
    const totals = new Map<string, number[]>();
    const add = (key: string, v: readonly number[]): void => {
      totals.set(key, [...(totals.get(key) ?? []), ...v]);
    };
    const over = (v: readonly number[]): number => v.filter((x) => x > PROJECT_TOL_CM).length;
    const dump: object[] = [];
    lines.push(
      'board | rule | band mm b/d | panel residual max mm b/d at ' +
        GRIDS.map((g) => g.join('x')).join(', ') +
        ' | 16x8 bottom residual by zone: inner / outer / last 5 mm | assembled section: max, med, >0.5 at ' +
        GRIDS.map((g) => g.join('x')).join(', '),
    );
    for (const b of allBoards()) {
      const sb = stored.find((x) => x.name === b.name);
      const bs = denseSections(b, DENSE_STATIONS);
      if (sb === undefined || sb.stations.length !== bs.sections.length) continue;
      const secs = bs.sections;
      const x0 = secs[0]!.x;
      const x1 = secs[secs.length - 1]!.x;
      const us = secs.map((s) => (s.x - x0) / (x1 - x0));
      for (const rule of RULES) {
        const per = HALVES.map((half) =>
          secs.map((_, i) => {
            const p = pick(sb.stations[i]![half], rule, half);
            return p === null
              ? { edge: -1, width: 0, z1: 0, rho: 0.5 }
              : { edge: p.f, width: p.width, z1: p.z1, rho: p.rho };
          }),
        );
        const bands = per.map((h) => mm(median(h.map((p) => p.width))));
        const fields: PanelField[][] = [];
        const resid: string[] = [];
        let zones = '';
        GRIDS.forEach(([nx, ny], gi) => {
          const pair: PanelField[] = [];
          const worst: number[] = [];
          HALVES.forEach((half, hi) => {
            const samples: PanelSample[] = [];
            const real: { p: PanelSample; toEdge: number }[] = [];
            secs.forEach((s, i) => {
              const chord = s.pts[2 * s.apex]!;
              const ps = panelSamples(s, half, us[i]!, per[hi]![i]!.edge);
              samples.push(...ps);
              // the extension sits past the band edge; the residual is judged on the real samples
              const cut = per[hi]![i]!.edge < 0 ? 1 : 1 - per[hi]![i]!.width / chord;
              for (const p of ps) {
                if (p.eta <= cut + 1e-9) real.push({ p, toEdge: (cut - p.eta) * chord });
              }
            });
            const field = fitPanel(samples, nx!, ny!);
            pair.push(field);
            let w = 0;
            const z = [0, 0, 0];
            for (const r of real) {
              const e = Math.abs(panelAt(field, r.p.u, r.p.eta) - r.p.z);
              w = Math.max(w, e);
              const k = r.toEdge <= EDGE_ZONE ? 2 : r.p.eta < 0.6 ? 0 : 1;
              z[k] = Math.max(z[k]!, e);
            }
            worst.push(w);
            if (gi === MAIN_GRID && half === 'bottom') zones = z.map(mm).join(' / ');
          });
          fields.push(pair);
          resid.push(`${mm(worst[0]!)}/${mm(worst[1]!)}`);
        });
        const assembled = (grid: number): number[] =>
          secs.map((s, i) =>
            Math.max(
              ...HALVES.map((half, hi) => {
                const p = per[hi]![i]!;
                const pe = panelEdge(s, fields[grid]![hi]!, us[i]!, p.width);
                // stage 1 stored the shoulder's height; turn it into this panel's own edge fraction
                const span = s.pts[2 * s.apex + 1]! - pe.g1;
                const e =
                  Math.abs(span) < 1e-9 ? 0 : Math.min(1, Math.max(0, (p.z1 - pe.g1) / span));
                return assembleHalf(s, half, pe, e, p.rho).dev.max;
              }),
            ),
          );
        const cols: string[] = [];
        GRIDS.forEach((g, gi) => {
          const v = assembled(gi);
          add(`${rule} ${g.join('x')}`, v);
          cols.push(`${mm(Math.max(...v))}, ${mm(median(v))}, ${over(v)}`);
          expect(v.every((x) => Number.isFinite(x))).toBe(true);
        });
        lines.push(
          [
            b.name.slice(0, 22),
            rule,
            bands.join('/'),
            resid.join(', '),
            zones,
            cols.join('  |  '),
          ].join(' | '),
        );
        if (!withLaws || rule !== 'mixed') continue;
        // laws on the mixed rule: band width first, then edge and shape refitted at the law's width
        for (const k of LAW_DOFS) {
          const stationC = new Array<number>(secs.length).fill(0);
          const laws: object[] = [];
          HALVES.forEach((half, hi) => {
            const field = fields[MAIN_GRID]![hi]!;
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
              stationC[i] = Math.max(
                stationC[i]!,
                assembleHalf(s, half, edges[i]!, e, rho).dev.max,
              );
            });
            laws.push({
              half,
              k,
              width: wLaw.coef,
              e: eLaw?.coef ?? null,
              rho: rLaw?.coef ?? null,
            });
          });
          add(`laws k=${k}`, stationC);
          lines.push(
            `${b.name.slice(0, 22)} | laws k=${k} on 16x8 | ${mm(Math.max(...stationC))}, ${mm(median(stationC))}, ${over(stationC)}`,
          );
          dump.push({ board: b.name, k, laws, stationMax: stationC });
        }
      }
    }
    lines.push('');
    for (const [key, v] of totals) {
      lines.push(
        `ALL ${key}: ${v.length} stations, max ${mm(Math.max(...v))}, median ${mm(median(v))}, within 0.5 mm ${((100 * v.filter((x) => x <= PROJECT_TOL_CM).length) / v.length).toFixed(1)}%`,
      );
    }
    console.log('\n' + lines.join('\n') + '\n');
    writeFileSync(
      resolve(dir, withLaws ? 'convert-laws.txt' : 'convert.txt'),
      lines.join('\n') + '\n',
    );
    if (withLaws) writeFileSync(resolve(dir, 'convert.json'), JSON.stringify(dump));
  });
});
