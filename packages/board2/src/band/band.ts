// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Band assembly (docs/design/board2.md §3.5, §5.3–§5.5, §6.3 stages 2–5 and
 * 7–12; stage 6, the bottom features, is step S4's and enters as the `bottom`
 * option).
 *
 * The band is a `NurbsSurface`, u periodic along the loop on the band basis
 * (the plan basis refined, `stations.ts`), v clamped cubic with knots
 * `[0, 0, 0, 0, ½, ½, ½, 1, 1, 1, 1]`: seven rows, the apex row at full
 * multiplicity. One **pass** builds it on a given basis:
 *
 * 4. the basis and its columns (Greville stations, σ, frames, pairing);
 * 5. effective insets = law + edge-row offset, limited by
 *    `insetCurvatureFraction · ρ(u)`, so the deck-edge and tuck plan rows;
 * 7–8. heights, slopes and the profile rows of every column (`profile.ts`), the
 *    handle offsets of stage 10 included (they move rows 1, 2, 4, 5 only, along
 *    directions the snap of stage 9 does not change, so the two stages commute);
 * 9. rows 0 and 6 snapped onto the deck and bottom (`snap.ts`), rows 1 and 5
 *    moved by the same Δz (handle vectors kept); partners averaged with their
 *    masters on a symmetric board;
 * 11. the exact mirror overwrite of every partner column (symmetric boards);
 * 12. measurements: the laws measured back at every span's mid parameter
 *    against the design there (a virtual column at that u), the deck join
 *    angle and both edge gaps (geom `edgeContinuity`), the apex normal angle
 *    and the tuck crease at every knot and span midpoint.
 *
 * {@link buildBand} repeats passes (§5.4): a span fails when a lane's
 * fidelity exceeds `lawTolerance`, its deck join exceeds `deckJoinAngleTol`, or
 * (when a boundary row misses `Tolerances.fit`) its z-fit error exceeds
 * `safety · fit`; failing spans are split at their midpoints (with their
 * mirrors) and the band is rebuilt, at most `maxBandRefinePasses` times. The
 * pass with the smallest worst ratio (measure over its target) is kept, and a
 * target it still misses is a `not-converged` warning located at the worst
 * span, never silent.
 *
 * **Invariants by construction.** The apex row's x, y are the plan refined to
 * the band basis (bitwise a function of the plan and the basis: no law or
 * offset touches them); rows 2 and 4 copy its x, y bitwise, so both one-sided
 * v-derivatives at v = ½ are vertical and the apex join is G1 with a
 * horizontal normal (§3.5). The deck and bottom surfaces are built from the
 * document alone, so laws and offsets cannot move the rocker or the deck line.
 */
import {
  clampedBasis,
  controlPointsInto,
  createScratch,
  curveEvalInto,
  curveSignedCurvature,
  DEFAULT_EDGE_FIT,
  edgeContinuity,
  makeCurve,
  makeSurface,
  makeTrimLoop,
  makeTrimmedSurface,
  resolveTolerances,
  reverseCurve,
  surfaceEvalInto,
  toClamped,
} from '@openshaper/geom';
import type {
  ClampedCurve,
  ContinuityProfile,
  EdgeFitSampling,
  EdgeSide,
  GeomIssue,
  NurbsCurve,
  NurbsSurface,
  PeriodicCurve,
  Point3,
  Tolerances,
} from '@openshaper/geom';
import {
  heightFieldSurface,
  heightSampler,
  OutsideFieldError,
  planCurvePcurve,
} from '../height-field';
import type { HeightSample } from '../height-field';
import { board2Err, board2Ok, causeOf, hasErrors, makeIssue } from '../issues';
import { lawEvaluator } from '../law';
import { offsetEvaluator, ZERO_OFFSETS } from '../offsets';
import type { OffsetEvaluator } from '../offsets';
import { RAIL_LANES } from '../params';
import { planArc, planCurve, planFrame, sigmaAt } from '../plan';
import type { PlanArc, PlanFrame } from '../plan';
import { mirrorOverwriteColumns } from '../symmetry';
import type {
  BandRow,
  BandStation,
  Board2Issue,
  Board2Result,
  BoardDoc,
  BoardFace,
  RailLane,
  RailLawValues,
} from '../types';
import { BAND_ROWS, measureColumn, measuredLawsAt, profileRows } from './profile';
import type { ProfileColumn } from './profile';
import { snapRow } from './snap';
import {
  bandBasis,
  bandColumns,
  basisSpans,
  insertMidpoints,
  PairingError,
  spanIndex,
  stationBasis,
} from './stations';
import type { BandBasis, Column, Span } from './stations';

/** The band's v knots: two cubic Bézier patches joined at the apex row (§3.5). */
export const BAND_V_KNOTS: readonly number[] = Object.freeze([
  0, 0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1,
]);

/** Row indices in v order (§3.5). */
export const ROW: { readonly [R in BandRow]: number } = Object.freeze({
  deckEdge: 0,
  deckHandle: 1,
  apexUpper: 2,
  apex: 3,
  apexLower: 4,
  tuckHandle: 5,
  tuck: 6,
});

const STRIDE = BAND_ROWS * 3;

// ---------------------------------------------------------------------------
// Context: stages 2 and 3
// ---------------------------------------------------------------------------

/** What every pass reads: the plan, σ, the surfaces and the law and offset evaluators. */
export interface BandContext {
  readonly doc: BoardDoc;
  readonly tol: Tolerances;
  readonly symmetric: boolean;
  readonly plan: PeriodicCurve<2>;
  readonly arc: PlanArc;
  readonly deck: NurbsSurface;
  /** The bottom the band meets (the base bottom until step S4 adds the features). */
  readonly bottom: NurbsSurface;
  readonly deckAt: (x: number, y: number) => HeightSample;
  readonly bottomAt: (x: number, y: number) => HeightSample;
  readonly laws: { readonly [L in RailLane]: (s: number) => number };
  readonly offsets: OffsetEvaluator;
  readonly edgeFit: EdgeFitSampling;
}

/** Stages 2–3 of §6.3. Throws geom's error on a basis geom refuses (a revived document has none). */
export function bandContext(doc: BoardDoc, bottom?: NurbsSurface): BandContext {
  const tol = resolveTolerances(doc.build.tolerances);
  const symmetric = doc.symmetry === 'mirror-y';
  const plan = planCurve(doc.plan, tol);
  const arc = planArc(plan, symmetric, tol);
  const deck = heightFieldSurface(doc.deck, doc.symmetry, tol);
  const bot = bottom ?? heightFieldSurface(doc.bottom, doc.symmetry, tol);
  const laws = {} as { [L in RailLane]: (s: number) => number };
  for (const lane of RAIL_LANES) laws[lane] = lawEvaluator(doc.laws[lane], tol);
  return Object.freeze({
    doc,
    tol,
    symmetric,
    plan,
    arc,
    deck,
    bottom: bot,
    deckAt: heightSampler(deck, doc.deck, tol),
    bottomAt: heightSampler(bot, doc.bottom, tol),
    laws: Object.freeze(laws),
    offsets: offsetEvaluator(doc.offsets, tol),
    edgeFit: Object.freeze({ ...DEFAULT_EDGE_FIT, ...doc.build.edgeFit }),
  });
}

// ---------------------------------------------------------------------------
// One column: stage 5 (effective insets) and stages 7–8 (profile rows)
// ---------------------------------------------------------------------------

/** A column built at `(A, frame, σ)`, with the lane values it was built from. */
export interface BuiltColumn {
  readonly profile: ProfileColumn;
  /** The lane values as built: effective insets, the other lanes' law values. */
  readonly laws: RailLawValues;
  /** The curvature limit of the effective inset is active. */
  readonly limited: boolean;
  readonly issues: readonly Board2Issue[];
}

/** 1/|κ| of the plan at `u` (`Infinity` where it is straight). */
function radiusAt(plan: PeriodicCurve<2>, u: number): number {
  const k = Math.abs(curveSignedCurvature(plan, u));
  return k > 0 ? 1 / k : Infinity;
}

/**
 * The column whose apex plan point is `(ax, ay)` with frame `frame` at loop
 * parameter `u` and arc fraction `sigma` (stages 5, 7, 8 and the handle
 * offsets of stage 10).
 */
export function columnAt(
  ctx: BandContext,
  ax: number,
  ay: number,
  frame: PlanFrame,
  u: number,
  sigma: number,
): BuiltColumn {
  const b = ctx.doc.build;
  // On a symmetric board the layer is read on the −y half and mirrored, like a
  // half-domain law: the (½, 1) half of its fields would be overwritten anyway.
  const sOff = ctx.symmetric && sigma > 0.5 ? 1 - sigma : sigma;
  const off = ctx.offsets === null ? ZERO_OFFSETS : ctx.offsets(sOff);
  const cap = b.insetCurvatureFraction * radiusAt(ctx.plan, u);
  const wdRaw = ctx.laws.deckInset(sigma) + off.deckEdgeN;
  const wtRaw = ctx.laws.tuckInset(sigma) + off.tuckN;
  const deckInset = Math.min(wdRaw, cap);
  const tuckInset = Math.min(wtRaw, cap);
  const issues: Board2Issue[] = [];
  for (const [lane, w] of [
    ['deckInset', deckInset],
    ['tuckInset', tuckInset],
  ] as const) {
    if (!(w >= b.minInset)) {
      issues.push(
        makeIssue(
          'inset-invalid',
          `${lane} ${w} at σ = ${sigma} (law plus offset) is below minInset ${b.minInset}`,
          { at: { sigma, u, lane }, value: w },
        ),
      );
    }
  }
  const laws: RailLawValues = Object.freeze({
    deckInset,
    tuckInset,
    apexHeight: ctx.laws.apexHeight(sigma),
    upperFullness: ctx.laws.upperFullness(sigma),
    lowerFullness: ctx.laws.lowerFullness(sigma),
    edgeHardness: ctx.laws.edgeHardness(sigma),
  });
  const profile = profileRows(
    { ax, ay, frame, ...laws, offsets: off },
    ctx.deckAt,
    ctx.bottomAt,
    b,
    { sigma, u },
  );
  issues.push(...profile.issues);
  return Object.freeze({
    profile,
    laws,
    limited: deckInset < wdRaw || tuckInset < wtRaw,
    issues: Object.freeze(issues),
  });
}

// ---------------------------------------------------------------------------
// One pass on a given basis: stages 4–5, 7–11
// ---------------------------------------------------------------------------

/** A band built on one basis, before measurement. */
export interface BandPass {
  readonly basis: BandBasis;
  readonly spans: readonly Span[];
  readonly columns: readonly Column[];
  readonly stations: readonly BandStation[];
  readonly band: NurbsSurface;
  readonly apex: PeriodicCurve<3>;
  readonly deckEdge: PeriodicCurve<3>;
  readonly tuck: PeriodicCurve<3>;
  /** Verified z-fit error of rows 0 and 6, per span and overall. */
  readonly snapError: { readonly deck: Float64Array; readonly tuck: Float64Array };
  readonly snapMax: { readonly deckEdge: number; readonly tuck: number };
  readonly insetLimited: readonly number[];
  readonly issues: readonly Board2Issue[];
}

/** Options of a pass (tests switch the overwrite off to show it only removes rounding, §3.7). */
export interface PassOptions {
  readonly mirrorOverwrite?: boolean;
}

function rowCurve(
  b: BandBasis,
  net: Float64Array,
  row: number,
  dim: 2 | 3,
): PeriodicCurve<2> | PeriodicCurve<3> {
  const n = b.basis.count;
  const pts = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < dim; k++) pts[i * dim + k] = net[i * STRIDE + row * 3 + k]!;
  }
  return makeCurve({ dim, basis: b.basis, points: pts }) as PeriodicCurve<2> | PeriodicCurve<3>;
}

/**
 * Builds the band on basis `b` (stages 4–5 and 7–11). Errors of the columns
 * (insets, rail height, profiles) and of the snap fits are returned as issues;
 * the pass is still returned when its geometry is finite, so the caller decides.
 */
export function bandPass(ctx: BandContext, b: BandBasis, opts: PassOptions = {}): BandPass {
  const overwrite = opts.mirrorOverwrite ?? true;
  const columns = bandColumns(b, ctx.arc);
  const spans = basisSpans(b.basis);
  const n = b.basis.count;
  const apexPts = new Float64Array(n * 2);
  controlPointsInto(b.apexPlan, apexPts, 0);
  const net = new Float64Array(n * STRIDE);
  const issues: Board2Issue[] = [];
  const stations: BandStation[] = [];
  const insetLimited: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = columns[i]!;
    const col = columnAt(ctx, apexPts[2 * i]!, apexPts[2 * i + 1]!, c.frame, c.u, c.sigma);
    net.set(col.profile.points, i * STRIDE);
    // A partner column repeats its master's issues (it is overwritten by its mirror).
    if (c.role !== 'partner' || !overwrite) issues.push(...col.issues);
    if (col.limited) insetLimited.push(i);
    stations.push(
      Object.freeze({
        u: c.u,
        sigma: c.sigma,
        tangent: c.frame.tangent,
        inward: c.frame.inward,
        laws: col.laws,
        partner: c.partner,
      }),
    );
  }

  // Stage 9: rows 0 and 6 onto the deck and the bottom; rows 1 and 5 follow.
  const snap = (row: number, handle: number, at: BandContext['deckAt'], face: BoardFace) => {
    const r = snapRow(
      b.basis,
      spans,
      rowCurve(b, net, row, 2) as PeriodicCurve<2>,
      at,
      ctx.edgeFit,
      ctx.tol,
    );
    if ('issues' in r) {
      for (const cause of r.issues as readonly GeomIssue[]) {
        issues.push(
          makeIssue('geom', `${face} edge z-fit: ${cause.message}`, { at: { face }, cause }),
        );
      }
      return { spanError: new Float64Array(spans.length).fill(Infinity), maxError: Infinity };
    }
    const z = r.z;
    if (b.pairing !== null && overwrite) {
      // Average each pair (a convex combination of curves within `fit` of a
      // symmetric target stays within `fit`); the overwrite then copies it.
      for (let i = 0; i < n; i++) {
        if (b.pairing.role[i] !== 'master') continue;
        const p = b.pairing.partner[i]!;
        const avg = 0.5 * (z[i]! + z[p]!);
        z[i] = avg;
        z[p] = avg;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const dz = z[i]! - net[o + row * 3 + 2]!;
      net[o + row * 3 + 2] = z[i]!;
      net[o + handle * 3 + 2] = net[o + handle * 3 + 2]! + dz;
    }
    return { spanError: r.spanError, maxError: r.maxError };
  };
  const deckSnap = snap(ROW.deckEdge, ROW.deckHandle, ctx.deckAt, 'deck');
  const tuckSnap = snap(ROW.tuck, ROW.tuckHandle, ctx.bottomAt, 'bottom');

  // Stage 11: the exact mirror overwrite.
  if (b.pairing !== null && overwrite) mirrorOverwriteColumns(net, BAND_ROWS, b.pairing);

  const band = makeSurface({ u: b.basis, v: clampedBasis(3, BAND_V_KNOTS), points: net });
  return Object.freeze({
    basis: b,
    spans,
    columns,
    stations: Object.freeze(stations),
    band,
    apex: rowCurve(b, net, ROW.apex, 3) as PeriodicCurve<3>,
    deckEdge: rowCurve(b, net, ROW.deckEdge, 3) as PeriodicCurve<3>,
    tuck: rowCurve(b, net, ROW.tuck, 3) as PeriodicCurve<3>,
    snapError: { deck: deckSnap.spanError, tuck: tuckSnap.spanError },
    snapMax: { deckEdge: deckSnap.maxError, tuck: tuckSnap.maxError },
    insetLimited: Object.freeze(insetLimited),
    issues: Object.freeze(issues),
  });
}

// ---------------------------------------------------------------------------
// Measurement: stage 12
// ---------------------------------------------------------------------------

const cross = (a: Point3, b: Point3): Point3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Point3): number => Math.hypot(a.x, a.y, a.z);
const angleBetween = (a: Point3, b: Point3): number => Math.atan2(norm(cross(a, b)), dot(a, b));

type Scratch = ReturnType<typeof createScratch>;

/** A scratch for evaluating `s` to first order (callers own it: no module state). */
const scratchFor = (s: NurbsSurface): Scratch =>
  createScratch({ maxDegree: Math.max(s.u.degree, s.v.degree), maxDerivs: 1 });

/** The band's (unnormalised) normal `Su × Sv` at `(u, v)`, from the given v side; `f` receives `S, Su, Sv`. */
function bandNormal(
  band: NurbsSurface,
  u: number,
  v: number,
  left: boolean,
  f: Float64Array,
  sc: Scratch,
): Point3 {
  surfaceEvalInto(band, u, v, 1, f, 0, sc, left ? { v: 'left' } : undefined);
  return cross({ x: f[3]!, y: f[4]!, z: f[5]! }, { x: f[6]!, y: f[7]!, z: f[8]! });
}

/**
 * The normal angle across the apex row at `u` (radians): between the band's
 * normals from below and above v = ½. The construction gives rounding (§3.5).
 */
export function apexAngleAt(band: NurbsSurface, u: number, sc: Scratch = scratchFor(band)): number {
  const f = new Float64Array(9);
  const lo = bandNormal(band, u, 0.5, true, f, sc);
  const hi = bandNormal(band, u, 0.5, false, f, sc);
  return angleBetween(lo, hi);
}

/**
 * The tuck crease at `u` measured on the surfaces, in the station plane: the
 * angle between the traces of the band (at v = 1) and of the bottom (at the
 * band's tuck point) in the plane normal to the plan tangent (radians).
 */
export function tuckCreaseAt(
  band: NurbsSurface,
  bottomAt: (x: number, y: number) => HeightSample,
  frame: PlanFrame,
  u: number,
  sc: Scratch = scratchFor(band),
): number {
  const f = new Float64Array(9);
  const nb = bandNormal(band, u, 1, true, f, sc);
  const s = bottomAt(f[0]!, f[1]!);
  // Outward normals: the band's is −Su × Sv (§7, sameSense false); the bottom's,
  // the graph z = B(x, y) seen from below, is (∂B/∂x, ∂B/∂y, −1).
  const nbot = { x: s.dzdx, y: s.dzdy, z: -1 };
  const t = frame.tangent;
  const proj = (a: Point3): Point3 => {
    const d = dot(a, t);
    return { x: a.x - d * t.x, y: a.y - d * t.y, z: a.z - d * t.z };
  };
  return angleBetween(proj({ x: -nb.x, y: -nb.y, z: -nb.z }), proj(nbot));
}

/** What a pass measured (stage 12). */
export interface PassMeasure {
  /** Per span: the worst lane fidelity ratio, the deck join angle, the z-fit error ratio. */
  readonly fidelityRatio: Float64Array;
  readonly joinAngle: Float64Array;
  readonly lawFidelity: RailLawValues;
  readonly apexJoinAngle: number;
  readonly deckJoinAngle: number;
  readonly tuckCreaseError: number;
  readonly edgeGaps: { readonly deckEdge: number; readonly tuck: number };
  /** Join and fit profiles, for reports and tests. */
  readonly deckJoin: ContinuityProfile;
  readonly tuckJoin: ContinuityProfile;
  /** Worst measure over its target across the band (≤ 1: every target met). */
  readonly score: number;
  /** Spans to split, and where the worst miss is. */
  readonly failing: readonly Span[];
  readonly worst: { readonly u: number; readonly what: string };
}

/** The laws designed at an arbitrary u: a virtual column there, read back (§5.7). */
export function designedLawsAt(
  ctx: BandContext,
  u: number,
): {
  readonly laws: RailLawValues;
  readonly crease: number;
  readonly frame: PlanFrame;
} {
  const frame = planFrame(ctx.plan, u, ctx.symmetric);
  if (frame === null) throw new Error(`the plan has no tangent at u = ${u}`);
  const sigma = sigmaAt(ctx.arc, u);
  const q = new Float64Array(2);
  curveEvalInto(
    ctx.plan,
    u,
    0,
    q,
    0,
    createScratch({ maxDegree: ctx.plan.basis.degree, maxDerivs: 0 }),
  );
  const col = columnAt(ctx, q[0]!, q[1]!, frame, u, sigma);
  return {
    laws: measureColumn(col.profile.points, frame, col.profile.sb),
    crease: col.profile.crease,
    frame,
  };
}

/** The (u, 0) or (u, 1) line on the band as a same-parameter pcurve over `[t0, t0 + 1]`. */
function bandLine(t0: number, v: number): ClampedCurve<2> {
  return makeCurve({
    dim: 2,
    basis: clampedBasis(1, [t0, t0, t0 + 1, t0 + 1]),
    points: [t0, v, t0 + 1, v],
  }) as ClampedCurve<2>;
}

/** The pcurve of a boundary row's plan curve on a height field, over `[t0, t0 + 1]`. */
function fieldPcurve(row: PeriodicCurve<3>, hf: BoardDoc['deck'], tol: Tolerances) {
  const n = row.basis.count;
  const p3 = new Float64Array(n * 3);
  controlPointsInto(row, p3, 0);
  const p2 = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    p2[2 * i] = p3[3 * i]!;
    p2[2 * i + 1] = p3[3 * i + 1]!;
  }
  const xy = makeCurve({ dim: 2, basis: row.basis, points: p2 });
  return planCurvePcurve(toClamped(xy, row.basis.domain[0], tol), hf);
}

/** Stage 12 on a pass. */
export function measurePass(ctx: BandContext, p: BandPass): PassMeasure {
  const b = ctx.doc.build;
  const spans = p.spans;
  const t0 = p.basis.basis.domain[0];
  const fidelityRatio = new Float64Array(spans.length);
  const joinAngle = new Float64Array(spans.length);
  const fid: Record<RailLane, number> = {
    deckInset: 0,
    tuckInset: 0,
    apexHeight: 0,
    upperFullness: 0,
    lowerFullness: 0,
    edgeHardness: 0,
  };
  let apexJoinAngle = 0;
  let tuckCreaseError = 0;
  const sc = scratchFor(p.band);
  spans.forEach((s, k) => {
    for (const u of [s.a, 0.5 * (s.a + s.b)]) {
      const d = designedLawsAt(ctx, u);
      apexJoinAngle = Math.max(apexJoinAngle, apexAngleAt(p.band, u, sc));
      const crease = tuckCreaseAt(p.band, ctx.bottomAt, d.frame, u, sc);
      tuckCreaseError = Math.max(tuckCreaseError, Math.abs(crease - d.crease));
      if (u === s.a) continue;
      // Fidelity at the span's mid parameter (§5.4 condition 3).
      const m = measuredLawsAt(p.band, d.frame, ctx.bottomAt, u);
      let worst = 0;
      for (const lane of RAIL_LANES) {
        const e = Math.abs(m[lane] - d.laws[lane]);
        fid[lane] = Math.max(fid[lane], e);
        worst = Math.max(worst, e / b.lawTolerance[lane]);
      }
      fidelityRatio[k] = worst;
    }
  });

  // Deck join and the edge gaps (geom's edgeContinuity, same-parameter pcurves).
  const join = (row: PeriodicCurve<3>, v: number, face: 'deck' | 'bottom'): ContinuityProfile => {
    const edge = toClamped(row, t0, ctx.tol) as NurbsCurve<3>;
    const bandSide: EdgeSide = { surface: p.band, pcurve: bandLine(t0, v), sameSense: false };
    const faceSide: EdgeSide = {
      surface: face === 'deck' ? ctx.deck : ctx.bottom,
      pcurve: fieldPcurve(row, ctx.doc[face], ctx.tol),
      sameSense: face === 'deck',
    };
    return edgeContinuity(edge, bandSide, faceSide, { tol: ctx.tol });
  };
  const deckJoin = join(p.deckEdge, 0, 'deck');
  const tuckJoin = join(p.tuck, 1, 'bottom');
  for (let j = 0; j < deckJoin.t.length; j++) {
    const k = spanIndex(spans, t0, deckJoin.t[j]!);
    joinAngle[k] = Math.max(joinAngle[k]!, deckJoin.normalAngle[j]!);
  }
  const k0 = spanIndex(spans, t0, deckJoin.argmax.normalAngle);
  joinAngle[k0] = Math.max(joinAngle[k0]!, deckJoin.max.normalAngle);

  // Score and failing spans.
  const fit = ctx.tol.fit;
  const snapMiss = p.snapMax.deckEdge > fit || p.snapMax.tuck > fit;
  const safety = ctx.edgeFit.safety * fit;
  let score = 0;
  let worst = { u: spans[0]!.a, what: '' };
  const failing: Span[] = [];
  spans.forEach((s, k) => {
    const snapK = Math.max(p.snapError.deck[k]!, p.snapError.tuck[k]!);
    const ratios: readonly [number, string][] = [
      [fidelityRatio[k]!, 'law fidelity'],
      [joinAngle[k]! / b.deckJoinAngleTol, 'deck join angle'],
      [snapK / fit, 'edge z-fit'],
    ];
    for (const [r, what] of ratios) {
      if (r > score) {
        score = r;
        worst = { u: 0.5 * (s.a + s.b), what };
      }
    }
    if (
      fidelityRatio[k]! > 1 ||
      joinAngle[k]! > b.deckJoinAngleTol ||
      (snapMiss && snapK > safety)
    ) {
      failing.push(s);
    }
  });

  return Object.freeze({
    fidelityRatio,
    joinAngle,
    lawFidelity: Object.freeze({ ...fid }),
    apexJoinAngle,
    deckJoinAngle: deckJoin.max.normalAngle,
    tuckCreaseError,
    edgeGaps: Object.freeze({ deckEdge: deckJoin.max.gap, tuck: tuckJoin.max.gap }),
    deckJoin,
    tuckJoin,
    score,
    failing: Object.freeze(failing),
    worst: Object.freeze(worst),
  });
}

// ---------------------------------------------------------------------------
// The inset loops (stage 5's check)
// ---------------------------------------------------------------------------

/**
 * The deck-edge and tuck plan curves must be simple, strictly inside the plan
 * loop and inside their height field's domain (§3.6): geom's certified trim
 * checks on each field, the plan loop as the outer loop and the inset loop as a
 * hole. `inset-loop-invalid` per failure, with geom's issue as the cause.
 */
export function insetLoopIssues(ctx: BandContext, p: BandPass): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const t0 = ctx.plan.basis.domain[0];
  const outerPlan = toClamped(ctx.plan, t0, ctx.tol);
  for (const [face, row] of [
    ['deck', p.deckEdge],
    ['bottom', p.tuck],
  ] as const) {
    const hf = ctx.doc[face];
    const surface = face === 'deck' ? ctx.deck : ctx.bottom;
    const outer = makeTrimLoop([planCurvePcurve(outerPlan, hf)], { snap: true, tol: ctx.tol });
    const hole = makeTrimLoop([reverseCurve(fieldPcurve(row, hf, ctx.tol), ctx.tol)], {
      snap: true,
      tol: ctx.tol,
    });
    const loops = [outer, hole];
    const geomIssues: GeomIssue[] = [];
    for (const l of loops) if (!l.ok) geomIssues.push(...l.issues);
    if (outer.ok && hole.ok) {
      const ts = makeTrimmedSurface(surface, outer.value, [hole.value], ctx.tol);
      if (!ts.ok) geomIssues.push(...ts.issues.filter((i) => i.severity === 'error'));
    }
    const rowName: BandRow = face === 'deck' ? 'deckEdge' : 'tuck';
    for (const cause of geomIssues) {
      out.push(
        makeIssue(
          'inset-loop-invalid',
          `the ${rowName} loop is not a simple loop strictly inside the plan loop on the ${face}: ${cause.message}`,
          { at: { face, row: rowName }, cause },
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildBand: the refinement loop of §5.4
// ---------------------------------------------------------------------------

/** What the band build measured (the band part of the §11 `BuildReport`). */
export interface BandReport {
  readonly issues: readonly Board2Issue[];
  readonly apexJoinAngle: number;
  readonly deckJoinAngle: number;
  readonly tuckCreaseError: number;
  readonly lawFidelity: RailLawValues;
  readonly edgeGaps: { readonly deckEdge: number; readonly tuck: number };
  readonly refinePasses: number;
  readonly insetLimited: readonly number[];
}

/** The band and everything it was built from (the band part of `BuiltBoard`). */
export interface BandBuild {
  readonly plan: PeriodicCurve<2>;
  readonly deck: NurbsSurface;
  readonly bottom: NurbsSurface;
  readonly band: NurbsSurface;
  readonly apex: PeriodicCurve<3>;
  readonly deckEdge: PeriodicCurve<3>;
  readonly tuck: PeriodicCurve<3>;
  readonly stations: readonly BandStation[];
  readonly basis: BandBasis;
  readonly report: BandReport;
  /** The kept pass and its measurements (for tests and step S4). */
  readonly pass: BandPass;
  readonly measure: PassMeasure;
}

export interface BuildBandOptions extends PassOptions {
  /** The bottom the band meets (step S4: the bottom with its features). Default: the base bottom. */
  readonly bottom?: NurbsSurface;
  /**
   * Refinement passes after the first (default `build.maxBandRefinePasses`).
   * Tests pass 0 to see the unrefined band.
   */
  readonly maxPasses?: number;
  /**
   * Uniform halvings of every span of the station basis before the first pass
   * (default 0). Tests use it to see the convergence of the unrefined
   * construction (§13.2: the deck join is O(h²) before refinement).
   */
  readonly uniformRefinements?: number;
}

function geomIssue(e: unknown, what: string): Board2Issue {
  if (e instanceof PairingError) {
    return makeIssue('symmetry-broken', e.message, e.u === undefined ? {} : { at: { u: e.u } });
  }
  if (e instanceof OutsideFieldError) {
    return makeIssue('inset-loop-invalid', `${what}: ${e.message}`, {});
  }
  const cause = causeOf(e);
  if (cause === undefined) throw e;
  return makeIssue('geom', `${what}: ${cause.message}`, { cause });
}

/**
 * Builds the rail band of a document (stages 2–5 and 7–12 of §6.3). The
 * document is expected to have passed `validateBoard` (the band builder does
 * not re-check it, so a test can build a notched loop directly, §3.8). Errors
 * of any pass are returned; `not-converged` and other warnings ride on a
 * successful result.
 */
export function buildBand(doc: BoardDoc, opts: BuildBandOptions = {}): Board2Result<BandBuild> {
  let ctx: BandContext;
  try {
    ctx = bandContext(doc, opts.bottom);
  } catch (e) {
    return board2Err([geomIssue(e, 'band context')]);
  }
  const maxPasses = opts.maxPasses ?? doc.build.maxBandRefinePasses;
  let best: { pass: BandPass; measure: PassMeasure; index: number } | null = null;
  try {
    let b = stationBasis(ctx.plan, ctx.arc, doc.build, ctx.symmetric, ctx.tol);
    for (let k = 0; k < (opts.uniformRefinements ?? 0); k++) {
      const next = insertMidpoints(b, basisSpans(b.basis), ctx.symmetric, ctx.tol);
      b = bandBasis(ctx.plan, next, ctx.symmetric, ctx.tol);
    }
    for (let pass = 0; ; pass++) {
      const p = bandPass(ctx, b, opts);
      if (hasErrors(p.issues)) return board2Err(p.issues);
      const m = measurePass(ctx, p);
      if (best === null || m.score < best.measure.score)
        best = { pass: p, measure: m, index: pass };
      if (m.failing.length === 0 || pass >= maxPasses) break;
      const next = insertMidpoints(b, m.failing, ctx.symmetric, ctx.tol);
      if (next.length === b.inserted.length) break;
      b = bandBasis(ctx.plan, next, ctx.symmetric, ctx.tol);
    }
  } catch (e) {
    return board2Err([geomIssue(e, 'band build')]);
  }
  const { pass: p, measure: m, index } = best!;
  const issues: Board2Issue[] = [...p.issues];
  try {
    issues.push(...insetLoopIssues(ctx, p));
  } catch (e) {
    issues.push(geomIssue(e, 'inset loops'));
  }
  if (m.apexJoinAngle > doc.build.apexJoinAngleTol) {
    issues.push(
      makeIssue(
        'rail-profile-invalid',
        `apex join angle ${m.apexJoinAngle} rad exceeds apexJoinAngleTol ${doc.build.apexJoinAngleTol}`,
        { value: m.apexJoinAngle },
      ),
    );
  }
  if (m.score > 1) {
    issues.push(
      makeIssue(
        'not-converged',
        `band refinement stopped after ${index} pass(es) with ${m.worst.what} at ${m.score} × its target near u = ${m.worst.u}`,
        {
          severity: 'warning',
          at: { u: m.worst.u, sigma: sigmaAt(ctx.arc, m.worst.u) },
          value: m.score,
        },
      ),
    );
  }
  if (hasErrors(issues)) return board2Err(issues);
  const report: BandReport = Object.freeze({
    issues: Object.freeze(issues),
    apexJoinAngle: m.apexJoinAngle,
    deckJoinAngle: m.deckJoinAngle,
    tuckCreaseError: m.tuckCreaseError,
    lawFidelity: m.lawFidelity,
    edgeGaps: m.edgeGaps,
    refinePasses: index,
    insetLimited: p.insetLimited,
  });
  return board2Ok(
    Object.freeze({
      plan: ctx.plan,
      deck: ctx.deck,
      bottom: ctx.bottom,
      band: p.band,
      apex: p.apex,
      deckEdge: p.deckEdge,
      tuck: p.tuck,
      stations: p.stations,
      basis: p.basis,
      report,
      pass: p,
      measure: m,
    }),
    issues,
  );
}

/**
 * The checks of stages 4–8 that `validateBoard` runs (§3.6, §4, §5.3): every
 * column of the station basis built, its insets, rail height and profile
 * judged, and the inset loops certified on that basis. Empty when they pass.
 */
export function bandChecks(doc: BoardDoc): readonly Board2Issue[] {
  try {
    const ctx = bandContext(doc);
    const b = stationBasis(ctx.plan, ctx.arc, doc.build, ctx.symmetric, ctx.tol);
    const p = bandPass(ctx, b);
    if (hasErrors(p.issues)) return p.issues;
    return insetLoopIssues(ctx, p);
  } catch (e) {
    return [geomIssue(e, 'band checks')];
  }
}
