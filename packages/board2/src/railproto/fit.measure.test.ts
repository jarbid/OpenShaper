// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fit quality of the rail model (`docs/design/rail-laws-test.md` §Result): how close a
 * conic pair with four parameters gets to a real section's rail. Run on demand:
 *
 *   RAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/railproto/fit.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { fitPinned, fitSingle, fitStation, fitStationFifth } from './rail-fit';
import type { StationFit } from './rail-fit';
import { allBoards, boardSections, denseSections } from './rail-samples';
import { DENSE_STATIONS, PINNED_TURNS, PROJECT_TOL_CM } from './rail-params';
import type { RealSection } from './rail-geom';

const study = describe.skipIf(process.env.RAIL_STUDY !== '1');

const mm = (cm: number): string => (cm * 10).toFixed(2);

interface Row {
  readonly board: string;
  readonly group: string;
  readonly length: number;
  readonly fits: readonly StationFit[];
}

function collect(dense: boolean): Row[] {
  const rows: Row[] = [];
  for (const b of allBoards()) {
    const bs = dense ? denseSections(b, DENSE_STATIONS) : boardSections(b);
    const fits: StationFit[] = [];
    for (const s of bs.sections) {
      const f = fitStation(s);
      if (f !== null) fits.push(f);
    }
    rows.push({ board: bs.name, group: bs.group, length: bs.length, fits });
  }
  return rows;
}

const share = (xs: readonly number[], limit: number): number =>
  xs.length === 0 ? 0 : xs.filter((x) => x <= limit).length / xs.length;

function table(rows: readonly Row[], title: string): number[] {
  console.log(`\n### ${title}`);
  console.log(
    '| board | n | max mm | RMS mm | <=0.5mm | <=1mm | blend span mm (b/d) | rho (b/d) |',
  );
  console.log('|---|---|---|---|---|---|---|---|');
  const all: number[] = [];
  for (const r of rows) {
    const maxes = r.fits.map((f) => f.max);
    all.push(...maxes);
    const rms = Math.sqrt(r.fits.reduce((a, f) => a + f.rms * f.rms, 0) / Math.max(1, r.fits.length));
    const avg = (pick: (f: StationFit) => number): string =>
      (r.fits.reduce((a, f) => a + pick(f), 0) / Math.max(1, r.fits.length)).toFixed(2);
    console.log(
      `| ${r.board} | ${r.fits.length} | ${mm(Math.max(...maxes, 0))} | ${mm(rms)} | ` +
        `${(100 * share(maxes, PROJECT_TOL_CM)).toFixed(0)}% | ${(100 * share(maxes, 0.1)).toFixed(0)}% | ` +
        `${avg((f) => f.bottom.span * 10)} / ${avg((f) => f.deck.span * 10)} | ` +
        `${avg((f) => f.bottom.rho)} / ${avg((f) => f.deck.rho)} |`,
    );
  }
  all.sort((a, b) => a - b);
  const q = (p: number): string => mm(all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0);
  console.log(
    `\n**overall** n=${all.length}  median ${q(0.5)} mm  p90 ${q(0.9)} mm  p99 ${q(0.99)} mm  ` +
      `max ${mm(all[all.length - 1] ?? 0)} mm\n` +
      `within 0.5 mm ${(100 * share(all, 0.05)).toFixed(1)}%  ` +
      `within 1.0 mm ${(100 * share(all, 0.1)).toFixed(1)}%  ` +
      `worse than 1 mm ${(100 * (1 - share(all, 0.1))).toFixed(1)}%`,
  );
  return all;
}

study('fit quality', () => {
  it('four parameters against the stored stations (the designers’ own data)', () => {
    const rows = collect(false);
    table(rows, 'Stored stations, four free parameters');
    // the worst stations, named
    const worst = rows
      .flatMap((r) => r.fits.map((f) => ({ board: r.board, length: r.length, f })))
      .sort((a, b) => b.f.max - a.f.max)
      .slice(0, 10);
    console.log('\n#### worst stored stations');
    console.log('| board | x cm | x/L | max mm | half | turn deg | rho | span mm | W cm | T cm |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const w of worst) {
      const h = w.f.bottom.max >= w.f.deck.max ? w.f.bottom : w.f.deck;
      const which = w.f.bottom.max >= w.f.deck.max ? 'bottom' : 'deck';
      console.log(
        `| ${w.board} | ${w.f.x.toFixed(1)} | ${(w.f.x / w.length).toFixed(2)} | ${mm(w.f.max)} | ` +
          `${which} | ${h.turn.toFixed(1)} | ${h.rho.toFixed(3)} | ${(h.span * 10).toFixed(1)} | ` +
          `${w.f.chord.toFixed(1)} | ${w.f.thickness.toFixed(2)} |`,
      );
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('four parameters against the dense as-built set', () => {
    const all = table(collect(true), 'Dense as-built stations, four free parameters');
    expect(all.length).toBeGreaterThan(0);
  });

  it('with the tangent points pinned: rho is the only freedom', () => {
    console.log('\n### Pinned tangent points (no freedom to shrink the blend)');
    console.log('| turn deg | n | median mm | p90 mm | max mm | <=0.5mm | mean span mm |');
    console.log('|---|---|---|---|---|---|---|');
    for (const turn of PINNED_TURNS) {
      const maxes: number[] = [];
      const spans: number[] = [];
      for (const b of allBoards()) {
        for (const s of boardSections(b).sections) {
          const fb = fitPinned(s, 'bottom', turn);
          const fd = fitPinned(s, 'deck', turn);
          if (fb === null || fd === null) continue;
          maxes.push(Math.max(fb.max, fd.max));
          spans.push(fb.span * 10, fd.span * 10);
        }
      }
      maxes.sort((a, b) => a - b);
      const q = (p: number): string => mm(maxes[Math.floor(p * maxes.length)] ?? 0);
      console.log(
        `| ${turn} | ${maxes.length} | ${q(0.5)} | ${q(0.9)} | ${mm(maxes[maxes.length - 1] ?? 0)} | ` +
          `${(100 * share(maxes, PROJECT_TOL_CM)).toFixed(0)}% | ` +
          `${(spans.reduce((a, b) => a + b, 0) / spans.length).toFixed(1)} |`,
      );
    }
    expect(true).toBe(true);
  });
});

study('open questions', () => {
  it('one conic or two', () => {
    console.log('\n### One conic from tangent point to tangent point, versus two meeting vertically at the apex');
    console.log('| board | n | two-conic max mm | one-conic max mm | one-conic median mm | apex miss mm (median/max) |');
    console.log('|---|---|---|---|---|---|');
    const two: number[] = [];
    const one: number[] = [];
    const miss: number[] = [];
    for (const b of allBoards()) {
      const t: number[] = [];
      const o: number[] = [];
      const m: number[] = [];
      for (const s of boardSections(b).sections) {
        const f = fitStation(s);
        if (f === null) continue;
        const single = fitSingle(s, f.bottom.turn, f.deck.turn);
        if (single === null) continue;
        t.push(f.max);
        o.push(single.max);
        m.push(single.apexMiss);
      }
      if (t.length === 0) continue;
      two.push(...t);
      one.push(...o);
      miss.push(...m);
      const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      console.log(
        `| ${b.name} | ${t.length} | ${mm(Math.max(...t))} | ${mm(Math.max(...o))} | ` +
          `${mm(med(o))} | ${mm(med(m))} / ${mm(Math.max(...m))} |`,
      );
    }
    const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(
      `\n**overall** two-conic median ${mm(med(two))} mm, max ${mm(Math.max(...two))} mm; ` +
        `one-conic median ${mm(med(one))} mm, max ${mm(Math.max(...one))} mm; ` +
        `one-conic within 0.5 mm ${(100 * share(one, 0.05)).toFixed(0)}% (two-conic ${(100 * share(two, 0.05)).toFixed(0)}%); ` +
        `apex miss median ${mm(med(miss))} mm, max ${mm(Math.max(...miss))} mm`,
    );
    expect(one.length).toBeGreaterThan(0);
  });

  it.each(['flat', 'lean'] as const)('a fifth parameter: %s at the apex', (kind) => {
    const label = kind === 'flat' ? 'a short vertical flat at the apex' : 'the apex tangent leaning off vertical';
    console.log(`\n### A fifth parameter: ${label}`);
    console.log('| board | n | 4-param max mm | 5-param max mm | 4-param median | 5-param median | value (median/max) |');
    console.log('|---|---|---|---|---|---|---|');
    const four: number[] = [];
    const five: number[] = [];
    const vals: number[] = [];
    for (const b of allBoards()) {
      const f4: number[] = [];
      const f5: number[] = [];
      const vs: number[] = [];
      for (const s of boardSections(b).sections) {
        const a = fitStation(s);
        const c = fitStationFifth(s, kind);
        if (a === null || c === null) continue;
        f4.push(a.max);
        f5.push(c.fit.max);
        vs.push(c.value);
      }
      if (f4.length === 0) continue;
      four.push(...f4);
      five.push(...f5);
      vals.push(...vs);
      const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      console.log(
        `| ${b.name} | ${f4.length} | ${mm(Math.max(...f4))} | ${mm(Math.max(...f5))} | ` +
          `${mm(med(f4))} | ${mm(med(f5))} | ${med(vs).toFixed(3)} / ${Math.max(...vs.map(Math.abs)).toFixed(3)} |`,
      );
    }
    const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const gain = four.map((v, i) => v - five[i]!);
    console.log(
      `\n**overall (${kind})** 4-param median ${mm(med(four))} mm max ${mm(Math.max(...four))} mm; ` +
        `5-param median ${mm(med(five))} mm max ${mm(Math.max(...five))} mm\n` +
        `residual removed: median ${mm(med(gain))} mm, mean ${mm(gain.reduce((a, b) => a + b, 0) / gain.length)} mm, ` +
        `best ${mm(Math.max(...gain))} mm; share of stations improved by more than 0.05 mm ` +
        `${((100 * gain.filter((g) => g > 0.005).length) / gain.length).toFixed(0)}%; ` +
        `share whose best fifth value is nonzero ${((100 * vals.filter((v) => Math.abs(v) > 1e-9).length) / vals.length).toFixed(0)}%`,
    );
    expect(five.length).toBeGreaterThan(0);
  });
});

study('context', () => {
  it('tail versus middle', () => {
    console.log('\n### Where along the board the residual sits (dense set)');
    const bins = [0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 1.01];
    const buckets = bins.map(() => [] as number[]);
    const bSpan = bins.map(() => [] as number[]);
    for (const b of allBoards()) {
      const bs = denseSections(b, DENSE_STATIONS);
      for (const s of bs.sections) {
        const f = fitStation(s);
        if (f === null) continue;
        const r = s.x / bs.length;
        const k = bins.findIndex((e) => r < e);
        if (k >= 0) {
          buckets[k]!.push(f.max);
          bSpan[k]!.push(f.bottom.span * 10, f.deck.span * 10);
        }
      }
    }
    console.log('| x/L | n | median mm | p90 mm | max mm | <=0.5mm | mean blend span mm |');
    console.log('|---|---|---|---|---|---|---|');
    let lo = 0;
    for (let k = 0; k < bins.length; k++) {
      const xs = [...buckets[k]!].sort((a, b) => a - b);
      if (xs.length === 0) { lo = bins[k]!; continue; }
      const sp = bSpan[k]!;
      console.log(
        `| ${lo.toFixed(2)}–${Math.min(1, bins[k]!).toFixed(2)} | ${xs.length} | ` +
          `${mm(xs[Math.floor(0.5 * xs.length)]!)} | ${mm(xs[Math.floor(0.9 * xs.length)]!)} | ` +
          `${mm(xs[xs.length - 1]!)} | ${(100 * share(xs, PROJECT_TOL_CM)).toFixed(0)}% | ` +
          `${(sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(1)} |`,
      );
      lo = bins[k]!;
    }
    expect(true).toBe(true);
  });
});

export type { RealSection };
