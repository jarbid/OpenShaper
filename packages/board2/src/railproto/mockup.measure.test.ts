// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generator for the law-swept 3D mockup (`mockup.ts`): writes one payload holding, per
 * board, the law-swept surface, today's as-built surface on the same grid, `meshBoard`'s own
 * mesh, and the per-vertex signed deviation between the first two. Run on demand, like the
 * study's other measure scripts:
 *
 *   RAIL_MOCKUP=1 RAIL_MOCKUP_OUT=/path/to/dir \
 *     pnpm --filter @openshaper/board2 exec vitest run src/railproto/mockup.measure.test.ts
 *
 * The payload is data, not a document: it holds board geometry (the Shape3D boards are
 * third-party), so it is written outside the repository — `RAIL_MOCKUP_OUT`, or the system
 * temporary directory — and never committed. The viewer that reads it is scratch too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMockup, columnFractions } from './mockup';
import type { MockupBoard, MockupSide } from './mockup';
import { roughness } from './rail-laws';
import {
  MOCKUP_COLUMN_BIAS,
  MOCKUP_FIT_STATIONS,
  MOCKUP_HALF_COLUMNS,
  MOCKUP_LAW_DOF,
  MOCKUP_SWEEP_STATIONS,
} from './rail-params';
import { allBoards } from './test-support/rail-samples';
import type { StudyBoard } from './test-support/rail-samples';

const study = describe.skipIf(process.env.RAIL_MOCKUP !== '1');

const OUT = process.env.RAIL_MOCKUP_OUT ?? tmpdir();
/** `RAIL_MOCKUP_LAWDOF=3` runs the control: a law too poor to follow the board. */
const LAW_DOF = Number(process.env.RAIL_MOCKUP_LAWDOF ?? MOCKUP_LAW_DOF);
/**
 * `RAIL_MOCKUP_RIPPLE=0.02` (optionally with `RAIL_MOCKUP_RIPPLE_PERIODS`) is the
 * calibration run: a sine of that amplitude is added to both rho laws, so the viewer can be
 * shown a ripple of known size and the claim "there is none" can be given a scale.
 */
const RIPPLE = Number(process.env.RAIL_MOCKUP_RIPPLE ?? 0);
const RIPPLE_PERIODS = Number(process.env.RAIL_MOCKUP_RIPPLE_PERIODS ?? 12);

/** The boards worth looking at: the goldens, the synthetics, and the two known failures. */
const WANTED = [/DIAMOND_TWIN/i, /5\.8_x_20.*TRUSTHER/i];

function chosen(): StudyBoard[] {
  const all = allBoards();
  const out = all.filter((b) => b.group !== 'carlos');
  for (const re of WANTED) {
    const hit = all.find((b) => b.group === 'carlos' && re.test(b.name));
    if (hit !== undefined) out.push(hit);
  }
  const only = process.env.RAIL_MOCKUP_ONLY;
  return only === undefined ? out : out.filter((b) => new RegExp(only, 'i').test(b.name));
}

const b64 = (a: Float32Array | Uint32Array | Uint16Array): string =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** Mesh indices narrowed to 16 bits when they fit: a third of the payload is index data. */
const indices = (a: Uint32Array, vertices: number): { bits: 16 | 32; data: string } =>
  vertices <= 0xffff ? { bits: 16, data: b64(Uint16Array.from(a)) } : { bits: 32, data: b64(a) };

const mm = (cm: number): string => (cm * 10).toFixed(3);

/** Columns of a station that the conics carry, as a mask over the grid's columns. */
function blendMask(side: MockupSide, h: number, row: number): Uint8Array {
  const frac = columnFractions(h, MOCKUP_COLUMN_BIAS);
  const st = side.stations[row]!;
  const mask = new Uint8Array(side.cols);
  for (let j = 0; j <= h; j++) {
    if (!st.fallbackTuck && frac[j]! >= st.tangentTuck) mask[j] = 1;
    if (!st.fallbackRail && frac[j]! >= st.tangentRail) mask[2 * h - j] = 1;
  }
  return mask;
}

interface Stats {
  readonly worstMm: number;
  readonly medianMm: number;
  readonly p90Mm: number;
  readonly worstX: number;
  readonly fallbackStations: number;
  readonly blendVertices: number;
  /** Max and median over blend columns of the ripple the law surface adds, µm. */
  readonly devWobbleMax: number;
  readonly devWobbleMedian: number;
  /** Largest per-column ratio of law to engine third-difference wobble over blend columns. */
  readonly wobbleRatio: number;
  readonly wobbleLawMax: number;
  readonly wobbleEngineMax: number;
  readonly seamWobble: number;
  /** Fallback rows where a conic exists at a wider turn, and where none exists at all. */
  readonly fallbackConventionOnly: number;
  readonly fallbackNoConic: number;
  /** x/L band the fallbacks occupy, and how many fall above x/L 0.45. */
  readonly fallbackBand: readonly [number, number];
  readonly fallbackAboveMid: number;
  readonly rhoTuckRange: readonly [number, number];
  readonly rhoRailRange: readonly [number, number];
}

/**
 * Third-difference wobble of a per-row 3D polyline, µm: how jagged a seam is along x.
 *
 * `live[i]` marks the rows where the seam is real. At a fallback row there is no tangent
 * point and the line holds the apex instead, so a window straddling the boundary would read
 * that step — a few hundred µm — as seam roughness, which it is not.
 */
function lineWobble(line: Float32Array, live: readonly boolean[]): number {
  const n = line.length / 3;
  let sum = 0;
  let count = 0;
  for (let i = 1; i + 2 < n; i++) {
    if (!live[i - 1] || !live[i] || !live[i + 1] || !live[i + 2]) continue;
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const d =
        line[3 * (i + 2) + c]! -
        3 * line[3 * (i + 1) + c]! +
        3 * line[3 * i + c]! -
        line[3 * (i - 1) + c]!;
      s += d * d;
    }
    sum += Math.sqrt(s);
    count += 1;
  }
  return count > 0 ? (sum / count) * 10000 : 0;
}

function statsOf(board: MockupBoard, h: number): Stats {
  const devs: number[] = [];
  let worst = 0;
  let worstX = 0;
  let fallback = 0;
  let wl = 0;
  let we = 0;
  let ratio = 0;
  let seam = 0;
  const dw: number[] = [];
  const rhoT: number[] = [];
  const rhoR: number[] = [];
  let conventionOnly = 0;
  let noConic = 0;
  let aboveMid = 0;
  let bandLo = Infinity;
  let bandHi = -Infinity;
  for (const side of board.sides) {
    seam = Math.max(
      seam,
      lineWobble(
        side.tuckLine,
        side.stations.map((st) => !st.fallbackTuck),
      ),
      lineWobble(
        side.railLine,
        side.stations.map((st) => !st.fallbackRail),
      ),
    );
    for (let i = 0; i < side.rows; i++) {
      const st = side.stations[i]!;
      if (st.fallbackTuck || st.fallbackRail) {
        fallback += 1;
        const reachable =
          (st.fallbackTuck && st.blendFromTuck > 0) || (st.fallbackRail && st.blendFromRail > 0);
        if (reachable) conventionOnly += 1;
        else noConic += 1;
        const xl = st.x / board.length;
        bandLo = Math.min(bandLo, xl);
        bandHi = Math.max(bandHi, xl);
        if (xl > 0.45) aboveMid += 1;
      }
      if (side.side === 0) {
        rhoT.push(st.rhoTuck);
        rhoR.push(st.rhoRail);
      }
      const mask = blendMask(side, h, i);
      for (let j = 0; j < side.cols; j++) {
        if (mask[j] !== 1) continue;
        const d = Math.abs(side.dev[i * side.cols + j]!);
        devs.push(d);
        if (d > worst) {
          worst = d;
          worstX = st.x;
        }
        wl = Math.max(wl, side.wobbleLaw[j]!);
        we = Math.max(we, side.wobbleEngine[j]!);
        dw.push(side.devWobble[j]!);
        // A column where the engine barely wobbles makes the ratio meaningless, so only
        // columns with a real baseline are compared.
        if (side.wobbleEngine[j]! > 1) {
          ratio = Math.max(ratio, side.wobbleLaw[j]! / side.wobbleEngine[j]!);
        }
      }
    }
  }
  devs.sort((a, b) => a - b);
  dw.sort((a, b) => a - b);
  return {
    worstMm: worst * 10,
    medianMm: (devs[devs.length >> 1] ?? 0) * 10,
    p90Mm: (devs[Math.floor(devs.length * 0.9)] ?? 0) * 10,
    worstX,
    fallbackStations: fallback,
    blendVertices: devs.length,
    devWobbleMax: Math.max(0, ...dw),
    devWobbleMedian: dw[dw.length >> 1] ?? 0,
    wobbleRatio: ratio,
    wobbleLawMax: wl,
    wobbleEngineMax: we,
    seamWobble: seam,
    fallbackConventionOnly: conventionOnly,
    fallbackNoConic: noConic,
    fallbackBand: [bandLo === Infinity ? 0 : bandLo, bandHi === -Infinity ? 0 : bandHi],
    fallbackAboveMid: aboveMid,
    rhoTuckRange: [Math.min(...rhoT), Math.max(...rhoT)],
    rhoRailRange: [Math.min(...rhoR), Math.max(...rhoR)],
  };
}

study('law-swept mockup', () => {
  it(
    'builds the law-swept surface, the matched engine surface and the deviation between them',
    () => {
      const boards = chosen();
      expect(boards.length).toBeGreaterThan(0);
      const h = MOCKUP_HALF_COLUMNS;
      const payload: unknown[] = [];
      console.log(
        `\n### Law-swept mockup: ${MOCKUP_SWEEP_STATIONS} stations x ${2 * h + 1} columns, ` +
          `laws k=${LAW_DOF} fitted on ${MOCKUP_FIT_STATIONS} stations\n`,
      );
      console.log(
        '| board | per-station mm | swept worst mm | median mm | p90 mm | worst at x | fallback rows | added ripple µm (max / median) | law/engine wobble | wobble law / engine µm | seam µm | rho tuck | rho rail |',
      );
      console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const b of boards) {
        const t0 = Date.now();
        const m = buildMockup(b, {
          lawDof: LAW_DOF,
          rhoRipple: RIPPLE > 0 ? { amplitude: RIPPLE, periods: RIPPLE_PERIODS } : undefined,
        });
        const s = statsOf(m, h);
        console.log(
          `| ${m.name} | ${mm(m.perStationWorst)} | ${s.worstMm.toFixed(3)} | ` +
            `${s.medianMm.toFixed(3)} | ${s.p90Mm.toFixed(3)} | ` +
            `${s.worstX.toFixed(1)} (x/L ${(s.worstX / m.length).toFixed(2)}) | ` +
            `${s.fallbackStations}/${MOCKUP_SWEEP_STATIONS * m.sides.length} | ` +
            `${s.devWobbleMax.toFixed(2)} / ${s.devWobbleMedian.toFixed(2)} | ` +
            `${s.wobbleRatio.toFixed(2)} | ` +
            `${s.wobbleLawMax.toFixed(2)} / ${s.wobbleEngineMax.toFixed(2)} | ` +
            `${s.seamWobble.toFixed(2)} | ` +
            `${s.rhoTuckRange[0].toFixed(3)}–${s.rhoTuckRange[1].toFixed(3)} | ` +
            `${s.rhoRailRange[0].toFixed(3)}–${s.rhoRailRange[1].toFixed(3)} |`,
        );
        // Per-board detail for the write-up: where the fallbacks are, and how smooth the
        // seams and the laws are along the board.
        const side0 = m.sides[0]!;
        console.log(
          `  ${m.name}: fallback x/L ${s.fallbackBand[0].toFixed(3)}–${s.fallbackBand[1].toFixed(3)}, ` +
            `${s.fallbackConventionOnly} reachable at a wider turn, ${s.fallbackNoConic} with no conic at all, ` +
            `${s.fallbackAboveMid} above x/L 0.45` +
            `  rho-tuck roughness ${roughness(side0.stations.map((st) => st.rhoTuck)).toFixed(4)}` +
            `  tangent-fraction roughness ${roughness(side0.stations.map((st) => st.tangentTuck)).toFixed(4)}` +
            `  engine mesh ${m.engineMesh.triangleCount} tris` +
            `  ${((Date.now() - t0) / 1000).toFixed(1)} s`,
        );
        payload.push({
          name: m.name,
          group: m.group,
          length: m.length,
          x0: m.x0,
          x1: m.x1,
          symmetry: m.symmetry,
          lawTuck: { k: m.lawTuck.k, coef: m.lawTuck.coef },
          lawRail: { k: m.lawRail.k, coef: m.lawRail.coef },
          perStationWorstMm: m.perStationWorst * 10,
          stats: s,
          sides: m.sides.map((side) => ({
            side: side.side,
            rows: side.rows,
            cols: side.cols,
            law: b64(side.law),
            engine: b64(side.engine),
            dev: b64(side.dev),
            devWobble: b64(side.devWobble),
            tuckLine: b64(side.tuckLine),
            apexLine: b64(side.apexLine),
            railLine: b64(side.railLine),
            wobbleLaw: b64(side.wobbleLaw),
            wobbleEngine: b64(side.wobbleEngine),
            sagLaw: b64(side.sagLaw),
            sagEngine: b64(side.sagEngine),
            stations: side.stations,
          })),
          engineMesh: {
            positions: b64(m.engineMesh.positions),
            indices: indices(m.engineMesh.indices, m.engineMesh.positions.length / 3),
            volume: m.engineMesh.volume,
            triangleCount: m.engineMesh.triangleCount,
          },
        });
      }
      mkdirSync(OUT, { recursive: true });
      const path = resolve(OUT, 'rail-mockup.json');
      writeFileSync(
        path,
        JSON.stringify({
          generated: new Date().toISOString(),
          params: {
            sweepStations: MOCKUP_SWEEP_STATIONS,
            halfColumns: h,
            columnBias: MOCKUP_COLUMN_BIAS,
            fitStations: MOCKUP_FIT_STATIONS,
            lawDof: LAW_DOF,
          },
          columnFractions: Array.from(columnFractions(h, MOCKUP_COLUMN_BIAS)),
          boards: payload,
        }),
      );
      console.log(`\nwrote ${path}`);
    },
    1000 * 60 * 30,
  );
});
