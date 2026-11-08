// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Option C of the tail-model study (`docs/design/tail-model.md`): today's chord map with a
 * longer notch zone. Tests the hypothesis that the STEP fold at the end of the zone is set by
 * how fast the fan's chords turn, not by the smoothness class of the join.
 *
 *   TAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/tailproto/zone.measure.test.ts
 */
import { checkBrep } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { meshBoard } from '../mesh';
import { boardSolid, boardStep } from '../step';
import { buildBoard } from '../surface';
import type { BuiltBoard } from '../surface';
import { fishBoard, swallowBoard } from '../testing';
import { validateBoard } from '../validate';
import { hasErrors } from '../issues';
import type { BoardDoc } from '../types';
import { foldAt } from './fold';

const build = (doc: BoardDoc): BuiltBoard => {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

const withZone = (doc: BoardDoc, zone: number): BoardDoc => ({
  ...doc,
  tail: { kind: 'notched', zone },
});

const CASES: readonly { name: string; doc: BoardDoc; zones: readonly number[] }[] = [
  { name: 'swallow', doc: swallowBoard(), zones: [24, 32, 44, 60, 80] },
  { name: 'fish', doc: fishBoard(), zones: [18, 26, 36, 50, 70] },
];

// Study runs only on demand: TAIL_STUDY=1 keeps it out of the package's suite.
const study = describe.skipIf(process.env.TAIL_STUDY !== '1');

study('tail model: zone length', () => {
  it('fold, deviation, size and mesh against the zone length', () => {
    const rows: string[] = [];
    for (const { name, doc: base, zones } of CASES) {
      for (const zone of zones) {
        const doc = withZone(base, zone);
        const v = validateBoard(doc);
        if (hasErrors(v)) {
          rows.push(`${name} zone ${zone} | REFUSED: ${v.map((i) => i.code).join(',')}`);
          console.log(rows[rows.length - 1]);
          continue;
        }
        const built = build(doc);
        const mesh = meshBoard(built);
        const t0 = performance.now();
        const solid = boardSolid(built);
        const ms = performance.now() - t0;
        const text = boardStep(built, { name });
        const brep = checkBrep(solid.brep);
        const fb = foldAt(built, solid, 0, 0.03, 0.97);
        const fd = foldAt(built, solid, 1, 0.03, 0.97);
        rows.push(
          [
            `${name} zone ${zone}`,
            `dev ${(10 * solid.report.deviation).toFixed(2)} mm`,
            `fold ${fb.worst.toFixed(3)} @s=${fb.at.toFixed(3)} / ${fd.worst.toFixed(3)}`,
            `ctl ${solid.report.controlCount[0]}x${solid.report.controlCount[1]}`,
            `passes ${solid.report.passes}`,
            `${(text.text.length / 1024).toFixed(0)} KB`,
            `${ms.toFixed(0)} ms`,
            `verts ${mesh.positions.length / 3}`,
            `brep ${brep.ok ? 'ok' : 'FAIL'}`,
          ].join(' | '),
        );
        console.log(rows[rows.length - 1]);
      }
    }
    console.log('\n[F] zone length\n' + rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 1_800_000);
});
