// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The converter from the classic `BezierBoard`, part I (docs/design/board2.md
 * §9.1–§9.6, §9.8; step S6): sampling, the plan loop with fillets, the
 * stringer lines, the inset laws and the deck and bottom height fields.
 * `convertGeometry` returns the document "so far" (§9.7 item 1: constant
 * `DEFAULT_RAIL_LAWS` on the four profile lanes) and what every stage achieved;
 * step S7 adds the band fit, the law extraction and `convertClassic`.
 *
 * **Frame.** board2 x = classic x − `shift`, where `shift` is the tail
 * centre's x after filleting: 0 unless the classic tail is a pointed tip, whose
 * fillet moves the tail centre inwards (decision 3 puts the tail at x = 0).
 *
 * **Knife tips** (§9.6, §4). Where a station's rail height `D(E) − B(T)` is
 * below `minRailHeight` the deck is lifted by a function of x alone,
 * `Λ(x) = Σ_i λ_i N_i(u(x))` added to every control row (so the lift is
 * uniform across, keeps the deck bitwise symmetric and raises the deck line
 * with it): `λ_i` is the largest deficit of the violating stations whose `E.x`
 * lies in the support of `N_i`. As the `N_i` are non-negative and sum to 1,
 * `Λ(E.x) ≥` that station's deficit at every violating station, in one round
 * (at most `maxRefinePasses` rounds in all; the later ones only absorb
 * rounding). Before the lift the deck's u basis is refined (exactly) so that
 * the lift's support ends inside the tip zone: `degree + 1` knots between the
 * last violating station and the zone's edge. A violating station outside the
 * tip zone (the lift then reaches into the fitted deck) and a rail height still
 * short after the last round are reported as `rail-height` warnings. This
 * replaces §9.6's equality constraints (S6 deviation): at a tip the stations
 * crowd within millimetres of each other on a basis with centimetre spans, and
 * the stringer identity already fixes the deck at the tip centre, so pointwise
 * equalities are dependent and in general inconsistent.
 */
import { hasTailCutout } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import {
  controlPointsInto,
  createScratch,
  curveEvalInto,
  makeCurve,
  refineKnotsSurface,
  resolveTolerances,
  surfaceControlPoint,
} from '@openshaper/geom';
import type { ClampedCurve, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { bandContext, effectiveInsets, geomIssue, insetRadiusAt } from '../band/band';
import type { BandContext } from '../band/band';
import { bandColumns, stationBasis } from '../band/stations';
import { buildBoard } from '../build';
import { deepFreeze } from '../freeze';
import type { BandBasis } from '../band/stations';
import { heightFieldSurface, heightSampler } from '../height-field';
import { board2Err, board2Ok, makeIssue } from '../issues';
import { DEFAULT_BUILD_PARAMS, DEFAULT_RAIL_LAWS, RAIL_LANES } from '../params';
import { planCurve, planExtent, planPieces } from '../plan';
import { mirrorOverwriteCurve } from '../symmetry';
import type {
  Board2Issue,
  Board2Result,
  BoardDoc,
  HeightFieldJSON,
  JsonValue,
  LawCurve,
  RailLaws,
} from '../types';
import { netDistance, stationKeys, windowTest } from './extract';
import { fitField } from './fields';
import type { FieldData, FieldFit } from './fields';
import { rowClassifier } from './membership';
import { fitPlanLoop, fitStringerLine, loopData, planLoopJSON } from './lines';
import type { LineFit } from './lines';
import { filletLine, filletOutline, samplePiece } from './outline';
import type { FilletedOutline, OutlineFillet } from './outline';
import { DEFAULT_CONVERT_OPTIONS } from './params';
import {
  classicFloors,
  classicStations,
  creaseAngles,
  loftRowPositions,
  sampleLoft,
} from './sample';
import type { ClassicFloors, LoftSamples } from './sample';
import { bandIssues, fitRail, netOf } from './rail';
import type { RailStage } from './rail';
import type { Conversion, ConversionReport, ConvertOptions } from './types';

/** A fitted stringer line and its fillets. */
export interface LineReport {
  /** Largest vertical error outside fillet zones (the fit's own samples), cm. */
  readonly error: number;
  /** Largest error to the filleted curve inside fillet zones, cm. */
  readonly filletError: number;
  readonly fillets: readonly OutlineFillet[];
  readonly knots: number;
}

/** What `convertGeometry` produced and achieved (board2 coordinates unless stated). */
export interface ClassicGeometry {
  readonly doc: BoardDoc;
  /** board2 x = classic x − shift. */
  readonly shift: number;
  /** The classic floors (classic coordinates). */
  readonly floors: ClassicFloors;
  /** Real classic stations, board2 x. */
  readonly stations: readonly number[];
  /** The classic floor zones and the plan's length in board2 x, for the windows of §9.6. */
  readonly zones: readonly (readonly [number, number])[];
  readonly length: number;
  /** The loft samples (classic coordinates; §9.2), for the band fit (§9.7). */
  readonly loft: LoftSamples;
  readonly creases: readonly { readonly x: number; readonly angle: number }[];
  readonly plan: {
    /** Largest distance from a sample outside the fillet zones to the loop, cm. */
    readonly error: number;
    /** The same inside the fillet zones, to the filleted outline. */
    readonly filletError: number;
    readonly fillets: readonly OutlineFillet[];
    readonly knots: number;
    readonly passes: number;
  };
  readonly rocker: LineReport;
  readonly deckLine: LineReport;
  readonly deck: FieldReport;
  readonly bottom: FieldReport;
  /** Stations (board2 x of E) where the knife-tip lift was needed, and its largest value (cm). */
  readonly railHeightFloored: readonly number[];
  readonly floorLift: number;
  /** The smallest rail height `D(E) − B(T)` over the station basis's columns after the lift, cm. */
  readonly railHeightMin: number;
  readonly timings: { readonly [stage: string]: number };
}

export interface FieldReport {
  readonly maxResidual: number;
  readonly maxResidualAll: number;
  readonly ratio: number;
  readonly meets: boolean;
  readonly passes: number;
  readonly fits: number;
  readonly samples: number;
}

type V2 = readonly [number, number];

/** Samples of a filleted chain, with the fillet index of each (−1 outside the arcs). */
function sampleChain(f: FilletedOutline, spacing: number): { pts: V2[]; fz: number[] } {
  const pts: V2[] = [];
  const fz: number[] = [];
  f.pieces.forEach((p, i) => {
    const arc = f.arcs.find((a) => a.piece === i);
    const s = samplePiece(p, spacing);
    for (let k = pts.length === 0 ? 0 : 1; k < s.length; k++) {
      pts.push(s[k]!);
      fz.push(arc === undefined ? -1 : arc.fillet);
    }
  });
  return { pts, fz };
}

/** A constant half-domain law. */
function constantLaw(value: number): LawCurve {
  return {
    domain: 'half',
    keys: [
      { s: 0, value },
      { s: 0.5, value },
    ],
  };
}

/** A placeholder height field (z = 0) over the right extent: stage-5 curves read no surface. */
function placeholderField(
  x: readonly [number, number],
  y: readonly [number, number],
): HeightFieldJSON {
  return {
    degreeU: 3,
    degreeV: 3,
    knotsU: [0, 0, 0, 0, 1, 1, 1, 1],
    knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
    x,
    y,
    z: new Array<number>(16).fill(0),
  };
}

/**
 * The inset laws (§9.5): keys at every real station inside the board (σ on
 * the −y half), `fraction × half-width` clamped to `[minInset, κ ρ]`; tip keys
 * at σ = 0 and ½ with the smaller of the neighbouring key and `κ ρ(tip)`.
 */
function insetLaws(
  plan: PeriodicCurve<2>,
  stations: readonly number[],
  o: ConvertOptions,
  tol: Tolerances,
): { deck: LawCurve; tuck: LawCurve } {
  const b = DEFAULT_BUILD_PARAMS;
  const sc = createScratch({ maxDegree: plan.basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  const cap = (u: number): number => b.insetCurvatureFraction * insetRadiusAt(plan, u);
  const keys = stationKeys(plan, stations, tol).map((k) => {
    curveEvalInto(plan, k.u, 0, q, 0, sc);
    const half = -q[1]!;
    const limit = cap(k.u);
    const clamp = (w: number): number => Math.max(b.minInset, Math.min(w, limit));
    return { s: k.s, d: clamp(o.deckInsetFraction * half), t: clamp(o.tuckInsetFraction * half) };
  });
  const law = (pick: 'd' | 't'): LawCurve => {
    if (keys.length === 0) {
      const w = Math.max(b.minInset, Math.min(cap(0), cap(0.5)));
      return constantLaw(w);
    }
    const first = keys[0]![pick];
    const last = keys[keys.length - 1]![pick];
    return {
      domain: 'half',
      keys: [
        { s: 0, value: Math.max(b.minInset, Math.min(first, cap(0))) },
        ...keys.map((k) => ({ s: k.s, value: k[pick] })),
        { s: 0.5, value: Math.max(b.minInset, Math.min(last, cap(0.5))) },
      ],
    };
  };
  return { deck: law('d'), tuck: law('t') };
}

/**
 * The plan curve of an inset row moved outwards by `extra` (the trim-data
 * strip of §9.6): each column's inset point minus `extra · n̂`, on the station
 * basis, mirror-overwritten. `extra = 0` is `insetPlanCurve` itself.
 */
function insetRow(
  ctx: BandContext,
  b: BandBasis,
  row: 'deckEdge' | 'tuck',
  extra: number,
): PeriodicCurve<2> {
  const columns = bandColumns(b, ctx.arc);
  const n = b.basis.count;
  const apex = new Float64Array(n * 2);
  controlPointsInto(b.apexPlan, apex, 0);
  const pts = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = columns[i]!;
    const e = effectiveInsets(ctx, c.u, c.sigma);
    const inset = row === 'tuck' ? e.tuckInset : e.deckInset;
    // The strip stays in the inner half of the band (S6 deviation): never into the classic rail.
    const w = inset - Math.min(extra, inset / 2);
    pts[2 * i] = apex[2 * i]! + w * c.frame.inward.x;
    pts[2 * i + 1] = apex[2 * i + 1]! + w * c.frame.inward.y;
  }
  const curve = makeCurve({ dim: 2, basis: b.basis, points: pts }) as PeriodicCurve<2>;
  return b.pairing === null ? curve : mirrorOverwriteCurve(curve, b.pairing);
}

function issue(
  code: Board2Issue['code'],
  message: string,
  extra: Parameters<typeof makeIssue>[2] = {},
): Board2Issue {
  return makeIssue(code, message, extra);
}

/** Classic → board2 for everything but the band (module comment). */
export function convertGeometry(
  board: BezierBoard,
  optsIn: Partial<ConvertOptions> = {},
): Board2Result<ClassicGeometry> {
  const o: ConvertOptions = { ...DEFAULT_CONVERT_OPTIONS, ...optsIn };
  const build = DEFAULT_BUILD_PARAMS;
  const tol = resolveTolerances(build.tolerances);
  const timings: Record<string, number> = {};
  let clock = performance.now();
  const lap = (name: string): void => {
    const now = performance.now();
    timings[name] = now - clock;
    clock = now;
  };

  // §9.1 preconditions.
  if (hasTailCutout(board.outline)) {
    return board2Err([
      issue('unsupported-tail', 'the classic outline has a tail cutout (Phase 5)'),
    ]);
  }
  if (board.crossSections.length < 3) {
    return board2Err([
      issue(
        'too-few-sections',
        `a board needs a real cross-section; got ${board.crossSections.length} sections`,
      ),
    ]);
  }

  // §9.2 sampling.
  const floors = classicFloors(board);
  const creasesClassic = creaseAngles(board, floors, o);
  const loft = sampleLoft(board, loftRowPositions(board, floors, o), o);
  lap('sample');

  // §9.3 plan loop.
  let outline: FilletedOutline;
  try {
    outline = filletOutline(board.outline, o, tol);
  } catch (e) {
    return board2Err([issue('unsupported-tail', e instanceof Error ? e.message : String(e))]);
  }
  const half = sampleChain(outline, o.lineSampleSpacing);
  const shift = half.pts[0]![0];
  const halfPts: V2[] = half.pts.map((p, k) => [
    p[0] - shift,
    k === 0 || k === half.pts.length - 1 ? 0 : p[1],
  ]);
  const ld = loopData(halfPts, half.fz);
  const pf = fitPlanLoop(ld, o.lineTol, o.surfaceKnotSpacing.x, tol);
  if (!('curve' in pf)) {
    return board2Err([issue('geom', pf.message, pf.cause ? { cause: pf.cause } : {})]);
  }
  let planErr = 0;
  let planFilletErr = 0;
  for (let k = 0; k < pf.errors.length; k++) {
    if (ld.fillet[k]! < 0) planErr = Math.max(planErr, pf.errors[k]!);
    else planFilletErr = Math.max(planFilletErr, pf.errors[k]!);
  }
  const plan = planLoopJSON(pf.curve);
  const planC = planCurve(plan, tol);
  const ext = planExtent(planPieces(planC, tol));
  const extentX = [ext.xMin - build.planMargin, ext.xMax + build.planMargin] as const;
  const yHalf = Math.max(-ext.yMin, ext.yMax) + build.planMargin;
  const extentY = [-yHalf, yHalf] as const;
  lap('plan');

  // §9.4 stringer lines.
  const L = floors.length;
  const lineFit = (
    s: BezierBoard['bottom'],
  ): { fit: LineFit<ClampedCurve<1>>; report: LineReport } | Board2Issue => {
    let f: FilletedOutline;
    try {
      f = filletLine(s, [o.endGap, L - o.endGap], o, tol);
    } catch (e) {
      return issue('geom', e instanceof Error ? e.message : String(e));
    }
    const sm = sampleChain(f, o.lineSampleSpacing);
    const keep: number[] = [];
    sm.pts.forEach((p, k) => {
      const x = p[0] - shift;
      if (p[0] >= o.endGap && p[0] <= L - o.endGap && x >= extentX[0] && x <= extentX[1])
        keep.push(k);
    });
    const xs = Float64Array.from(keep.map((k) => sm.pts[k]![0] - shift));
    const zs = Float64Array.from(keep.map((k) => sm.pts[k]![1]));
    const fit = fitStringerLine(xs, zs, extentX, o.lineTol, o.surfaceKnotSpacing.x, tol);
    if (!('curve' in fit)) return issue('geom', fit.message, fit.cause ? { cause: fit.cause } : {});
    let err = 0;
    let filletErr = 0;
    keep.forEach((k, i) => {
      if (sm.fz[k]! < 0) err = Math.max(err, fit.errors[i]!);
      else filletErr = Math.max(filletErr, fit.errors[i]!);
    });
    const fillets = f.fillets.map((x) => ({ ...x, x: x.x - shift }));
    return {
      fit,
      report: { error: err, filletError: filletErr, fillets, knots: fit.knots.length },
    };
  };
  const rocker = lineFit(board.bottom);
  if ('code' in rocker) return board2Err([rocker]);
  const deckLine = lineFit(board.deck);
  if ('code' in deckLine) return board2Err([deckLine]);
  lap('lines');

  // §9.5 insets; the document so far (§9.7 item 1).
  const stations = classicStations(board).map((x) => x - shift);
  const insets = insetLaws(planC, stations, o, tol);
  const laws = {} as Record<(typeof RAIL_LANES)[number], LawCurve>;
  for (const lane of RAIL_LANES) laws[lane] = constantLaw(DEFAULT_RAIL_LAWS[lane]);
  laws.deckInset = insets.deck;
  laws.tuckInset = insets.tuck;
  const draft: BoardDoc = {
    format: 'openshaper.board2',
    version: 1,
    meta: { name: 'classic', source: 'classic' },
    symmetry: 'mirror-y',
    tail: { kind: 'standard' },
    plan,
    deck: placeholderField(extentX, extentY),
    bottom: placeholderField(extentX, extentY),
    laws: laws as RailLaws,
    offsets: { basis: null, rows: [] },
    features: [],
    build: JSON.parse(JSON.stringify(build)) as BoardDoc['build'],
  };
  let ctx: BandContext;
  let basis: BandBasis;
  try {
    ctx = bandContext(draft);
    basis = stationBasis(ctx.plan, ctx.arc, build, true, tol);
  } catch (e) {
    return board2Err([
      issue('geom', `station basis: ${e instanceof Error ? e.message : String(e)}`),
    ]);
  }
  const loops = {
    deckEdge: rowClassifier(insetRow(ctx, basis, 'deckEdge', 0), tol),
    deckStrip: rowClassifier(insetRow(ctx, basis, 'deckEdge', o.trimDataMargin), tol),
    tuck: rowClassifier(insetRow(ctx, basis, 'tuck', 0), tol),
    tuckStrip: rowClassifier(insetRow(ctx, basis, 'tuck', o.trimDataMargin), tol),
  };
  lap('insets');

  // §9.6 data: windows, membership.
  const length = ext.xMax;
  const zones = floors.zones.map(([a, b]) => [a - shift, b - shift] as const);
  const inWindow = windowTest(stations, zones, length, o);
  const nf = loft.fractions.length;
  // The turn of the ring polyline at ring point k of row r (radians), and
  // whether k is a crease there: a turn exceeding both turns two points away
  // by `cornerAngleMin` (the classic's ring ladder spreads a smooth turn over
  // its points; a section corner concentrates it in one or two of them).
  const ringTurn = (r: number, k: number): number => {
    if (k <= 0 || k >= nf - 1) return 0;
    const at = (j: number): readonly [number, number] => [loft.y[r * nf + j]!, loft.z[r * nf + j]!];
    const [y0, z0] = at(k - 1);
    const [y1, z1] = at(k);
    const [y2, z2] = at(k + 1);
    const ax = y1 - y0;
    const az = z1 - z0;
    const bx = y2 - y1;
    const bz = z2 - z1;
    return Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
  };
  const ringCrease = (r: number, k: number): boolean =>
    ringTurn(r, k) - Math.max(ringTurn(r, k - 2), ringTurn(r, k + 2)) >= o.cornerAngleMin;
  const collect = (side: 'deck' | 'bottom'): FieldData => {
    const strip = side === 'deck' ? loops.deckStrip : loops.tuckStrip;
    const face = side === 'deck' ? loops.deckEdge : loops.tuck;
    const pts: number[] = [];
    const judged: number[] = [];
    for (let r = 0; r < loft.x.length; r++) {
      const x = loft.x[r]! - shift;
      const a = loft.apex[r]!;
      const win = inWindow(x);
      const sc = strip.crossings(x);
      const fc = face.crossings(x);
      // From the stringer outwards: the bottom side ascends in k, the deck side descends.
      const ks: number[] = [];
      if (side === 'bottom') for (let k = 0; k < a; k++) ks.push(k);
      else for (let k = nf - 1; k > a; k--) ks.push(k);
      // S7 as built: the data stop where the classic leaves the face. The
      // strip outside the face pins the field's slope at its edge only while
      // the classic continues the face: it ends once the ring has turned by
      // `cornerAngleMin` from the last point inside (a hard edge at once, a
      // rail rolling away right at the edge within a few points). Inside the
      // face, within the strip's width of its edge, a classic section corner
      // (`ringCrease`) is the classic's own edge, which the inset law places
      // only approximately between stations: the samples past it are the
      // rail. A height field cannot follow either across the turn; its
      // refinement then does not end (a preset's tuck on the band mark).
      const faceEdge = fc.length > 0 ? fc[fc.length - 1]! : 0;
      const width = (sc.length > 0 ? sc[sc.length - 1]! : faceEdge) - faceEdge;
      let stop = false;
      let turned = 0;
      for (let e = 0; e < ks.length; e++) {
        const k = ks[e]!;
        const y = loft.y[r * nf + k]!;
        const z = loft.z[r * nf + k]!;
        const onStringer = !(y > 0);
        // The loops are mirror images, so the −y sample's membership is the +y one's.
        if (!strip.inside(sc, onStringer ? 0 : y)) continue;
        const inFace = face.inside(fc, onStringer ? 0 : y);
        if (e > 0 && !inFace) turned += ringTurn(r, ks[e - 1]!);
        if (e > 0 && y >= faceEdge - width && ringCrease(r, ks[e - 1]!)) stop = true;
        if (turned >= o.cornerAngleMin) stop = true;
        if (stop) continue;
        const j = !win && inFace ? 1 : 0;
        pts.push(x, onStringer ? 0 : y, z);
        judged.push(j);
        if (!onStringer) {
          pts.push(x, -y, z);
          judged.push(j);
        }
      }
    }
    return { points: Float64Array.from(pts), judged: Uint8Array.from(judged) };
  };
  const bottomData = collect('bottom');
  const deckData = collect('deck');
  lap('data');

  const field = (data: FieldData, line: ClampedCurve<1>, name: string): FieldFit | Board2Issue => {
    const r = fitField(data, extentX, extentY, line, o, tol);
    if ('message' in r)
      return issue('geom', `${name}: ${r.message}`, r.cause ? { cause: r.cause } : {});
    return r;
  };
  const bottomFit = field(bottomData, rocker.fit.curve, 'bottom');
  if ('code' in bottomFit) return board2Err([bottomFit]);
  lap('bottom');
  const deckFit = field(deckData, deckLine.fit.curve, 'deck');
  if ('code' in deckFit) return board2Err([deckFit]);
  lap('deck');

  // Knife tips (module comment).
  const floor = liftKnifeTips({ ...draft, deck: deckFit.field, bottom: bottomFit.field }, zones, o);
  lap('floor');

  const issues: Board2Issue[] = [
    ...convergenceIssues([
      { stage: 'plan loop', error: pf.maxError, target: o.lineTol },
      { stage: 'rocker', error: rocker.fit.maxError, target: o.lineTol },
      { stage: 'deck line', error: deckLine.fit.maxError, target: o.lineTol },
      { stage: 'bottom (judged samples)', error: bottomFit.maxResidual, target: o.surfaceTol },
      { stage: 'deck (judged samples)', error: deckFit.maxResidual, target: o.surfaceTol },
    ]),
    ...floor.issues,
  ];
  const doc: BoardDoc = { ...draft, deck: floor.deck, bottom: bottomFit.field };
  const fieldReport = (f: FieldFit, d: FieldData): FieldReport => ({
    maxResidual: f.maxResidual,
    maxResidualAll: f.maxResidualAll,
    ratio: f.ratio,
    meets: f.meets,
    passes: f.passes,
    fits: f.fits,
    samples: d.judged.length,
  });
  return board2Ok(
    {
      doc,
      shift,
      floors,
      stations,
      zones,
      length,
      loft,
      creases: creasesClassic.map((c) => ({ x: c.x - shift, angle: c.angle })),
      plan: {
        error: planErr,
        filletError: planFilletErr,
        fillets: outline.fillets.map((f) => ({ ...f, x: f.x - shift })),
        knots: pf.knots.length,
        passes: pf.passes,
      },
      rocker: rocker.report,
      deckLine: deckLine.report,
      deck: fieldReport(deckFit, deckData),
      bottom: fieldReport(bottomFit, bottomData),
      railHeightFloored: floor.floored,
      floorLift: floor.lift,
      railHeightMin: floor.minHeight,
      timings,
    },
    issues,
  );
}

/** A fit stage's achieved error and its target (cm). */
export interface StageError {
  readonly stage: string;
  readonly error: number;
  readonly target: number;
}

/**
 * A `not-converged` warning for every stage whose achieved error is above its
 * target: the plan loop and the stringer lines against `lineTol` (their fits
 * stop at `LINE_REFINE_PASSES` or when no failing span can be split), the
 * height fields' judged residual against `surfaceTol` (review of S6).
 */
export function convergenceIssues(stages: readonly StageError[]): Board2Issue[] {
  return stages
    .filter((s) => s.error > s.target)
    .map((s) =>
      issue('not-converged', `${s.stage}: error ${s.error} cm above the target ${s.target} cm`, {
        severity: 'warning',
        value: s.error,
      }),
    );
}

/** What the knife-tip lift did: the lifted deck, where, by how much, and the smallest rail height after it. */
export interface KnifeTipLift {
  readonly deck: HeightFieldJSON;
  /** x of the deck-edge points of the stations that needed it. */
  readonly floored: readonly number[];
  readonly lift: number;
  readonly minHeight: number;
  /**
   * `rail-height` warnings (review of S6): a violating station outside the tip
   * zone (the lift then reaches into the fitted deck), and a rail height still
   * below `minRailHeight` after `maxRefinePasses` rounds.
   */
  readonly issues: readonly Board2Issue[];
}

/** The distance from |x| to the next larger double. */
function doubleSpacing(x: number): number {
  const a = new Float64Array([Math.abs(x)]);
  const bits = new BigInt64Array(a.buffer);
  bits[0] = bits[0]! + 1n;
  return a[0]! - Math.abs(x);
}

/** The tip zone's inner edges: the tip windows widened by the classic floor zones that touch an end. */
function tipZoneEdges(
  zones: readonly (readonly [number, number])[],
  length: number,
  o: ConvertOptions,
): { tail: number; nose: number } {
  return {
    tail: Math.max(o.tipWindow, ...zones.filter(([a]) => a <= 0).map(([, b]) => b)),
    nose: Math.min(length - o.tipWindow, ...zones.filter(([, b]) => b >= length).map(([a]) => a)),
  };
}

/**
 * The knife-tip lift of the deck (module comment) on the station basis of
 * `doc`, at its `build.minRailHeight`. `zones` are the classic floor zones in
 * board2 x; with the tip windows they bound where the lift may reach.
 */
export function liftKnifeTips(
  doc: BoardDoc,
  zones: readonly (readonly [number, number])[],
  o: ConvertOptions,
): KnifeTipLift {
  const tol = resolveTolerances(doc.build.tolerances);
  const h = doc.build.minRailHeight;
  const ctx0 = bandContext(doc);
  const basis = stationBasis(ctx0.plan, ctx0.arc, doc.build, true, tol);
  const length = planExtent(planPieces(ctx0.plan, tol)).xMax;
  const columns = bandColumns(basis, ctx0.arc);
  const n = basis.basis.count;
  const apex = new Float64Array(2 * n);
  controlPointsInto(basis.apexPlan, apex, 0);
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  columns.forEach((c, i) => {
    const e = effectiveInsets(ctx0, c.u, c.sigma);
    ex[i] = apex[2 * i]! + e.deckInset * c.frame.inward.x;
    ey[i] = apex[2 * i + 1]! + e.deckInset * c.frame.inward.y;
    tx[i] = apex[2 * i]! + e.tuckInset * c.frame.inward.x;
    ty[i] = apex[2 * i + 1]! + e.tuckInset * c.frame.inward.y;
  });
  const bottomAt = heightSampler(heightFieldSurface(doc.bottom, 'mirror-y', tol), doc.bottom, tol);
  const floored = new Set<number>();
  const issues: Board2Issue[] = [];
  let deck: HeightFieldJSON = doc.deck;
  let lift = 0;
  let minHeight = Infinity;
  for (let round = 0; ; round++) {
    const deckAt = heightSampler(heightFieldSurface(deck, 'mirror-y', tol), deck, tol);
    const deficits: { x: number; d: number }[] = [];
    minHeight = Infinity;
    for (let i = 0; i < n; i++) {
      const height = deckAt(ex[i]!, ey[i]!).z - bottomAt(tx[i]!, ty[i]!).z;
      minHeight = Math.min(minHeight, height);
      if (height < h) deficits.push({ x: ex[i]!, d: h - height });
    }
    if (deficits.length === 0 || round >= o.maxRefinePasses) break;
    for (const f of deficits) floored.add(f.x);
    if (round === 0) {
      const edge = tipZoneEdges(zones, length, o);
      const outside = deficits.filter((f) => f.x >= edge.tail && f.x <= edge.nose);
      if (outside.length > 0) {
        issues.push(
          issue(
            'rail-height',
            `knife-tip lift: ${outside.length} station(s) below minRailHeight ${h} outside the tip zone [${edge.tail}, ${edge.nose}]; the lift reaches into the fitted deck`,
            { severity: 'warning', at: { x: outside[0]!.x }, value: h - outside[0]!.d },
          ),
        );
      }
      deck = localise(deck, deficits, edge, length, tol);
    }
    const [x0, x1] = deck.x;
    const U = deck.knotsU;
    const p = deck.degreeU;
    const nu = U.length - p - 1;
    const lam = new Float64Array(nu);
    // Each deficit plus one spacing of doubles at the deck's largest height: a
    // deficit below that spacing (the rounding of the last round's sum) would
    // add nothing and the rail height would stay a rounding short of h (S7 as
    // built; seen on the funboard with the 80/20 preset).
    let zMax = 0;
    for (const v of deck.z) zMax = Math.max(zMax, Math.abs(v));
    const step = doubleSpacing(zMax);
    for (const f0 of deficits) {
      const f = { x: f0.x, d: f0.d + step };
      const u = (f.x - x0) / (x1 - x0);
      for (let i = 0; i < nu; i++) {
        // N_i is non-zero on (U[i], U[i + p + 1]) (and at its clamped end).
        const inSupport =
          (u > U[i]! && u < U[i + p + 1]!) ||
          (u === U[i]! && i === 0) ||
          (u === U[i + p + 1]! && i === nu - 1);
        if (inSupport && f.d > lam[i]!) lam[i] = f.d;
      }
    }
    const nv = deck.knotsV.length - deck.degreeV - 1;
    const z = deck.z.slice();
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) z[i * nv + j] = z[i * nv + j]! + lam[i]!;
    deck = { ...deck, z };
    lift = Math.max(lift, ...lam);
  }
  if (minHeight < h) {
    issues.push(
      issue(
        'rail-height',
        `knife-tip lift: rail height ${minHeight} still below minRailHeight ${h} after ${o.maxRefinePasses} round(s)`,
        { severity: 'warning', value: minHeight },
      ),
    );
  }
  return { deck, floored: [...floored].sort((a, b) => a - b), lift, minHeight, issues };
}

/**
 * Refines the deck's u knots (exactly) so the lift for `deficits` stays inside
 * the tip zone: `degree + 1` knots, evenly spaced, between the innermost
 * violating station and the zone's edge at each end where that station lies
 * inside the zone (otherwise none: the caller reports it).
 */
function localise(
  deck: HeightFieldJSON,
  deficits: readonly { x: number; d: number }[],
  edge: { readonly tail: number; readonly nose: number },
  length: number,
  tol: Tolerances,
): HeightFieldJSON {
  const [x0, x1] = deck.x;
  const p = deck.degreeU;
  const add: number[] = [];
  const tailEdge = edge.tail;
  const noseEdge = edge.nose;
  const tail = deficits.filter((f) => f.x < length / 2).map((f) => f.x);
  const nose = deficits.filter((f) => f.x >= length / 2).map((f) => f.x);
  if (tail.length > 0) {
    const a = Math.max(...tail);
    if (a < tailEdge) for (let k = 1; k <= p + 1; k++) add.push(a + ((tailEdge - a) * k) / (p + 2));
  }
  if (nose.length > 0) {
    const b = Math.min(...nose);
    if (b > noseEdge)
      for (let k = 1; k <= p + 1; k++) add.push(noseEdge + ((b - noseEdge) * k) / (p + 2));
  }
  const us = add
    .map((x) => (x - x0) / (x1 - x0))
    .filter((u) => deck.knotsU.every((k) => Math.abs(k - u) > tol.knotRel));
  if (us.length === 0) return deck;
  const s = refineKnotsSurface(
    heightFieldSurface(deck, 'mirror-y', tol),
    'u',
    us.sort((a, b) => a - b),
    tol,
  );
  const nu = s.u.count;
  const nv = s.v.count;
  const z = new Array<number>(nu * nv);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) z[i * nv + j] = surfaceControlPoint(s, i, j).z;
  return { ...deck, knotsU: Array.from(s.u.knots), z };
}

/**
 * The converter (§9): `convertGeometry` (§9.1–§9.6), the rail stage
 * (`rail.ts`, §9.7) and `buildBoard` of the result. Returns the document, its
 * build and the conversion report, or the issues that stopped it. Warnings:
 * every stage that missed its target (`not-converged`, the band against
 * `surfaceTol` on its judged samples included) and the build's own.
 */
export function convertClassic(
  board: BezierBoard,
  opts: Partial<ConvertOptions> = {},
): Board2Result<Conversion> {
  const r = convertDetailed(board, opts);
  return r.ok ? board2Ok(r.value.conversion, r.issues) : r;
}

/** A conversion with its stages' internals (for the tests and the deviation report). */
export interface DetailedConversion {
  readonly conversion: Conversion;
  readonly geometry: ClassicGeometry;
  /** The warnings of `convertGeometry` alone (§9.1–§9.6). */
  readonly geometryIssues: readonly Board2Issue[];
  readonly rail: RailStage;
}

/** {@link convertClassic}, keeping the stages' internals. */
export function convertDetailed(
  board: BezierBoard,
  optsIn: Partial<ConvertOptions> = {},
): Board2Result<DetailedConversion> {
  const o: ConvertOptions = { ...DEFAULT_CONVERT_OPTIONS, ...optsIn };
  const geo = convertGeometry(board, o);
  if (!geo.ok) return board2Err(geo.issues);
  const g = geo.value;
  let rail: ReturnType<typeof fitRail>;
  try {
    rail = fitRail(g, o);
  } catch (e) {
    return board2Err([...geo.issues, geomIssue(e, 'rail stage')]);
  }
  if (!rail.ok) return board2Err([...geo.issues, ...rail.issues]);
  const r = rail.value;
  // Deep-frozen, as `reviveBoardDoc` returns a document (review of S7).
  const doc: BoardDoc = deepFreeze({
    ...r.doc,
    passthrough: { fins: JSON.parse(JSON.stringify(board.fins)) as JsonValue },
  });
  const clock = performance.now();
  const built = buildBoard(doc);
  const buildTime = performance.now() - clock;
  if (!built.ok)
    return board2Err([
      ...geo.issues,
      ...built.issues.map((i) =>
        i.severity === 'error' ? { ...i, message: `buildBoard: ${i.message}` } : i,
      ),
    ]);
  // §9.7 item 6: the document's band is the fitted band (same basis, no refinement).
  const factorisationError =
    built.value.band.u.count === r.basis.basis.count
      ? netDistance(netOf(built.value.band), r.fitted)
      : Infinity;
  const report: ConversionReport = {
    planError: g.plan.error,
    rockerError: g.rocker.error,
    deckLineError: g.deckLine.error,
    deckSurfaceError: g.deck.maxResidual,
    bottomSurfaceError: g.bottom.maxResidual,
    bandError: r.fit.judgedMax,
    fillets: g.plan.fillets.map((f) => ({
      x: f.x,
      radius: f.radius,
      predictedDeviation: f.predictedDeviation,
    })),
    floorZones: g.zones,
    railHeightFloored: g.railHeightFloored,
    creases: g.creases,
    stationLaws: r.stationLaws,
    factorisationError,
    band: {
      ratio: r.fit.ratio,
      corrections: r.fit.corrections,
      history: r.fit.history,
      samples: r.samples,
      judgedMax: r.fit.judgedMax,
      allMax: r.fit.allMax,
      meets: r.fit.meets,
      columns: r.basis.basis.count,
      initialApexKeysAdded: r.initialApexKeysAdded,
      apexKeysAdded: r.apexKeysAdded,
      insetKeysAdded: r.insetKeysAdded,
    },
    builtColumns: built.value.stations.length,
    builtPasses: built.value.report.refinePasses,
    timings: { ...g.timings, ...r.timings, build: buildTime },
  };
  return board2Ok(
    {
      conversion: { doc, built: built.value, report },
      geometry: g,
      geometryIssues: geo.issues,
      rail: r,
    },
    [...geo.issues, ...bandIssues(r, o), ...built.issues],
  );
}
