// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 2 of docs/design/trim-blend-plan.md: real boards through the trim kernel, measured
 * against the current engine at 41 stations each. Rail keys are fitted to the current surface
 * (`station.ts`) and the rail between them is interpolated, so most measured stations fall
 * between keys. A notched board's panels and keys come from its notch-free twin, its loop from
 * its own outline, and it is measured only beyond its notch zone, where its sections are plane.
 * Run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> [TRIM_ONLY=<part of a board's name>] \
 *     pnpm --filter @openshaper/board2 exec vitest run src/trim/bridge.measure.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { funcEval } from '../chain';
import { meshBoard } from '../mesh';
import type { BoardMesh } from '../mesh';
import { allBoards } from '../railproto/test-support/rail-samples';
import { DENSE_STATIONS } from '../railproto/rail-params';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import type { BoardDoc } from '../types';
import type { Loop } from './loop';
import { buildTrimMesh, checkClosed, sliceX } from './solid';
import type { Panels, TrimMesh } from './solid';
import {
  boardLoop,
  boardPanels,
  boardRails,
  notchFreeTwin,
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
/** Shares of the crotch depth at which a notched tail's lobes are sampled. */
const LOBE_AT = [0.2, 0.4, 0.6, 0.8] as const;
/** Two decimals, as a number, for the JSON summary. */
const r2 = (v: number): number => Math.round(v * 100) / 100;

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
  /** Largest distance (cm) of a measured section's point from its station's plane, away from the tips. */
  readonly offPlane: number;
  readonly mesh: TrimMesh;
  readonly panels: Panels;
}

/**
 * A board built by the kernel from `plus` and `minus` keys, its panels read off `source`, against
 * the sections of `reference` at `stations`. They are one board unless the tail is notched.
 */
function measure(
  source: BuiltBoard,
  reference: BuiltBoard,
  loop: Loop,
  plus: readonly RailKey[],
  minus: readonly RailKey[],
  stations: readonly Station[],
): Measured {
  const along = [railsAlong(plus), railsAlong(minus)] as const;
  const panels = boardPanels(source, along[0], along[1]);
  const mesh = buildTrimMesh(loop, boardRails(loop, along[0], along[1]), panels, GRID, ROWS);
  const closed = checkClosed(mesh);
  const ev = createEvaluator(reference);
  const out = new Float64Array(3);
  let offPlane = 0;
  const sides: (0 | 1)[] = reference.doc.symmetry === 'asymmetric' ? [0, 1] : [0];
  const gaps: number[] = [];
  const where: Measured['where'] = [];
  for (const st of stations) {
    const slice = sliceX(mesh, mesh.panels, st.x);
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
        if (!st.tip) offPlane = Math.max(offPlane, Math.abs(out[0]! - st.x));
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
  return { open: closed.openEdges, volume: closed.volume, gaps, where, offPlane, mesh, panels };
}

/** Thickness (cm) of a closed mesh straight up through (x, y): top crossing less bottom; NaN if it misses. */
function thicknessAt(
  m: { readonly positions: Float32Array; readonly indices: Uint32Array },
  x: number,
  y: number,
): number {
  const p = m.positions;
  const idx = m.indices;
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!;
    const b = 3 * idx[t + 1]!;
    const c = 3 * idx[t + 2]!;
    const ex = p[b]! - p[a]!;
    const ey = p[b + 1]! - p[a + 1]!;
    const fx = p[c]! - p[a]!;
    const fy = p[c + 1]! - p[a + 1]!;
    const det = ex * fy - fx * ey;
    if (det === 0) continue;
    const px = x - p[a]!;
    const py = y - p[a + 1]!;
    const u = (px * fy - fx * py) / det;
    const v = (ex * py - px * ey) / det;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const z = p[a + 2]! + u * (p[b + 2]! - p[a + 2]!) + v * (p[c + 2]! - p[a + 2]!);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return hi > lo ? hi - lo : Number.NaN;
}

/** What a notched tail looks like in the kernel, where it is not gated. */
interface TailRegion {
  /** Thinnest rail wall over the loop samples, cm, and where. */
  readonly wall: { readonly min: number; readonly x: number; readonly y: number };
  /** At points across each lobe's middle: thickness (cm) of the kernel, of today's notched board, and of the twin's panels. */
  readonly lobes: {
    readonly x: number;
    readonly y: number;
    readonly kernel: number;
    readonly now: number;
    readonly twinPanels: number;
  }[];
}

function tailRegion(
  m: Measured,
  nowMesh: BoardMesh,
  depth: number,
  stringer: (x: number) => number,
): TailRegion & { readonly stringer: { x: number; panels: number; doc: number }[] } {
  const { mesh, panels } = m;
  let wall = { min: Infinity, x: 0, y: 0 };
  for (let i = 0; i < mesh.loop.n; i++) {
    const w = mesh.wallTop[i]! - mesh.wallBottom[i]!;
    if (w < wall.min) wall = { min: w, x: mesh.loop.x[i]!, y: mesh.loop.y[i]! };
  }
  const lobes: TailRegion['lobes'] = [];
  const stringerRows: { x: number; panels: number; doc: number }[] = [];
  for (const share of LOBE_AT) {
    const x = share * depth;
    // the plus lobe's span across the board, from the kernel's slice
    const slice = sliceX(mesh, mesh.panels, x);
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let s = 0; s < slice.length; s += 5) {
      for (const o of [0, 2]) {
        const y = slice[s + o]!;
        if (y > 0) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    const y = 0.5 * (y0 + y1);
    lobes.push({
      x,
      y,
      kernel: thicknessAt(mesh, x, y),
      now: thicknessAt(nowMesh, x, y),
      twinPanels: panels.deck(x, y) - panels.bottom(x, y),
    });
    stringerRows.push({ x, panels: panels.deck(x, 0) - panels.bottom(x, 0), doc: stringer(x) });
  }
  return { wall, lobes, stringer: stringerRows };
}

interface SetSummary {
  readonly keys: number;
  readonly maxMm: number;
  readonly medianMm: number;
  readonly over05: number;
  readonly over10: number;
}

interface BoardSummary {
  readonly name: string;
  readonly tail: BoardDoc['tail'];
  /** x (cm) where a notched board's sections become plane: crotch depth plus zone. */
  readonly zoneEnd?: number;
  openEdges: number;
  readonly volumeNowLitres: number;
  volumeDiffPercent: number;
  readonly tipStations: number;
  readonly measuredStations: number;
  readonly sets: Record<string, SetSummary>;
  keysNeeded: number;
  /** Notched boards: largest distance (mm) of a measured section from its station's plane. */
  offPlaneMm?: number;
  /** Notched boards: `TailRegion` with thicknesses in mm and positions in cm. */
  tailRegion?: { wallMm: TailRegion['wall']; lobesMm: TailRegion['lobes'] };
}

study('real boards through the trim kernel', () => {
  it('builds closed and stays within the bar of the current engine', { timeout: 7_200_000 }, () => {
    const lines: string[] = [
      'board | open edges | volume: now L, kernel diff | per key set (keys: max mm, median mm, over 0.5, over 1.0), stations away from the tips only | tip stations',
    ];
    const totals = new Map<string, number[]>();
    const needed: string[] = [];
    const detail: string[] = [];
    const tailLines: string[] = [];
    const summaries: BoardSummary[] = [];
    const only = process.env.TRIM_ONLY ?? '';
    const build = (doc: BoardDoc, name: string): BuiltBoard => {
      const r = buildBoard(doc, { check: false });
      if (!r.ok) {
        throw new Error(`${name}: does not build: ${r.issues.map((i) => i.message).join('; ')}`);
      }
      return r.value;
    };
    for (const b of allBoards()) {
      if (only !== '' && !b.name.includes(only)) continue;
      // bottom features ride on the panel, inboard of the tuck, and are the same functions in
      // either engine; the rail is measured on the board without them
      const built = build({ ...b.doc, features: [] }, b.name);
      const tail = built.doc.tail;
      const notched = tail.kind === 'notched';
      // a notched board's panels and keys come from its twin, whose sections are plane everywhere
      const source = notched ? build(notchFreeTwin(built.doc), `${b.name} twin`) : built;
      const depth = notched ? built.doc.outline.plus.knots[0]!.p[0] : 0;
      const zoneEnd = tail.kind === 'notched' ? depth + tail.zone : -Infinity;
      const loop = boardLoop(built);
      const nowMesh = meshBoard(built);
      const now = nowMesh.volume;
      const asym = b.doc.symmetry === 'asymmetric';
      const usable = usableStations(source, 'plus');
      const x0 = usable[0]!;
      const x1 = usable[usable.length - 1]!;
      const corners: number[] = [source.xiMin, source.xiMax];
      for (let i = 0; i < loop.n; i++) if (loop.corner[i] !== 0) corners.push(loop.x[i]!);
      const stations: Station[] = [];
      for (let k = 0; k < DENSE_STATIONS; k++) {
        const x = x0 + ((x1 - x0) * k) / (DENSE_STATIONS - 1);
        stations.push({
          x,
          tip: x < zoneEnd + TIP_REACH || corners.some((c) => Math.abs(c - x) < TIP_REACH),
        });
      }
      const tips = stations.filter((s) => s.tip).length;
      const keysAt = (xs: readonly number[]): [RailKey[], RailKey[]] => {
        const plus = railKeysAt(source, 'plus', xs);
        return [plus, asym ? railKeysAt(source, 'minus', xs) : plus];
      };
      const run = (keys: [RailKey[], RailKey[]]): Measured =>
        measure(source, built, loop, keys[0], keys[1], stations);
      const even: number[] = [];
      for (let k = 0; k < KEY_STATIONS; k++) even.push(x0 + ((x1 - x0) * k) / (KEY_STATIONS - 1));
      const sets: [string, number[]][] = [
        ['stations', usable],
        ['every 4', even.filter((_, i) => i % 4 === 0)],
        ['every 1', even],
      ];
      const summary: BoardSummary = {
        name: b.name,
        tail,
        ...(notched ? { zoneEnd } : {}),
        openEdges: 0,
        volumeNowLitres: r2(now / 1000),
        volumeDiffPercent: 0,
        tipStations: tips,
        measuredStations: stations.length - tips,
        sets: {},
        keysNeeded: 0,
      };
      const cols: string[] = [];
      let open = 0;
      let diff = '';
      let offPlane = 0;
      const report = (name: string, count: number, m: Measured): void => {
        const gaps = m.gaps.filter((_, i) => !stations[i]!.tip);
        totals.set(name, [...(totals.get(name) ?? []), ...gaps]);
        const sorted = [...gaps].sort((a, c) => a - c);
        const max = sorted[sorted.length - 1]!;
        const median = sorted[Math.floor(sorted.length / 2)]!;
        const over05 = gaps.filter((g) => g > 0.05).length;
        const over10 = gaps.filter((g) => g > BAR).length;
        cols.push(`${name} (${count}): ${mm(max)}, ${mm(median)}, ${over05}, ${over10}`);
        summary.sets[name] = {
          keys: count,
          maxMm: r2(max * 10),
          medianMm: r2(median * 10),
          over05,
          over10,
        };
        open = Math.max(open, m.open);
        offPlane = Math.max(offPlane, m.offPlane);
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
        const m = run(keysAt(xs));
        if (name === 'stations') {
          diff = `${(((m.volume - now) / now) * 100).toFixed(2)}%`;
          summary.volumeDiffPercent = r2(((m.volume - now) / now) * 100);
          if (notched) {
            const r = new Float64Array(3);
            const d = new Float64Array(3);
            const t = tailRegion(m, nowMesh, depth, (x) => {
              funcEval(source.rocker, x, r, 0);
              funcEval(source.deck, x, d, 0);
              return d[0]! - r[0]!;
            });
            summary.tailRegion = {
              wallMm: { min: r2(t.wall.min * 10), x: r2(t.wall.x), y: r2(t.wall.y) },
              lobesMm: t.lobes.map((l) => ({
                x: r2(l.x),
                y: r2(l.y),
                kernel: r2(l.kernel * 10),
                now: r2(l.now * 10),
                twinPanels: r2(l.twinPanels * 10),
              })),
            };
            tailLines.push(
              `${b.name}: thinnest wall ${mm(t.wall.min)} mm at x ${t.wall.x.toFixed(2)} y ${t.wall.y.toFixed(2)}`,
              ...t.lobes.map(
                (l) =>
                  `  lobe x ${l.x.toFixed(1)} y ${l.y.toFixed(2)}: kernel ${mm(l.kernel)} mm, now ${mm(l.now)} mm, twin panels ${mm(l.twinPanels)} mm`,
              ),
              ...t.stringer.map(
                (s) =>
                  `  twin at the stringer, x ${s.x.toFixed(1)}: panels ${mm(s.panels)} mm, deck less rocker ${mm(s.doc)} mm`,
              ),
            );
          }
        }
        report(name, xs.length, m);
      }
      // as many keys as the board needs: start from its stored stations and add one where it misses most
      const xs = [...usable];
      let m = run(keysAt(xs));
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
        m = run(keysAt(xs));
      }
      report('as needed', xs.length, m);
      summary.openEdges = open;
      summary.keysNeeded = xs.length;
      if (notched) summary.offPlaneMm = r2(offPlane * 10);
      summaries.push(summary);
      needed.push(`${b.name.slice(0, 24)}: ${usable.length} stored stations, ${xs.length} keys`);
      lines.push(
        [
          b.name.slice(0, 24),
          open,
          `${(now / 1000).toFixed(2)}, ${diff}`,
          cols.join('  ||  '),
          tips,
          ...(notched ? [`zone end ${zoneEnd.toFixed(1)}, off plane ${mm(offPlane)} mm`] : []),
        ].join(' | '),
      );
      expect(open, b.name).toBe(0);
    }
    lines.push('');
    const all: Record<string, unknown> = {};
    for (const [name, gaps] of totals) {
      const s = [...gaps].sort((a, c) => a - c);
      const within = (lim: number): number =>
        (100 * gaps.filter((g) => g <= lim).length) / gaps.length;
      lines.push(
        `ALL, keys ${name}: ${gaps.length} stations, max ${mm(s[s.length - 1]!)} mm, median ${mm(s[Math.floor(s.length / 2)]!)} mm, within 0.5 mm ${within(0.05).toFixed(1)}%, within 1 mm ${within(BAR).toFixed(1)}%`,
      );
      all[name] = {
        stations: gaps.length,
        maxMm: r2(s[s.length - 1]! * 10),
        medianMm: r2(s[Math.floor(s.length / 2)]! * 10),
        within05Percent: Math.round(within(0.05) * 10) / 10,
        within10Percent: Math.round(within(BAR) * 10) / 10,
      };
    }
    lines.push('', 'keys needed:', ...needed);
    if (tailLines.length > 0) lines.push('', 'notched tails, not gated:', ...tailLines);
    const dir = process.env.TRIM_OUT ?? '';
    if (dir !== '') {
      mkdirSync(dir, { recursive: true });
      const stem = only === '' ? 'bridge' : `bridge-${only}`;
      writeFileSync(resolve(dir, `${stem}.txt`), lines.join('\n') + '\n');
      writeFileSync(
        resolve(dir, `${stem}.json`),
        JSON.stringify({ boards: summaries, ALL: all }, null, 2) + '\n',
      );
      if (only !== '') {
        writeFileSync(resolve(dir, `${stem}-stations.txt`), detail.join('\n') + '\n');
      }
    }
  });
});
