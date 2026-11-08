// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Measurements for the tail-model study (`docs/design/tail-model.md`). Not an acceptance
 * test: it prints the tables of the design note. Run it on demand:
 *
 *   pnpm --filter @openshaper/board2 exec vitest run src/tailproto/measure.test.ts
 */
import { surfaceDerivatives } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { chainEval, compileChain } from '../chain';
import { frameAt, makeFrame, outlineParam } from '../frame';
import type { PlanFrame } from '../frame';
import { MIN_CHORD_ANGLE } from '../params';
import type { BoardSolid } from '../step';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import { boardSet, surfaceMove } from '../test-support/board-set';
import { meshBoard } from '../mesh';
import type { BoardDoc } from '../types';
import { chordAngle, normalBreakdown, normalMapFactory, smoothMapFactory } from './maps';
import { PROTO_ANGLE_SAMPLES } from './proto-params';

const deg = (r: number): number => (r * 180) / Math.PI;

const build = (doc: BoardDoc, mode: 'zone' | 'smooth' | 'normal'): BuiltBoard => {
  const chordMap =
    mode === 'smooth'
      ? smoothMapFactory(MIN_CHORD_ANGLE)
      : mode === 'normal'
        ? normalMapFactory
        : undefined;
  const r = buildBoard(doc, { check: false, chordMap });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

const angleDeg = (a: [number, number, number], b: [number, number, number]): number => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c = dot / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

/** step.test.ts's `foldExcess`, copied so the study does not import a test file. */
export function foldExcess(built: BuiltBoard, solid: BoardSolid, v: 0 | 1, from: number, to: number) {
  const ev = createEvaluator(built);
  const mirror = built.doc.symmetry === 'mirror';
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const evDir = (side: 0 | 1, s: number): [number, number, number] => {
    ev.row(side, solid.xiOf(s), 0);
    ev.eval(v, 0, a);
    ev.eval(v === 0 ? 1e-6 : 1 - 1e-6, 0, b);
    const k = v === 0 ? 1 : -1;
    return [k * (b[0]! - a[0]!), k * (b[1]! - a[1]!), k * (b[2]! - a[2]!)];
  };
  let worst = 0;
  let at = 0;
  for (let k = 0; k <= 300; k++) {
    const s = from + ((to - from) * k) / 300;
    const p = surfaceDerivatives(solid.plus, s, v, 1).Sv;
    const m = surfaceDerivatives(solid.minus, s, v, 1).Sv;
    const step = angleDeg([p.x, p.y, p.z], [-m.x, -m.y, -m.z]);
    const ep = evDir(0, s);
    const em = evDir(mirror ? 0 : 1, s);
    const emm: [number, number, number] = mirror ? [em[0], -em[1], em[2]] : em;
    const exact = angleDeg(ep, [-emm[0], -emm[1], -emm[2]]);
    if (Math.abs(step - exact) > worst) {
      worst = Math.abs(step - exact);
      at = s;
    }
  }
  return { worst, at };
}

/** Median and p95 of a timed closure over `n` runs, ms. */
function timed(n: number, f: () => void): { median: number; p95: number } {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { median: ts[ts.length >> 1]!, p95: ts[Math.min(ts.length - 1, Math.floor(0.95 * ts.length))]! };
}

/** The swallow made asymmetric (step.test.ts's case, dv = 0.06). */
const asymmetricSwallow = (dv: number): BoardDoc => {
  const d = swallowBoard();
  const stations = d.stations.map((st) => {
    const m = structuredClone(st.plus) as unknown as { chain: { knots: { p: [number, number]; in: [number, number]; out: [number, number] }[] }; apex: number }; // prettier-ignore
    const k = m.chain.knots[m.apex]!;
    for (const q of [k.p, k.in, k.out]) q[1] += dv;
    return { ...st, minus: m as unknown as typeof st.plus };
  });
  return { ...d, symmetry: 'asymmetric', outline: { plus: d.outline.plus, minus: d.outline.plus }, stations }; // prettier-ignore
};

const SET = boardSet();
const named = (n: string): BoardDoc => SET.find((b) => b.name === n)!.doc;
const NOTCHED: readonly { name: string; doc: BoardDoc }[] = [
  { name: 'swallow', doc: swallowBoard() },
  { name: 'fish', doc: fishBoard() },
  { name: 'classic swallow', doc: named('classic swallow') },
  { name: 'classic fish', doc: named('classic fish') },
  { name: 'asymmetric swallow', doc: asymmetricSwallow(0.06) },
];
const STANDARD: readonly { name: string; doc: BoardDoc }[] = [
  { name: 'shortboard', doc: named('shortboard') },
  { name: 'funboard', doc: named('funboard') },
  { name: 'longboard', doc: named('longboard') },
  { name: 'asymmetric', doc: asymmetricBoard() },
];

describe('tail model study', () => {
  it('A. option D: chord map smoothness, build report, surface move, mesh cost', () => {
    const rows: string[] = [];
    for (const { name, doc } of NOTCHED) {
      const z = build(doc, 'zone');
      const s = build(doc, 'smooth');
      const chain = compileChain(doc.outline.plus);
      const fz = makeFrame(chain, z.doc.tail);
      const fs = makeFrame(chain, s.doc.tail, smoothMapFactory(MIN_CHORD_ANGLE));
      const d = chain.c[0]!;
      let minZ = Infinity;
      let minS = Infinity;
      const zone = z.doc.tail.kind === 'notched' ? z.doc.tail.zone : 0;
      for (let i = 1; i <= PROTO_ANGLE_SAMPLES; i++) {
        const xi = d + (zone * i) / PROTO_ANGLE_SAMPLES;
        minZ = Math.min(minZ, deg(frameChordAngle(fz, xi)));
        minS = Math.min(minS, deg(chordAngle(chain, fs.map!, xi)));
      }
      const mz = meshBoard(z);
      const ms = meshBoard(s);
      const tz = timed(7, () => meshBoard(build(doc, 'zone')));
      const ts = timed(7, () => meshBoard(build(doc, 'smooth')));
      rows.push(
        [
          name,
          `d=${d.toFixed(1)} zone=${zone}`,
          `fit ${z.report.stationFitError.toFixed(4)} -> ${s.report.stationFitError.toFixed(4)}`,
          `normal ${deg(z.report.stationNormalError).toFixed(2)} -> ${deg(s.report.stationNormalError).toFixed(2)}`,
          `angle ${minZ.toFixed(1)} -> ${minS.toFixed(1)}`,
          `move ${(10 * surfaceMove(z, s)).toFixed(2)} mm`,
          `verts ${mz.positions.length / 3} -> ${ms.positions.length / 3}`,
          `build+mesh ${tz.median.toFixed(1)}/${tz.p95.toFixed(1)} -> ${ts.median.toFixed(1)}/${ts.p95.toFixed(1)} ms`,
        ].join(' | '),
      );
    }
    console.log('\n[A] option D on notched boards\n' + rows.join('\n'));
    expect(rows.length).toBe(NOTCHED.length);
  }, 600_000);

  it('B. option D: standard boards are untouched', () => {
    for (const { name, doc } of STANDARD) {
      const z = build(doc, 'zone');
      const s = build(doc, 'smooth');
      expect(s.sides[0].frame.map, name).toBe(null);
      expect(surfaceMove(z, s), name).toBe(0);
    }
  }, 300_000);

  it('C. option B: how far perpendicular chords move a standard board', () => {
    const rows: string[] = [];
    for (const { name, doc } of STANDARD) {
      const z = build(doc, 'zone');
      const n = build(doc, 'normal');
      const chain = compileChain(doc.outline.plus);
      const f = makeFrame(chain, doc.tail, normalMapFactory);
      // chord tilt from the x-plane at each station
      const tilts = doc.stations.map((st) => {
        const o = new Float64Array(6);
        const s = new Float64Array(3);
        f.map!.param(st.x, s);
        chainEval(chain, s[0]!, 0, o, 0);
        return deg(Math.atan2(o[0]! - st.x, Math.max(Math.abs(o[1]!), 1e-12)));
      });
      const mz = meshBoard(z);
      const mn = meshBoard(n);
      rows.push(
        [
          name,
          `move ${(10 * surfaceMove(z, n)).toFixed(1)} mm`,
          `tilt ${tilts.map((t) => t.toFixed(0)).join('/')} deg`,
          `fit ${z.report.stationFitError.toFixed(4)} -> ${n.report.stationFitError.toFixed(4)}`,
          `verts ${mz.positions.length / 3} -> ${mn.positions.length / 3}`,
        ].join(' | '),
      );
    }
    console.log('\n[C] option B on standard boards\n' + rows.join('\n'));
    expect(rows.length).toBe(STANDARD.length);
  }, 600_000);

  it('D. option B: where the perpendicular rule stops reaching the stringer', () => {
    const rows: string[] = [];
    for (const { name, doc } of NOTCHED) {
      const chain = compileChain(doc.outline.plus);
      const b = normalBreakdown(chain);
      const d = chain.c[0]!;
      // the outline x at which the inward perpendicular's foot first reaches the notch bottom
      const o = new Float64Array(6);
      let sCross = b.sTip;
      for (let i = 0; i <= 4000; i++) {
        const s = b.sTip + ((chain.segments - b.sTip) * i) / 4000;
        chainEval(chain, s, 1, o, 0);
        const foot = o[0]! + (o[1]! * o[3]!) / (o[2]! === 0 ? 1e-12 : o[2]!);
        if (foot >= d) {
          sCross = s;
          break;
        }
      }
      chainEval(chain, sCross, 0, o, 0);
      const zone = doc.tail.kind === 'notched' ? doc.tail.zone : 0;
      rows.push(
        `${name} | notch bottom x=${d.toFixed(1)} | today's zone ${zone} cm | perpendicular foot first reaches the stringer at outline x=${o[0]!.toFixed(1)}, y=${o[1]!.toFixed(1)} | fan needed over x in [0, ${o[0]!.toFixed(1)}]`,
      );
    }
    console.log('\n[D] option B breakdown on a notch\n' + rows.join('\n'));
    expect(rows.length).toBe(NOTCHED.length);
  });
});

/** How far a frame's own chord at ξ crosses the outline (radians); `validate.ts`'s measure. */
function frameChordAngle(f: PlanFrame, xi: number): number {
  const s = new Float64Array(3);
  const o = new Float64Array(6);
  const p = new Float64Array(6);
  outlineParam(f, xi, s);
  chainEval(f.chain, s[0]!, 1, o, 0);
  frameAt(f, xi, p);
  const wx = p[0]! - xi;
  const wy = p[1]!;
  const len = Math.hypot(wx, wy) * Math.hypot(o[2]!, o[3]!);
  if (!(len > 0)) return Infinity;
  return Math.asin(Math.min(1, Math.abs(wx * o[3]! - wy * o[2]!) / len));
}
