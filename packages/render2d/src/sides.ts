// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two halves of an asymmetric board in one pane (docs/design/m2-editor.md §3).
 *
 * A mirrored pane draws one half spline and its reflection. An asymmetric board has a spline for each
 * half, so the pane (`splitSides`) draws the plus target as it is and the minus target reflected across
 * the pane's axis (the outline below the stringer, a section on the far side of the centre line), and
 * edits both where they are drawn. A minus spline is stored in the same half-plane as the plus one, so the
 * editor works on a reflected copy of it (this module) and reflects every point it hands back to the store.
 */
import { knot, knotLock, splineFromKnots, vec2, type Spline, type Vec2 } from '@openshaper/kernel';
import { findTargetSpline, getTargetSpline, type SplineTarget } from '@openshaper/store';
import type { BezierBoard } from '@openshaper/kernel';

/** The axis a pane reflects across: `y` for the outline (about the stringer), `x` for a section. */
export type ReflectAxis = 'x' | 'y';

/** The axis a pane splits its sides across, or null when it does not (mirrored panes, classic). */
export const splitAxis = (
  splitSides: boolean,
  mirrorX: boolean,
  mirrorY: boolean,
): ReflectAxis | null => (!splitSides ? null : mirrorY ? 'y' : mirrorX ? 'x' : null);

/** Whether the target is a minus half (a minus outline, section or station curve). */
export const isMinus = (t: SplineTarget): boolean =>
  t.kind !== 'deck' && t.kind !== 'bottom' && t.side === 'minus';

/** A point reflected across the axis. */
export const reflectPoint = (p: Vec2, axis: ReflectAxis): Vec2 =>
  axis === 'y' ? vec2(p.x, -p.y) : vec2(-p.x, p.y);

const reflected = new WeakMap<Spline, { x?: Spline; y?: Spline }>();

/** The spline reflected across the axis; one object per spline, so a pane draws and hits the same one. */
export function reflectSpline(spline: Spline, axis: ReflectAxis): Spline {
  let held = reflected.get(spline);
  if (held === undefined) {
    held = {};
    reflected.set(spline, held);
  }
  let r = held[axis];
  if (r === undefined) {
    r = splineFromKnots(
      spline.knots.map((k) =>
        knot(
          reflectPoint(k.end, axis),
          reflectPoint(k.tangentToPrev, axis),
          reflectPoint(k.tangentToNext, axis),
          k.continuous,
          k.other,
          k.lock &&
            knotLock(
              k.lock.prev && reflectPoint(k.lock.prev, axis),
              k.lock.next && reflectPoint(k.lock.next, axis),
            ),
        ),
      ),
    );
    held[axis] = r;
  }
  return r;
}

/**
 * The target's spline as the pane draws it: reflected for a minus target in a split pane. A minus target
 * the board has no minus half for (a stale one) is drawn as the plus half.
 */
export function viewSpline(board: BezierBoard, t: SplineTarget, axis: ReflectAxis | null): Spline {
  const s = getTargetSpline(board, t);
  return axis !== null && isMinus(t) && findTargetSpline(board, t) !== null
    ? reflectSpline(s, axis)
    : s;
}

/** A point of the pane's drawing as the target's own spline holds it (the inverse of {@link viewSpline}). */
export const toTargetSpace = (t: SplineTarget, axis: ReflectAxis | null, p: Vec2): Vec2 =>
  axis !== null && isMinus(t) ? reflectPoint(p, axis) : p;
