// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 and S7 exit checks of one sample file (docs/design/board2.md §14 S6,
 * S7), shared by the `convert.*.exit.test.ts` files (split so that vitest runs
 * the conversions on several workers). One `convertDetailed` per file serves
 * both: its geometry stage is `convertGeometry`'s result. Test-only.
 */
import { checkBrep, resolveTolerances } from '@openshaper/geom';
import type { BezierBoard } from '@openshaper/kernel';
import { expect } from 'vitest';
import { writeBoardStep } from '../../brep';
import { buildBoard } from '../../build';
import { reviveBoardDoc } from '../../doc';
import type { Board2Issue } from '../../types';
import { validateBoard } from '../../validate';
import { convertDetailed } from '../convert';
import type { DetailedConversion } from '../convert';
import { DEFAULT_CONVERT_OPTIONS as O } from '../params';
import { netOf } from '../rail';
import { CHORD, measureConversion } from './conversion-checks';
import type { ExitRun } from './conversion-checks';
import type { ClassicSample } from './samples';

/** A sample file through the whole converter: the S6 measures and the S7 result. */
export interface FullRun extends ExitRun {
  readonly board: BezierBoard;
  readonly detailed: DetailedConversion;
  /** Every warning of the conversion (geometry, band, build). */
  readonly issues: readonly Board2Issue[];
}

/**
 * §9.7 item 6: the document's band reproduces the fitted band. The identity is
 * exact in exact arithmetic (the build evaluates the laws and offsets at the
 * same columns the converter read them at); 1e-9 cm is the design's bound for
 * the rounding of the offset interpolation and the profile construction.
 */
export const IDENTITY_TOL = 1e-9;

/** Rounding allowance on a re-evaluated residual (z ≤ 20 cm, a few dozen flops). */
const ROUNDING = 1e-12;
/** §9.3: inside the fillet zones the distance to the classic outline is at most 1.1 × the prediction. */
const FILLET_ZONE_FACTOR = 1.1;
/** Rounding of the tip closed form against the converter's `|K − c| − r` (x ≤ 230 cm). */
const CLOSED_FORM_ROUNDING = 1e-12;

export function runExit(sample: ClassicSample): FullRun {
  const board = sample.load();
  const r = convertDetailed(board);
  if (!r.ok) throw new Error(`${sample.name}: ${r.issues.map((i) => i.message).join('; ')}`);
  const g = r.value.geometry;
  return {
    board,
    detailed: r.value,
    issues: r.issues,
    geometry: g,
    measures: measureConversion(board, g, O),
    warnings: r.value.geometryIssues,
  };
}

/**
 * Exit criterion 1 (§13.3) and the identity (S7): `convertClassic` succeeds
 * with warnings only, and those only `not-converged` (the band against
 * `surfaceTol`, the build's law fidelity: S7 as built); the document passes
 * `validateBoard` with no error, revives from its JSON unchanged, and builds
 * again from that JSON into the fitted band within {@link IDENTITY_TOL} (an
 * independent rebuild, not the converter's own measure, which is checked as
 * well); `checkBrep` of the built B-rep is ok with three faces, three edges,
 * two vertices and a positive volume; `writeBoardStep` writes it; the input
 * board is unchanged.
 */
export function expectS7Exit(name: string, run: FullRun, fresh: BezierBoard): void {
  const msg = (what: string): string => `${name}: ${what}`;
  const { conversion, rail } = run.detailed;
  const { doc, built, report } = conversion;
  expect(run.board, msg('input unchanged')).toEqual(fresh);
  expect(
    run.issues.filter((i) => i.severity === 'error' || i.code !== 'not-converged'),
    msg('warnings other than not-converged'),
  ).toEqual([]);
  expect(
    validateBoard(doc).filter((i) => i.severity === 'error'),
    msg('validateBoard'),
  ).toEqual([]);
  const json = JSON.parse(JSON.stringify(doc)) as unknown;
  const revived = reviveBoardDoc(json);
  expect(revived.ok, msg('revive')).toBe(true);
  if (!revived.ok) return;
  expect(revived.value, msg('JSON round trip')).toEqual(doc);
  const again = buildBoard(revived.value);
  expect(again.ok, msg('rebuild')).toBe(true);
  if (!again.ok) return;
  let identity = 0;
  const a = netOf(again.value.band);
  expect(a.length, msg('rebuild columns')).toBe(rail.fitted.length);
  for (let k = 0; k < a.length; k++)
    identity = Math.max(identity, Math.abs(a[k]! - rail.fitted[k]!));
  expect(identity, msg('factorisation identity (rebuilt)')).toBeLessThanOrEqual(IDENTITY_TOL);
  expect(report.factorisationError, msg('factorisation identity (report)')).toBeLessThanOrEqual(
    IDENTITY_TOL,
  );
  const check = checkBrep(built.brep, resolveTolerances(doc.build.tolerances));
  expect(check.ok, msg(`checkBrep ${JSON.stringify(check.issues)}`)).toBe(true);
  expect([check.euler.F, check.euler.E, check.euler.V], msg('B-rep counts')).toEqual([3, 3, 2]);
  expect(check.signedVolume, msg('outward volume')).toBeGreaterThan(0);
  const step = writeBoardStep(built);
  expect(step.text.startsWith('ISO-10303-21;'), msg('STEP')).toBe(true);
  expect([step.stats.faces, step.stats.edges, step.stats.vertices], msg('STEP counts')).toEqual([
    3, 3, 2,
  ]);
  for (const v of [report.bandError, report.band.allMax, report.band.ratio]) {
    expect(Number.isFinite(v), msg('report finite')).toBe(true);
  }
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
