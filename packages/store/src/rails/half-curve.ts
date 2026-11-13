// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rules of a rails board's half curve: a station's bottom curve or deck curve as the editor
 * shows it, in cm in the section's frame (x from the stringer, y above the rocker). They are the
 * counterpart, for a half curve, of the rules that hold a classic slice inside the blank
 * (`constrainSectionToBlank` in `edits.ts`):
 *
 *  1. The first knot stays on the stringer at its fixed place: (0, 0) for a bottom curve, (0, T)
 *     for a deck curve. The rocker and the deck line own those heights.
 *  2. The curve is flat at the stringer: the first knot's outgoing handle keeps the knot's height.
 *  3. The last knot stays on the wall, x = w. Its height is free, except that a deck curve's end
 *     stays at or above the bottom curve's end at the same station, and a bottom curve's end at or
 *     below the deck curve's.
 *  4. The curve stays a function of x: its knots strictly increase in x, and each handle stays
 *     inside its segment's x range.
 *  5. The first and last knots cannot be deleted and a curve keeps at least two knots
 *     (`canDeleteKnot` refuses both).
 *
 * An edit that would break a rule is held at the limit, not refused.
 */
import {
  splineFromKnots,
  vec2,
  withHandles,
  type Knot,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { matchKnots, type StationSplines } from '../edits';

/** What the rules of one half curve need to know of its station. */
export interface HalfCurveFrame {
  readonly curve: 'bottom' | 'deck';
  /** The half width at the station (cm): where the wall is. */
  readonly w: number;
  /** The thickness at the station (cm): the deck curve's height at the stringer. */
  readonly T: number;
  /** The height (cm) of the end of the station's other curve, on the wall. */
  readonly otherEnd: number;
}

/** The frame of one curve of a station, from its projection entry. */
export const halfCurveFrame = (entry: StationSplines, curve: 'bottom' | 'deck'): HalfCurveFrame => {
  const other = curve === 'bottom' ? entry.deck : entry.bottom;
  return { curve, w: entry.w, T: entry.T, otherEnd: other.knots[other.knots.length - 1]!.end.y };
};

/**
 * The least spacing (cm) of two neighbouring knots along x: knots stay strictly apart, as two
 * stations do. On a curve too narrow for its knots at that spacing, half of an even share.
 */
const KNOT_GAP = 1e-3;

/** Whether two points are the same point (exact: a point counts as moved if it moved at all). */
const same = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

const sameKnot = (a: Knot, b: Knot): boolean =>
  same(a.end, b.end) &&
  same(a.tangentToPrev, b.tangentToPrev) &&
  same(a.tangentToNext, b.tangentToNext) &&
  a.continuous === b.continuous &&
  a.other === b.other &&
  a.lock === b.lock;

/** `k` with its point at `end` and its handles carried by the same move. */
const carry = (k: Knot, end: Vec2): Knot => {
  if (same(k.end, end)) return k;
  const dx = end.x - k.end.x;
  const dy = end.y - k.end.y;
  return withHandles(
    { ...k, end },
    vec2(k.tangentToPrev.x + dx, k.tangentToPrev.y + dy),
    vec2(k.tangentToNext.x + dx, k.tangentToNext.y + dy),
  );
};

/** `k` moved along x only, to `x`. */
const carryX = (k: Knot, x: number): Knot => carry(k, vec2(x, k.end.y));

/**
 * A handle of a knot at `at` held between `lo` and `hi` in x. On the knot's side of it but too
 * long, it is shortened along its own direction (a smooth knot stays smooth); on the wrong side of
 * the knot it is stood upright at its own height.
 */
function holdHandle(at: Vec2, h: Vec2, lo: number, hi: number): Vec2 {
  if (h.x >= lo && h.x <= hi) return h;
  const towardHi = at.x <= lo;
  // the handle points away from its segment: stand it upright on the knot
  if (towardHi ? h.x < at.x : h.x > at.x) return vec2(at.x, h.y);
  const limit = towardHi ? hi : lo;
  const t = (limit - at.x) / (h.x - at.x);
  return vec2(limit, at.y + (h.y - at.y) * t);
}

/**
 * The half curve `next`, an edit of `prev`, held to the five rules above in `frame`. Knots the
 * edit moved are held between their neighbours (their handles carried with them); a curve that
 * broke a rule before the edit is repaired too. Returns `prev` itself when the rules take the
 * whole edit back, and `next` itself when it already obeys them.
 */
export function constrainHalfCurve(prev: Spline, next: Spline, frame: HalfCurveFrame): Spline {
  const nk = next.knots;
  const n = nk.length;
  if (n < 2) return next;
  const knots = [...nk];
  const from = matchKnots(prev.knots, nk);
  const moved = (i: number): boolean => {
    const j = from[i]!;
    return j < 0 || !same(nk[i]!.end, prev.knots[j]!.end);
  };
  const { w } = frame;
  const z0 = frame.curve === 'bottom' ? 0 : frame.T;
  const gap = Math.max(0, Math.min(KNOT_GAP, w / (2 * (n - 1))));

  // 1. The first knot on the stringer.
  knots[0] = carry(knots[0]!, vec2(0, z0));
  // 3. The last knot on the wall, its end on the right side of the other curve's.
  const end = knots[n - 1]!.end;
  const zEnd =
    frame.curve === 'deck' ? Math.max(end.y, frame.otherEnd) : Math.min(end.y, frame.otherEnd);
  knots[n - 1] = carry(knots[n - 1]!, vec2(w, zEnd));

  // 4. Knots strictly increasing in x: a moved knot is held between its neighbours, then two
  // sweeps repair whatever is left (a curve that folded before the edit, a neighbour that moved).
  for (let i = 1; i < n - 1; i++) {
    if (!moved(i)) continue;
    const lo = knots[i - 1]!.end.x + gap;
    const hi = knots[i + 1]!.end.x - gap;
    if (lo > hi) continue;
    const x = knots[i]!.end.x;
    if (x < lo) knots[i] = carryX(knots[i]!, lo);
    else if (x > hi) knots[i] = carryX(knots[i]!, hi);
  }
  for (let i = 1; i < n - 1; i++) {
    const lo = knots[i - 1]!.end.x + gap;
    if (knots[i]!.end.x < lo) knots[i] = carryX(knots[i]!, lo);
  }
  for (let i = n - 2; i >= 1; i--) {
    const hi = knots[i + 1]!.end.x - gap;
    if (knots[i]!.end.x > hi) knots[i] = carryX(knots[i]!, hi);
  }

  // Handles: inside their segments; the open ends' unused handles on their points; 2. flat at the stringer.
  for (let i = 0; i < n; i++) {
    const k = knots[i]!;
    const prevX = i > 0 ? knots[i - 1]!.end.x : k.end.x;
    const nextX = i < n - 1 ? knots[i + 1]!.end.x : k.end.x;
    let inn = i === 0 ? k.end : holdHandle(k.end, k.tangentToPrev, prevX, k.end.x);
    let out = i === n - 1 ? k.end : k.tangentToNext;
    if (i === 0) out = vec2(out.x, z0);
    if (i < n - 1) out = holdHandle(k.end, out, k.end.x, nextX);
    if (i === 0) inn = k.end;
    if (!same(inn, k.tangentToPrev) || !same(out, k.tangentToNext)) {
      knots[i] = withHandles(k, inn, out);
    }
  }

  if (knots.every((k, i) => k === nk[i])) return next;
  if (n === prev.knots.length && knots.every((k, i) => sameKnot(k, prev.knots[i]!))) return prev;
  return splineFromKnots(knots);
}

/** Whether a half curve obeys rules 1 to 4 in `frame` (for tests and checks), with the knot spacing `gap`. */
export function obeysHalfCurveRules(s: Spline, frame: HalfCurveFrame, gap = 0): boolean {
  const k = s.knots;
  const n = k.length;
  if (n < 2) return false;
  const z0 = frame.curve === 'bottom' ? 0 : frame.T;
  if (!same(k[0]!.end, vec2(0, z0)) || k[0]!.tangentToNext.y !== z0) return false;
  const last = k[n - 1]!.end;
  if (last.x !== frame.w) return false;
  if (frame.curve === 'deck' ? last.y < frame.otherEnd : last.y > frame.otherEnd) return false;
  for (let i = 0; i + 1 < n; i++) {
    const a = k[i]!.end.x;
    const b = k[i + 1]!.end.x;
    if (!(b - a > gap)) return false;
    const out = k[i]!.tangentToNext.x;
    const inn = k[i + 1]!.tangentToPrev.x;
    if (out < a || out > b || inn < a || inn > b) return false;
  }
  return true;
}
