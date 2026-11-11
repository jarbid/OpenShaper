// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Profile view's Scale tool (owner request): a box at the profile's extent with a drag
 * block at its top-left corner. Dragging the block out along the box's diagonal makes the
 * fin larger, in toward the opposite corner smaller, evenly, about the lower right: the
 * base's rear end, the trailing-edge root (the views draw the front on the left). It is on
 * the tab top, so the fin scales along the top of the tab and stays rear-aligned on it.
 *
 * For a fin whose tip doesn't reach back past its base, that is the box's lower-right
 * corner. A raked fin's tip does, putting the corner in the air behind the base; scaling
 * about the corner would slide the base off the back of the tab as it shrank, so the fixed
 * point stays the base's rear end. Scaled about either, the shape is the same.
 */
import type { Spline, Vec2 } from '@openshaper/kernel';
import { boundsOf, sampleSpline } from '@openshaper/render2d';

/** The box, in the outline's frame (x + toward the nose, which the view draws on the left). */
export interface ScaleBox {
  /** The point that stays put: the trailing-edge root, on the tab top. */
  readonly origin: Vec2;
  /** The drag block: the box's top left in the view (front, top). */
  readonly corner: Vec2;
  /** The box's other corner: its lower right in the view (rear, on the tab top). */
  readonly rear: Vec2;
}

/** How far one drag may scale the fin, either way. */
export const SCALE_LIMITS = { min: 0.1, max: 10 } as const;

export const SCALE_BLOCK = 'scale-profile';

/** The box round `outline`: from the tab top up to its highest point, rear to front. */
export const scaleBox = (outline: Spline): ScaleBox => {
  const b = boundsOf(sampleSpline(outline));
  const k = outline.knots;
  return {
    origin: { x: k[k.length - 1]?.end.x ?? b.minX, y: 0 } as Vec2,
    corner: { x: b.maxX, y: Math.max(b.maxY, 0) } as Vec2,
    rear: { x: b.minX, y: 0 } as Vec2,
  };
};

/**
 * The scale for the block dragged to `to`: how far it is along the line from the fixed
 * point through where it started, as a share of that line (1 where it started), so the
 * block stays under the pointer. A drag across the line does nothing.
 */
export const scaleFactor = (box: ScaleBox, to: Vec2): number => {
  const dx = box.corner.x - box.origin.x;
  const dy = box.corner.y - box.origin.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return 1;
  const k = ((to.x - box.origin.x) * dx + (to.y - box.origin.y) * dy) / len2;
  return Math.min(SCALE_LIMITS.max, Math.max(SCALE_LIMITS.min, k));
};
