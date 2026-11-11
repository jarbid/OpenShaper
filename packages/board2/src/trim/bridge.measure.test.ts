// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 2 of docs/design/trim-blend-plan.md: real boards through the trim kernel, measured
 * against the current engine at 41 stations each. Rail keys are fitted to the current surface
 * (`station.ts`) and the rail between them is interpolated, so most measured stations fall
 * between keys. Run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> [TRIM_ONLY=<part of a board's name>] \
 *     pnpm --filter @openshaper/board2 exec vitest run src/trim/bridge.measure.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { meshBoard } from '../mesh';
import { allBoards } from '../railproto/test-support/rail-samples';
import { DENSE_STATIONS } from '../railproto/rail-params';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import type { Loop } from './loop';
import { buildTrimMesh, checkClosed, sliceX } from './solid';
import {
  boardLoop,
  boardPanels,
  boardRails,
  railKeysAt,
  railsAlong,
  usableStations,
} from './test-support/bridge';
import type { RailKey } from './test-support/bridge';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const GRID = 0.7;
/** Rows across the blends: twice the display mesh's, so its facets are not what is measured. */
const ROWS = { deckRows: 28, tuckRows: 20 } as const;
/** Samples of the current section a slice is measured against. */
const SECTION_SAMPLES = 1201;
/** The bar a converted board must meet, cm (docs/design/trim-blend-plan.md, decision 2). */
const BAR = 0.1;
/**
 * A station this close (cm) to either end of the board, or to a corner of its outline, is in
 * a tip: the kernel rounds every corner, so it differs there on purpose.
 */
const TIP_REACH = 3;
/** Even stations a fixed set of keys is fitted at; the sparser sets take every 4th of them. */
const KEY_STATIONS = 21;
/** Keys are added where the board misses the bar, up to this many; two keys are never closer than this (cm). */
const KEYS_MAX = 16;
const KEYS_APART = 2;
const mm = (cm: number): string => (cm * 10).toFixed(2);

const segDist = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const ex = bx - ax;
  const ey = by - ay;
  const ee = ex * ex + ey * ey;
  const f = ee > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / ee)) : 0;
  return Math.hypot(px - ax - f * ex, py - ay - f * ey);
};

/** Two-sided gap between a slice (segments `y1 z1 y2 z2 face`) and a section polyline `y z …`. */
function gap(slice: Float64Array, section: Float64Array): { max: number; y: number; z: number } {
  let max = 0;
  let wy = 0;
  let wz = 0;
  const pts = section.length / 2;
  for (let i = 0; i < pts; i++) {
    let d = Infinity;
    for (let s = 0; s < slice.length; s += 5) {
      d = Math.min(
        d,
        segDist(
          section[2 * i]!,
          section[2 * i + 1]!,
          slice[s]!,
          slice[s + 1]!,
          slice[s + 2]!,
          slice[s + 3]!,
        ),
      );
    }
    if (d > max) {
      max = d;
      wy = section[2 * i]!;
      wz = section[2 * i + 1]!;
    }
  }
  for (let s = 0; s < slice.length; s += 5) {
    for (const o of [0, 2]) {
      let d = Infinity;
      for (let i = 0; i + 1 < pts; i++) {
        d = Math.min(
          d,
          segDist(
            slice[s + o]!,
            slice[s + o + 1]!,
            section[2 * i]!,
            section[2 * i + 1]!,
            section[2 * i + 2]!,
            section[2 * i + 3]!,
          ),
        );
      }
      if (d > max) {
        max = d;
        wy = slice[s + o]!;
        wz = slice[s + o + 1]!;
      }
    }
  }
  return { max, y: wy, z: wz };
}

interface Station {
  readonly x: number;
  readonly tip: boolean;
}

interface Measured {
  readonly open: number;
  readonly volume: number;
  /** Worst gap at each station, cm; both sides of an asymmetric board. */
  readonly gaps: number[];
  /** The worst point of each station: side, y, z. */
  readonly where: { side: 0 | 1; y: number; z: number }[];
}

/** A board built by the kernel from `plus` and `minus` keys, against the current engine at `stations`. */
function measure(
  built: BuiltBoard,
  loop: Loop,
  plus: readonly RailKey[],
  minus: readonly RailKey[],
  stations: readonly Station[],
): Measured {
  const along = [railsAlong(plus), railsAlong(minus)] as const;
  const panels = boardPanels(built, along[0], along[1]);
  const mesh = buildTrimMesh(loop, boardRails(loop, along[0], along[1]), panels, GRID, ROWS);
  const closed = checkClosed(mesh);
  const ev = createEvaluator(built);
  const out = new Float64Array(3);
  const sides: (0 | 1)[] = built.doc.symmetry === 'asymmetric' ? [0, 1] : [0];
  const gaps: number[] = [];
  const where: Measured['where'] = [];
  for (const st of stations) {
    const slice = sliceX(mesh, panels, st.x);
    let worst = { max: -1, y: 0, z: 0 };
    let worstSide: 0 | 1 = 0;
    for (const side of sides) {
      const sign = side === 0 ? 1 : -1;
      const section = new Float64Array(2 * SECTION_SAMPLES);
      ev.row(side, st.x, 0);
      for (let i = 0; i < SECTION_SAMPLES; i++) {
        ev.eval(i / (SECTION_SAMPLES - 1), 0, out);
        section[2 * i] = out[1]!;
        section[2 * i + 1] = out[2]!;
      }
      // this side's part of the slice: a panel runs across the stringer, so it is clipped there
      const half: number[] = [];
      for (let s = 0; s < slice.length; s += 5) {
        let ya = sign * slice[s]!;
        let za = slice[s + 1]!;
        let yb = sign * slice[s + 2]!;
        let zb = slice[s + 3]!;
        if (ya < 0 && yb < 0) continue;
        if (ya < 0) {
          za += ((0 - ya) / (yb - ya)) * (zb - za);
          ya = 0;
        } else if (yb < 0) {
          zb += ((0 - yb) / (ya - yb)) * (za - zb);
          yb = 0;
        }
        half.push(sign * ya, za, sign * yb, zb, slice[s + 4]!);
      }
      const g = gap(Float64Array.from(half), section);
      if (g.max > worst.max) {
        worst = g;
        worstSide = side;
      }
    }
    gaps.push(worst.max);
    where.push({ side: worstSide, y: worst.y, z: worst.z });
  }
  return { open: closed.openEdges, volume: closed.volume, gaps, where };
}

study('real boards through the trim kernel', () => {
  it('builds closed and stays within the bar of the current engine', { timeout: 7_200_000 }, () => {
    const lines: string[] = [
      'board | open edges | volume: now L, kernel diff | per key set (keys: max mm, median mm, over 0.5, over 1.0), stations away from the tips only | tip stations',
    ];
    const totals = new Map<string, number[]>();
    const needed: string[] = [];
    const detail: string[] = [];
    const only = process.env.TRIM_ONLY ?? '';
    for (const b of allBoards()) {
      if (only !== '' && !b.name.includes(only)) continue;
      if (b.doc.tail.kind !== 'standard') {
        lines.push(
          `${b.name.slice(0, 24)} | notched tail: not measured (its sections are not plane in the current engine)`,
        );
        continue;
      }
      // bottom features ride on the panel, inboard of the tuck, and are the same functions in
      // either engine; the rail is measured on the board without them
      const builtR = buildBoard({ ...b.doc, features: [] }, { check: false });
      if (!builtR.ok) throw new Error(`${b.name}: does not build`);
      const built = builtR.value;
      const loop = boardLoop(built);
      const now = meshBoard(built).volume;
      const asym = b.doc.symmetry === 'asymmetric';
      const usable = usableStations(built, 'plus');
      const x0 = usable[0]!;
      const x1 = usable[usable.length - 1]!;
      const corners: number[] = [built.xiMin, built.xiMax];
      for (let i = 0; i < loop.n; i++) if (loop.corner[i] !== 0) corners.push(loop.x[i]!);
      const stations: Station[] = [];
      for (let k = 0; k < DENSE_STATIONS; k++) {
        const x = x0 + ((x1 - x0) * k) / (DENSE_STATIONS - 1);
        stations.push({ x, tip: corners.some((c) => Math.abs(c - x) < TIP_REACH) });
      }
      const tips = stations.filter((s) => s.tip).length;
      const keysAt = (xs: readonly number[]): [RailKey[], RailKey[]] => {
        const plus = railKeysAt(built, 'plus', xs);
        return [plus, asym ? railKeysAt(built, 'minus', xs) : plus];
      };
      const even: number[] = [];
      for (let k = 0; k < KEY_STATIONS; k++) even.push(x0 + ((x1 - x0) * k) / (KEY_STATIONS - 1));
      const sets: [string, number[]][] = [
        ['stations', usable],
        ['every 4', even.filter((_, i) => i % 4 === 0)],
        ['every 1', even],
      ];
      const cols: string[] = [];
      let open = 0;
      let diff = '';
      const report = (name: string, count: number, m: Measured): void => {
        const gaps = m.gaps.filter((_, i) => !stations[i]!.tip);
        totals.set(name, [...(totals.get(name) ?? []), ...gaps]);
        const sorted = [...gaps].sort((a, c) => a - c);
        cols.push(
          `${name} (${count}): ${mm(sorted[sorted.length - 1]!)}, ${mm(sorted[Math.floor(sorted.length / 2)]!)}, ${gaps.filter((g) => g > 0.05).length}, ${gaps.filter((g) => g > BAR).length}`,
        );
        open = Math.max(open, m.open);
        if (only !== '') {
          m.gaps.forEach((g, i) => {
            if (g > 0.03) {
              detail.push(
                `${name} | x ${stations[i]!.x.toFixed(1)} (${(stations[i]!.x / built.xiMax).toFixed(3)})${stations[i]!.tip ? ' TIP' : ''} | ${mm(g)} mm at side ${m.where[i]!.side} y ${m.where[i]!.y.toFixed(2)} z ${m.where[i]!.z.toFixed(2)}`,
              );
            }
          });
        }
      };
      for (const [name, xs] of sets) {
        const [plus, minus] = keysAt(xs);
        const m = measure(built, loop, plus, minus, stations);
        if (name === 'stations') diff = `${(((m.volume - now) / now) * 100).toFixed(2)}%`;
        report(name, xs.length, m);
      }
      // as many keys as the board needs: start from its stored stations and add one where it misses most
      const xs = [...usable];
      let m = measure(built, loop, ...keysAt(xs), stations);
      for (;;) {
        let worst = -1;
        for (let i = 0; i < stations.length; i++) {
          const s = stations[i]!;
          if (s.tip || m.gaps[i]! <= BAR) continue;
          if (xs.some((x) => Math.abs(x - s.x) < KEYS_APART)) continue;
          if (worst < 0 || m.gaps[i]! > m.gaps[worst]!) worst = i;
        }
        if (worst < 0 || xs.length >= KEYS_MAX) break;
        xs.push(stations[worst]!.x);
        xs.sort((a, c) => a - c);
        m = measure(built, loop, ...keysAt(xs), stations);
      }
      report('as needed', xs.length, m);
      needed.push(`${b.name.slice(0, 24)}: ${usable.length} stored stations, ${xs.length} keys`);
      lines.push(
        [
          b.name.slice(0, 24),
          open,
          `${(now / 1000).toFixed(2)}, ${diff}`,
          cols.join('  ||  '),
          tips,
        ].join(' | '),
      );
      expect(open, b.name).toBe(0);
    }
    lines.push('');
    for (const [name, all] of totals) {
      const s = [...all].sort((a, c) => a - c);
      const share = (lim: number): string =>
        ((100 * all.filter((g) => g <= lim).length) / all.length).toFixed(1);
      lines.push(
        `ALL, keys ${name}: ${all.length} stations, max ${mm(s[s.length - 1]!)} mm, median ${mm(s[Math.floor(s.length / 2)]!)} mm, within 0.5 mm ${share(0.05)}%, within 1 mm ${share(BAR)}%`,
      );
    }
    lines.push('', 'keys needed:', ...needed);
    const dir = process.env.TRIM_OUT ?? '';
    if (dir !== '') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, only === '' ? 'bridge.txt' : `bridge-${only}.txt`),
        lines.join('\n') + '\n',
      );
      if (only !== '') {
        writeFileSync(resolve(dir, `bridge-${only}-stations.txt`), detail.join('\n') + '\n');
      }
    }
  });
});
