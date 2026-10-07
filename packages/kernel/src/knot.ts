// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

/**
 * Knot — a single bezier control point, ported from legacy `cadcore.BezierKnot`.
 *
 * A knot carries its on-curve endpoint plus two tangent handles: one toward the
 * previous segment and one toward the next. In the legacy this was a mutable class
 * with locks, slaves, and change-listeners (editing concerns). Here it is plain
 * immutable geometry; editing lives in `@openshaper/store`, which is also where a
 * {@link KnotLock} is enforced.
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
  /** Fixed handle directions. Absent on a free knot — the key is omitted, never `undefined`. */
  readonly lock?: KnotLock;
}

/**
 * Handle directions an editor must keep: unit vectors from `end` toward each handle.
 * A locked handle may change length, down to zero, but never direction. The
 * direction is stored rather than read back off the handle, so a handle collapsed
 * onto its point still knows which way it comes out again.
 *
 * Nothing in the kernel reads this: curve evaluation uses the handles alone. It lives
 * on the knot so that undo, insert/delete, copy and save carry it with the point.
 */
export interface KnotLock {
  readonly prev?: Vec2;
  readonly next?: Vec2;
}

/** A lock keeping whichever of the two directions are given, or undefined when neither is. */
export const knotLock = (prev?: Vec2, next?: Vec2): KnotLock | undefined =>
  prev || next ? { ...(prev ? { prev } : {}), ...(next ? { next } : {}) } : undefined;

export const knot = (
  end: Vec2,
  tangentToPrev: Vec2,
  tangentToNext: Vec2,
  continuous = true,
  other = false,
  lock?: KnotLock,
): Knot =>
  lock
    ? { end, tangentToPrev, tangentToNext, continuous, other, lock }
    : { end, tangentToPrev, tangentToNext, continuous, other };

/** The same knot with new handle positions, keeping its flags and any lock. */
export const withHandles = (k: Knot, tangentToPrev: Vec2, tangentToNext: Vec2): Knot => ({
  ...k,
  tangentToPrev,
  tangentToNext,
});

/**
 * Build a knot from the legacy flat coordinate order used in `.brd` `cp` records:
 * [endX, endY, prevX, prevY, nextX, nextY].
 */
export const knotFromArray = (v: readonly number[], continuous = true, other = false): Knot => {
  const [ex, ey, px, py, nx, ny] = v as [number, number, number, number, number, number];
  return knot(vec2(ex, ey), vec2(px, py), vec2(nx, ny), continuous, other);
};

/**
 * A unit direction after a non-uniform scale, so it stays parallel to the scaled
 * handle it describes. Undefined when the scale flattens it to nothing.
 */
const scaleDirection = (d: Vec2 | undefined, sx: number, sy: number): Vec2 | undefined => {
  if (!d) return undefined;
  const x = d.x * sx;
  const y = d.y * sy;
  const len = Math.hypot(x, y);
  return len > 1e-12 ? vec2(x / len, y / len) : undefined;
};

/**
 * Scale all three points about the origin (legacy BezierKnot.scale). A non-uniform
 * scale turns handles, so a lock's directions are scaled the same way: the locked
 * handle keeps pointing along its lock instead of fighting it on the next edit.
 */
export const scaleKnot = (k: Knot, sx: number, sy: number): Knot => {
  const lock =
    k.lock && knotLock(scaleDirection(k.lock.prev, sx, sy), scaleDirection(k.lock.next, sx, sy));
  return knot(
    vec2(k.end.x * sx, k.end.y * sy),
    vec2(k.tangentToPrev.x * sx, k.tangentToPrev.y * sy),
    vec2(k.tangentToNext.x * sx, k.tangentToNext.y * sy),
    k.continuous,
    k.other,
    lock,
  );
};

export const tangentToPrevLength = (k: Knot): number =>
  Math.hypot(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);

export const tangentToNextLength = (k: Knot): number =>
  Math.hypot(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
