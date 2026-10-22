// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 exit check of one sample file (docs/design/board2.md §14 S6), shared
 * by the `convert.*.exit.test.ts` files (split so that vitest runs the
 * conversions on several workers). Test-only.
 */
import { expect } from 'vitest';
import { convertGeometry } from '../convert';
import { DEFAULT_CONVERT_OPTIONS as O } from '../params';
import { CHORD, measureConversion } from './conversion-checks';
import type { ExitRun } from './conversion-checks';
import type { ClassicSample } from './samples';

/** Rounding allowance on a re-evaluated residual (z ≤ 20 cm, a few dozen flops). */
const ROUNDING = 1e-12;
/** §9.3: inside the fillet zones the distance to the classic outline is at most 1.1 × the prediction. */
const FILLET_ZONE_FACTOR = 1.1;
/** Rounding of the tip closed form against the converter's `|K − c| − r` (x ≤ 230 cm). */
const CLOSED_FORM_ROUNDING = 1e-12;

export function runExit(sample: ClassicSample): ExitRun {
  const board = sample.load();
  const r = convertGeometry(board);
  if (!r.ok) throw new Error(`${sample.name}: ${r.issues.map((i) => i.message).join('; ')}`);
  return { geometry: r.value, measures: measureConversion(board, r.value, O), warnings: r.issues };
}

/**
 * Plan and lines within `lineTol` outside the fillet zones; inside them the
 * loop and the lines within `lineTol` of the fillet arcs both ways, the loop
 * within 1.1 × the predicted deviation of the classic outline both ways (§9.3),
 * each corner's distance to the loop its predicted deviation within `lineTol`,
 * the arcs themselves checked against the classic (circles inscribed, straight
 * pointed tips at the closed form), and the converter's own fillet-zone errors
 * within `lineTol`;
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
  expect(m.plan.planToLoop, msg('classic outline → loop')).toBeLessThanOrEqual(O.lineTol);
  expect(m.plan.loopToPlan, msg('loop → classic outline')).toBeLessThanOrEqual(O.lineTol);
  expect(m.plan.filletMiss, msg('corner distance − predicted')).toBeLessThanOrEqual(O.lineTol);
  expect(m.plan.arcToLoop, msg('fillet arcs → loop')).toBeLessThanOrEqual(O.lineTol);
  expect(m.plan.zoneLoopToFilleted, msg('loop → fillet arcs')).toBeLessThanOrEqual(O.lineTol);
  expect(m.plan.zoneRatio, msg('fillet zones, × predicted (§9.3)')).toBeLessThanOrEqual(
    FILLET_ZONE_FACTOR,
  );
  expect(m.plan.tipFormulaMiss, msg('tip fillets, closed form')).toBeLessThanOrEqual(
    CLOSED_FORM_ROUNDING,
  );
  expect(m.plan.filletTangency, msg('fillet circles inscribed')).toBeLessThanOrEqual(CHORD);
  expect(g.plan.filletError, msg('plan fit in fillet zones')).toBeLessThanOrEqual(O.lineTol);
  expect(g.rocker.filletError, msg('rocker fit in fillet zones')).toBeLessThanOrEqual(O.lineTol);
  expect(g.deckLine.filletError, msg('deck line fit in fillet zones')).toBeLessThanOrEqual(
    O.lineTol,
  );
  expect(m.lineArcError, msg('line fillet arcs → line')).toBeLessThanOrEqual(O.lineTol);
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
