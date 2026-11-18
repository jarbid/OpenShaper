// SPDX-License-Identifier: GPL-3.0-or-later
import { RAIL_ZONE_COLORS, zoneColorAt, railZoneColor } from '@openshaper/render3d/patches';
import type { RailKey } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { zonesOfKeys } from '../rail-zones';
import {
  blendColor,
  canAddAt,
  clickPlace,
  dragTarget,
  fitLabel,
  gradientCss,
  gradientStops,
  grabOffsetOf,
  hitTest,
  isDrag,
  laneHandles,
  laneLayout,
  MAP_PAD,
  nudged,
  pxToX,
  readableOn,
  rulerTicks,
  STRETCH_OFFSET,
  xToPx,
  type Frame,
} from './rail-map';

/** A 200 cm board on a 440 px strip: 2 px to the cm, from px 20 to 420. */
const F: Frame = { width: 440, length: 200 };

const key = (x: number, apex: number): RailKey => ({
  x,
  rail: { band: 2, hardness: 0.5, tuck: 1.4, tuckShape: 0.45, bottomEdge: 0, deckEdge: 0, apex },
});
/** zone 0: 20-60, blend 20: 60-100, zone 1: a tick at 100, blend, zone 2: 140-180. */
const SIDE = zonesOfKeys([key(20, 0.5), key(60, 0.5), key(100, 0.3), key(140, 0.4), key(180, 0.4)]);

describe('board x and pixels', () => {
  it('map the board across the strip, with a margin at each end, and back', () => {
    expect(xToPx(0, F)).toBe(MAP_PAD);
    expect(xToPx(200, F)).toBe(F.width - MAP_PAD);
    expect(xToPx(100, F)).toBe(220);
    expect(pxToX(220, F)).toBe(100);
    for (const x of [0, 7.25, 99.5, 200]) expect(pxToX(xToPx(x, F), F)).toBeCloseTo(x, 9);
  });

  it('hold a pixel past the strip to the board', () => {
    expect(pxToX(-50, F)).toBe(0);
    expect(pxToX(5000, F)).toBe(200);
  });

  it('have no scale for a board with no length', () => {
    expect(pxToX(100, { width: 400, length: 0 })).toBe(0);
    expect(xToPx(5, { width: 400, length: 0 })).toBe(MAP_PAD);
  });
});

describe('the layout of a lane', () => {
  const layout = laneLayout(SIDE, F);

  it('has a block for each zone and each blend, a tick for a zone of no length', () => {
    expect(layout.zones.map((b) => [b.zone, b.tick])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    expect(layout.zones[0]).toMatchObject({ left: xToPx(20, F), width: 80 });
    const tick = layout.zones[1]!;
    expect(tick.width).toBeGreaterThanOrEqual(4);
    expect(tick.left + tick.width / 2).toBeCloseTo(xToPx(100, F), 9);
    expect(layout.blends.map((b) => [b.blend, b.before, b.after])).toEqual([
      [0, 0, 1],
      [1, 1, 2],
    ]);
    expect(layout.blends[0]).toMatchObject({ left: xToPx(60, F), width: 80 });
  });

  it('shows the rail held flat before the first zone and after the last', () => {
    expect(layout.lead).toMatchObject({ zone: 0, left: xToPx(0, F), width: 40 });
    expect(layout.trail).toMatchObject({ zone: 2, left: xToPx(180, F), width: 40 });
  });

  it('has no stretch where a zone is at the board’s end', () => {
    const flush = laneLayout(zonesOfKeys([key(0, 0.5), key(200, 0.4)]), F);
    expect(flush.lead).toBeNull();
    expect(flush.trail).toBeNull();
  });

  it('has nothing for a side with no zones', () => {
    expect(laneLayout({ zones: [], blends: [] }, F)).toEqual({
      zones: [],
      blends: [],
      lead: null,
      trail: null,
    });
  });
});

describe('the handles', () => {
  it('stand at both ends of a zone of length and at the place of one of none', () => {
    expect(laneHandles(SIDE, F, null).map((h) => [h.zone, h.end, h.px])).toEqual([
      [0, 'from', xToPx(20, F)],
      [0, 'to', xToPx(60, F)],
      [1, 'from', xToPx(100, F)],
      [2, 'from', xToPx(140, F)],
      [2, 'to', xToPx(180, F)],
    ]);
  });

  it('give the chosen zone of no length a grip that draws it out, to the right of its place', () => {
    const grips = laneHandles(SIDE, F, 1).filter((h) => h.stretch);
    expect(grips).toEqual([
      {
        zone: 1,
        end: 'to',
        px: xToPx(100, F) + STRETCH_OFFSET,
        placePx: xToPx(100, F),
        stretch: true,
      },
    ]);
    // a zone of length has its two ends and no grip
    expect(laneHandles(SIDE, F, 0).some((h) => h.stretch)).toBe(false);
  });
});

describe('what is under a point', () => {
  it('is a handle within a few pixels of a zone’s end, the nearer when two are close', () => {
    expect(hitTest(SIDE, F, xToPx(20, F) + 4)).toEqual({ kind: 'handle', zone: 0, end: 'from' });
    expect(hitTest(SIDE, F, xToPx(60, F) - 8)).toEqual({ kind: 'handle', zone: 0, end: 'to' });
    expect(hitTest(SIDE, F, xToPx(100, F) + 2)).toEqual({ kind: 'handle', zone: 1, end: 'from' });
    expect(hitTest(SIDE, F, xToPx(100, F) + STRETCH_OFFSET - 1, 1)).toEqual({
      kind: 'handle',
      zone: 1,
      end: 'to',
    });
    // the grip is not there for a zone that is not chosen
    expect(hitTest(SIDE, F, xToPx(100, F) + STRETCH_OFFSET, null).kind).toBe('blend');
  });

  it('is a zone, a blend, or the stretch before and after', () => {
    expect(hitTest(SIDE, F, xToPx(40, F))).toEqual({ kind: 'zone', zone: 0 });
    expect(hitTest(SIDE, F, xToPx(80, F))).toEqual({ kind: 'blend', blend: 0 });
    expect(hitTest(SIDE, F, xToPx(120, F))).toEqual({ kind: 'blend', blend: 1 });
    expect(hitTest(SIDE, F, xToPx(5, F))).toEqual({ kind: 'zone', zone: 0 });
    expect(hitTest(SIDE, F, xToPx(195, F))).toEqual({ kind: 'zone', zone: 2 });
  });

  it('is empty only on a lane with no zone', () => {
    expect(hitTest({ zones: [], blends: [] }, F, 100)).toEqual({ kind: 'empty' });
  });

  it('says a "+" would add a zone in a zone of length or a blend, not on a handle or a tick', () => {
    expect(canAddAt(SIDE, F, xToPx(40, F))).toBe(true);
    expect(canAddAt(SIDE, F, xToPx(80, F))).toBe(true);
    expect(canAddAt(SIDE, F, xToPx(20, F) + 3)).toBe(false);
    expect(canAddAt(SIDE, F, xToPx(100, F) + 20)).toBe(true);
    expect(canAddAt({ zones: [], blends: [] }, F, 100)).toBe(false);
  });
});

describe('a drag and a key', () => {
  it('ask for the place under the pointer plus where the handle was taken, held to the board', () => {
    // taken 3 px to the right of the handle's centre: the handle stays where it was under the finger
    const down = 100 + xToPx(60, F) + 3;
    const offset = grabOffsetOf(xToPx(60, F), down, 100);
    expect(offset).toBe(-3);
    expect(dragTarget(down, 100, offset, F)).toBeCloseTo(60, 9);
    expect(dragTarget(100 + xToPx(75, F) + 3, 100, offset, F)).toBeCloseTo(75, 9);
    expect(dragTarget(-900, 100, 0, F)).toBe(0);
    expect(dragTarget(9000, 100, 0, F)).toBe(200);
  });

  it('is a drag only past a few pixels', () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(true);
  });

  it('nudges by half a centimetre, by five with Shift, within the board', () => {
    expect(nudged(30, 1, false, 200)).toBe(30.5);
    expect(nudged(30, -1, false, 200)).toBe(29.5);
    expect(nudged(30, 1, true, 200)).toBe(35);
    expect(nudged(2, -1, true, 200)).toBe(0);
    expect(nudged(199, 1, true, 200)).toBe(200);
  });

  it('puts the cursor where a click landed inside the zone or blend, else in its middle', () => {
    expect(clickPlace(20, 60, xToPx(35, F), F)).toBeCloseTo(35, 9);
    expect(clickPlace(20, 60, xToPx(10, F), F)).toBe(20);
    expect(clickPlace(20, 60, null, F)).toBe(40);
    expect(clickPlace(100, 100, xToPx(90, F), F)).toBe(100);
  });
});

describe('the gradient of a blend', () => {
  const a = railZoneColor(0);
  const b = railZoneColor(1);

  it('runs from the first zone’s colour to the second’s', () => {
    expect(blendColor(a, b, 0)).toBe(a.toLowerCase());
    expect(blendColor(a, b, 1)).toBe(b.toLowerCase());
    const stops = gradientStops(a, b);
    expect(stops).toHaveLength(9);
    expect(stops[0]).toEqual({ offset: 0, color: a.toLowerCase() });
    expect(stops[8]).toEqual({ offset: 1, color: b.toLowerCase() });
  });

  it('is the colour the board has at that place, to a unit of eight bits', () => {
    const zones = [
      { from: 0, to: 0, color: a },
      { from: 100, to: 100, color: b },
    ];
    for (const t of [0.2, 0.5, 0.8]) {
      const lin = zoneColorAt(zones, 100 * t);
      const srgb = lin.map((c) =>
        Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)),
      );
      const got = blendColor(a, b, t);
      const rgb = [1, 3, 5].map((i) => Number.parseInt(got.slice(i, i + 2), 16));
      rgb.forEach((v, i) => expect(Math.abs(v - srgb[i]!)).toBeLessThanOrEqual(1));
    }
  });

  it('is a CSS gradient across the block with the same stops', () => {
    const css = gradientCss(a, b);
    expect(css.startsWith('linear-gradient(to right, ')).toBe(true);
    expect(css).toContain(`${a.toLowerCase()} 0.0%`);
    expect(css).toContain(`${b.toLowerCase()} 100.0%`);
  });
});

describe('the text on a block', () => {
  // WCAG 2 contrast, computed here independently of the function under test
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('is dark on light colours and light on dark ones', () => {
    expect(readableOn('#ffffff')).toBe('#111111');
    expect(readableOn('#000000')).toBe('#ffffff');
  });

  it('is whichever of the two reads better, on every colour a zone can take', () => {
    for (let i = 0; i < RAIL_ZONE_COLORS.length; i++) {
      const color = railZoneColor(i);
      const ink = readableOn(color);
      const other = ink === '#111111' ? '#ffffff' : '#111111';
      expect(ratio(color, ink), `zone colour ${i} ${color}`).toBeGreaterThanOrEqual(
        ratio(color, other),
      );
      // and readable: the better of the two is at least the large-text threshold
      expect(ratio(color, ink), `zone colour ${i} ${color}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the label of a block', () => {
  it('is the whole name when it fits, an ellipsis when part of it does, nothing when little does', () => {
    expect(fitLabel('Tucked', 120)).toBe('Tucked');
    expect(fitLabel('Down rail 80/20', 70)).toMatch(/…$/);
    expect(fitLabel('Down rail 80/20', 70).length).toBeLessThan('Down rail 80/20'.length);
    expect(fitLabel('Tucked', 30)).toBe('');
    expect(fitLabel('Tucked', 4)).toBe('');
  });
});

describe('the ruler', () => {
  it('has round numbers of the display unit, far enough apart to read', () => {
    const mm = rulerTicks({ width: 828, length: 200 }, lengthUnitByKey('mm'));
    expect(mm[0]).toEqual({ x: 0, label: '0 mm' });
    expect(mm[1]!.label).toBe('200 mm');
    const gaps = mm.slice(1).map((t, i) => (t.x - mm[i]!.x) * 4);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(64);
    // every label is a multiple of the step
    expect(mm.every((t) => Number.parseFloat(t.label) % 200 === 0)).toBe(true);
  });

  it('reads in centimetres, and in feet and inches', () => {
    const cm = rulerTicks({ width: 828, length: 200 }, lengthUnitByKey('cm'));
    expect(cm.at(-1)!.x).toBeLessThanOrEqual(200);
    expect(cm[1]!.label).toBe('20 cm');
    const ft = rulerTicks({ width: 828, length: 183 }, lengthUnitByKey('ftin'));
    expect(ft[0]!.label).toMatch(/^0/);
    expect(ft[1]!.label).toBe('6"');
    expect(ft.length).toBeGreaterThan(2);
  });

  it('has none for a board with no length', () => {
    expect(rulerTicks({ width: 800, length: 0 }, lengthUnitByKey('mm'))).toEqual([]);
  });
});
