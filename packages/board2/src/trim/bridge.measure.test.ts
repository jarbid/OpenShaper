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
import { allBoards, boardSections } from '../railproto/test-support/rail-samples';
import { DENSE_STATIONS } from '../railproto/rail-params';
import { buildBoard, createEvaluator } from '../surface';
import { buildTrimMesh, checkClosed, sliceX } from './solid';
import { boardLoop, boardPanels, boardRails, railKeys } from './test-support/bridge';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const GRID = 0.7;
/** Samples of the current section a slice is measured against. */
const SECTION_SAMPLES = 1201;
/** The bar a converted board must meet, cm (docs/design/trim-blend-plan.md, decision 2). */
const BAR = 0.1;
/** A station this close (cm, along the board) to a rounded corner's arc is in that corner's reach. */
const CORNER_REACH = 1.5;
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

study('real boards through the trim kernel', () => {
  it('builds closed and stays within the bar of the current engine', { timeout: 3_600_000 }, () => {
    const lines: string[] = [
      'board | loop n | open edges | volume L: now / kernel / diff | rail keys, worst key fit mm | 41 stations: max mm, median mm, over 0.5, over 1.0 | away from rounded corners: stations, max mm, over 1.0 | worst at x/L, y, z',
    ];
    const all: number[] = [];
    const clear: number[] = [];
    const only = process.env.TRIM_ONLY ?? '';
    for (const b of allBoards()) {
      if (only !== '' && !b.name.includes(only)) continue;
      if (b.doc.tail.kind !== 'standard') {
        lines.push(
          `${b.name.slice(0, 24)} | notched tail: not measured (its sections are not plane in the current engine)`,
        );
        continue;
      }
      const builtR = buildBoard(b.doc, { check: false });
      if (!builtR.ok) throw new Error(`${b.name}: does not build`);
      const built = builtR.value;
      const loop = boardLoop(built);
      const panels = boardPanels(built, loop);
      const plus = railKeys(built, 'plus');
      const minus = b.doc.symmetry === 'asymmetric' ? railKeys(built, 'minus') : plus;
      const laws = boardRails(loop, plus, minus);
      const mesh = buildTrimMesh(loop, laws, panels, GRID);
      const closed = checkClosed(mesh);
      const now = meshBoard(built).volume;
      // the same 41 stations as the studies: between the first and last usable stored station
      const usable = boardSections(b).sections;
      const x0 = usable[0]!.x;
      const x1 = usable[usable.length - 1]!.x;
      const ev = createEvaluator(built);
      const out = new Float64Array(3);
      const gaps: number[] = [];
      const away: number[] = [];
      let worst = { max: 0, y: 0, z: 0, x: 0 };
      const sides: (0 | 1)[] = b.doc.symmetry === 'asymmetric' ? [0, 1] : [0];
      for (let k = 0; k < DENSE_STATIONS; k++) {
        const x = x0 + ((x1 - x0) * k) / (DENSE_STATIONS - 1);
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
          if (g.max > worst.max) worst = { ...g, x };
        }
        gaps.push(station);
        // a rounded tip or corner moves the outline on purpose (decision 2: "except the tips")
        let corner = false;
        for (let i = 0; i < loop.n && !corner; i++) {
          corner = loop.corner[i] !== 0 && Math.abs(loop.x[i]! - x) < CORNER_REACH;
        }
        if (!corner) away.push(station);
      }
      all.push(...gaps);
      clear.push(...away);
      const sorted = [...gaps].sort((a, c) => a - c);
      const keyFit = Math.max(...plus.map((k) => k.fit), ...minus.map((k) => k.fit));
      lines.push(
        [
          b.name.slice(0, 24),
          loop.n,
          closed.openEdges,
          `${(now / 1000).toFixed(2)} / ${(closed.volume / 1000).toFixed(2)} / ${(((closed.volume - now) / now) * 100).toFixed(2)}%`,
          `${plus.length}${minus === plus ? '' : `+${minus.length}`}, ${mm(keyFit)}`,
          `${mm(sorted[sorted.length - 1]!)}, ${mm(sorted[Math.floor(sorted.length / 2)]!)}, ${gaps.filter((g) => g > 0.05).length}, ${gaps.filter((g) => g > BAR).length}`,
          `${away.length}, ${mm(Math.max(0, ...away))}, ${away.filter((g) => g > BAR).length}`,
          `${(worst.x / built.xiMax).toFixed(2)}, ${worst.y.toFixed(2)}, ${worst.z.toFixed(2)}`,
        ].join(' | '),
      );
      expect(closed.openEdges, b.name).toBe(0);
    }
    if (all.length > 0) {
      const s = [...all].sort((a, c) => a - c);
      const share = (lim: number): string =>
        ((100 * all.filter((g) => g <= lim).length) / all.length).toFixed(1);
      lines.push(
        '',
        `ALL ${all.length} stations: max ${mm(s[s.length - 1]!)} mm, median ${mm(s[Math.floor(s.length / 2)]!)} mm, within 0.5 mm ${share(0.05)}%, within 1 mm ${share(BAR)}%`,
      );
      const c = [...clear].sort((a, d) => a - d);
      lines.push(
        `AWAY FROM ROUNDED CORNERS ${clear.length} stations: max ${mm(c[c.length - 1] ?? 0)} mm, within 1 mm ${((100 * clear.filter((g) => g <= BAR).length) / Math.max(1, clear.length)).toFixed(1)}%`,
      );
    }
    console.log('\n' + lines.join('\n') + '\n');
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
