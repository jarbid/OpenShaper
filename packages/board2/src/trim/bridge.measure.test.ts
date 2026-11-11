// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 2 of docs/design/trim-blend-plan.md: real boards through the trim kernel, measured
 * against the current engine. One rail key per stored station; the rail between stations is
 * interpolated from them, and the 41 measured stations mostly fall between. Run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/trim/bridge.measure.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { meshBoard } from '../mesh';
import { allBoards, boardSections, denseSections } from '../railproto/test-support/rail-samples';
import { DENSE_STATIONS } from '../railproto/rail-params';
import { buildBoard, createEvaluator } from '../surface';
import { buildTrimMesh, checkClosed, sliceX } from './solid';
import {
  boardLoop,
  boardPanels,
  boardRails,
  railKeys,
  railKeysAt,
  railsAlong,
} from './test-support/bridge';
import type { RailKey } from './test-support/bridge';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const GRID = 0.7;
/** Samples of the current section a slice is measured against. */
const SECTION_SAMPLES = 1201;
/** The bar a converted board must meet, cm (docs/design/trim-blend-plan.md, decision 2). */
const BAR = 0.1;
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

/** A station this close (cm) to either end of the board is in a tip, which differs on purpose. */
const TIP_REACH = 3;
/** Rail keys fitted to the surface as built at this many even stations, and at every 2nd and 4th of them. */
const KEY_STATIONS = 21;

study('real boards through the trim kernel', () => {
  it('builds closed and stays within the bar of the current engine', { timeout: 7_200_000 }, () => {
    const lines: string[] = [
      'board | open edges | volume: now L, kernel diff | per key set (keys: max mm, median mm, over 0.5, over 1.0), stations away from the tips only | tip stations | worst at x/L, y, z',
    ];
    const totals = new Map<string, number[]>();
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
      const stored = railKeys(built, 'plus');
      // key sets: the stored stations, and even stations of the surface as built
      const sets: [string, RailKey[], RailKey[]][] = [
        ['stations', stored, asym ? railKeys(built, 'minus') : stored],
      ];
      if (!asym) {
        const dense = railKeysAt(built, denseSections(b, KEY_STATIONS).sections);
        for (const step of [4, 1]) {
          const keys = dense.filter((_, i) => i % step === 0 || i === dense.length - 1);
          sets.push([`every ${step}`, keys, keys]);
        }
      }
      const usable = boardSections(b).sections;
      const x0 = usable[0]!.x;
      const x1 = usable[usable.length - 1]!.x;
      const ev = createEvaluator(built);
      const out = new Float64Array(3);
      const sides: (0 | 1)[] = asym ? [0, 1] : [0];
      const cols: string[] = [];
      let open = 0;
      let diff = '';
      let tips = 0;
      let worst = { max: 0, y: 0, z: 0, x: 0 };
      for (const [name, plus, minus] of sets) {
        const along = [railsAlong(plus), railsAlong(minus)] as const;
        const panels = boardPanels(built, loop, along[0], along[1]);
        const laws = boardRails(loop, along[0], along[1]);
        const mesh = buildTrimMesh(loop, laws, panels, GRID);
        const closed = checkClosed(mesh);
        open = Math.max(open, closed.openEdges);
        if (name === 'stations') diff = `${(((closed.volume - now) / now) * 100).toFixed(2)}%`;
        const gaps: number[] = [];
        tips = 0;
        for (let k = 0; k < DENSE_STATIONS; k++) {
          const x = x0 + ((x1 - x0) * k) / (DENSE_STATIONS - 1);
          if (x < built.xiMin + TIP_REACH || x > built.xiMax - TIP_REACH) {
            tips++;
            continue;
          }
          const slice = sliceX(mesh, panels, x);
          let station = 0;
          for (const side of sides) {
            const sign = side === 0 ? 1 : -1;
            const section = new Float64Array(2 * SECTION_SAMPLES);
            ev.row(side, x, 0);
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
            station = Math.max(station, g.max);
            if (name === 'stations' && g.max > worst.max) worst = { ...g, x };
          }
          gaps.push(station);
        }
        totals.set(name, [...(totals.get(name) ?? []), ...gaps]);
        const sorted = [...gaps].sort((a, c) => a - c);
        cols.push(
          `${name} (${plus.length}): ${mm(sorted[sorted.length - 1]!)}, ${mm(sorted[Math.floor(sorted.length / 2)]!)}, ${gaps.filter((g) => g > 0.05).length}, ${gaps.filter((g) => g > BAR).length}`,
        );
      }
      lines.push(
        [
          b.name.slice(0, 24),
          open,
          `${(now / 1000).toFixed(2)}, ${diff}`,
          cols.join('  ||  '),
          tips,
          `${(worst.x / built.xiMax).toFixed(2)}, ${worst.y.toFixed(2)}, ${worst.z.toFixed(2)}`,
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
        `ALL, keys at ${name}: ${all.length} stations, max ${mm(s[s.length - 1]!)} mm, median ${mm(s[Math.floor(s.length / 2)]!)} mm, within 0.5 mm ${share(0.05)}%, within 1 mm ${share(BAR)}%`,
      );
    }
    const dir = process.env.TRIM_OUT ?? '';
    if (dir !== '') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, only === '' ? 'bridge.txt' : `bridge-${only}.txt`),
        lines.join('\n') + '\n',
      );
    }
  });
});
