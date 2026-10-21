// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail profile of one band column (docs/design/board2.md §5.3, decision 16)
 * and its inverse, reading the laws back off seven points (§5.7).
 *
 * A column lives in its **station plane**, spanned by the outward normal
 * `ô = −n̂` and `ẑ`. Coordinates `(o, z)` there are measured from the apex
 * point's plan position `A.xy` (the plan control point), so `A = (0, A.z)`, the
 * deck edge `E = (−w_d, E.z)` and the tuck `T = (−w_t, T.z)`; a point maps to
 * 3D as `A.xy + w n̂ + z ẑ` with `w = −o` (inwards positive).
 *
 * - **Upper half** (E → A) on the corner `C_u = (0, E.z + s_d w_d)`, where the
 *   deck's tangent line at E meets the apex vertical (`s_d = ∂D/∂ô` at E):
 *   `P1 = E + f_u (C_u − E)` (along the deck tangent: the deck join is G1 at the
 *   column), `P2 = A + f_u H_u ẑ` with `H_u = C_u.z − A.z > 0` (vertical), `P3 = A`.
 *   With `f_u = 2/3` this is the degree elevation of the quadratic (E, C_u, A).
 * - **Lower half** (A → T) on `C_l = (0, T.z + s_b w_t)` (`s_b = ∂B/∂ô` at T):
 *   `P4 = A − f_l H_l ẑ` with `H_l = A.z − C_l.z > 0`, and the tuck handle along
 *   the bottom tangent `û_b = (1, s_b)/|·|` rotated towards the **handle chord**
 *   `P4 − T` by `h · φ_chord` (`φ_chord` the angle from `û_b` to `P4 − T`):
 *   `P5 = T + f_l |C_l − T| · rot(û_b, h φ_chord)`, `P6 = T`. The crease angle
 *   between bottom and band in the station plane is `h · φ_chord`.
 *   Deviation from §5.3 (board2.md, S3 as built): the design rotates towards
 *   the chord `A − T`, which puts P5 inside the line `P4 − T` (an inflection,
 *   a concave dip above the tuck) for every hardness above `φ'/φ`; rotating
 *   towards `P4 − T` keeps the lower profile convex for every `h ∈ [0, 1]`, as
 *   §5.3 intends (at `h = 1` it leaves the tuck straight towards the lower
 *   apex handle, which tends to the apex as `f_l → 0`).
 *
 * The offset layer (§6.1) then moves P1 along the unit deck tangent, P2 and P4
 * along ẑ and P5 in the station plane; the edge-row offsets are already in the
 * effective insets. The handles stay where the structural rules put them
 * (P2, P4 on the apex vertical with `x, y` copied bitwise from A, so the apex
 * join is G1 by construction, §3.5).
 *
 * Polynomial only (decision 17): the weights are all 1, returned so a rational
 * profile (D5) changes this function and not its callers.
 */
import { controlPointsInto, isoCurve } from '@openshaper/geom';
import type { NurbsSurface, Tolerances } from '@openshaper/geom';
import { heightSampler } from '../height-field';
import type { HeightSample } from '../height-field';
import { makeIssue } from '../issues';
import type { OffsetValues } from '../offsets';
import { planFrame } from '../plan';
import type { PlanFrame } from '../plan';
import type { Board2Issue, BuildParams, BuiltBoard, RailLawValues } from '../types';

/** The seven rows of a column. */
export const BAND_ROWS = 7;

/** Samples a height field at plan (x, y). */
export type HeightSampler = (x: number, y: number) => HeightSample;

/** What a column is built from (stages 5 and 7 of §6.3 done by the caller). */
export interface ColumnSpec {
  /** The apex point's plan position (the band's row-3 control point). */
  readonly ax: number;
  readonly ay: number;
  readonly frame: PlanFrame;
  /** Effective insets (laws + edge offsets, curvature-limited), cm. */
  readonly deckInset: number;
  readonly tuckInset: number;
  readonly apexHeight: number;
  readonly upperFullness: number;
  readonly lowerFullness: number;
  readonly edgeHardness: number;
  /** The handle offsets of the column (the edge-row parts are in the insets). */
  readonly offsets: OffsetValues;
}

/** A built column: rows 0…6 as `x, y, z` triples, weights, and the construction's quantities. */
export interface ProfileColumn {
  readonly points: Float64Array;
  /** All 1 (polynomial profiles, decision 17). */
  readonly weights: Float64Array;
  /** Deck and bottom slopes along ô at E and T. */
  readonly sd: number;
  readonly sb: number;
  /** Corner heights above / below the apex (both > 0 on a valid column). */
  readonly hu: number;
  readonly hl: number;
  /**
   * Angle from the bottom tangent to the handle chord P4 − T, and the designed crease:
   * the angle of the final tuck handle `P5 − T` from the bottom tangent (radians;
   * `h · φ_chord` exactly when the tuck handle has no offset).
   */
  readonly phiChord: number;
  readonly crease: number;
  /** `rail-height`, `rail-profile-invalid` (errors) at this column. */
  readonly issues: readonly Board2Issue[];
}

/** Where a column is, for the issues it reports. */
export interface ColumnAt {
  readonly sigma: number;
  readonly u: number;
}

/**
 * Builds one column (module comment): heights from the surfaces, the corner
 * triangles, the seven points, then the handle offsets. Never throws; an
 * invalid profile is reported in `issues` (its points are still finite where
 * the inputs are).
 */
export function profileRows(
  spec: ColumnSpec,
  deck: HeightSampler,
  bottom: HeightSampler,
  build: Pick<BuildParams, 'minRailHeight'>,
  at: ColumnAt,
): ProfileColumn {
  const issues: Board2Issue[] = [];
  const n = spec.frame.inward;
  const wd = spec.deckInset;
  const wt = spec.tuckInset;
  const ex = spec.ax + wd * n.x;
  const ey = spec.ay + wd * n.y;
  const tx = spec.ax + wt * n.x;
  const ty = spec.ay + wt * n.y;
  // ô = −n̂: the slope along ô is −∇z · n̂.
  const D = deck(ex, ey);
  const B = bottom(tx, ty);
  const sd = -(D.dzdx * n.x + D.dzdy * n.y);
  const sb = -(B.dzdx * n.x + B.dzdy * n.y);
  const ez = D.z;
  const tz = B.z;
  const loc = { sigma: at.sigma, u: at.u };
  if (!(ez - tz >= build.minRailHeight)) {
    issues.push(
      makeIssue(
        'rail-height',
        `rail height E.z − T.z = ${ez - tz} at σ = ${at.sigma} is below minRailHeight ${build.minRailHeight}`,
        { at: loc, value: ez - tz },
      ),
    );
  }
  const az = tz + spec.apexHeight * (ez - tz);
  const hu = ez + sd * wd - az;
  const hl = az - (tz + sb * wt);
  const invalid = (what: string, value: number): void => {
    issues.push(
      makeIssue('rail-profile-invalid', `rail profile at σ = ${at.sigma}: ${what}`, {
        at: loc,
        value,
      }),
    );
  };
  if (!(hu > 0)) {
    invalid('the deck falls below the apex height (H_u ≤ 0): no convex upper profile', hu);
  }
  if (!(hl > 0)) {
    invalid('the bottom rises above the apex height (H_l ≤ 0): no convex lower profile', hl);
  }
  const fu = spec.upperFullness;
  const fl = spec.lowerFullness;
  const off = spec.offsets;

  // Station-plane (w, z): w = inset (inwards), so o = −w.
  const p = new Float64Array(BAND_ROWS * 3);
  const put = (r: number, w: number, z: number): void => {
    p[3 * r] = spec.ax + w * n.x;
    p[3 * r + 1] = spec.ay + w * n.y;
    p[3 * r + 2] = z;
  };
  // Upper half. The deck tangent in the station plane, unit: (ô + s_d ẑ)/√(1 + s_d²).
  const td = Math.hypot(1, sd);
  const p1w = wd - fu * wd - off.deckHandleL / td;
  const p1z = ez + fu * sd * wd + (off.deckHandleL * sd) / td;
  put(0, wd, ez);
  put(1, p1w, p1z);
  // P2, P3, P4 share A.xy bitwise: the apex join is G1 by construction.
  const b2 = fu * hu + off.apexUpperZ;
  const b4 = fl * hl - off.apexLowerZ;
  p[6] = spec.ax;
  p[7] = spec.ay;
  p[8] = az + b2;
  p[9] = spec.ax;
  p[10] = spec.ay;
  p[11] = az;
  p[12] = spec.ax;
  p[13] = spec.ay;
  p[14] = az - b4;
  if (!(b2 > 0)) invalid('the upper apex handle has no length (after offsets)', b2);
  if (!(b4 > 0)) invalid('the lower apex handle has no length (after offsets)', b4);
  if (!(fu * wd * td + off.deckHandleL > 0)) {
    invalid('the deck handle has no length (after offsets)', fu * wd * td + off.deckHandleL);
  }
  // Lower half: the bottom tangent rotated towards the handle chord P4 − T by h·φ_chord
  // (P4 is on the apex vertical, a horizontal distance w_t from T). The law's P4,
  // before its offset, so an apex-handle offset moves its own row only.
  const thetaB = Math.atan2(sb, 1);
  const phiChord = Math.atan2(az - fl * hl - tz, wt) - thetaB;
  const len = fl * wt * Math.hypot(1, sb);
  const theta = thetaB + spec.edgeHardness * phiChord;
  // Direction (o, z) = (cos θ, sin θ); in w: −cos θ.
  const p5w = wt - len * Math.cos(theta) + off.tuckHandleN;
  const p5z = tz + len * Math.sin(theta) + off.tuckHandleZ;
  put(5, p5w, p5z);
  put(6, wt, tz);
  const crease =
    off.tuckHandleN === 0 && off.tuckHandleZ === 0
      ? spec.edgeHardness * phiChord
      : Math.atan2(p5z - tz, wt - p5w) - thetaB;
  // §5.3: every point inboard of or on the apex vertical (w ≥ 0), so by the
  // convex-hull property no profile reaches past its apex and the outline stays
  // the widest line. P0, P6 have w > 0 (insets ≥ minInset), P2–P4 have w = 0,
  // so only the two offset handles can break it.
  if (!(p1w >= 0)) invalid('the deck handle reaches past the apex vertical', p1w);
  if (!(p5w >= 0)) invalid('the tuck handle reaches past the apex vertical', p5w);
  const weights = new Float64Array(BAND_ROWS).fill(1);
  return Object.freeze({
    points: p,
    weights,
    sd,
    sb,
    hu,
    hl,
    phiChord,
    crease,
    issues: Object.freeze(issues),
  });
}

/**
 * The six lane values read off a column's seven points (§5.7: the formulas of
 * §5.3 inverted), in the station plane of `frame`:
 *
 * - insets: `(E − A) · n̂` and `(T − A) · n̂` (horizontal);
 * - apex height: `(A.z − T.z) / (E.z − T.z)`;
 * - upper fullness: `(P2.z − A.z) / H_u`, with the deck slope read from the
 *   deck handle `P1 − P0` itself and `H_u = E.z + s_d w_d − A.z`;
 * - lower fullness: `(A.z − P4.z) / H_l`, `H_l = A.z − (T.z + s_b w_t)` with `s_b`
 *   the bottom's slope along ô at T (`sb`, from the bottom surface);
 * - edge hardness: the angle of `P5 − T` from the bottom tangent, over
 *   `φ_chord` (the angle of the handle chord `P4 − T`).
 *
 * On a column built by {@link profileRows} with no offsets this returns its
 * inputs (to rounding); on an iso-curve of the band between columns it is
 * "the law the surface actually has" (§5.7).
 *
 * Hardness is read against the column's **actual** P4, the only P4 the points
 * carry. The construction rotates towards the law's P4, before an `apexLower`
 * offset (S3 deviation 1), so such an offset keeps P5 and the crease but
 * changes the measured hardness to `h · φ_law / φ_actual`. Fidelity is
 * unaffected (the design side is measured with this function too); a reader
 * of {@link measureLaws} sees that shift as the offset's, not a hardness edit.
 */
export function measureColumn(q: ArrayLike<number>, frame: PlanFrame, sb: number): RailLawValues {
  const n = frame.inward;
  const ax = q[9]!;
  const ay = q[10]!;
  const az = q[11]!;
  const along = (r: number): number => (q[3 * r]! - ax) * n.x + (q[3 * r + 1]! - ay) * n.y;
  const wd = along(0);
  const wt = along(6);
  const ez = q[2]!;
  const tz = q[20]!;
  // Deck slope along ô from the deck handle: Δz / Δo with Δo = −Δw.
  const dw = along(1) - wd;
  const sd = (q[5]! - ez) / -dw;
  const hu = ez + sd * wd - az;
  const hl = az - (tz + sb * wt);
  const thetaB = Math.atan2(sb, 1);
  const phiChord = Math.atan2(q[14]! - tz, wt - along(4)) - thetaB;
  const theta5 = Math.atan2(q[17]! - tz, -(along(5) - wt));
  return Object.freeze({
    deckInset: wd,
    tuckInset: wt,
    apexHeight: (az - tz) / (ez - tz),
    upperFullness: (q[8]! - az) / hu,
    lowerFullness: (az - q[14]!) / hl,
    edgeHardness: (theta5 - thetaB) / phiChord,
  });
}

/** The iso-curve of the band at `u` (fixed u, a curve in v): its seven control points `x, y, z`. */
export function isoColumn(band: NurbsSurface, u: number): Float64Array {
  const q = new Float64Array(BAND_ROWS * 3);
  controlPointsInto(isoCurve(band, 'u', u), q, 0);
  return q;
}

/**
 * The laws measured off the band's iso-curve at `u` in the station plane of
 * `frame` (§5.7), with the bottom's slope along ô at the iso-curve's tuck point.
 */
export function measuredLawsAt(
  band: NurbsSurface,
  frame: PlanFrame,
  bottomAt: (x: number, y: number) => HeightSample,
  u: number,
): RailLawValues {
  const q = isoColumn(band, u);
  const s = bottomAt(q[18]!, q[19]!);
  const n = frame.inward;
  return measureColumn(q, frame, -(s.dzdx * n.x + s.dzdy * n.y));
}

/**
 * The six lane values the band actually has at loop parameter `u` (§5.7,
 * §11.2): its iso-curve in v read back with {@link measureColumn} in the
 * station plane of the plan frame at `u`. Exact at the columns of a law-only
 * band where neighbouring columns agree (a straight, constant-law stretch);
 * between columns it is what the fidelity check (§5.4) compares with the laws.
 * Edge hardness is measured against the surface's own lower apex handle, so
 * an `apexLower` offset shifts it (see {@link measureColumn}).
 *
 * Takes the parts of a built board it reads (`buildBoard` arrives in step S4;
 * a `BuiltBoard` satisfies the type): the document (symmetry and the bottom's
 * extent), the plan loop, the band and the bottom the band meets. Throws
 * `RangeError` where the plan has no tangent at `u`.
 */
export function measureLaws(
  b: Pick<BuiltBoard, 'doc' | 'plan' | 'band' | 'bottom'>,
  u: number,
  tol?: Partial<Tolerances>,
): RailLawValues {
  const frame = planFrame(b.plan, u, b.doc.symmetry === 'mirror-y');
  if (frame === null) throw new RangeError(`measureLaws: the plan has no tangent at u = ${u}`);
  return measuredLawsAt(b.band, frame, heightSampler(b.bottom, b.doc.bottom, tol), u);
}
