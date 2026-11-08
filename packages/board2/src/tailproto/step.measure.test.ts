// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The headline measurement of the tail-model study (`docs/design/tail-model.md`): the STEP
 * export's worst fold along the stringer seams, with today's notch zone and with option D's
 * C-infinity chord map, plus the deviation, control counts, passes, size and time.
 *
 *   pnpm --filter @openshaper/board2 exec vitest run src/tailproto/step.measure.test.ts
 */
import { checkBrep } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { MIN_CHORD_ANGLE } from '../params';
import { boardSolid, boardStep } from '../step';
import { buildBoard } from '../surface';
import type { BuiltBoard } from '../surface';
import { fishBoard, swallowBoard } from '../testing';
import { boardSet } from '../test-support/board-set';
import type { BoardDoc } from '../types';
import { foldAt } from './fold';
import { smoothMapFactory } from './maps';

const build = (doc: BoardDoc, smooth: boolean): BuiltBoard => {
  const r = buildBoard(doc, {
    check: false,
    chordMap: smooth ? smoothMapFactory(MIN_CHORD_ANGLE) : undefined,
  });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

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

const BOARDS: readonly { name: string; doc: BoardDoc }[] = [
  { name: 'swallow', doc: swallowBoard() },
  { name: 'fish', doc: fishBoard() },
  { name: 'asymmetric swallow', doc: asymmetricSwallow(0.06) },
  { name: 'shortboard (control)', doc: named('shortboard') },
];

describe('tail model: STEP', () => {
  it('fold, deviation, size and time with today s zone and with option D', () => {
    const rows: string[] = [];
    for (const { name, doc } of BOARDS) {
      for (const smooth of [false, true]) {
        const built = build(doc, smooth);
        const t0 = performance.now();
        const solid = boardSolid(built);
        const ms = performance.now() - t0;
        const text = boardStep(built, { name });
        const brep = checkBrep(solid.brep);
        const fb = foldAt(built, solid, 0, 0.03, 0.97);
        const fd = foldAt(built, solid, 1, 0.03, 0.97);
        rows.push(
          [
            `${name}${smooth ? ' [D]' : ' [today]'}`,
            `dev ${(10 * solid.report.deviation).toFixed(2)} mm`,
            `fold ${fb.worst.toFixed(3)} @s=${fb.at.toFixed(3)} / ${fd.worst.toFixed(3)} @s=${fd.at.toFixed(3)}`,
            `ctl ${solid.report.controlCount[0]}x${solid.report.controlCount[1]}`,
            `passes ${solid.report.passes}`,
            `${(text.text.length / 1024).toFixed(0)} KB`,
            `${ms.toFixed(0)} ms`,
            `brep ${brep.ok ? 'ok' : brep.issues.map((i) => i.code).join(',')}`,
            `${solid.report.tail}/${solid.report.nose}`,
          ].join(' | '),
        );
        console.log(rows[rows.length - 1]);
      }
    }
    console.log('\n[E] STEP, today vs option D\n' + rows.join('\n'));
    expect(rows.length).toBe(2 * BOARDS.length);
  }, 1_800_000);
});
