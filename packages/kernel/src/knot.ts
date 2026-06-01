// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

/**
 * Knot — a single bezier control point, ported from legacy `cadcore.BezierKnot`.
 *
 * A knot carries its on-curve endpoint plus two tangent handles: one toward the
 * previous segment and one toward the next. In the legacy this was a mutable class
 * with locks, slaves, and change-listeners (editing concerns). Here it is plain
 * immutable geometry; editing/locking lives in `@openshaper/store`.
 *
 * The legacy serialization order (in `.brd` `cp` records) is:
 *   [endX, endY, prevX, prevY, nextX, nextY]  (followed by continuous, other flags)
 * i.e. point[0]=end, point[1]=tangentToPrev, point[2]=tangentToNext.
 */
export interface Knot {
  readonly end: Vec2;
  readonly tangentToPrev: Vec2;
  readonly tangentToNext: Vec2;
  /** Whether the two tangents are kept collinear when edited. */
  readonly continuous: boolean;
  /** Legacy "other" flag (used by mirror/slave bookkeeping). */
  readonly other: boolean;
}

export const knot = (
  end: Vec2,
  tangentToPrev: Vec2,
  tangentToNext: Vec2,
  continuous = true,
  other = false,
): Knot => ({ end, tangentToPrev, tangentToNext, continuous, other });

/**
 * Build a knot from the legacy flat coordinate order used in `.brd` `cp` records:
 * [endX, endY, prevX, prevY, nextX, nextY].
 */
export const knotFromArray = (
  v: readonly number[],
  continuous = true,
  other = false,
): Knot => {
  const [ex, ey, px, py, nx, ny] = v as [number, number, number, number, number, number];
  return knot(vec2(ex, ey), vec2(px, py), vec2(nx, ny), continuous, other);
};

/** Scale all three points about the origin (legacy BezierKnot.scale). */
export const scaleKnot = (k: Knot, sx: number, sy: number): Knot => ({
  end: vec2(k.end.x * sx, k.end.y * sy),
  tangentToPrev: vec2(k.tangentToPrev.x * sx, k.tangentToPrev.y * sy),
  tangentToNext: vec2(k.tangentToNext.x * sx, k.tangentToNext.y * sy),
  continuous: k.continuous,
  other: k.other,
});

export const tangentToPrevLength = (k: Knot): number =>
  Math.hypot(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);

export const tangentToNextLength = (k: Knot): number =>
  Math.hypot(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
