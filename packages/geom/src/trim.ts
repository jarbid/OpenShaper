// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trim loops and trimmed surfaces (design §6.16, §4.7, decisions 29 and 30).
 *
 * - **Loops.** A trim loop is a closed chain of clamped 2D curves in a
 *   surface's (u, v) domain, head to tail with **bitwise** joins (the Euclidean
 *   end control point of curve i equals the start control point of curve
 *   i + 1, and the last ends where the first starts). `signedArea` is the
 *   (u, v) area by Green's theorem, `½∮(u dv − v du)`; positive ⇔
 *   counter-clockwise.
 * - **Orientation.** Material is on the left: the outer loop is counter-
 *   clockwise, holes clockwise. {@link makeTrimmedSurface} reverses a loop
 *   with the wrong orientation and reports it as a warning (decision 30).
 * - **Natural boundary.** `outer = null` means the domain rectangle. Trim loops
 *   are accepted only on surfaces clamped in both directions (decision 29):
 *   a periodic direction has no closed natural loop in (u, v).
 * - **Validation** is certified by subdivision of the loops' rational Bézier
 *   pieces (`pieces.ts`): bounding boxes of the control points contain the
 *   pieces. The resolution is `uvTol = paramRel × max(L_u, L_v)` (parameter
 *   equality, design §7): curves closer than that are treated as touching, and
 *   classification reports `'boundary'` for points within `√2 · uvTol` of a
 *   loop; every point farther away is classified exactly (winding number by a
 *   certified ray crossing count).
 */
import { checkBasisShape, curveEvalInto, curveFromHomogeneous, makeCurve } from './curve';
import { makeScratch } from './array';
import { clampedBasis, sanitizeParam } from './basis';
import { curveOnSurface, curveOnSurfaceEvalInto } from './curve-on-surface';
import { errResult, fail, okResult } from './errors';
import { bezierPieces, ctrl, monotone, pieceBox, splitPiece } from './pieces';
import type { Piece } from './pieces';
import { checkSeeding, closestPointOnSurface, closestPointOnSurfaceWhere } from './project';
import type { ProjectionSeeding, SurfaceProjection } from './project';
import { gaussLegendre, integrate1d } from './quadrature';
import { checkSurfaceShape } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  ClampedCurve,
  GeomIssue,
  NurbsSurface,
  Point2,
  Point3,
  Result,
  TrimLoop,
  TrimmedSurface,
  UV,
} from './types';

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

function checkPcurve(c: ClampedCurve<2>, i: number): void {
  if (typeof c !== 'object' || c === null) fail('size-mismatch', `trim curve ${i} is not a curve`);
  checkBasisShape(c.basis);
  if (c.dim !== 2) {
    fail('dimension-mismatch', `trim curve ${i} must be 2D (u, v); got dimension ${c.dim}`, {
      index: i,
    });
  }
  if (c.basis.kind !== 'clamped') {
    fail('unsupported', `trim curve ${i} must be clamped (convert periodic curves first)`, {
      index: i,
    });
  }
  if (!(c.cw instanceof Float64Array) || c.cw.length !== 3 * c.basis.count) {
    fail('size-mismatch', `trim curve ${i}: net does not match its basis (use makeCurve)`, {
      index: i,
    });
  }
}

/** Euclidean start / end control point (the curve's exact ends; `cw / w` as `controlPoint`). */
const startOf = (c: ClampedCurve<2>): Point2 => ({
  x: c.cw[0]! / c.cw[2]!,
  y: c.cw[1]! / c.cw[2]!,
});
function endOf(c: ClampedCurve<2>): Point2 {
  const o = 3 * (c.basis.count - 1);
  return { x: c.cw[o]! / c.cw[o + 2]!, y: c.cw[o + 1]! / c.cw[o + 2]! };
}

/** `c` with its first control point moved to `p` (weight kept); null if `p` is not reproduced bitwise. */
function withStart(c: ClampedCurve<2>, p: Point2): ClampedCurve<2> | null {
  const cw = Float64Array.from(c.cw);
  const w = cw[2]!;
  cw[0] = p.x * w;
  cw[1] = p.y * w;
  if (cw[0] / w !== p.x || cw[1] / w !== p.y) return null;
  return curveFromHomogeneous({ dim: 2, basis: c.basis, cw }) as ClampedCurve<2>;
}

/**
 * Green's theorem area term `½∫(u v′ − v u′) dt` of one curve. Polynomial: the
 * integrand has degree `2q − 1` per span, so q-point Gauss–Legendre per span is
 * exact; rational: adaptive Gauss–Kronrod to `quadRel` (split at the knots).
 */
function areaTerm(c: ClampedCurve<2>, t: Tolerances): number {
  const q = c.basis.degree;
  const sc = makeScratch(q, 1);
  const out = new Float64Array(4);
  const g = (x: number): number => {
    curveEvalInto(c, x, 1, out, 0, sc);
    return 0.5 * (out[0]! * out[3]! - out[1]! * out[2]!);
  };
  const U = c.basis.knots;
  const [a, b] = c.basis.domain;
  if (!c.rational) {
    const rule = gaussLegendre(q);
    let s = 0;
    for (let k = q; k < c.basis.count; k++) {
      const lo = U[k]!;
      const hi = U[k + 1]!;
      if (!(hi > lo)) continue;
      const m = 0.5 * (lo + hi);
      const h = 0.5 * (hi - lo);
      for (let i = 0; i < q; i++) s += h * rule.weights[i]! * g(m + h * rule.nodes[i]!);
    }
    return s;
  }
  return integrate1d(g, a, b, { breaks: U, tol: t }).value;
}

function freezeLoop(curves: readonly ClampedCurve<2>[], t: Tolerances): TrimLoop {
  let area = 0;
  for (const c of curves) area += areaTerm(c, t);
  return Object.freeze({
    curves: Object.freeze(curves.slice()),
    signedArea: area,
  }) as unknown as TrimLoop;
}

/**
 * Join tolerance of a trim loop, in parameter units: `paramRel` (parameter
 * equality, design §7) times the larger side of the loop's control-point box.
 * A loop lives in (u, v), so its closure is a parameter question: `point`
 * (cm) has no meaning there, and mapping the gap to 3D would accept large
 * (u, v) gaps where the surface degenerates (a pole). The loop lies in the
 * domain, so this never exceeds the classification resolution `uvTol`.
 */
function joinTol(curves: readonly ClampedCurve<2>[], t: Tolerances): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of curves) {
    for (let i = 0; i < c.basis.count; i++) {
      const x = c.cw[3 * i]! / c.cw[3 * i + 2]!;
      const y = c.cw[3 * i + 1]! / c.cw[3 * i + 2]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return t.paramRel * Math.max(x1 - x0, y1 - y0);
}

/**
 * A trim loop from clamped 2D curves head to tail. Joins must be bitwise
 * (end control point of curve i = start control point of curve i + 1, and
 * last to first); with `snap`, a join within the parameter tolerance
 * `paramRel × max(box width, box height)` of the loop's control points (in
 * (u, v) units, see {@link joinTol}) is made bitwise by moving the next
 * curve's start control point (its weight kept). Errors (`trim-not-closed`):
 * a gap above that tolerance, or below it without `snap`, or a join a
 * weighted control point cannot reproduce bitwise. A loop of zero
 * signed area has no orientation (`trim-orientation`). Contract violations
 * (no curves, not 2D, not clamped) throw.
 */
export function makeTrimLoop(
  curves: readonly ClampedCurve<2>[],
  opts?: { readonly snap?: boolean; readonly tol?: Partial<Tolerances> },
): Result<TrimLoop> {
  const t = resolveTolerances(opts?.tol);
  if (!Array.isArray(curves) || curves.length === 0) {
    fail('too-few-points', 'a trim loop needs at least one curve');
  }
  curves.forEach(checkPcurve);
  const out = curves.slice();
  const n = out.length;
  const tolUV = joinTol(curves, t);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = endOf(out[i]!);
    const b = startOf(out[j]!);
    if (a.x === b.x && a.y === b.y) continue;
    const gap = Math.hypot(a.x - b.x, a.y - b.y);
    const at = { index: j, uv: { u: b.x, v: b.y } };
    if (gap > tolUV || !opts?.snap) {
      return errResult([
        {
          code: 'trim-not-closed',
          severity: 'error',
          message:
            gap > tolUV
              ? `trim curve ${i} ends ${gap} (u, v) from the start of curve ${j} (join tolerance ${tolUV} = paramRel × loop extent)`
              : `trim curve ${i} ends ${gap} from the start of curve ${j}: within tolerance but not bitwise (pass snap: true)`,
          at,
          value: gap,
        },
      ]);
    }
    const moved = withStart(out[j]!, a);
    if (moved === null) {
      return errResult([
        {
          code: 'trim-not-closed',
          severity: 'error',
          message: `cannot snap the start of trim curve ${j}: its weight does not reproduce the join bitwise`,
          at,
          value: gap,
        },
      ]);
    }
    out[j] = moved;
    // Curve j's start moved: if j === 0 the first join is already checked, recheck it.
    if (j === 0 && n > 1) {
      const e0 = endOf(out[0]!);
      const s1 = startOf(out[1]!);
      if (e0.x !== s1.x || e0.y !== s1.y) fail('trim-not-closed', 'snap broke the first join');
    }
  }
  const loop = freezeLoop(out, t);
  if (loop.signedArea === 0) {
    return errResult([
      {
        code: 'trim-orientation',
        severity: 'error',
        message: 'trim loop encloses zero signed area: its orientation is undefined',
        value: 0,
      },
    ]);
  }
  return okResult(loop);
}

/**
 * The natural boundary of a surface clamped in both directions as a
 * counter-clockwise loop of four straight pcurves: `v = v0` (u ascending),
 * `u = u1`, `v = v1` (u descending), `u = u0`, from the corner `(u0, v0)`. A
 * periodic direction has no closed natural loop (`trim-on-periodic`, thrown).
 */
export function naturalBoundaryLoop(s: NurbsSurface): TrimLoop {
  checkSurfaceShape(s);
  if (s.u.kind !== 'clamped' || s.v.kind !== 'clamped') {
    fail(
      'trim-on-periodic',
      'a surface with a periodic direction has no closed natural boundary loop',
    );
  }
  return rectangleLoop(s);
}

/**
 * The domain rectangle as a loop of four straight pcurves (internal: also for a
 * periodic direction, whose two seam edges then coincide on the surface; the
 * tessellator meshes a natural-boundary face over one period this way).
 */
export function rectangleLoop(s: NurbsSurface): TrimLoop {
  const [u0, u1] = s.u.domain;
  const [v0, v1] = s.v.domain;
  const corners = [u0, v0, u1, v0, u1, v1, u0, v1];
  const curves: ClampedCurve<2>[] = [];
  const basis = clampedBasis(1, [0, 0, 1, 1]);
  for (let k = 0; k < 4; k++) {
    const m = (k + 1) % 4;
    curves.push(
      makeCurve({
        dim: 2,
        basis,
        points: [corners[2 * k]!, corners[2 * k + 1]!, corners[2 * m]!, corners[2 * m + 1]!],
      }) as ClampedCurve<2>,
    );
  }
  return freezeLoop(curves, resolveTolerances());
}

/** A clamped 2D curve traversed backwards: knots `a + b − u`, control points reversed, same domain. */
function reverseCurve2(c: ClampedCurve<2>): ClampedCurve<2> {
  const p = c.basis.degree;
  const U = c.basis.knots;
  const m = U.length - 1;
  const [a, b] = c.basis.domain;
  const R = new Float64Array(m + 1);
  for (let i = 0; i <= m; i++) R[i] = i <= p ? a : i >= m - p ? b : a + b - U[m - i]!;
  const n = c.basis.count;
  const cw = new Float64Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) cw[3 * i + k] = c.cw[3 * (n - 1 - i) + k]!;
  return curveFromHomogeneous({ dim: 2, basis: clampedBasis(p, R), cw }) as ClampedCurve<2>;
}

/** The loop traversed backwards (curves reversed, in reverse order); area negated exactly. */
function reverseLoop(l: TrimLoop): TrimLoop {
  const curves = l.curves.slice().reverse().map(reverseCurve2);
  return Object.freeze({
    curves: Object.freeze(curves),
    signedArea: -l.signedArea,
  }) as unknown as TrimLoop;
}

// ---------------------------------------------------------------------------
// Certified subdivision searches
// ---------------------------------------------------------------------------

/** Loops of a trimmed surface as pieces: the outer (or natural) loop first, then each hole. */
export interface PreparedLoops {
  readonly loops: readonly TrimLoop[];
  /** Per loop, per curve, the curve's Bézier pieces. */
  readonly pieces: readonly (readonly (readonly Piece[])[])[];
  readonly uvTol: number;
}

/** The outer loop (the domain rectangle when natural) and the holes. */
export function loopsOf(ts: TrimmedSurface): TrimLoop[] {
  return [ts.outer ?? rectangleLoop(ts.surface), ...ts.holes];
}

export function prepareLoops(ts: TrimmedSurface, t: Tolerances): PreparedLoops {
  const loops = loopsOf(ts);
  return {
    loops,
    pieces: loops.map((l) => l.curves.map(bezierPieces)),
    uvTol: uvTolOf(ts.surface, t),
  };
}

function uvTolOf(s: NurbsSurface, t: Tolerances): number {
  const lu = s.u.domain[1] - s.u.domain[0];
  const lv = s.v.domain[1] - s.v.domain[0];
  return t.paramRel * (lu > lv ? lu : lv);
}

const boxSize = (b: readonly number[]): number => Math.max(b[2]! - b[0]!, b[3]! - b[1]!);

/**
 * Signed crossings of the ray `{(x′, y) : x′ > x}` by the piece (upward +1,
 * downward −1, half-open in y so shared piece ends count once), or `null` when
 * the point lies in the piece's box and that box is at most `tol` (on the
 * boundary). A piece entirely right of the point crosses the line only on the
 * ray, so its signed count follows from its ends alone (the curve is
 * continuous); a piece entirely left, above or below crosses nothing.
 */
function rayCrossings(pc: Piece, x: number, y: number, tol: number): number | null {
  const b = pieceBox(pc);
  if (b[1] > y || b[3] < y || b[2] < x) return 0;
  if (b[0] > x) {
    const ya = ctrl(pc, 0, 1);
    const yb = ctrl(pc, pc.p, 1);
    if (ya <= y && y < yb) return 1;
    if (yb <= y && y < ya) return -1;
    return 0;
  }
  if (boxSize(b) <= tol) return null;
  const [l, r] = splitPiece(pc, 0.5);
  const cl = rayCrossings(l, x, y, tol);
  if (cl === null) return null;
  const cr = rayCrossings(r, x, y, tol);
  return cr === null ? null : cl + cr;
}

/** Winding number of a loop's pieces round `(x, y)`, or `null` on its boundary. */
function windingOf(
  curves: readonly (readonly Piece[])[],
  x: number,
  y: number,
  tol: number,
): number | null {
  let w = 0;
  for (const ps of curves) {
    for (const pc of ps) {
      const c = rayCrossings(pc, x, y, tol);
      if (c === null) return null;
      w += c;
    }
  }
  return w;
}

/** Classifies `(u, v)` against prepared loops (winding 1 = material). */
export function classifyPrepared(
  pl: PreparedLoops,
  u: number,
  v: number,
): 'inside' | 'outside' | 'boundary' {
  let w = 0;
  for (const curves of pl.pieces) {
    const wl = windingOf(curves, u, v, pl.uvTol);
    if (wl === null) return 'boundary';
    w += wl;
  }
  return w === 1 ? 'inside' : 'outside';
}

const sameXY = (pa: Piece, ja: number, pb: Piece, jb: number): boolean =>
  ctrl(pa, ja, 0) === ctrl(pb, jb, 0) && ctrl(pa, ja, 1) === ctrl(pb, jb, 1);

/**
 * The cone from `J` spanned by a piece's control points, as an angular
 * interval `[start, start + span]` (radians), or null when it spans π or more
 * (or `J` is the only point). The piece lies in its control points' convex
 * hull, hence in this cone: `P − J = Σ λ_i (P_i − J)` with `λ_i ≥ 0`.
 */
function coneOf(pc: Piece, jx: number, jy: number): [number, number] | null {
  const angles: number[] = [];
  for (let j = 0; j <= pc.p; j++) {
    const dx = ctrl(pc, j, 0) - jx;
    const dy = ctrl(pc, j, 1) - jy;
    if (dx !== 0 || dy !== 0) angles.push(Math.atan2(dy, dx));
  }
  if (angles.length === 0) return null;
  angles.sort((x, y) => x - y);
  // The cone is the complement of the largest gap between consecutive directions.
  let gap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
  let start = angles[0]!;
  for (let k = 1; k < angles.length; k++) {
    const g = angles[k]! - angles[k - 1]!;
    if (g > gap) {
      gap = g;
      start = angles[k]!;
    }
  }
  const span = 2 * Math.PI - gap;
  return span < Math.PI ? [start, span] : null;
}

/** Whether two cones from the same apex share only the apex (disjoint angular intervals). */
function conesDisjoint(a: [number, number], b: [number, number]): boolean {
  const off = (((b[0] - a[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // b starts `off` after a's start; disjoint iff b starts after a ends and ends before a starts again.
  return off > a[1] && off + b[1] < 2 * Math.PI;
}

/**
 * Whether two pieces meet anywhere except at shared ends (`flags` bit 0: `a`'s
 * end is `b`'s start; bit 1: `a`'s start is `b`'s end). Depth-first
 * subdivision of the larger box until both boxes are at most `tol`. A pair
 * whose cones from a shared end are disjoint meets at most there (pruned), so
 * pieces meeting at an angle are separated near their join; a cusp, whose
 * cones never separate, reaches the leaves and is reported. Returns a point
 * of the intersection or null.
 */
function piecesMeet(a0: Piece, b0: Piece, flags0: number, tol: number): Point2 | null {
  const joints: [number, number][] = [];
  if (flags0 & 1) joints.push([ctrl(a0, a0.p, 0), ctrl(a0, a0.p, 1)]);
  if (flags0 & 2) joints.push([ctrl(a0, 0, 0), ctrl(a0, 0, 1)]);
  const stack: [Piece, Piece, number][] = [[a0, b0, flags0]];
  while (stack.length > 0) {
    const [a, b, f] = stack.pop()!;
    const ba = pieceBox(a);
    const bb = pieceBox(b);
    if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) continue;
    let separated = false;
    for (const [jx, jy] of joints) {
      const ca = coneOf(a, jx, jy);
      const cb = coneOf(b, jx, jy);
      if (ca !== null && cb !== null && conesDisjoint(ca, cb)) {
        separated = true;
        break;
      }
    }
    if (separated) continue;
    const sa = boxSize(ba);
    const sb = boxSize(bb);
    if (sa <= tol && sb <= tol) {
      if (f !== 0) continue; // the shared end
      return { x: 0.5 * (ba[0] + ba[2]), y: 0.5 * (ba[1] + ba[3]) };
    }
    if (sa >= sb) {
      const [l, r] = splitPiece(a, 0.5);
      stack.push([l, b, f & 2], [r, b, f & 1]);
    } else {
      const [l, r] = splitPiece(b, 0.5);
      stack.push([a, l, f & 1], [a, r, f & 2]);
    }
  }
  return null;
}

/** A self-intersection inside one piece (closed: its ends coincide as a one-piece loop). */
function pieceSelfMeets(pc: Piece, closed: boolean, tol: number): Point2 | null {
  if (!closed && (monotone(pc, 0) || monotone(pc, 1))) return null;
  if (boxSize(pieceBox(pc)) <= tol) return null;
  const [l, r] = splitPiece(pc, 0.5);
  return (
    piecesMeet(l, r, 1 | (closed ? 2 : 0), tol) ??
    pieceSelfMeets(l, false, tol) ??
    pieceSelfMeets(r, false, tol)
  );
}

function err(code: GeomIssue['code'], message: string, uv?: Point2, index?: number): GeomIssue {
  const at: Record<string, unknown> = {};
  if (uv !== undefined) at.uv = { u: uv.x, v: uv.y };
  if (index !== undefined) at.index = index;
  return {
    code,
    severity: 'error',
    message,
    ...(Object.keys(at).length > 0 ? { at: at as GeomIssue['at'] } : {}),
  };
}

/** A point of the piece outside the domain by more than `tol`, or null. */
function outsideDomain(
  pc: Piece,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  tol: number,
): Point2 | null {
  const b = pieceBox(pc);
  if (b[0] >= u0 - tol && b[2] <= u1 + tol && b[1] >= v0 - tol && b[3] <= v1 + tol) return null;
  for (const j of [0, pc.p]) {
    const x = ctrl(pc, j, 0);
    const y = ctrl(pc, j, 1);
    if (x < u0 - tol || x > u1 + tol || y < v0 - tol || y > v1 + tol) return { x, y };
  }
  if (boxSize(b) <= tol) return null;
  const [l, r] = splitPiece(pc, 0.5);
  return outsideDomain(l, u0, u1, v0, v1, tol) ?? outsideDomain(r, u0, u1, v0, v1, tol);
}

/**
 * Geometric validity of prepared loops (index 0 the outer or natural loop):
 * inside the domain, no self-intersection, no two loops meeting, every hole
 * inside the outer loop and outside every other hole. Orientation is checked
 * by the callers.
 */
function geometricIssues(s: NurbsSurface, pl: PreparedLoops, natural: boolean): GeomIssue[] {
  const issues: GeomIssue[] = [];
  const tol = pl.uvTol;
  const [u0, u1] = s.u.domain;
  const [v0, v1] = s.v.domain;
  // Flatten pieces with their loop and position in the loop.
  const all: { pc: Piece; loop: number; k: number; n: number }[] = [];
  pl.pieces.forEach((curves, li) => {
    const flat = curves.flat();
    flat.forEach((pc, k) => all.push({ pc, loop: li, k, n: flat.length }));
  });
  for (const { pc, loop } of all) {
    if (natural && loop === 0) continue;
    const out = outsideDomain(pc, u0, u1, v0, v1, tol);
    if (out !== null) {
      issues.push(
        err(
          'trim-outside-domain',
          `trim loop ${loop} leaves the surface domain at (${out.x}, ${out.y})`,
          out,
          loop,
        ),
      );
      return issues;
    }
  }
  for (let i = 0; i < all.length; i++) {
    const A = all[i]!;
    const self = pieceSelfMeets(A.pc, A.n === 1, tol);
    if (self !== null) {
      issues.push(
        err(
          'trim-self-intersects',
          `trim loop ${A.loop} intersects itself near (${self.x}, ${self.y})`,
          self,
          A.loop,
        ),
      );
      return issues;
    }
    for (let j = i + 1; j < all.length; j++) {
      const B = all[j]!;
      let flags = 0;
      if (A.loop === B.loop) {
        if (sameXY(A.pc, A.pc.p, B.pc, 0) && (B.k === A.k + 1 || (A.n === 2 && B.k === 1)))
          flags |= 1;
        if (sameXY(A.pc, 0, B.pc, B.pc.p) && A.k === 0 && B.k === A.n - 1) flags |= 2;
      }
      const hit = piecesMeet(A.pc, B.pc, flags, tol);
      if (hit !== null) {
        const same = A.loop === B.loop;
        issues.push(
          err(
            same ? 'trim-self-intersects' : 'trim-loops-intersect',
            same
              ? `trim loop ${A.loop} intersects itself near (${hit.x}, ${hit.y})`
              : `trim loops ${A.loop} and ${B.loop} meet near (${hit.x}, ${hit.y})`,
            hit,
            same ? A.loop : B.loop,
          ),
        );
        return issues;
      }
    }
  }
  // Containment: holes inside the outer loop and outside each other.
  for (let h = 1; h < pl.pieces.length; h++) {
    const first = pl.pieces[h]![0]![0]!;
    const x = ctrl(first, 0, 0);
    const y = ctrl(first, 0, 1);
    const wo = windingOf(pl.pieces[0]!, x, y, tol);
    if (wo !== 1) {
      issues.push(
        err('trim-hole-outside', `hole ${h - 1} lies outside the outer loop`, { x, y }, h),
      );
      continue;
    }
    for (let g = 1; g < pl.pieces.length; g++) {
      if (g === h) continue;
      const wg = windingOf(pl.pieces[g]!, x, y, tol);
      if (wg !== 0) {
        issues.push(
          err(
            'trim-hole-outside',
            `hole ${h - 1} lies inside hole ${g - 1}: outside the material`,
            { x, y },
            h,
          ),
        );
        break;
      }
    }
  }
  return issues;
}

function checkLoopShape(l: TrimLoop, what: string): void {
  if (typeof l !== 'object' || l === null || !Array.isArray(l.curves) || l.curves.length === 0) {
    fail('size-mismatch', `${what} is not a trim loop (use makeTrimLoop)`);
  }
  l.curves.forEach(checkPcurve);
}

/**
 * A trimmed surface. `outer = null` is the natural boundary; loops are allowed
 * only on surfaces clamped in both directions (`trim-on-periodic`). A loop
 * with the wrong orientation (outer clockwise, hole counter-clockwise) is
 * reversed and reported as a `trim-orientation` warning. Errors: a loop
 * outside the domain, self-intersecting, two loops meeting, a hole outside the
 * outer loop or inside another hole (see the module comment for the
 * resolution).
 */
export function makeTrimmedSurface(
  surface: NurbsSurface,
  outer: TrimLoop | null,
  holes: readonly TrimLoop[] = [],
  tol?: Partial<Tolerances>,
): Result<TrimmedSurface> {
  checkSurfaceShape(surface);
  const t = resolveTolerances(tol);
  if (outer !== null) checkLoopShape(outer, 'outer');
  holes.forEach((h, i) => checkLoopShape(h, `hole ${i}`));
  if (
    (outer !== null || holes.length > 0) &&
    (surface.u.kind !== 'clamped' || surface.v.kind !== 'clamped')
  ) {
    return errResult([
      err('trim-on-periodic', 'trim loops need a surface clamped in both directions (decision 29)'),
    ]);
  }
  const warnings: GeomIssue[] = [];
  const warn = (what: string, area: number, index: number): void => {
    warnings.push({
      code: 'trim-orientation',
      severity: 'warning',
      message: `${what} had the wrong orientation (signed area ${area}); reversed (material on the left)`,
      at: { index },
      value: area,
    });
  };
  let o = outer;
  if (o !== null && o.signedArea < 0) {
    warn('outer trim loop', o.signedArea, 0);
    o = reverseLoop(o);
  }
  const hs = holes.map((h, i) => {
    if (h.signedArea > 0) {
      warn(`hole ${i}`, h.signedArea, i + 1);
      return reverseLoop(h);
    }
    return h;
  });
  const ts = Object.freeze({
    surface,
    outer: o,
    holes: Object.freeze(hs),
  }) as unknown as TrimmedSurface;
  const issues = geometricIssues(surface, prepareLoops(ts, t), o === null);
  if (issues.length > 0) return errResult([...issues, ...warnings]);
  return okResult(ts, warnings);
}

/**
 * Every problem of a trimmed surface's loops, as issues (empty when valid):
 * orientation (an error here, nothing is reversed), the geometric checks of
 * {@link makeTrimmedSurface}, and loops on a periodic surface.
 */
export function checkTrimLoops(
  ts: TrimmedSurface,
  tol?: Partial<Tolerances>,
): readonly GeomIssue[] {
  checkSurfaceShape(ts.surface);
  const t = resolveTolerances(tol);
  if (ts.outer !== null) checkLoopShape(ts.outer, 'outer');
  ts.holes.forEach((h, i) => checkLoopShape(h, `hole ${i}`));
  const s = ts.surface;
  if (
    (ts.outer !== null || ts.holes.length > 0) &&
    (s.u.kind !== 'clamped' || s.v.kind !== 'clamped')
  ) {
    return [
      err('trim-on-periodic', 'trim loops need a surface clamped in both directions (decision 29)'),
    ];
  }
  const issues: GeomIssue[] = [];
  if (ts.outer !== null && !(ts.outer.signedArea > 0)) {
    issues.push(
      err(
        'trim-orientation',
        `outer trim loop must be counter-clockwise (material on the left); signed area ${ts.outer.signedArea}`,
        undefined,
        0,
      ),
    );
  }
  ts.holes.forEach((h, i) => {
    if (!(h.signedArea < 0)) {
      issues.push(
        err(
          'trim-orientation',
          `hole ${i} must be clockwise (material on the left); signed area ${h.signedArea}`,
          undefined,
          i + 1,
        ),
      );
    }
  });
  if (ts.outer === null && ts.holes.length === 0) return issues;
  return [...issues, ...geometricIssues(s, prepareLoops(ts, t), ts.outer === null)];
}

/**
 * Where `uv` lies relative to the trimmed domain: `'inside'` the material,
 * `'outside'`, or `'boundary'` within `√2 · paramRel · max(L_u, L_v)` of a loop
 * (module comment). Points outside the surface's domain are `'outside'`.
 */
export function classifyUV(
  ts: TrimmedSurface,
  uv: UV,
  tol?: Partial<Tolerances>,
): 'inside' | 'outside' | 'boundary' {
  checkSurfaceShape(ts.surface);
  if (!Number.isFinite(uv.u) || !Number.isFinite(uv.v)) {
    fail('non-finite', `uv is not finite: (${uv.u}, ${uv.v})`, { uv });
  }
  const t = resolveTolerances(tol);
  const s = ts.surface;
  if (ts.outer === null && ts.holes.length === 0) {
    // Natural boundary of any surface: the domain rectangle (a periodic
    // direction has no boundary).
    const tolUV = uvTolOf(s, t);
    let edge = false;
    for (const [b, x] of [
      [s.u, uv.u],
      [s.v, uv.v],
    ] as const) {
      if (b.kind === 'periodic') continue;
      const [a, e] = b.domain;
      if (x < a - tolUV || x > e + tolUV) return 'outside';
      if (x <= a + tolUV || x >= e - tolUV) edge = true;
    }
    return edge ? 'boundary' : 'inside';
  }
  return classifyPrepared(prepareLoops(ts, t), uv.u, uv.v);
}

// ---------------------------------------------------------------------------
// Closest point on a trimmed surface (§11.2 "Trimmed")
// ---------------------------------------------------------------------------

/** Distance² from `p` to `S(c(t))` and its first derivative, Newton-ready (stride 9 eval in `out`). */
interface TrimCurveProjection {
  t: number;
  d2: number;
  iters: number;
  converged: boolean;
}

/**
 * The closest point of `S(c(t))` (a trim curve's image) to `p`: samples every
 * pcurve span at `oversample · q · (p_u + p_v) + 1` parameters (the degree of
 * the composition of polynomial pieces), then a safeguarded Newton (bracketed
 * between the best sample's neighbours) on `f(t) = C′·(C − p)` (P&T §6.1),
 * from the `starts` best samples.
 */
function projectOnTrimCurve(
  s: NurbsSurface,
  c: ClampedCurve<2>,
  p: Point3,
  t: Tolerances,
  seeding: ProjectionSeeding,
): TrimCurveProjection {
  const cs = curveOnSurface(s, c, t);
  const q = c.basis.degree;
  const sc = makeScratch(Math.max(q, s.u.degree, s.v.degree), 2);
  const out = new Float64Array(9);
  const U = c.basis.knots;
  const [a, b] = c.basis.domain;
  const L = b - a;
  const m = seeding.oversample * q * (s.u.degree + s.v.degree) + 1;
  const ts: number[] = [];
  for (let k = q; k < c.basis.count; k++) {
    const lo = U[k]!;
    const hi = U[k + 1]!;
    if (!(hi > lo)) continue;
    for (let i = 0; i < m; i++) ts.push(i === m - 1 ? hi : lo + ((hi - lo) * i) / (m - 1));
  }
  const dist2 = (x: number): number => {
    curveOnSurfaceEvalInto(cs, x, 0, out, 0, sc);
    const dx = out[0]! - p.x;
    const dy = out[1]! - p.y;
    const dz = out[2]! - p.z;
    return dx * dx + dy * dy + dz * dz;
  };
  const d2s = ts.map(dist2);
  const order = d2s.map((_, i) => i).sort((i, j) => d2s[i]! - d2s[j]! || i - j);
  let best: TrimCurveProjection = {
    t: ts[order[0]!]!,
    d2: d2s[order[0]!]!,
    iters: 0,
    converged: false,
  };
  for (let r = 0; r < Math.min(seeding.starts, order.length); r++) {
    const i = order[r]!;
    let lo = ts[Math.max(0, i - 1)]!;
    let hi = ts[Math.min(ts.length - 1, i + 1)]!;
    let x = ts[i]!;
    let iters = 0;
    let converged = false;
    for (; iters < t.newtonMaxIter; iters++) {
      curveOnSurfaceEvalInto(cs, x, 2, out, 0, sc);
      const rx = out[0]! - p.x;
      const ry = out[1]! - p.y;
      const rz = out[2]! - p.z;
      const f = out[3]! * rx + out[4]! * ry + out[5]! * rz;
      const g2 = out[3]! * out[3]! + out[4]! * out[4]! + out[5]! * out[5]!;
      const r2 = rx * rx + ry * ry + rz * rz;
      if (Math.abs(f) <= t.cosine * Math.sqrt(r2 * g2) || r2 === 0) {
        converged = true;
        break;
      }
      // Bracket update: f < 0 ⇒ the minimum lies above x.
      if (f < 0) lo = x;
      else hi = x;
      const fp = out[6]! * rx + out[7]! * ry + out[8]! * rz + g2;
      let nx = fp > 0 ? x - f / fp : NaN;
      if (!(nx > lo && nx < hi)) nx = 0.5 * (lo + hi);
      if (Math.abs(nx - x) <= t.paramRel * L) {
        x = nx;
        converged = true;
        break;
      }
      x = nx;
    }
    const d2 = dist2(x);
    if (d2 < best.d2 || (d2 === best.d2 && converged && !best.converged)) {
      best = { t: x, d2, iters, converged };
    }
  }
  return best;
}

/**
 * The closest point of a trimmed surface: the closest point of the surface
 * when it classifies inside (or on the boundary). Otherwise the trimmed
 * minimum is either a local minimum of the surface inside the trim or a point
 * of a trim loop's image: the nearer of the best inside minimum (seeded from
 * the samples inside only, results kept only inside) and the closest point of
 * the loops' images (`onBoundary: 'trim'`, per curve by
 * {@link projectOnTrimCurve}). Like the untrimmed projection this is a
 * sampled global search (§11.2), not a proof.
 */
export function closestPointOnTrimmed(
  ts: TrimmedSurface,
  p: Point3,
  opts?: { readonly tol?: Partial<Tolerances>; readonly seeding?: Partial<ProjectionSeeding> },
): SurfaceProjection {
  checkSurfaceShape(ts.surface);
  const t = resolveTolerances(opts?.tol);
  const seeding = checkSeeding(opts?.seeding);
  const base = closestPointOnSurface(ts.surface, p, { tol: opts?.tol, seeding: opts?.seeding });
  if (ts.outer === null && ts.holes.length === 0) return base;
  const pl = prepareLoops(ts, t);
  if (classifyPrepared(pl, base.uv.u, base.uv.v) !== 'outside') return base;
  const s = ts.surface;
  let best: { c: ClampedCurve<2>; r: TrimCurveProjection } | null = null;
  for (const loop of pl.loops) {
    for (const c of loop.curves) {
      const r = projectOnTrimCurve(s, c, p, t, seeding);
      if (best === null || r.d2 < best.r.d2) best = { c, r };
    }
  }
  const { c, r } = best!;
  const inner = closestPointOnSurfaceWhere(
    s,
    p,
    (u, v) => classifyPrepared(pl, u, v) !== 'outside',
    t,
    seeding,
  );
  if (inner !== null && inner.distance * inner.distance < r.d2) return inner;
  const sc = makeScratch(Math.max(c.basis.degree, s.u.degree, s.v.degree), 0);
  const uvOut = new Float64Array(2);
  curveEvalInto(c, r.t, 0, uvOut, 0, sc);
  const out = new Float64Array(3);
  curveOnSurfaceEvalInto(curveOnSurface(s, c, t), r.t, 0, out, 0, sc);
  const u = sanitizeParam(s.u, uvOut[0]!);
  const v = sanitizeParam(s.v, uvOut[1]!);
  return Object.freeze({
    uv: Object.freeze({ u, v }),
    point: Object.freeze({ x: out[0]!, y: out[1]!, z: out[2]! }),
    distance: Math.sqrt(r.d2),
    converged: r.converged,
    iterations: r.iters,
    onBoundary: 'trim' as const,
  });
}
