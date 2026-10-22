// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The classic outline as exact plan data, with its corners filleted
 * (docs/design/board2.md §9.3, §4 "tip finish").
 *
 * The classic outline is the +y half of the plan, a chain of cubic Béziers
 * from the tail centre (0, 0) to the nose centre (L, 0). It is turned into a
 * list of exact **pieces** (Bézier segments, possibly trimmed, and circular
 * arcs) and sampled by arc length on the curves themselves: samples are placed
 * as the kernel's `arcLengthTable` / `pointAtArcFraction` place them (the
 * classic's `ARC_TABLE_SAMPLES` chords per segment, inverted linearly), but
 * each is then evaluated on the exact cubic at the parameter the table gives,
 * so the data carry no chord error (the kernel's interpolated table point is
 * up to h²/8ρ off the curve: 2.4·10⁻³ cm on a 90 cm segment of radius 100 cm,
 * above `lineTol`).
 *
 * **Corners.** A knot is a corner when the curve's own one-sided tangents turn
 * by more than `cornerAngleMin` across it. The tangents are the curve's (a
 * zero-length handle falls back to the next control point, the limit
 * direction), not the `continuous` flag: the synthetic files store polygonal
 * outlines with zero-length handles on knots flagged continuous (the editor
 * treats such knots as corners). The tips are corners too when the outline does
 * not leave the stringer at right angles: mirrored, the loop turns by
 * `π − 2α` there (α the outline's angle to the x-axis).
 *
 * **Fillets.** A corner is replaced by a circular arc of radius
 * `r = min(cornerFilletRadius, what fits)` tangent to both neighbours: the
 * tangent length `r / tan(θ/2)` (θ the interior angle) may use half of each
 * neighbouring segment of the loop (a segment that ends at a smooth tip is half
 * of a loop segment twice its length, so all of it). On curved neighbours the
 * arc's centre is found by Newton's method on the two tangent parameters; at a
 * tip the centre lies on the stringer (a bracketed root on one parameter). The
 * predicted plan deviation is the corner's distance to the arc, `|K − c| − r`:
 * `r (1/sin(θ/2) − 1)` on straight neighbours (the design's formula, tested),
 * and the exact value on curved ones, where the formula with the knot's
 * tangents is off (by 0.03 cm at the rocker files' tips, measured).
 *
 * A filleted tip moves the tip centre inwards by that deviation. At the tail
 * the converter then shifts the board so the tail centre is at x = 0 again
 * (decision 3: the frame is a convention), and reports the shift.
 */
import { ARC_TABLE_SAMPLES } from '@openshaper/kernel';
import type { Spline } from '@openshaper/kernel';
import { resolveTolerances } from '@openshaper/geom';
import type { Tolerances } from '@openshaper/geom';
import type { ConvertOptions } from './types';

type V2 = readonly [number, number];

/** A cubic Bézier by its four control points. */
export interface Cubic {
  readonly p: readonly [V2, V2, V2, V2];
}

/** A piece of the filleted half outline, traversed tail to nose. */
export type OutlinePiece =
  | { readonly kind: 'bezier'; readonly c: Cubic; readonly t0: number; readonly t1: number }
  | {
      readonly kind: 'arc';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      /** Start angle and signed sweep (radians). */
      readonly a0: number;
      readonly sweep: number;
    };

/** A replaced corner (classic coordinates). */
export interface OutlineFillet {
  /** The corner. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Interior angle at the corner (radians). */
  readonly interior: number;
  /** The corner's distance to the arc, `|K − c| − r` (`r (1/sin(θ/2) − 1)` on straight neighbours). */
  readonly predictedDeviation: number;
  readonly tip: boolean;
}

/** The half outline as pieces, with what was filleted. */
export interface FilletedOutline {
  readonly pieces: readonly OutlinePiece[];
  /** Piece indices that are fillet arcs, and the fillet each one replaces. */
  readonly arcs: readonly { readonly piece: number; readonly fillet: number }[];
  readonly fillets: readonly OutlineFillet[];
}

// ---------------------------------------------------------------------------
// Cubic evaluation (Bernstein form; the kernel's own evaluator is internal)
// ---------------------------------------------------------------------------

export function cubicOf(s: Spline, i: number): Cubic {
  const c = s.curves[i]!;
  return {
    p: [
      [c.p0.x, c.p0.y],
      [c.c1.x, c.c1.y],
      [c.c2.x, c.c2.y],
      [c.p3.x, c.p3.y],
    ],
  };
}

export function cubicPoint(c: Cubic, t: number): V2 {
  const s = 1 - t;
  const b0 = s * s * s;
  const b1 = 3 * s * s * t;
  const b2 = 3 * s * t * t;
  const b3 = t * t * t;
  const [p0, p1, p2, p3] = c.p;
  return [
    b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
    b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
  ];
}

function cubicDeriv(c: Cubic, t: number): V2 {
  const s = 1 - t;
  const [p0, p1, p2, p3] = c.p;
  const a = 3 * s * s;
  const b = 6 * s * t;
  const d = 3 * t * t;
  return [
    a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + d * (p3[0] - p2[0]),
    a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + d * (p3[1] - p2[1]),
  ];
}

function cubicDeriv2(c: Cubic, t: number): V2 {
  const [p0, p1, p2, p3] = c.p;
  const s = 1 - t;
  return [
    6 * (s * (p2[0] - 2 * p1[0] + p0[0]) + t * (p3[0] - 2 * p2[0] + p1[0])),
    6 * (s * (p2[1] - 2 * p1[1] + p0[1]) + t * (p3[1] - 2 * p2[1] + p1[1])),
  ];
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const norm = (a: V2): number => Math.hypot(a[0], a[1]);
const cross = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
const unit = (a: V2): V2 => {
  const l = norm(a);
  return [a[0] / l, a[1] / l];
};

/**
 * The curve's direction leaving its start (`end = 0`) or arriving at its end
 * (`end = 1`): the derivative there, or, where a handle has zero length, the
 * limit direction (the next distinct control point). `null` for a point.
 */
function endDirection(c: Cubic, end: 0 | 1): V2 | null {
  const [p0, p1, p2, p3] = c.p;
  const cands =
    end === 0 ? [sub(p1, p0), sub(p2, p0), sub(p3, p0)] : [sub(p3, p2), sub(p3, p1), sub(p3, p0)];
  for (const d of cands) if (d[0] !== 0 || d[1] !== 0) return unit(d);
  return null;
}

/** Chord-polygon length of a cubic over `[t0, t1]` on `ARC_TABLE_SAMPLES` chords (an allowance, not a measure). */
function chordLength(c: Cubic, t0: number, t1: number): number {
  let s = 0;
  let prev = cubicPoint(c, t0);
  for (let j = 1; j <= ARC_TABLE_SAMPLES; j++) {
    const q = cubicPoint(c, t0 + ((t1 - t0) * j) / ARC_TABLE_SAMPLES);
    s += norm(sub(q, prev));
    prev = q;
  }
  return s;
}

/** Signed angle from `a` to `b`. */
const turnOf = (a: V2, b: V2): number => Math.atan2(cross(a, b), dot(a, b));

// ---------------------------------------------------------------------------
// Fillet geometry
// ---------------------------------------------------------------------------

/**
 * Centre-curve point `P(t) + r n(t)` and its derivative, `n = s · J T̂` (J the
 * +90° rotation): the curve offset by r towards the side `s` (+1 left).
 */
function offsetPoint(c: Cubic, t: number, r: number, s: number): { q: V2; dq: V2 } {
  const p = cubicPoint(c, t);
  const d = cubicDeriv(c, t);
  const dd = cubicDeriv2(c, t);
  const l = norm(d);
  if (l === 0) {
    // A zero-length handle at an end leaves no derivative there: the limit direction.
    const e = endDirection(c, t < 0.5 ? 0 : 1)!;
    return { q: [p[0] - s * r * e[1], p[1] + s * r * e[0]], dq: d };
  }
  const tx = d[0] / l;
  const ty = d[1] / l;
  // dT̂/dt = (T′ − T̂ (T̂·T′)) / |T|
  const pr = tx * dd[0] + ty * dd[1];
  const dtx = (dd[0] - tx * pr) / l;
  const dty = (dd[1] - ty * pr) / l;
  return {
    q: [p[0] - s * r * ty, p[1] + s * r * tx],
    dq: [d[0] - s * r * dty, d[1] + s * r * dtx],
  };
}

/** Solves `A(tA) + r nA = B(tB) + r nB` by Newton's method; null when it does not converge in the unit square. */
function interiorFillet(
  a: Cubic,
  b: Cubic,
  r: number,
  s: number,
  ta0: number,
  tb0: number,
  tol: Tolerances,
): { ta: number; tb: number; centre: V2 } | null {
  let ta = ta0;
  let tb = tb0;
  for (let it = 0; it < tol.newtonMaxIter; it++) {
    const A = offsetPoint(a, ta, r, s);
    const B = offsetPoint(b, tb, r, s);
    const f = sub(A.q, B.q);
    // J = [dqA, −dqB]; solve J δ = −f.
    const det = -A.dq[0] * B.dq[1] + A.dq[1] * B.dq[0];
    if (det === 0) return null;
    const da = (-f[0] * -B.dq[1] - -f[1] * -B.dq[0]) / det;
    const db = (A.dq[0] * -f[1] - A.dq[1] * -f[0]) / det;
    ta += da;
    tb += db;
    if (!(ta > 0 && ta < 1 && tb > 0 && tb < 1)) return null;
    if (Math.abs(da) <= tol.paramRel && Math.abs(db) <= tol.paramRel) {
      const A2 = offsetPoint(a, ta, r, s);
      const B2 = offsetPoint(b, tb, r, s);
      if (norm(sub(A2.q, B2.q)) > tol.point) return null;
      return { ta, tb, centre: [(A2.q[0] + B2.q[0]) / 2, (A2.q[1] + B2.q[1]) / 2] };
    }
  }
  return null;
}

/** The parameter on `c` at chord distance `d` from its end `end` (bisection; the chord grows away from the end). */
function paramAtChord(c: Cubic, end: 0 | 1, d: number): number {
  const k = cubicPoint(c, end);
  let near: number = end;
  let far: number = 1 - end;
  if (norm(sub(cubicPoint(c, far), k)) <= d) return far;
  for (;;) {
    const mid = 0.5 * (near + far);
    if (!(mid !== near && mid !== far)) return mid;
    if (norm(sub(cubicPoint(c, mid), k)) < d) near = mid;
    else far = mid;
  }
}

/**
 * A tip fillet: the circle of radius r centred on the stringer (y = 0) and
 * tangent to `c` on its inner (right-hand, `s = −1`) side; `end` is the curve's
 * end at the tip. The root of the centre-curve's y on the parameter (bisected
 * to the last bit) between the tip and `limit`.
 */
function tipFillet(
  c: Cubic,
  end: 0 | 1,
  r: number,
  limit: number,
): { t: number; centre: V2 } | null {
  const yAt = (t: number): number => offsetPoint(c, t, r, -1).q[1];
  let near: number = end;
  let far = limit;
  if (!(yAt(near) < 0 && yAt(far) > 0)) return null;
  for (;;) {
    const mid = 0.5 * (near + far);
    if (!(mid !== near && mid !== far)) break;
    if (yAt(mid) < 0) near = mid;
    else far = mid;
  }
  const t = Math.abs(yAt(near)) <= Math.abs(yAt(far)) ? near : far;
  const q = offsetPoint(c, t, r, -1).q;
  return { t, centre: [q[0], 0] };
}

/**
 * A flat tip's arc: the circle centred on the stringer, tangent to `c` on its
 * inner side and to the flat's line x = `xTip` at the tip centre, so it passes
 * through `(xTip, 0)`. For a point `c(t)` the inner tangent circle centred on
 * the stringer has `r(t) = −c_y(t) / n_y(t)`; the root of
 * `centre_x(t) ± r(t) − xTip` (+ at the nose, − at the tail) on `t` is bisected
 * to the last bit from the corner end (`end`), where it is positive (nose).
 */
function flatTipFillet(
  c: Cubic,
  end: 0 | 1,
  xTip: number,
): { t: number; centre: V2; r: number } | null {
  const sgn = end === 1 ? 1 : -1;
  const at = (t: number): { f: number; centre: V2; r: number } => {
    const p = cubicPoint(c, t);
    const n = offsetPoint(c, t, 1, -1).q; // p + n̂ (unit inner normal)
    const ny = n[1] - p[1];
    const nx = n[0] - p[0];
    const r = -p[1] / ny;
    const cx = p[0] + r * nx;
    return { f: sgn * (cx + sgn * r - xTip), centre: [cx, 0], r };
  };
  let near: number = end;
  let far: number = 1 - end;
  if (!(at(near).f > 0 && at(far).f < 0)) return null;
  for (;;) {
    const mid = 0.5 * (near + far);
    if (!(mid !== near && mid !== far)) break;
    if (at(mid).f > 0) near = mid;
    else far = mid;
  }
  const t = Math.abs(at(near).f) <= Math.abs(at(far).f) ? near : far;
  const g = at(t);
  return { t, centre: g.centre, r: g.r };
}

const angleOf = (p: V2, c: V2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** The cubics of a classic spline with positive length (a repeated knot carries no shape). */
function chainOf(s: Spline): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i < s.curves.length; i++) {
    const c = cubicOf(s, i);
    if (endDirection(c, 0) !== null) out.push(c);
  }
  return out;
}

/**
 * The half outline with its corners filleted (module comment). Throws
 * `Error` on an outline the converter cannot read (an end off the stringer, a
 * degenerate segment at a corner, a fillet that does not converge); the
 * converter turns that into an issue.
 */
export function filletOutline(
  outline: Spline,
  opts: Pick<ConvertOptions, 'cornerAngleMin' | 'cornerFilletRadius'>,
  tolIn?: Partial<Tolerances>,
): FilletedOutline {
  const tol = resolveTolerances(tolIn);
  const cubics = chainOf(outline);
  const n = cubics.length;
  if (n === 0) throw new Error('outline: no segment of positive length');
  const first = cubics[0]!.p[0];
  const last = cubics[n - 1]!.p[3];
  if (Math.abs(first[1]) > tol.point || Math.abs(last[1]) > tol.point) {
    throw new Error(
      `outline: the ends (${first[0]}, ${first[1]}) and (${last[0]}, ${last[1]}) must lie on the stringer`,
    );
  }
  // A flat tip: an end segment whose chord is within `cornerAngleMin` of
  // perpendicular to the stringer and whose other end is a corner (the
  // shortboard's 1 cm flat nose). Along it x′ is about 0 (the golden's handle
  // even pokes 0.002 cm past the tip: x is not monotone), a straight transom
  // invariant 2 refuses. It is replaced, with its corner, by one arc through
  // the tip centre.
  const isFlat = (k: number): boolean => {
    const c = cubics[k]!;
    const chord = sub(c.p[3], c.p[0]);
    const offPerpendicular = Math.abs(Math.atan2(Math.abs(chord[0]), Math.abs(chord[1])));
    if (!(offPerpendicular <= opts.cornerAngleMin)) return false;
    const inner = k === 0 ? 1 : n - 1;
    const turn = turnOf(endDirection(cubics[inner - 1]!, 1)!, endDirection(cubics[inner]!, 0)!);
    return Math.abs(turn) > opts.cornerAngleMin;
  };
  const tailFlat = n > 1 && isFlat(0);
  const noseFlat = n > 1 && isFlat(n - 1);
  const chain = cubics.slice(tailFlat ? 1 : 0, noseFlat ? n - 1 : n);
  if (chain.length === 0) throw new Error('outline: nothing but flat tips');
  return filletChain(chain, true, opts, tol, {
    tail: tailFlat ? first[0] : null,
    nose: noseFlat ? last[0] : null,
  });
}

/**
 * A stringer line's curve (the classic bottom or deck) with its interior
 * corners filleted, the same way as the outline's (S6: the synthetic decks are
 * polygonal, a kink a C² line cannot follow within `lineTol`). Segments that
 * lie within `endGap` of an end in x (the deck's vertical end segments, §9.4)
 * are dropped first: they are not part of the line.
 */
export function filletLine(
  s: Spline,
  xRange: readonly [number, number],
  opts: Pick<ConvertOptions, 'cornerAngleMin' | 'cornerFilletRadius'>,
  tolIn?: Partial<Tolerances>,
): FilletedOutline {
  const tol = resolveTolerances(tolIn);
  const cubics = chainOf(s).filter((c) => {
    const xa = Math.min(c.p[0][0], c.p[3][0]);
    const xb = Math.max(c.p[0][0], c.p[3][0]);
    return xb > xRange[0] && xa < xRange[1];
  });
  if (cubics.length === 0) throw new Error('stringer line: no segment inside the board');
  return filletChain(cubics, false, opts, tol, { tail: null, nose: null });
}

/** Fillets the corners of a chain of cubics; `tips`: the chain is the half outline and its ends are tips. */
function filletChain(
  cubics: readonly Cubic[],
  tips: boolean,
  opts: Pick<ConvertOptions, 'cornerAngleMin' | 'cornerFilletRadius'>,
  tol: Tolerances,
  /** The tip x of a flat tip replaced by an arc (its segment removed from the chain), else null. */
  flats: { readonly tail: number | null; readonly nose: number | null },
): FilletedOutline {
  const n = cubics.length;
  const first = cubics[0]!.p[0];
  const last = cubics[n - 1]!.p[3];
  const lengths = cubics.map((c) => chordLength(c, 0, 1));

  // Tip turns: the loop turns by π − 2α at a tip, α the outline's angle to the x-axis there.
  const dTail = endDirection(cubics[0]!, 0)!;
  const dNose = endDirection(cubics[n - 1]!, 1)!;
  const alphaTail = Math.atan2(dTail[1], dTail[0]);
  const alphaNose = Math.atan2(dNose[1] * -1, dNose[0]);
  const tailCorner = flats.tail !== null || (tips && Math.PI - 2 * alphaTail > opts.cornerAngleMin);
  const noseCorner = flats.nose !== null || (tips && Math.PI - 2 * alphaNose > opts.cornerAngleMin);

  // Interior corners: knot k joins cubics k − 1 and k.
  const turns: number[] = [0];
  for (let k = 1; k < n; k++) {
    turns.push(turnOf(endDirection(cubics[k - 1]!, 1)!, endDirection(cubics[k]!, 0)!));
  }
  const isCorner = (k: number): boolean =>
    k === 0 ? tailCorner : k === n ? noseCorner : Math.abs(turns[k]!) > opts.cornerAngleMin;
  // Allowance of segment i at its end `e` (0 start, 1 end): half the loop segment
  // (all of a segment whose other end is a smooth tip or the end of a line).
  const allowance = (i: number, e: 0 | 1): number => {
    const other = e === 0 ? i + 1 : i;
    const otherIsSmoothEnd = (other === 0 || other === n) && !isCorner(other);
    return otherIsSmoothEnd ? lengths[i]! : lengths[i]! / 2;
  };

  const fillets: OutlineFillet[] = [];
  // Per cubic, its trimmed parameter range; per knot, the arc that replaces it.
  const t0s = new Float64Array(n);
  const t1s = new Float64Array(n).fill(1);
  const knotArc: (OutlinePiece | null)[] = new Array<OutlinePiece | null>(n + 1).fill(null);
  const knotFillet: number[] = new Array<number>(n + 1).fill(-1);

  // Each attempt either places the fillet or shrinks its radius for the next one.
  const scaleUntilFits = (solve: () => boolean): void => {
    for (let it = 0; it < tol.newtonMaxIter; it++) if (solve()) return;
    throw new Error('outline: a corner fillet did not converge');
  };

  // A flat tip's arc: through the tip centre, tangent to the flat and the neighbour.
  const flatArc = (end: 0 | 1): void => {
    const k = end === 0 ? 0 : n;
    const c = cubics[end === 0 ? 0 : n - 1]!;
    const corner = end === 0 ? first : last;
    const f = flatTipFillet(c, end, (end === 0 ? flats.tail : flats.nose)!);
    if (f === null) throw new Error('outline: a flat tip could not be rounded');
    const tp = cubicPoint(c, f.t);
    const a = angleOf(tp, f.centre);
    if (end === 0) {
      t0s[0] = f.t;
      knotArc[k] = { kind: 'arc', cx: f.centre[0], cy: 0, r: f.r, a0: Math.PI, sweep: a - Math.PI };
    } else {
      t1s[n - 1] = f.t;
      knotArc[k] = { kind: 'arc', cx: f.centre[0], cy: 0, r: f.r, a0: a, sweep: -a };
    }
    const flatDir: V2 = end === 0 ? [0, 1] : [0, -1];
    const d = endDirection(c, end)!;
    const turn = end === 0 ? turnOf(flatDir, d) : turnOf(d, flatDir);
    knotFillet[k] = fillets.length;
    fillets.push({
      x: corner[0],
      y: corner[1],
      radius: f.r,
      interior: Math.PI - Math.abs(turn),
      predictedDeviation: Math.hypot(corner[0] - f.centre[0], corner[1]) - f.r,
      tip: true,
    });
  };
  if (flats.tail !== null) flatArc(0);
  else if (tailCorner) {
    const interior = 2 * alphaTail;
    const allow = allowance(0, 0);
    let r = Math.min(opts.cornerFilletRadius, Math.tan(interior / 2) * allow);
    scaleUntilFits(() => {
      const f = tipFillet(cubics[0]!, 0, r, 1);
      if (f === null) return false;
      const used = chordLength(cubics[0]!, 0, f.t);
      if (used > allow) {
        r *= allow / used;
        return false;
      }
      t0s[0] = f.t;
      const tp = cubicPoint(cubics[0]!, f.t);
      const a1 = angleOf(tp, f.centre);
      knotArc[0] = { kind: 'arc', cx: f.centre[0], cy: 0, r, a0: Math.PI, sweep: a1 - Math.PI };
      knotFillet[0] = fillets.length;
      fillets.push({
        x: first[0],
        y: 0,
        radius: r,
        interior,
        predictedDeviation: Math.hypot(first[0] - f.centre[0], first[1]) - r,
        tip: true,
      });
      return true;
    });
  }
  for (let k = 1; k < n; k++) {
    if (!isCorner(k)) continue;
    const a = cubics[k - 1]!;
    const b = cubics[k]!;
    const turn = turns[k]!;
    const s = Math.sign(turn);
    const interior = Math.PI - Math.abs(turn);
    const allow = Math.min(allowance(k - 1, 1), allowance(k, 0));
    let r = Math.min(opts.cornerFilletRadius, Math.tan(interior / 2) * allow);
    scaleUntilFits(() => {
      const d = r / Math.tan(interior / 2);
      const f = interiorFillet(a, b, r, s, paramAtChord(a, 1, d), paramAtChord(b, 0, d), tol);
      if (f === null) {
        r /= 2;
        return false;
      }
      const used = Math.max(chordLength(a, f.ta, 1), chordLength(b, 0, f.tb));
      if (used > allow) {
        r *= allow / used;
        return false;
      }
      t1s[k - 1] = f.ta;
      t0s[k] = f.tb;
      const pa = cubicPoint(a, f.ta);
      const sweep = turnOf(unit(cubicDeriv(a, f.ta)), unit(cubicDeriv(b, f.tb)));
      knotArc[k] = {
        kind: 'arc',
        cx: f.centre[0],
        cy: f.centre[1],
        r,
        a0: angleOf(pa, f.centre),
        sweep,
      };
      knotFillet[k] = fillets.length;
      const kp = a.p[3];
      fillets.push({
        x: kp[0],
        y: kp[1],
        radius: r,
        interior,
        predictedDeviation: Math.hypot(kp[0] - f.centre[0], kp[1] - f.centre[1]) - r,
        tip: false,
      });
      return true;
    });
  }
  if (flats.nose !== null) flatArc(1);
  else if (noseCorner) {
    const interior = 2 * alphaNose;
    const allow = allowance(n - 1, 1);
    let r = Math.min(opts.cornerFilletRadius, Math.tan(interior / 2) * allow);
    const c = cubics[n - 1]!;
    scaleUntilFits(() => {
      const f = tipFillet(c, 1, r, t0s[n - 1]!);
      if (f === null) return false;
      const used = chordLength(c, f.t, 1);
      if (used > allow) {
        r *= allow / used;
        return false;
      }
      t1s[n - 1] = f.t;
      const tp = cubicPoint(c, f.t);
      const a0 = angleOf(tp, f.centre);
      knotArc[n] = { kind: 'arc', cx: f.centre[0], cy: 0, r, a0, sweep: -a0 };
      knotFillet[n] = fillets.length;
      fillets.push({
        x: last[0],
        y: 0,
        radius: r,
        interior,
        predictedDeviation: Math.hypot(last[0] - f.centre[0], last[1]) - r,
        tip: true,
      });
      return true;
    });
  }

  const pieces: OutlinePiece[] = [];
  const arcs: { piece: number; fillet: number }[] = [];
  const pushArc = (k: number): void => {
    const arc = knotArc[k];
    if (arc === null || arc === undefined) return;
    arcs.push({ piece: pieces.length, fillet: knotFillet[k]! });
    pieces.push(arc);
  };
  pushArc(0);
  for (let i = 0; i < n; i++) {
    if (!(t1s[i]! > t0s[i]!)) throw new Error(`outline: fillets overlap on segment ${i}`);
    pieces.push({ kind: 'bezier', c: cubics[i]!, t0: t0s[i]!, t1: t1s[i]! });
    pushArc(i + 1);
  }
  return Object.freeze({
    pieces: Object.freeze(pieces),
    arcs: Object.freeze(arcs),
    fillets: Object.freeze(fillets),
  });
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** A point of a piece at its local parameter `t ∈ [0, 1]`. */
export function piecePoint(p: OutlinePiece, t: number): V2 {
  if (p.kind === 'arc') {
    const a = p.a0 + p.sweep * t;
    return [p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)];
  }
  return cubicPoint(p.c, p.t0 + (p.t1 - p.t0) * t);
}

/**
 * Exact samples of a piece about `spacing` apart in arc length, both ends
 * included: arcs uniformly in angle; Béziers at equal steps of the chord
 * length of a table of `ARC_TABLE_SAMPLES` chords (the kernel's
 * `arcLengthTable`), each step located on its chord by bisection on the exact
 * cubic, so every sample is a point of the curve.
 */
export function samplePiece(p: OutlinePiece, spacing: number): V2[] {
  if (p.kind === 'arc') {
    const len = Math.abs(p.sweep) * p.r;
    const m = Math.max(1, Math.ceil(len / spacing));
    return Array.from({ length: m + 1 }, (_, k) => piecePoint(p, k / m));
  }
  const M = ARC_TABLE_SAMPLES;
  const cum = new Float64Array(M + 1);
  let prev = piecePoint(p, 0);
  for (let j = 1; j <= M; j++) {
    const q = piecePoint(p, j / M);
    cum[j] = cum[j - 1]! + norm(sub(q, prev));
    prev = q;
  }
  const len = cum[M]!;
  const m = Math.max(1, Math.ceil(len / spacing));
  const out: V2[] = [piecePoint(p, 0)];
  let j = 0;
  for (let k = 1; k < m; k++) {
    const target = (len * k) / m;
    while (j < M - 1 && cum[j + 1]! < target) j++;
    // Inside chord j, the point whose chord from the chord's start is the
    // remaining length (bisection to the last bit; the chord grows along it).
    const base = piecePoint(p, j / M);
    const want = target - cum[j]!;
    let lo = j / M;
    let hi = (j + 1) / M;
    for (;;) {
      const mid = 0.5 * (lo + hi);
      if (!(mid > lo && mid < hi)) break;
      const q = piecePoint(p, mid);
      if (Math.hypot(q[0] - base[0], q[1] - base[1]) < want) lo = mid;
      else hi = mid;
    }
    out.push(piecePoint(p, lo));
  }
  out.push(piecePoint(p, 1));
  return out;
}

/** A classic spline sampled exactly, segment by segment as {@link samplePiece} (the stringer lines). */
export function sampleSpline(s: Spline, spacing: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < s.curves.length; i++) {
    const c = cubicOf(s, i);
    if (endDirection(c, 0) === null) continue;
    const pts = samplePiece({ kind: 'bezier', c, t0: 0, t1: 1 }, spacing);
    for (let k = out.length === 0 ? 0 : 1; k < pts.length; k++) out.push(pts[k]!);
  }
  return out;
}
