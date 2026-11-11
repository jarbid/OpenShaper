// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Law smoothness for the rail-law study (`docs/design/rail-laws-test.md` §Law smoothness):
 * do the four fitted parameters vary smoothly enough along a board to be stored as curves,
 * and what does smoothing them cost on the reconstructed section? Run on demand:
 *
 *   RAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/railproto/laws.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { fitHalf, fitStation, halfDeviation, stationAt } from './rail-fit';
import type { StationFit } from './rail-fit';
import { LAW_PENALTY, fitLaw, lawAt, optimiseLaws, roughness } from './rail-laws';
import { allBoards, boardSections, denseSections } from './test-support/rail-samples';
import { DENSE_STATIONS, LAW_DOFS, PROJECT_TOL_CM } from './rail-params';
import type { RealSection } from './rail-geom';

const study = describe.skipIf(process.env.RAIL_STUDY !== '1');

const mm = (cm: number): string => (cm * 10).toFixed(2);
const med = (xs: readonly number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const KEYS = ['turnB', 'rhoB', 'turnD', 'rhoD'] as const;
type Key = (typeof KEYS)[number];
const pick: Record<Key, (f: StationFit) => number> = {
  turnB: (f) => f.bottom.turn,
  rhoB: (f) => f.bottom.rho,
  turnD: (f) => f.deck.turn,
  rhoD: (f) => f.deck.rho,
};

interface Board {
  readonly name: string;
  readonly group: string;
  readonly length: number;
  readonly sections: readonly RealSection[];
  readonly fits: readonly StationFit[];
  readonly ts: readonly number[];
}

function measured(dense: boolean): Board[] {
  const out: Board[] = [];
  for (const b of allBoards()) {
    const bs = dense ? denseSections(b, DENSE_STATIONS) : boardSections(b);
    const sections: RealSection[] = [];
    const fits: StationFit[] = [];
    for (const s of bs.sections) {
      const f = fitStation(s);
      if (f === null) continue;
      sections.push(s);
      fits.push(f);
    }
    if (fits.length < 4) continue;
    const x0 = sections[0]!.x;
    const x1 = sections[sections.length - 1]!.x;
    out.push({
      name: bs.name,
      group: bs.group,
      length: bs.length,
      sections,
      fits,
      ts: sections.map((s) => (s.x - x0) / (x1 - x0)),
    });
  }
  return out;
}

study('law smoothness', () => {
  it('how jagged each parameter is along a board, and what a law curve costs in mm', () => {
    const boards = measured(true);
    console.log('\n### Parameter roughness (dense set): mean |second difference| over the range');
    console.log(
      '| board | n | turnB | rhoB | turnD | rhoD | turnB range deg | rhoB range | turnD range deg | rhoD range |',
    );
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    const rough: Record<Key, number[]> = { turnB: [], rhoB: [], turnD: [], rhoD: [] };
    for (const b of boards) {
      const vals = Object.fromEntries(KEYS.map((k) => [k, b.fits.map(pick[k])])) as Record<
        Key,
        number[]
      >;
      for (const k of KEYS) rough[k].push(roughness(vals[k]));
      const rng = (k: Key): string =>
        (Math.max(...vals[k]) - Math.min(...vals[k])).toFixed(k.startsWith('turn') ? 1 : 3);
      console.log(
        `| ${b.name} | ${b.fits.length} | ` +
          KEYS.map((k) => roughness(vals[k]).toFixed(3)).join(' | ') +
          ` | ${rng('turnB')} | ${rng('rhoB')} | ${rng('turnD')} | ${rng('rhoD')} |`,
      );
    }
    console.log(
      `\n**median roughness** ` + KEYS.map((k) => `${k} ${med(rough[k]).toFixed(3)}`).join(', '),
    );

    console.log('\n### What a law curve costs, in mm on the reconstructed section (dense set)');
    console.log(
      '| board | per-station max mm | k=3 max mm | k=4 max mm | k=5 max mm | k=5 extra mm (median/max) |',
    );
    console.log('|---|---|---|---|---|---|');
    const byK: Record<number, number[]> = {};
    const freeAll: number[] = [];
    const extraAll: Record<number, number[]> = {};
    for (const k of LAW_DOFS) {
      byK[k] = [];
      extraAll[k] = [];
    }
    for (const b of boards) {
      const free = b.fits.map((f) => f.max);
      freeAll.push(...free);
      const cells: string[] = [];
      let k5extra: number[] = [];
      for (const k of LAW_DOFS) {
        const laws = Object.fromEntries(
          KEYS.map((key) => [key, fitLaw(b.ts, b.fits.map(pick[key]), k)]),
        ) as Record<Key, ReturnType<typeof fitLaw>>;
        const maxes: number[] = [];
        for (let i = 0; i < b.sections.length; i++) {
          const t = b.ts[i]!;
          const f = stationAt(
            b.sections[i]!,
            lawAt(laws.turnB, t),
            lawAt(laws.rhoB, t),
            lawAt(laws.turnD, t),
            lawAt(laws.rhoD, t),
          );
          maxes.push(f === null ? Infinity : f.max);
        }
        byK[k]!.push(...maxes);
        const extra = maxes.map((v, i) => v - free[i]!);
        extraAll[k]!.push(...extra);
        cells.push(mm(Math.max(...maxes)));
        if (k === 5) k5extra = extra;
      }
      console.log(
        `| ${b.name} | ${mm(Math.max(...free))} | ${cells.join(' | ')} | ` +
          `${mm(med(k5extra))} / ${mm(Math.max(...k5extra))} |`,
      );
    }
    const share = (xs: readonly number[], lim: number): string =>
      `${((100 * xs.filter((x) => x <= lim).length) / xs.length).toFixed(0)}%`;
    console.log(
      `\n**overall** per-station free fit: median ${mm(med(freeAll))} mm, max ${mm(Math.max(...freeAll))} mm, ` +
        `within 0.5 mm ${share(freeAll, PROJECT_TOL_CM)}`,
    );
    for (const k of LAW_DOFS) {
      const xs = byK[k]!;
      const ex = extraAll[k]!;
      console.log(
        `  k=${k}: median ${mm(med(xs))} mm, p90 ${mm([...xs].sort((a, b) => a - b)[Math.floor(0.9 * xs.length)]!)} mm, ` +
          `max ${mm(Math.max(...xs))} mm, within 0.5 mm ${share(xs, PROJECT_TOL_CM)}; ` +
          `extra over the free fit: median ${mm(med(ex))} mm, max ${mm(Math.max(...ex))} mm`,
      );
    }
    expect(boards.length).toBeGreaterThan(0);
  });

  it('the parameter traces, as text plots', () => {
    const boards = measured(true).filter((b) => b.group !== 'synthetic');
    for (const b of boards.slice(0, 6)) {
      console.log(`\n#### ${b.name}  (n=${b.fits.length}, tail at x/L=0 on the left)`);
      for (const k of KEYS) {
        const ys = b.fits.map(pick[k]);
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        const glyph = ' .:-=+*#%@';
        const row = ys
          .map((y) => glyph[Math.min(9, Math.floor(((y - lo) / (hi - lo || 1)) * 9.999))]!)
          .join('');
        console.log(
          `  ${k.padEnd(6)} ${lo.toFixed(3).padStart(7)} .. ${hi.toFixed(3).padStart(7)}  |${row}|  rough ${roughness(ys).toFixed(3)}`,
        );
      }
    }
    expect(boards.length).toBeGreaterThan(0);
  });

  it('a law across the stored stations alone, for the record', () => {
    const boards = measured(false);
    console.log(
      '\n### Laws fitted to the stored stations only (3 to 6 points: the law has as many degrees of freedom as data)',
    );
    console.log('| board | n | free max mm | k=3 max mm | k=4 max mm |');
    console.log('|---|---|---|---|---|');
    for (const b of boards) {
      const free = b.fits.map((f) => f.max);
      const cells = [3, 4].map((k) => {
        const laws = Object.fromEntries(
          KEYS.map((key) => [key, fitLaw(b.ts, b.fits.map(pick[key]), k)]),
        ) as Record<Key, ReturnType<typeof fitLaw>>;
        const maxes = b.sections.map((s, i) => {
          const t = b.ts[i]!;
          const f = stationAt(
            s,
            lawAt(laws.turnB, t),
            lawAt(laws.rhoB, t),
            lawAt(laws.turnD, t),
            lawAt(laws.rhoD, t),
          );
          return f === null ? Infinity : f.max;
        });
        return mm(Math.max(...maxes));
      });
      console.log(
        `| ${b.name} | ${b.fits.length} | ${mm(Math.max(...free))} | ${cells.join(' | ')} |`,
      );
    }
    expect(boards.length).toBeGreaterThan(0);
  });
});

study('laws fitted to the sections', () => {
  it('the best a law of k degrees of freedom can do, per half', () => {
    const boards = measured(true);
    console.log(
      '\n### Laws optimised against the sections (not through the per-station parameters)',
    );
    console.log('| board | n | per-station max mm | k=3 max mm | k=4 max mm | k=5 max mm |');
    console.log('|---|---|---|---|---|---|');
    const byK: Record<number, number[]> = {};
    for (const k of LAW_DOFS) byK[k] = [];
    const freeAll: number[] = [];
    for (const b of boards) {
      const free = b.fits.map((f) => f.max);
      freeAll.push(...free);
      const cells: string[] = [];
      for (const k of LAW_DOFS) {
        let worst = 0;
        for (const half of ['bottom', 'deck'] as const) {
          const turns = b.fits.map((f) => (half === 'bottom' ? f.bottom.turn : f.deck.turn));
          const rhos = b.fits.map((f) => (half === 'bottom' ? f.bottom.rho : f.deck.rho));
          // Stations the per-station fit could not blend at any tangent point are left out:
          // no law value works there, and charging the law for them says nothing about laws.
          const usable = b.sections.map((s) => fitHalf(s, half) !== null);
          const cost = (ts: readonly number[], rs: readonly number[]): number => {
            let m = 0;
            let fails = 0;
            for (let i = 0; i < b.sections.length; i++) {
              if (!usable[i]) continue;
              const d = halfDeviation(b.sections[i]!, half, ts[i]!, rs[i]!);
              if (d === null) fails += 1;
              else m = Math.max(m, d.max);
            }
            // A flat plateau would stall the line search, so a failure's cost counts them.
            return m + LAW_PENALTY * fails;
          };
          const validTurns = b.sections
            .map((_s, i) => (usable[i] ? turns[i]! : NaN))
            .filter((v) => !Number.isNaN(v));
          const mid = [...validTurns].sort((a, c) => a - c)[validTurns.length >> 1] ?? 75;
          // Two starts: the least-squares law through the per-station values, and a constant
          // turn at their median. The first saturates against the band's edges on some boards
          // and starts outside the valid range; the second is dull but always lands inside it.
          const starts = [
            { turn: fitLaw(b.ts, turns, k), rho: fitLaw(b.ts, rhos, k) },
            {
              turn: fitLaw(
                b.ts,
                b.ts.map(() => mid),
                k,
              ),
              rho: fitLaw(b.ts, rhos, k),
            },
          ];
          let bestCost = Infinity;
          for (const st of starts) {
            const r = optimiseLaws(b.ts, st, cost, 2, 14, 6);
            bestCost = Math.min(bestCost, r.cost);
          }
          const r = { cost: bestCost };
          worst = Math.max(worst, r.cost);
        }
        byK[k]!.push(worst);
        cells.push(mm(worst));
      }
      console.log(
        `| ${b.name} | ${b.fits.length} | ${mm(Math.max(...free))} | ${cells.join(' | ')} |`,
      );
    }
    console.log(
      `\n**overall** worst board, per-station free fit ${mm(Math.max(...freeAll))} mm; ` +
        LAW_DOFS.map(
          (k) =>
            `k=${k} worst board ${mm(Math.max(...byK[k]!))} mm, median board ${mm(med(byK[k]!))} mm`,
        ).join('; '),
    );
    expect(boards.length).toBeGreaterThan(0);
  });
});
