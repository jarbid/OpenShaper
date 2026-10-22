// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 exit check of one sample file (docs/design/board2.md §14 S6), shared
 * by the `convert.*.exit.test.ts` files (split so that vitest runs the
 * conversions on several workers). Test-only.
 */
import { expect } from 'vitest';
import { convertGeometry } from '../convert';
import { DEFAULT_CONVERT_OPTIONS as O } from '../params';
import { measureConversion } from './conversion-checks';
import type { ExitRun } from './conversion-checks';
import type { ClassicSample } from './samples';

/** Rounding allowance on a re-evaluated residual (z ≤ 20 cm, a few dozen flops). */
const ROUNDING = 1e-12;

export function runExit(sample: ClassicSample): ExitRun {
  const board = sample.load();
  const r = convertGeometry(board);
  if (!r.ok) throw new Error(`${sample.name}: ${r.issues.map((i) => i.message).join('; ')}`);
  return { geometry: r.value, measures: measureConversion(board, r.value, O), warnings: r.issues };
}

/**
 * Plan and lines within `lineTol` (fillet zones as predicted, within `lineTol`);
 * deck and bottom residual within `surfaceTol` outside the crease and tip
 * windows at the fitted rows (and within 2 × `surfaceTol` halfway between them,
 * §12.3's reason: the fit is verified where it was made); knife tips floored
 * (no station below `minRailHeight`).
 */
export function expectExit(name: string, run: ExitRun): void {
  const { geometry: g, measures: m } = run;
  const msg = (what: string): string => `${name}: ${what}`;
  expect(
    run.warnings.filter((i) => i.code === 'not-converged'),
    msg('warnings'),
  ).toEqual([]);
  expect(m.planToLoop, msg('classic outline → loop')).toBeLessThanOrEqual(O.lineTol);
  expect(m.loopToPlan, msg('loop → classic outline')).toBeLessThanOrEqual(O.lineTol);
  expect(m.filletMiss, msg('corner distance − predicted')).toBeLessThanOrEqual(O.lineTol);
  expect(m.rocker, msg('rocker')).toBeLessThanOrEqual(O.lineTol);
  expect(m.deckLine, msg('deck line')).toBeLessThanOrEqual(O.lineTol);
  expect(m.lineFilletExcess, msg('line fillet zones')).toBeLessThanOrEqual(O.lineTol);
  expect(m.judged, msg('judged samples')).toBeGreaterThan(5000);
  expect(m.deckResidual, msg('deck residual')).toBeLessThanOrEqual(O.surfaceTol + ROUNDING);
  expect(m.bottomResidual, msg('bottom residual')).toBeLessThanOrEqual(O.surfaceTol + ROUNDING);
  expect(m.deckResidualMid, msg('deck residual, mid rows')).toBeLessThanOrEqual(2 * O.surfaceTol);
  expect(m.bottomResidualMid, msg('bottom residual, mid rows')).toBeLessThanOrEqual(
    2 * O.surfaceTol,
  );
  expect(m.railHeightIssues, msg('rail heights')).toEqual([]);
  expect(g.railHeightMin, msg('smallest rail height')).toBeGreaterThanOrEqual(
    g.doc.build.minRailHeight,
  );
}
