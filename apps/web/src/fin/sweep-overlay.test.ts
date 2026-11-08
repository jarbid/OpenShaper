// SPDX-License-Identifier: GPL-3.0-or-later
import {
  chordAt,
  defaultFinDesign,
  prepareBlade,
  sweepFrame,
  smoothRowLine,
  type Vec2,
  thicknessAt,
  thicknessPathOf,
  tipLineOf,
  knot,
  splineFromKnots,
  vec2,
} from '@openshaper/kernel';
import { createFinStore, TIP_FOIL } from '@openshaper/store';
import { describe, expect, it } from 'vitest';
import { foilSize, foilTrueScale } from './FinSectionPane';
import { pickSweepLine, sweepMarkerHandlers, sweepOverlay } from './sweep-overlay';

describe('the foil sweep over the profile', () => {
  it('draws the base, the tip line and the thickness path between them, with handles', () => {
    const d = defaultFinDesign('side', 'left');
    const o = sweepOverlay(d);
    // The base starts at the leading-edge root, on the tab top.
    expect(o.base[0]!.y).toBeCloseTo(0, 9);
    // The path runs from the base up to the tip line.
    expect(o.path[0]!.y).toBeCloseTo(0, 6);
    const tipMid = o.tip[Math.floor(o.tip.length / 2)]!;
    expect(o.path[o.path.length - 1]!.y).toBeGreaterThan(0.8 * tipMid.y);
    expect(o.markers.map((m) => m.id)).toEqual([
      'tip-start',
      'tip-end',
      'path-0',
      'path-1',
      'path-2',
    ]);
  });

  it('moves the tip line and the thickness path by dragging, one undo step each', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'left'));
    const h = sweepMarkerHandlers(store);
    const d0 = store.getState().design!;
    const before = tipLineOf(d0);
    // Drag the tip line's front end down the leading edge.
    const edge = sweepFrame(d0).leading.pts;
    const lower = edge[Math.floor(edge.length * 0.85)]!;
    h.onMarkerDragStart('tip-start');
    h.onMarkerDrag('tip-start', lower);
    h.onMarkerDragEnd();
    expect(store.getState().design!.tipLine!.start).toBeLessThan(before.start);
    expect(store.getState().past.at(-1)!.label).toBe('Move the tip line');
    // Drag the base point of the thickness path toward the leading edge.
    const d1 = store.getState().design!;
    const base = smoothRowLine(d1, 0, 400);
    h.onMarkerDragStart('path-0');
    h.onMarkerDrag('path-0', base[100]! as Vec2);
    h.onMarkerDragEnd();
    expect(thicknessPathOf(store.getState().design!)[0]).toBeCloseTo(0.25, 2);
    expect(store.getState().past.at(-1)!.label).toBe('Move the thickness path');
  });
});

describe('the foil view, true to scale', () => {
  it('draws the root foil as thick for its chord as the taper makes it', () => {
    const d = defaultFinDesign('side', 'left');
    const b = prepareBlade(d);
    const { leading, trailing } = chordAt(b, 0);
    // The drawn shape, stretched by the scale, has the root's real thickness over chord.
    const k = foilTrueScale(d, 0);
    expect(k * b.shapeThickness).toBeCloseTo(thicknessAt(b, 0) / (leading - trailing), 9);
  });

  it('draws a foil stored far thinner than it is true to scale too', () => {
    // Owner testing: a tip foil stored at a twentieth of its thickness, drawn flat.
    const d = defaultFinDesign('side', 'left');
    const thin = (s: typeof d.section.outside) =>
      splineFromKnots(
        s.knots.map((k) => {
          const f = (p: { x: number; y: number }) => vec2(p.x, p.y / 50);
          return knot(f(k.end), f(k.tangentToPrev), f(k.tangentToNext), k.continuous);
        }),
      );
    const tip = {
      outside: thin(d.section.outside),
      inside: d.section.inside && thin(d.section.inside),
    };
    const k = foilTrueScale({ ...d, tipSection: tip }, TIP_FOIL);
    expect(k).toBeCloseTo(foilTrueScale(d, TIP_FOIL) * 50, 6);
  });
});

describe('picking the sweep lines in the profile', () => {
  it('picks the base or the tip line near a click, nothing between', () => {
    const o = sweepOverlay(defaultFinDesign('side', 'left'));
    const px = 0.01; // cm per pixel
    const mid = (pts: readonly { x: number; y: number }[]) => pts[Math.floor(pts.length / 2)]!;
    expect(pickSweepLine(o, { x: mid(o.base).x, y: mid(o.base).y + 0.03 }, px)).toBe(0);
    expect(pickSweepLine(o, mid(o.tip), px)).toBe(TIP_FOIL);
    expect(pickSweepLine(o, { x: mid(o.base).x, y: 3 }, px)).toBeNull();
  });

  it('draws the tip foil true to scale across the tip line', () => {
    const d = defaultFinDesign('side', 'left');
    const tip = foilSize(d, TIP_FOIL);
    const base = foilSize(d, 0);
    // A tip line across the top, shorter and thinner than the root.
    expect(tip.chord).toBeLessThan(base.chord * 0.6);
    expect(tip.thickness).toBeLessThan(base.thickness);
    expect(foilTrueScale(d, TIP_FOIL)).toBeGreaterThan(0);
  });
});
