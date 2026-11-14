// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tells a tap from a drag. A tap is a primary pointer that goes down and up in nearly the same
 * place, soon, with no second pointer joining: orbiting the camera (a drag), pinching and
 * panning never count. Pure, so the rule is testable without a pointer.
 */

/** A pointer event's part in the decision. */
export interface TapPointer {
  readonly id: number;
  /** Client pixels. */
  readonly x: number;
  readonly y: number;
  /** Milliseconds, any clock that only rises. */
  readonly time: number;
  /** The pointer is the primary one of its kind (the first finger, the mouse). */
  readonly primary: boolean;
  /** Which mouse button went down (0 the main one); 0 for a touch. */
  readonly button: number;
  readonly touch: boolean;
}

/** How far a pointer may move and how long it may stay down and still be a tap. */
export const TAP_LIMITS = { mousePx: 5, touchPx: 10, ms: 500 } as const;

export interface TapTracker {
  down(e: TapPointer): void;
  move(e: TapPointer): void;
  /** True when the release ends a tap. */
  up(e: TapPointer): boolean;
  /** The gesture was taken over (the pointer was cancelled). */
  cancel(): void;
}

export function createTapTracker(limits = TAP_LIMITS): TapTracker {
  let start: TapPointer | null = null;
  let spoiled = false;
  const reach = (e: TapPointer): number =>
    Math.hypot(e.x - start!.x, e.y - start!.y) / (start!.touch ? limits.touchPx : limits.mousePx);
  return {
    down(e) {
      if (start !== null) {
        // a second pointer: a pinch or a pan, not a tap
        spoiled = true;
        return;
      }
      start = e;
      spoiled = !e.primary || e.button !== 0;
    },
    move(e) {
      if (start === null || e.id !== start.id) return;
      if (reach(e) > 1) spoiled = true;
    },
    up(e) {
      if (start === null) return false;
      if (e.id !== start.id) return false;
      const tap = !spoiled && reach(e) <= 1 && e.time - start.time <= limits.ms;
      start = null;
      spoiled = false;
      return tap;
    },
    cancel() {
      start = null;
      spoiled = false;
    },
  };
}
