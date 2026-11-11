// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { SCALE_LIMITS, scaleBox, scaleFactor } from './profile-scale';

describe('the Scale box', () => {
  const outline = defaultFinDesign('side', 'left').outline;
  const box = scaleBox(outline);
  const k = outline.knots;

  it('runs from the tab top to the profile’s top, rear to front, fixed at the base’s rear end', () => {
    expect(box.origin).toEqual({ x: k[k.length - 1]!.end.x, y: 0 });
    expect(box.rear.y).toBe(0);
    expect(box.corner.x).toBeCloseTo(k[0]!.end.x, 6); // the leading-edge root is frontmost
    expect(box.corner.y).toBeGreaterThan(0);
    // A raked fin's tip reaches back past its base: the box's rear is behind the root.
    expect(box.rear.x).toBeLessThan(box.origin.x);
  });

  it('reads the scale from how far the block is along its line: 1 where it started', () => {
    const along = (t: number) => ({
      x: box.origin.x + (box.corner.x - box.origin.x) * t,
      y: box.origin.y + (box.corner.y - box.origin.y) * t,
    });
    expect(scaleFactor(box, box.corner)).toBeCloseTo(1, 12);
    expect(scaleFactor(box, along(1.25))).toBeCloseTo(1.25, 12);
    expect(scaleFactor(box, along(0.5))).toBeCloseTo(0.5, 12);
    // Across the line changes nothing.
    const dx = box.corner.x - box.origin.x;
    const dy = box.corner.y - box.origin.y;
    expect(scaleFactor(box, { x: box.corner.x - dy, y: box.corner.y + dx })).toBeCloseTo(1, 12);
  });

  it('keeps one drag within its limits', () => {
    expect(scaleFactor(box, box.origin)).toBe(SCALE_LIMITS.min);
    expect(scaleFactor(box, { x: box.corner.x * 100, y: box.corner.y * 100 })).toBe(
      SCALE_LIMITS.max,
    );
  });
});
