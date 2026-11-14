// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails board's STEP export (`trim/step.ts`) on the study's sample boards, run on demand:
 *
 *   TRIM_STUDY=1 TRIM_OUT=<dir> [TRIM_ONLY=<part of a board's name>] [STEP_OCCT=1] \
 *     pnpm --filter @openshaper/board2 exec vitest run src/trim/step.measure.test.ts
 *
 * Each board, with its features, through `convertSections`, `buildRails` and `railsStep`: the deviation
 * (panels, strips), the passes, faces, splits and control points, the band edges' gap, the file's size
 * and the time, `checkBrep`, and with `STEP_OCCT=1` OCCT's verdict (one valid solid with the B-rep's
 * counts and no tolerance growth). Beside it, today's exporter (`boardStep` on the sections board): its
 * size and time. One table goes to `TRIM_OUT`. Nothing is gated: a board that fails says why in the table.
 *
 * The sample boards are third-party designs: nothing here is committed or printed beyond these numbers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBrep } from '@openshaper/geom';
import { describe, it } from 'vitest';
import { allBoards } from '../railproto/test-support/rail-samples';
import { boardStep } from '../step';
import { buildBoard } from '../surface';
import { convertSections } from './convert';
import { buildRails } from './native';
import { railsSolid, railsStep } from './step';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const mm = (cm: number): string => (cm * 10).toFixed(2);
const kb = (text: string): string => (text.length / 1024).toFixed(0);
const s1 = (ms: number): string => (ms / 1000).toFixed(1);

/** OCCT's verdict on a file: valid, one solid, the counts, and no tolerance growth past twice the uncertainty. */
type Verdict = (text: string, counts: readonly [number, number, number], uncertainty: number) => string; // prettier-ignore

async function occtVerdict(): Promise<Verdict | null> {
  if (process.env.STEP_OCCT !== '1') return null;
  const occt = await import('@openshaper/geom/testing/occt');
  const kernel = await occt.OcctKernel.init();
  return (text, [f, e, v], unc) =>
    occt.withCheckpoint(kernel, () => {
      const shape = kernel.importStep(text);
      const ok =
        kernel.isValid(shape) &&
        kernel.subShapeCount(shape, 'solid') === 1 &&
        kernel.subShapeCount(shape, 'shell') === 1 &&
        kernel.subShapeCount(shape, 'face') === f &&
        kernel.subShapeCount(shape, 'edge') === e &&
        kernel.subShapeCount(shape, 'vertex') === v;
      const grown = occt.maxShapeTolerance(kernel.toBREP(shape));
      return `${ok && grown <= 2 * unc ? 'valid' : 'FAIL'} (grown ${grown.toExponential(1)} mm)`;
    });
}

study('the rails STEP export on the sample boards', () => {
  it('writes the table', { timeout: 7_200_000 }, async () => {
    const only = process.env.TRIM_ONLY ?? '';
    const verdict = await occtVerdict();
    const lines: string[] = [
      'board | deviation mm (panels / strips) | passes (panels, strips) | faces | splits | controls | edge gap µm | file KB | time s | checkBrep | OCCT | today: file KB, time s',
      '--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---',
    ];
    for (const b of allBoards()) {
      if (only !== '' && !b.name.includes(only)) continue;
      const row: string[] = [b.name];
      try {
        const c = convertSections(b.doc);
        if (!c.ok) throw new Error(c.issues.map((i) => i.message).join('; '));
        const r = buildRails(c.value.board);
        if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
        const t0 = performance.now();
        const out = railsStep(r.value, { timestamp: '2026-01-01T00:00:00' });
        const ms = performance.now() - t0;
        const rep = out.report;
        const check = checkBrep(railsSolid(r.value).brep);
        row.push(
          `${mm(rep.deviation)} (${mm(rep.panelDeviation)} / ${mm(rep.stripDeviation)})`,
          `${rep.passes[0]}, ${rep.passes[1]}`,
          `${rep.faces}`,
          `${rep.splits}`,
          `${rep.controlCount}`,
          (rep.edgeGap * 1e4).toFixed(2),
          kb(out.text),
          s1(ms),
          check.ok ? 'ok' : `FAIL: ${check.issues[0]?.message ?? ''}`,
          verdict === null
            ? 'not run'
            : verdict(out.text, [out.stats.faces, out.stats.edges, out.stats.vertices], out.stats.uncertainty), // prettier-ignore
        );
      } catch (e) {
        row.push(`FAIL: ${(e as Error).message}`, '', '', '', '', '', '', '', '', '', '');
      }
      try {
        const built = buildBoard(b.doc, { check: false });
        if (!built.ok) throw new Error('sections build refused');
        const t0 = performance.now();
        const text = boardStep(built.value).text;
        row.push(`${kb(text)}, ${s1(performance.now() - t0)}`);
      } catch (e) {
        row.push(`FAIL: ${(e as Error).message}`);
      }
      lines.push(row.join(' | '));
    }
    const dir = process.env.TRIM_OUT ?? '';
    if (dir !== '') {
      mkdirSync(dir, { recursive: true });
      const stem = only === '' ? 'step' : `step-${only}`;
      writeFileSync(resolve(dir, `${stem}.md`), lines.join('\n') + '\n');
    }
  });
});
