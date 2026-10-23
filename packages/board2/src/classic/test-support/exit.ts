// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 and S7 exit checks of one sample file (docs/design/board2.md §14 S6,
 * S7), shared by the `convert.*.exit.test.ts` files (split so that vitest runs
 * the conversions on several workers). One `convertDetailed` per file serves
 * both: its geometry stage is `convertGeometry`'s result. Test-only.
 */
import { checkBrep, curvePoint, resolveTolerances } from '@openshaper/geom';
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

/**
 * The S7 exit's characterization (review of S7): per sample file, the values
 * measured when these bounds were set (docs/design/board2.md, S7 as built,
 * "Measured"), checked within {@link CHARACTERIZATION_MARGIN} of them. They pin
 * what the converter achieves today, so a change that makes the band fit or the
 * law extraction worse fails here; they are **not** accuracy targets
 * (`surfaceTol` and `lawTolerance` are, and both are missed and reported).
 *
 * - `band`: the band's largest projected distance over its judged samples (cm,
 *   `ConversionReport.bandError`);
 * - `lawFidelity`: the build's worst law-fidelity ratio, on the law-only band
 *   (the value of its `not-converged` warning; 0 where there is none);
 * - `crease`: the build's tuck-crease error on the law-only band (radians;
 *   exit criterion 5, "tuck crease = law"). On the band with offsets it was
 *   0.4–0.7 rad. `band.test.ts` bounds it by `lawTolerance.edgeHardness ·
 *   max |φ_chord|` where every lane meets its tolerance; here fidelity is
 *   missed, and scaling that bound by the miss does not hold on three files
 *   (the chord angle's own error, set by the other lanes, dominates where
 *   φ_chord is small), so the crease is characterized too.
 */
export const S7_MEASURED: Readonly<
  Record<string, { band: number; lawFidelity: number; crease: number }>
> = Object.freeze({
  'shortboard.brd': { band: 0.0591, lawFidelity: 3.46, crease: 0.00218 },
  'funboard.brd': { band: 0.076, lawFidelity: 2.37, crease: 0.00213 },
  'longboard.brd': { band: 0.0688, lawFidelity: 5.11, crease: 0.00242 },
  'synthetic-clean-6x22x2-75.s3dx': { band: 0.1511, lawFidelity: 0, crease: 0.000154 },
  'synthetic-degenerate-section.s3dx': { band: 0.1686, lawFidelity: 2.18, crease: 0.00905 },
  'synthetic-fallback-outline-5x10.s3dx': { band: 0.1367, lawFidelity: 0, crease: 0.000273 },
  'synthetic-rocker-absolute-deck.s3dx': { band: 0.8846, lawFidelity: 1.73, crease: 0.00146 },
  'synthetic-rocker-thickness-deck.s3dx': { band: 0.8838, lawFidelity: 1.75, crease: 0.00145 },
  'synthetic-stringer-fold-a.s3dx': { band: 0.1339, lawFidelity: 1.22, crease: 0.000597 },
  'synthetic-stringer-fold-b.s3dx': { band: 0.1293, lawFidelity: 1.14, crease: 0.000666 },
});

/** Allowance over {@link S7_MEASURED}: room for rounding across platforms, not for a regression. */
export const CHARACTERIZATION_MARGIN = 1.2;

/**
 * Where the law-only band may miss law fidelity: within this distance in x of
 * either end (cm; characterization like {@link S7_MEASURED}). The fit's basis
 * was refined for the initial laws, and the final apex law and measured lanes
 * change fastest towards the tips: measured 1.4–4.1 cm from an end on six
 * files, 17.8 cm on the two rocker files (one real station; S7 as built).
 */
export const LAW_FIDELITY_TIP_ZONE = 20;

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

/** Every object and array inside `x` is frozen. */
function deepFrozen(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return true;
  return Object.isFrozen(x) && Object.values(x).every(deepFrozen);
}

/** A warning the S7 exit expects, by code and message; `check` adds its bound and location. */
interface ExpectedWarning {
  readonly what: string;
  readonly code: Board2Issue['code'];
  readonly message: RegExp;
}

const NUM = String.raw`[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;
const BAND_WARNING: ExpectedWarning = {
  what: 'the band fit above surfaceTol (rail.ts, bandIssues)',
  code: 'not-converged',
  message: new RegExp(
    `^rail band \\(judged samples\\): distance ${NUM} cm above the target ${NUM} cm$`,
  ),
};
const FIDELITY_WARNING: ExpectedWarning = {
  what: 'law fidelity of the law-only band near a tip (band.ts, buildBand)',
  code: 'not-converged',
  message: new RegExp(
    `^band refinement stopped after 0 pass\\(es\\) with law fidelity at ${NUM} × its target near u = ${NUM}$`,
  ),
};

const matches = (i: Board2Issue, w: ExpectedWarning): boolean =>
  i.severity === 'warning' && i.code === w.code && w.message.test(i.message);

/**
 * Exit criterion 1 (§13.3) and the identity (S7): `convertClassic` succeeds
 * with warnings only, each one of the expected kinds (the band against
 * `surfaceTol`, within its characterization bound; the law-only band's law
 * fidelity, within its bound and near a tip: review of S7); the document passes
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
  expect(deepFrozen(doc), msg('the document is deep-frozen')).toBe(true);
  const measured = S7_MEASURED[name.split('/').pop()!];
  expect(measured, msg('characterization entry')).toBeDefined();
  if (measured === undefined) return;
  expect(
    run.issues.filter((i) => !matches(i, BAND_WARNING) && !matches(i, FIDELITY_WARNING)),
    msg('unexpected warnings'),
  ).toEqual([]);
  // The band: characterization (not accuracy), and warned exactly when above surfaceTol.
  expect(report.bandError, msg('band error (characterization)')).toBeLessThanOrEqual(
    CHARACTERIZATION_MARGIN * measured.band,
  );
  expect(
    run.issues.filter((i) => matches(i, BAND_WARNING)).length,
    msg('band warning iff above surfaceTol'),
  ).toBe(report.bandError > O.surfaceTol ? 1 : 0);
  // Law fidelity on the law-only band: bounded, and missed only near a tip.
  const fidelity = run.issues.filter((i) => matches(i, FIDELITY_WARNING));
  expect(fidelity.length, msg('one fidelity warning at most')).toBeLessThanOrEqual(1);
  let fidelityRatio = 0;
  for (const w of fidelity) {
    fidelityRatio = w.value!;
    expect(fidelityRatio, msg('law fidelity ratio (characterization)')).toBeLessThanOrEqual(
      CHARACTERIZATION_MARGIN * measured.lawFidelity,
    );
    const x = curvePoint(built.plan, w.at!.u!).x;
    const length = run.geometry.length;
    expect(Math.min(x, length - x), msg(`fidelity miss near a tip (x ${x})`)).toBeLessThanOrEqual(
      LAW_FIDELITY_TIP_ZONE,
    );
  }
  // Exit criterion 5, tuck crease = law, on the law-only band (review of S7).
  expect(
    built.report.tuckCreaseError,
    msg('tuck crease = law (law-only band)'),
  ).toBeLessThanOrEqual(CHARACTERIZATION_MARGIN * measured.crease);
  // The offsets' contribution: reported per row, never on the apex row (§6.1).
  const contribution = built.report.offsetContribution;
  expect(contribution.apex, msg('offsets never move the apex row')).toBe(0);
  for (const v of Object.values(contribution))
    expect(Number.isFinite(v), msg('contribution')).toBe(true);
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
  expect(report.band.allMax, msg('all samples ≥ judged')).toBeGreaterThanOrEqual(report.bandError);
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
