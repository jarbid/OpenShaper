// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Symmetry as a constraint (docs/design/board2.md §3.7, decision 11).
 *
 * Data is always full width. A symmetric board pairs every control point with
 * its mirror image in the plane y = 0, and expresses the pairing to geom's
 * solver as **DOF rules** (geom §6.13, §10.3): a partner is a `mirror` of its
 * master, a self-paired point has its y locked (`fixAxes`). geom re-applies
 * coordinate-plane mirrors from the masters after every solve, so both halves
 * agree with `===`; asymmetric boards (Phase 6) drop the mirror rules and
 * nothing else.
 *
 * **Pairing is computed, not assumed.** For a periodic basis with a
 * mirror-symmetric knot set, the function of control point i, reflected
 * through u ↦ −u, is the function whose Greville abscissa is `−ū_i (mod T)`:
 * {@link periodicPairing} finds that partner from the abscissae and checks the
 * result is an involution. Points with `ū ∈ (0, ½)` (the −y half, §3.2) are
 * masters, those at `ū = 0` or `½` pair with themselves. A clamped direction
 * with symmetric knots (the height fields' v) pairs `j ↔ m − 1 − j`.
 *
 * | Net           | Masters                         | Partners             | Self-paired           |
 * | ------------- | ------------------------------- | -------------------- | --------------------- |
 * | Plan loop     | ū ∈ (0, ½), free                | `mirror` in y = 0    | `fixAxes` y           |
 * | Height fields | j < (m − 1)/2, `fixAxes` x, y   | `mirror` in y = 0    | `fixAxes` x, y        |
 * | Band          | ū ∈ (0, ½) (row rules: step S3) | `mirror`, every row  | `fixAxes` y (S3: row rules with ŷ-free directions) |
 */
import {
  controlPointsInto,
  resolveTolerances,
  surfaceControlPoint,
  withControlPoints,
} from '@openshaper/geom';
import type {
  Basis,
  ClampedBasis,
  DofRule,
  NurbsCurve,
  NurbsSurface,
  PeriodicBasis,
  Tolerances,
} from '@openshaper/geom';
import { grevilleAbscissae } from './height-field';
import { board2Err, board2Ok, makeIssue } from './issues';
import type { Board2Issue, Board2Result, BoardFace, BuiltBoard, HeightFieldJSON } from './types';

/** The mirror plane of a symmetric board: y = 0 (a coordinate plane, so mirrors are bitwise). */
export const MIRROR_PLANE = Object.freeze({
  normal: Object.freeze({ x: 0, y: 1, z: 0 }),
  d: 0,
});

/** DOF bitmasks of geom's `fixAxes` (x = 1, y = 2, z = 4). */
const AXIS_Y = 2;
const AXES_XY = 3;

/** What a control point is in a symmetric net. */
export type PairRole = 'master' | 'partner' | 'self';

/** The mirror pairing of one direction's control points. */
export interface Pairing {
  /** Partner index per control point (its own index when self-paired). */
  readonly partner: Int32Array;
  readonly role: readonly PairRole[];
}

/** A pairing, or why there is none. */
export type PairingResult =
  | { readonly ok: true; readonly pairing: Pairing }
  | { readonly ok: false; readonly message: string; readonly u?: number };

/** `x` wrapped into `[0, T)`. */
function wrap(x: number, T: number): number {
  if (x >= 0 && x < T) return x;
  let r = x % T;
  if (r < 0) r += T;
  return r < T ? r : 0;
}

/** Distance on the circle of circumference `T`. */
function circ(a: number, b: number, T: number): number {
  const d = Math.abs(a - b) % T;
  return Math.min(d, T - d);
}

/**
 * Whether a periodic knot set is invariant under `u ↦ −u (mod T)`, multiplicities
 * included, within `paramRel × T` per knot (knots are design data; the slack
 * only absorbs the rounding of `T − t`).
 */
export function periodicKnotsSymmetric(b: PeriodicBasis, tol?: Partial<Tolerances>): boolean {
  const slack = resolveTolerances(tol).paramRel * b.period;
  const T = b.period;
  const a = Array.from(b.knots, (t) => wrap(t, T));
  const used = new Uint8Array(a.length);
  for (const t of a) {
    const m = wrap(T - t, T);
    let hit = -1;
    for (let k = 0; k < a.length; k++) {
      if (!used[k] && circ(a[k]!, m, T) <= slack) {
        hit = k;
        break;
      }
    }
    if (hit < 0) return false;
    used[hit] = 1;
  }
  return true;
}

/**
 * The mirror pairing of a periodic basis (§3.7): partner j of control point i
 * has `ū_j ≡ −ū_i (mod T)` within `paramRel × T`, and the result must be an
 * involution. Refused when the knot set is not symmetric, a point has no
 * partner, or two points claim the same one.
 */
export function periodicPairing(b: PeriodicBasis, tol?: Partial<Tolerances>): PairingResult {
  const T = b.period;
  const slack = resolveTolerances(tol).paramRel * T;
  if (!periodicKnotsSymmetric(b, tol)) {
    return { ok: false, message: 'the knot set is not invariant under u ↦ −u (mod 1)' };
  }
  const g = Array.from(grevilleAbscissae(b), (x) => wrap(x, T));
  const n = g.length;
  const partner = new Int32Array(n);
  const role: PairRole[] = [];
  for (let i = 0; i < n; i++) {
    const m = wrap(T - g[i]!, T);
    let best = -1;
    let dist = Infinity;
    for (let j = 0; j < n; j++) {
      const d = circ(g[j]!, m, T);
      if (d < dist) [best, dist] = [j, d];
    }
    if (!(dist <= slack)) {
      return {
        ok: false,
        message: `control point ${i} (Greville u ${g[i]}) has no mirror partner`,
        u: g[i]!,
      };
    }
    partner[i] = best;
    const onTip = circ(g[i]!, 0, T) <= slack || circ(g[i]!, T / 2, T) <= slack;
    role.push(onTip ? 'self' : g[i]! < T / 2 ? 'master' : 'partner');
  }
  for (let i = 0; i < n; i++) {
    const j = partner[i]!;
    const selfOk = (role[i] === 'self') === (j === i);
    if (partner[j] !== i || !selfOk) {
      return {
        ok: false,
        message: `the pairing is not an involution at control point ${i}`,
        u: g[i]!,
      };
    }
  }
  return { ok: true, pairing: Object.freeze({ partner, role: Object.freeze(role) }) };
}

/**
 * The pairing of a clamped direction with symmetric knots (`t_k + t_{L−k} =
 * a + b` within `paramRel` of the domain): `j ↔ m − 1 − j`, the middle point
 * (odd m) self-paired, the lower half masters.
 */
export function clampedPairing(b: ClampedBasis, tol?: Partial<Tolerances>): PairingResult {
  const [a, e] = b.domain;
  const slack = resolveTolerances(tol).paramRel * (e - a);
  const U = b.knots;
  const L = U.length;
  for (let k = 0; k < L; k++) {
    if (!(Math.abs(U[k]! + U[L - 1 - k]! - (a + e)) <= slack)) {
      return { ok: false, message: `knots are not symmetric about the domain centre (knot ${k})` };
    }
  }
  const m = b.count;
  const partner = new Int32Array(m);
  const role: PairRole[] = [];
  for (let j = 0; j < m; j++) {
    partner[j] = m - 1 - j;
    role.push(2 * j + 1 === m ? 'self' : 2 * j < m - 1 ? 'master' : 'partner');
  }
  return { ok: true, pairing: Object.freeze({ partner, role: Object.freeze(role) }) };
}

/** Pairing of either kind of basis. */
export function basisPairing(b: Basis, tol?: Partial<Tolerances>): PairingResult {
  return b.kind === 'periodic' ? periodicPairing(b, tol) : clampedPairing(b, tol);
}

// ---------------------------------------------------------------------------
// Document checks (validateBoard, plan invariant 4 and §3.4's symmetric mode)
// ---------------------------------------------------------------------------

/**
 * Plan invariant 4 (§3.3): the knot set is invariant under u ↦ −u, the
 * pairing exists, and the control points pair **bitwise**: a partner is
 * `(x_m, −y_m)` of its master, a self-paired point has `y === 0`.
 */
export function checkPlanSymmetry(
  c: NurbsCurve<2>,
  tol?: Partial<Tolerances>,
): readonly Board2Issue[] {
  if (c.basis.kind !== 'periodic') return [];
  const r = periodicPairing(c.basis, tol);
  if (!r.ok) {
    return [
      makeIssue(
        'symmetry-broken',
        `plan: ${r.message}`,
        r.u === undefined ? {} : { at: { u: r.u } },
      ),
    ];
  }
  const g = grevilleAbscissae(c.basis);
  const pts = new Float64Array(c.basis.count * 2);
  controlPointsInto(c, pts, 0);
  const out: Board2Issue[] = [];
  const { partner, role } = r.pairing;
  for (let i = 0; i < partner.length; i++) {
    const at = { u: wrap(g[i]!, c.basis.period) };
    if (role[i] === 'self' && pts[2 * i + 1] !== 0) {
      out.push(
        makeIssue('symmetry-broken', `plan: control point ${i} is on the stringer but y ≠ 0`, {
          at,
          value: pts[2 * i + 1]!,
        }),
      );
    }
    if (role[i] === 'partner') {
      const m = partner[i]!;
      if (pts[2 * i] !== pts[2 * m] || pts[2 * i + 1] !== -pts[2 * m + 1]!) {
        out.push(
          makeIssue(
            'symmetry-broken',
            `plan: control point ${i} is not the exact mirror of control point ${m}`,
            { at },
          ),
        );
      }
    }
  }
  return out;
}

/**
 * §3.4's symmetric mode for a height field: `y0 = −y1` bitwise, symmetric
 * v-knots, and `z_ij === z_i,(m−1−j)`.
 */
export function checkHeightFieldSymmetry(
  hf: HeightFieldJSON,
  face: BoardFace,
  tol?: Partial<Tolerances>,
): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const at = { face };
  if (hf.y[0] !== -hf.y[1]) {
    out.push(makeIssue('symmetry-broken', `${face}: y extent must be [−a, a] exactly`, { at }));
  }
  const L = hf.knotsV.length;
  const slack = resolveTolerances(tol).paramRel;
  for (let k = 0; k < L; k++) {
    if (!(Math.abs(hf.knotsV[k]! + hf.knotsV[L - 1 - k]! - 1) <= slack)) {
      out.push(makeIssue('symmetry-broken', `${face}: v knots are not symmetric about ½`, { at }));
      break;
    }
  }
  const m = L - hf.degreeV - 1;
  const nu = hf.knotsU.length - hf.degreeU - 1;
  let bad = 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; 2 * j < m - 1; j++) {
      if (hf.z[i * m + j] !== hf.z[i * m + m - 1 - j]) bad++;
    }
  }
  if (bad > 0) {
    out.push(
      makeIssue(
        'symmetry-broken',
        `${face}: ${bad} control height(s) differ from their mirror partner`,
        { at, value: bad },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOF rules (what Phase 3's solver receives)
// ---------------------------------------------------------------------------

/** Plan loop: partners mirror their masters; self-paired points keep y (= 0). */
export function planSymmetryRules(pairing: Pairing): readonly DofRule[] {
  const rules: DofRule[] = [];
  for (let i = 0; i < pairing.partner.length; i++) {
    if (pairing.role[i] === 'partner') {
      rules.push({ kind: 'mirror', cp: i, master: pairing.partner[i]!, plane: MIRROR_PLANE });
    } else if (pairing.role[i] === 'self') {
      rules.push({ kind: 'fixAxes', cp: i, axes: AXIS_Y });
    }
  }
  return Object.freeze(rules);
}

/**
 * Height field (u-major net `i · m + j`): x and y are fixed everywhere (the
 * affine graph), z is free on masters and self-paired rows, and partner rows
 * mirror their masters.
 */
export function heightFieldSymmetryRules(nu: number, v: Pairing): readonly DofRule[] {
  const m = v.partner.length;
  const rules: DofRule[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < m; j++) {
      const cp = i * m + j;
      if (v.role[j] === 'partner') {
        rules.push({ kind: 'mirror', cp, master: i * m + v.partner[j]!, plane: MIRROR_PLANE });
      } else {
        rules.push({ kind: 'fixAxes', cp, axes: AXES_XY });
      }
    }
  }
  return Object.freeze(rules);
}

/**
 * Band (u periodic along the loop, `rows` control rows in v; net `i · rows +
 * r`): every row of a partner column mirrors the same row of its master
 * column; self-paired columns keep y (= 0). Masters carry no rule here: the
 * structural row rules of §3.5 (step S3) are added on master columns and, with
 * directions whose y-component is exactly 0, replace the y lock on self-paired
 * columns.
 */
export function bandSymmetryRules(u: Pairing, rows: number): readonly DofRule[] {
  const rules: DofRule[] = [];
  for (let i = 0; i < u.partner.length; i++) {
    for (let r = 0; r < rows; r++) {
      const cp = i * rows + r;
      if (u.role[i] === 'partner') {
        rules.push({ kind: 'mirror', cp, master: u.partner[i]! * rows + r, plane: MIRROR_PLANE });
      } else if (u.role[i] === 'self') {
        rules.push({ kind: 'fixAxes', cp, axes: AXIS_Y });
      }
    }
  }
  return Object.freeze(rules);
}

/** The nets {@link symmetryRules} knows (the §11.2 `net` argument). */
export type SymmetryNet = 'plan' | 'deck' | 'bottom' | 'band';

/**
 * The symmetry DOF rules of one net of a (partly) built board (§3.7, §11.2).
 * The pairing is computed from the net's own basis and checked; a net that is
 * absent or has no pairing is an error result (`symmetry-broken`), never a
 * throw. For a height field the control grid's x and y must also be paired
 * bitwise (a symmetric extent, built in `'mirror-y'` mode), since the mirror
 * rules overwrite them; z, and the plan's and band's control points, are what
 * the rules pair (they come from the mirror overwrite; `validateBoard` checks
 * the document's). Feed the rules to geom's `makeDofMap` together with any
 * other rules for points the symmetry leaves free.
 */
export function symmetryRules(
  b: Partial<Pick<BuiltBoard, 'plan' | 'deck' | 'bottom' | 'band'>>,
  net: SymmetryNet,
  tol?: Partial<Tolerances>,
): Board2Result<readonly DofRule[]> {
  const fail = (message: string, u?: number): Board2Result<readonly DofRule[]> =>
    board2Err([
      makeIssue('symmetry-broken', `${net}: ${message}`, u === undefined ? {} : { at: { u } }),
    ]);
  if (net === 'plan') {
    const c = b.plan;
    if (c === undefined) return fail('no plan loop given');
    const r = periodicPairing(c.basis, tol);
    return r.ok ? board2Ok(planSymmetryRules(r.pairing)) : fail(r.message, r.u);
  }
  const s: NurbsSurface | undefined = b[net];
  if (s === undefined) return fail(`no ${net} surface given`);
  if (net === 'band') {
    if (s.u.kind !== 'periodic') return fail('the band must be periodic in u');
    const r = periodicPairing(s.u, tol);
    return r.ok ? board2Ok(bandSymmetryRules(r.pairing, s.v.count)) : fail(r.message, r.u);
  }
  if (s.v.kind !== 'clamped') return fail('a height field is clamped in v');
  const r = clampedPairing(s.v, tol);
  if (!r.ok) return fail(r.message);
  // The mirror rules overwrite a partner's x and y from its master, so the affine
  // grid must already be paired: otherwise a solve would move partner rows off it
  // and the surface would stop being a graph z = F(x, y).
  const bad = heightFieldGridAsymmetry(s, r.pairing);
  if (bad !== null) return fail(bad);
  return board2Ok(heightFieldSymmetryRules(s.u.count, r.pairing));
}

/**
 * Where a height field's control grid is not mirror-paired bitwise in x and y
 * (a partner `(x_m, −y_m)` of its master row, the middle row on y = 0), or
 * `null`. z is not judged: pairing it is what the mirror rules do.
 */
function heightFieldGridAsymmetry(s: NurbsSurface, v: Pairing): string | null {
  for (let i = 0; i < s.u.count; i++) {
    for (let j = 0; j < v.partner.length; j++) {
      const p = surfaceControlPoint(s, i, j);
      if (v.role[j] === 'self' && p.y !== 0) {
        return `control point (${i}, ${j}) is on the stringer row but y ≠ 0`;
      }
      if (v.role[j] === 'partner') {
        const m = surfaceControlPoint(s, i, v.partner[j]!);
        if (p.x !== m.x || p.y !== -m.y) {
          return `control point (${i}, ${j}) is not the mirror in x, y of (${i}, ${v.partner[j]}): the y extent must be [−a, a] and the grid paired bitwise`;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The exact mirror overwrite (§3.7 "Build")
// ---------------------------------------------------------------------------

/**
 * Overwrites every partner control point of a polynomial curve with the exact
 * mirror of its master (`y ↦ −y`, other coordinates copied) and sets y to 0 on
 * self-paired points. On a curve that is symmetric up to rounding this only
 * removes the rounding; afterwards the pairs are mirror images bit for bit.
 */
export function mirrorOverwriteCurve<C extends NurbsCurve<2> | NurbsCurve<3>>(
  c: C,
  pairing: Pairing,
): C {
  const d = c.dim;
  const pts = new Float64Array(c.basis.count * d);
  controlPointsInto(c, pts, 0);
  mirrorRows(pts, d, 1, pairing);
  return withControlPoints(c, pts);
}

/**
 * The same overwrite on the columns of a surface's u-major Euclidean net
 * (`rows` points per column, stride 3), in place: column i of a partner takes
 * the mirror of column `partner[i]`.
 */
export function mirrorOverwriteColumns(points: Float64Array, rows: number, pairing: Pairing): void {
  mirrorRows(points, 3, rows, pairing);
}

function mirrorRows(pts: Float64Array, d: number, rows: number, pairing: Pairing): void {
  for (let i = 0; i < pairing.partner.length; i++) {
    for (let r = 0; r < rows; r++) {
      const o = (i * rows + r) * d;
      if (pairing.role[i] === 'self') pts[o + 1] = 0;
      else if (pairing.role[i] === 'partner') {
        const m = (pairing.partner[i]! * rows + r) * d;
        for (let k = 0; k < d; k++) pts[o + k] = k === 1 ? -pts[m + 1]! : pts[m + k]!;
      }
    }
  }
}
