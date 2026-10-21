// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The band's u-basis and its stations (docs/design/board2.md §5.4, §3.2, §3.7).
 *
 * The band's u-basis is the plan basis refined: `inserted` is the sorted list
 * of knots added to the plan's own, so the band basis, and the apex row's x and
 * y, are a pure function of `(plan, inserted)`: {@link bandBasis} refines the
 * plan in **one** pass (`refineKnots`, exact) and, on a symmetric board,
 * overwrites each partner control point with the exact mirror of its master.
 * Two builds on the same `inserted` therefore have bitwise the same apex
 * plan, whatever their laws and offsets (the outline invariance of §13.2).
 *
 * Refinement inserts the midpoint of each span that fails a condition and, on
 * a symmetric board, the mirror `−m (mod 1)` of that midpoint, so the knot set
 * stays invariant under `u ↦ −u` (to `paramRel`, the slack geom's pairing
 * allows). A candidate within geom's `knotRel` of a knot that is already there
 * is dropped, never snapped (a snapped insertion would raise a multiplicity
 * and break the C² plan), so a span narrower than `2 · knotRel` is never split
 * and every refinement loop terminates.
 *
 * Conditions 1 and 2 of §5.4 are judged here, exactly on the Bézier pieces:
 *
 * 1. **Frame turn**: on a span the tangent direction lies in the cone of the
 *    hodograph's three control vectors (convex hull property), so the cone's
 *    angular extent (`2π` minus the widest gap between the three directions)
 *    bounds the turn between any two stations of the span; it must be at most
 *    `maxFrameTurn`.
 * 2. **Spacing**: the span's arc length (geom's adaptive table, to `quadRel`)
 *    is at most `maxStationSpacing`.
 *
 * Stations (columns) sit at the Greville abscissae of the band basis. On a
 * symmetric board the self-paired columns are placed at exactly u = 0 and ½
 * (the pairing says they are the fixed points; the abscissa itself may be one
 * rounding off), so their frames are the exact tip frames of `planFrame` and
 * their rows stay on y = 0; a partner column takes σ = `1 − σ_master` (S2,
 * deviation 3).
 */
import {
  controlPointsInto,
  decomposeBezier,
  lengthAtParam,
  refineKnots,
  resolveTolerances,
  toClamped,
} from '@openshaper/geom';
import type { PeriodicBasis, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { grevilleAbscissae } from '../height-field';
import { planFrame, sigmaAt, wrapUnit } from '../plan';
import type { PlanArc, PlanFrame } from '../plan';
import { mirrorOverwriteCurve, periodicPairing } from '../symmetry';
import type { Pairing, PairRole } from '../symmetry';
import type { BuildParams } from '../types';

/** The band basis and the apex row's plan curve on it. */
export interface BandBasis {
  /** The plan refined by `inserted` (and mirror-overwritten when symmetric): row 3's x, y. */
  readonly apexPlan: PeriodicCurve<2>;
  readonly basis: PeriodicBasis;
  /** Knots added to the plan's, ascending, in the plan's stored period. */
  readonly inserted: readonly number[];
  /** The mirror pairing of the band basis (`null` on an asymmetric board). */
  readonly pairing: Pairing | null;
}

/** A knot span `[a, b]` of a periodic basis, in its stored period (`b` may be `t0 + T`). */
export interface Span {
  readonly a: number;
  readonly b: number;
}

/** Thrown when a symmetric board's band basis has no mirror pairing (a broken document). */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly u?: number,
  ) {
    super(message);
  }
}

/**
 * The band basis of `inserted` (module comment). On a symmetric board the
 * refined plan is mirror-overwritten so masters and partners are exact mirrors;
 * a basis with no pairing throws {@link PairingError}.
 */
export function bandBasis(
  plan: PeriodicCurve<2>,
  inserted: readonly number[],
  symmetric: boolean,
  tol?: Partial<Tolerances>,
): BandBasis {
  const refined = inserted.length > 0 ? refineKnots(plan, inserted, tol) : plan;
  let pairing: Pairing | null = null;
  let apexPlan = refined;
  if (symmetric) {
    const r = periodicPairing(refined.basis, tol);
    if (!r.ok) throw new PairingError(`band basis: ${r.message}`, r.u);
    pairing = r.pairing;
    apexPlan = mirrorOverwriteCurve(refined, pairing);
  }
  return Object.freeze({
    apexPlan,
    basis: refined.basis,
    inserted: Object.freeze([...inserted]),
    pairing,
  });
}

/** The knot spans of a periodic basis, in order from its domain start. */
export function basisSpans(b: PeriodicBasis): readonly Span[] {
  const U = b.knots;
  const br: number[] = [];
  for (let i = 0; i < U.length; i++) if (i === 0 || U[i] !== U[i - 1]) br.push(U[i]!);
  const end = b.domain[0] + b.period;
  return br.map((a, k) => ({ a, b: k + 1 < br.length ? br[k + 1]! : end }));
}

/** The index of the span of `spans` containing `u` (wrapped into the basis period). */
export function spanIndex(spans: readonly Span[], t0: number, u: number): number {
  let x = u - Math.floor(u - t0);
  if (x >= t0 + 1) x -= 1;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid]!.a <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** `x` mapped into the period `[t0, t0 + 1)`. */
function intoPeriod(x: number, t0: number): number {
  let y = x - Math.floor(x - t0);
  if (y >= t0 + 1) y -= 1;
  return y;
}

/** Distance on the unit circle. */
function circ(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/**
 * `inserted` grown by the midpoint of every span in `split` and, when
 * symmetric, its mirror (module comment). Candidates within `knotRel` of a knot
 * of the basis or of an earlier candidate are dropped. Returns the new sorted
 * list (equal in length to `inserted` when nothing could be added).
 */
export function insertMidpoints(
  b: BandBasis,
  split: readonly Span[],
  symmetric: boolean,
  tol?: Partial<Tolerances>,
): readonly number[] {
  const gap = resolveTolerances(tol).knotRel;
  const t0 = b.basis.domain[0];
  const taken: number[] = Array.from(b.basis.knots);
  const added: number[] = [];
  const consider = (x: number): void => {
    const k = intoPeriod(x, t0);
    for (const t of taken) if (circ(t, k) <= gap) return;
    taken.push(k);
    added.push(k);
  };
  for (const s of split) {
    const m = 0.5 * (s.a + s.b);
    consider(m);
    if (symmetric) consider(-m);
  }
  return Object.freeze([...b.inserted, ...added].sort((x, y) => x - y));
}

/** The angular extent of the cone of up to three plane vectors (0 when all vanish). */
function coneExtent(v: readonly (readonly [number, number])[]): number {
  const angles = v.filter(([x, y]) => x !== 0 || y !== 0).map(([x, y]) => Math.atan2(y, x));
  if (angles.length < 2) return 0;
  angles.sort((a, b) => a - b);
  let widest = 2 * Math.PI - (angles[angles.length - 1]! - angles[0]!);
  for (let k = 1; k < angles.length; k++) widest = Math.max(widest, angles[k]! - angles[k - 1]!);
  return 2 * Math.PI - widest;
}

/** Per span of the band basis: the bound of the frame turn and the arc length. */
export interface SpanGeometry {
  readonly spans: readonly Span[];
  readonly turn: Float64Array;
  readonly length: Float64Array;
}

/** {@link SpanGeometry} of a band basis (exact turn bound on the Bézier pieces; arc length by the table). */
export function spanGeometry(b: BandBasis, arc: PlanArc, tol?: Partial<Tolerances>): SpanGeometry {
  const spans = basisSpans(b.basis);
  const t0 = b.basis.domain[0];
  const pieces = decomposeBezier(toClamped(b.apexPlan, t0, tol));
  const turn = new Float64Array(spans.length);
  const length = new Float64Array(spans.length);
  const p = new Float64Array(8);
  const at = (u: number): number =>
    u >= t0 + 1 ? arc.table.total : lengthAtParam(arc.curve, arc.table, u);
  for (let k = 0; k < spans.length; k++) {
    controlPointsInto(pieces[k]!, p, 0);
    turn[k] = coneExtent([
      [p[2]! - p[0]!, p[3]! - p[1]!],
      [p[4]! - p[2]!, p[5]! - p[3]!],
      [p[6]! - p[4]!, p[7]! - p[5]!],
    ]);
    length[k] = at(spans[k]!.b) - at(spans[k]!.a);
  }
  return Object.freeze({ spans, turn, length });
}

/**
 * The station basis (§5.4 conditions 1 and 2, stage 4 of §6.3): the plan basis
 * refined until every span turns at most `maxFrameTurn` and is at most
 * `maxStationSpacing` long. Each round splits every failing span at its
 * midpoint (with its mirror); it stops when no span fails or none can be split.
 */
export function stationBasis(
  plan: PeriodicCurve<2>,
  arc: PlanArc,
  build: Pick<BuildParams, 'maxFrameTurn' | 'maxStationSpacing'>,
  symmetric: boolean,
  tol?: Partial<Tolerances>,
): BandBasis {
  let b = bandBasis(plan, [], symmetric, tol);
  for (;;) {
    const g = spanGeometry(b, arc, tol);
    const split = g.spans.filter(
      (_, k) => g.turn[k]! > build.maxFrameTurn || g.length[k]! > build.maxStationSpacing,
    );
    if (split.length === 0) return b;
    const next = insertMidpoints(b, split, symmetric, tol);
    if (next.length === b.inserted.length) return b;
    b = bandBasis(plan, next, symmetric, tol);
  }
}

/** A band column's station (the §11 `BandStation` without its laws). */
export interface Column {
  /** Greville parameter, wrapped into [0, 1) (exactly 0 or ½ when self-paired). */
  readonly u: number;
  readonly sigma: number;
  readonly frame: PlanFrame;
  readonly partner: number;
  readonly role: PairRole;
}

/**
 * The columns of a band basis: Greville abscissae, σ, frames and the pairing
 * (module comment). Throws `Error` where the plan has no tangent (a cusp; a
 * validated plan has none).
 */
export function bandColumns(b: BandBasis, arc: PlanArc): readonly Column[] {
  const g = grevilleAbscissae(b.basis);
  const n = b.basis.count;
  const symmetric = b.pairing !== null;
  const u = new Float64Array(n);
  const sigma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const role = b.pairing?.role[i];
    u[i] = role === 'self' ? (circ(wrapUnit(g[i]!), 0.5) < 0.25 ? 0.5 : 0) : wrapUnit(g[i]!);
    if (role !== 'partner') sigma[i] = sigmaAt(arc, u[i]!);
  }
  const out: Column[] = [];
  for (let i = 0; i < n; i++) {
    const role: PairRole = b.pairing?.role[i] ?? 'master';
    const partner = b.pairing?.partner[i] ?? i;
    if (role === 'partner') sigma[i] = 1 - sigma[partner]!;
    const frame = planFrame(arc.curve, u[i]!, symmetric);
    if (frame === null) throw new Error(`band column ${i}: the plan has no tangent at u = ${u[i]}`);
    out.push(Object.freeze({ u: u[i]!, sigma: sigma[i]!, frame, partner, role }));
  }
  return Object.freeze(out);
}
