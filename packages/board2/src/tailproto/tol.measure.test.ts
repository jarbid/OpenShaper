// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Is the notch fold a property of the tail model or of the STEP fitter? Today's map,
 * today's documents, the fit's tolerance tightened. If the fold falls with the tolerance,
 * it is the fit's resolution, not the notch zone (`docs/design/tail-model.md`).
 *
 *   pnpm --filter @openshaper/board2 exec vitest run src/tailproto/tol.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { boardSolid, boardStep } from '../step';
import { buildBoard } from '../surface';
import { fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { foldAt } from './fold';

const build = (doc: BoardDoc) => {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

const CASES: readonly { name: string; doc: BoardDoc }[] = [
  { name: 'swallow', doc: swallowBoard() },
  { name: 'fish', doc: fishBoard() },
];
const TOLS = [0.05, 0.035, 0.025, 0.015];

describe('tail model: fit tolerance', () => {
  it('fold against the STEP fit tolerance', () => {
    const rows: string[] = [];
    for (const { name, doc } of CASES) {
      const built = build(doc);
      for (const tolerance of TOLS) {
        const t0 = performance.now();
        const solid = boardSolid(built, { tolerance });
        const ms = performance.now() - t0;
        const text = boardStep(built, { name });
        const fb = foldAt(built, solid, 0, 0.03, 0.97);
        rows.push(
          [
            `${name} tol ${(10 * tolerance).toFixed(2)} mm`,
            `dev ${(10 * solid.report.deviation).toFixed(3)} mm`,
            `fold ${fb.worst.toFixed(3)} @s=${fb.at.toFixed(3)}`,
            `ctl ${solid.report.controlCount[0]}x${solid.report.controlCount[1]}`,
            `passes ${solid.report.passes}`,
            `${(text.text.length / 1024).toFixed(0)} KB`,
            `${ms.toFixed(0)} ms`,
          ].join(' | '),
        );
        console.log(rows[rows.length - 1]);
      }
    }
    console.log('\n[G] fit tolerance\n' + rows.join('\n'));
    expect(rows.length).toBe(CASES.length * TOLS.length);
  }, 1_800_000);
});
