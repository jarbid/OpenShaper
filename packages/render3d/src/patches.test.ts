// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  BOTH_SIDES,
  MAX_ZONES,
  NO_SELECTION,
  PATCH,
  PATCH_COLORS,
  PATCH_NAMES,
  RAIL_NO_ZONES_COLOR,
  RAIL_ZONE_COLORS,
  SELECTION_LOOK,
  SPAN_FEATHER,
  TUCK,
  TUCK_SHADE,
  hexToLinear,
  isLit,
  isTuckId,
  locateZone,
  luminance,
  packZones,
  patchColorAt,
  patchNamed,
  patchOfId,
  pickPatch,
  railZoneColor,
  selectionSpan,
  selectionTint,
  selectionUniforms,
  smooth,
  sortedZones,
  spanLit,
  tuckFactor,
  zoneColorAt,
  type RailZone,
  type RailZones,
} from './patches';

const red = '#ff0000';
const green = '#00ff00';
const blue = '#0000ff';
const z = (from: number, to: number, color: string): RailZone => ({ from, to, color });

describe('zone lookup', () => {
  const zones = [z(10, 20, red), z(40, 40, green), z(60, 80, blue)];

  it('finds the zone a place is in, edges included', () => {
    expect(locateZone(zones, 10)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone(zones, 15)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone(zones, 20)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone(zones, 60)).toEqual({ kind: 'zone', zone: 2 });
    expect(locateZone(zones, 70)).toEqual({ kind: 'zone', zone: 2 });
  });

  it('holds the first zone before it and the last after it', () => {
    expect(locateZone(zones, -5)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone(zones, 200)).toEqual({ kind: 'zone', zone: 2 });
  });

  it('is a blend between two zones, with how far across it is', () => {
    expect(locateZone(zones, 25)).toEqual({ kind: 'blend', blend: 0, t: 0.25 });
    expect(locateZone(zones, 30)).toEqual({ kind: 'blend', blend: 0, t: 0.5 });
    const b = locateZone(zones, 50);
    expect(b).toEqual({ kind: 'blend', blend: 1, t: 0.5 });
  });

  it('treats a zone of no length as the place its colour is pure', () => {
    expect(locateZone(zones, 40)).toEqual({ kind: 'zone', zone: 1 });
    expect(locateZone(zones, 39.999)?.kind).toBe('blend');
    expect(locateZone(zones, 40.001)?.kind).toBe('blend');
  });

  it('has no answer with no zones, and one zone is everywhere', () => {
    expect(locateZone([], 5)).toBeNull();
    expect(locateZone([z(30, 30, red)], 0)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone([z(30, 30, red)], 99)).toEqual({ kind: 'zone', zone: 0 });
  });

  it('lets an earlier zone win where zones overlap', () => {
    const overlap = [z(0, 50, red), z(30, 60, green)];
    expect(locateZone(overlap, 40)).toEqual({ kind: 'zone', zone: 0 });
    expect(locateZone(overlap, 55)).toEqual({ kind: 'zone', zone: 1 });
  });
});

describe('zone colour', () => {
  const zones = [z(10, 20, red), z(40, 40, green)];
  const lin = (hex: string) => hexToLinear(hex);

  it('is the zone colour inside a zone and beyond the ends', () => {
    expect(zoneColorAt(zones, 15)).toEqual(lin(red));
    expect(zoneColorAt(zones, 0)).toEqual(lin(red));
    expect(zoneColorAt(zones, 40)).toEqual(lin(green));
    expect(zoneColorAt(zones, 99)).toEqual(lin(green));
  });

  it('mixes the two colours smoothly across a blend, equal at the middle', () => {
    const mid = zoneColorAt(zones, 30);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.5, 6);
    // smoothstep: flat at both ends, so the colour leaves a zone gently
    const near = zoneColorAt(zones, 20.3);
    expect(near[0]).toBeGreaterThan(0.99);
    expect(smooth(0)).toBe(0);
    expect(smooth(1)).toBe(1);
    expect(smooth(0.5)).toBe(0.5);
  });

  it('is continuous across a zone edge', () => {
    const a = zoneColorAt(zones, 20);
    const b = zoneColorAt(zones, 20 + 1e-6);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-6);
  });

  it('is monotone from one colour to the other across a gap', () => {
    let last = zoneColorAt(zones, 20)[0]!;
    for (let x = 21; x < 40; x++) {
      const r = zoneColorAt(zones, x)[0]!;
      expect(r).toBeLessThanOrEqual(last + 1e-9);
      last = r;
    }
  });

  it('is a neutral rail colour with no zones', () => {
    expect(zoneColorAt([], 5)).toEqual(hexToLinear(RAIL_NO_ZONES_COLOR));
  });

  it('converts sRGB to linear light', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('#000000')).toEqual([0, 0, 0]);
    expect(hexToLinear('#808080')[0]).toBeCloseTo(0.2159, 3);
  });
});

describe('the zone colours', () => {
  it('takes the colours round again past the palette', () => {
    expect(railZoneColor(RAIL_ZONE_COLORS.length)).toBe(RAIL_ZONE_COLORS[0]);
    expect(railZoneColor(-1)).toBe(RAIL_ZONE_COLORS[RAIL_ZONE_COLORS.length - 1]);
  });
});

describe('packing for the shader', () => {
  it('lays both sides out in fixed slots, plus first', () => {
    const p = packZones({ plus: [z(10, 20, red), z(40, 40, green)], minus: [z(5, 5, blue)] });
    expect(p.count).toEqual([2, 1]);
    expect(p.span).toHaveLength(4 * MAX_ZONES);
    expect(p.color).toHaveLength(6 * MAX_ZONES);
    expect([...p.span.slice(0, 4)]).toEqual([10, 20, 40, 40]);
    expect([...p.span.slice(2 * MAX_ZONES, 2 * MAX_ZONES + 2)]).toEqual([5, 5]);
    expect([...p.color.slice(0, 3)]).toEqual(hexToLinear(red).map(Math.fround));
    expect([...p.color.slice(3 * MAX_ZONES, 3 * MAX_ZONES + 3)]).toEqual(
      hexToLinear(blue).map(Math.fround),
    );
    expect(p.truncated).toBe(false);
  });

  it('sorts a side by where it starts and makes `to` no earlier than `from`', () => {
    const p = packZones({ plus: [z(40, 30, green), z(10, 20, red)], minus: [] });
    expect([...p.span.slice(0, 4)]).toEqual([10, 20, 40, 40]);
    expect(p.count).toEqual([2, 0]);
  });

  it('keeps the first MAX_ZONES along the board and says it dropped the rest', () => {
    const many: RailZone[] = Array.from({ length: MAX_ZONES + 4 }, (_, i) => z(i * 5, i * 5, red));
    const p = packZones({ plus: many.slice().reverse(), minus: [] });
    expect(p.count[0]).toBe(MAX_ZONES);
    expect(p.truncated).toBe(true);
    expect(p.span[2 * (MAX_ZONES - 1)]).toBe((MAX_ZONES - 1) * 5);
    // the rail past the last kept zone holds that zone's colour
    const kept = sortedZones(many);
    expect(kept).toHaveLength(MAX_ZONES);
    expect(locateZone(kept, 500)).toEqual({ kind: 'zone', zone: MAX_ZONES - 1 });
  });

  it('exactly MAX_ZONES is not truncated', () => {
    const full: RailZone[] = Array.from({ length: MAX_ZONES }, (_, i) => z(i, i, red));
    expect(packZones({ plus: full, minus: [] }).truncated).toBe(false);
  });
});

describe('the chosen zone or blend', () => {
  const zones = [z(10, 20, red), z(40, 40, green), z(60, 80, blue)];

  it('lights a blend over its gap', () => {
    expect(selectionSpan(zones, { blend: 0 })).toEqual([20, 40]);
    expect(selectionSpan(zones, { blend: 1 })).toEqual([40, 60]);
  });

  it('lights a zone from halfway across the gap before to halfway across the gap after', () => {
    expect(selectionSpan(zones, { zone: 1 })).toEqual([30, 50]);
    const [lo0] = selectionSpan(zones, { zone: 0 })!;
    const [, hi2] = selectionSpan(zones, { zone: 2 })!;
    expect(lo0).toBeLessThan(-1e3);
    expect(hi2).toBeGreaterThan(1e3);
    expect(selectionSpan(zones, { zone: 0 })![1]).toBe(30);
  });

  it('lights the whole side when neither is named', () => {
    const [lo, hi] = selectionSpan(zones, {})!;
    expect(lo).toBeLessThan(-1e3);
    expect(hi).toBeGreaterThan(1e3);
  });

  it('names nothing when the zone or blend is not on the list', () => {
    expect(selectionSpan(zones, { zone: 3 })).toBeNull();
    expect(selectionSpan(zones, { zone: -1 })).toBeNull();
    expect(selectionSpan(zones, { blend: 2 })).toBeNull();
    expect(selectionSpan([], { zone: 0 })).toBeNull();
  });

  it('makes uniforms: a rail on one side, a whole patch otherwise, none for no choice', () => {
    const both: RailZones = { plus: zones, minus: [z(0, 0, red), z(100, 100, blue)] };
    expect(selectionUniforms(null, both)).toEqual(NO_SELECTION);
    expect(selectionUniforms({ patch: 'deck' }, both)).toEqual({
      patch: PATCH.deck,
      side: -1,
      lo: 0,
      hi: 0,
    });
    expect(selectionUniforms({ patch: 'rail', side: 'plus', blend: 1 }, both)).toEqual({
      patch: PATCH.rail,
      side: 0,
      lo: 40,
      hi: 60,
    });
    expect(selectionUniforms({ patch: 'rail', side: 'minus', blend: 0 }, both)).toEqual({
      patch: PATCH.rail,
      side: 1,
      lo: 0,
      hi: 100,
    });
    // a stale choice (the zone was removed) lights nothing rather than everything
    expect(selectionUniforms({ patch: 'rail', side: 'plus', zone: 7 }, both)).toEqual(NO_SELECTION);
  });

  it('says which places are lit', () => {
    const sel = selectionUniforms(
      { patch: 'rail', side: 'plus', blend: 0 },
      { plus: zones, minus: zones },
    );
    expect(isLit(sel, PATCH.rail, 30, 5)).toBe(true);
    expect(isLit(sel, PATCH.rail, 30, -5)).toBe(false);
    expect(isLit(sel, PATCH.rail, 50, 5)).toBe(false);
    expect(isLit(sel, PATCH.deck, 30, 5)).toBe(false);
    const deck = selectionUniforms({ patch: 'deck' }, { plus: [], minus: [] });
    expect(isLit(deck, PATCH.deck, 1, -1)).toBe(true);
    expect(isLit(deck, PATCH.bottom, 1, -1)).toBe(false);
  });

  it('lights a span on both sides when the selection says both, reading the span from its own side', () => {
    const own = { plus: zones, minus: zones };
    const sel = selectionUniforms({ patch: 'rail', side: 'minus', blend: 1, both: true }, own);
    expect(sel).toEqual({ patch: PATCH.rail, side: BOTH_SIDES, lo: 40, hi: 60 });
    expect(isLit(sel, PATCH.rail, 50, 5)).toBe(true);
    expect(isLit(sel, PATCH.rail, 50, -5)).toBe(true);
    expect(isLit(sel, PATCH.rail, 70, 5)).toBe(false);
    expect(isLit(sel, PATCH.rail, 70, -5)).toBe(false);
    // without `both` the same selection stays on its side
    const one = selectionUniforms({ patch: 'rail', side: 'minus', blend: 1 }, own);
    expect(isLit(one, PATCH.rail, 50, 5)).toBe(false);
    expect(isLit(one, PATCH.rail, 50, -5)).toBe(true);
  });
});

describe('patch ids and palette', () => {
  it('names each id', () => {
    PATCH_NAMES.forEach((name, i) => {
      expect(PATCH[name]).toBe(i);
      expect(patchNamed(i)).toBe(name);
    });
    // an id no patch has, and the ids between the patches and their tuck variants
    expect(patchNamed(5)).toBeNull();
    expect(patchNamed(7)).toBeNull();
    expect(patchNamed(255)).toBeNull();
  });

  it('carries the tuck in a bit of the id, and every reader takes it off', () => {
    expect(TUCK).toBe(8);
    expect(PATCH_NAMES.length).toBeLessThanOrEqual(TUCK);
    for (const name of PATCH_NAMES) {
      const id = PATCH[name];
      expect(isTuckId(id)).toBe(false);
      expect(isTuckId(id + TUCK)).toBe(true);
      expect(patchOfId(id + TUCK)).toBe(id);
      expect(patchNamed(id + TUCK)).toBe(name);
    }
  });

  it('keeps the fixed colours apart from each other and from every zone colour', () => {
    const all = [...Object.values(PATCH_COLORS), ...RAIL_ZONE_COLORS];
    expect(new Set(all.map((c) => c.toLowerCase())).size).toBe(all.length);
  });

  it('makes the deck lighter than the bottom by a small step, both light and quiet', () => {
    const lum = (hex: string) => luminance(hexToLinear(hex));
    const ratio = lum(PATCH_COLORS.deck) / lum(PATCH_COLORS.bottom);
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.6);
    // both read as light panels, lighter than any rail colour
    for (const panel of [PATCH_COLORS.deck, PATCH_COLORS.bottom]) {
      for (const zone of RAIL_ZONE_COLORS) expect(lum(panel)).toBeGreaterThan(lum(zone));
    }
  });

  it('starts the rail zones with the teal, blue and orange of the reference', () => {
    expect(RAIL_ZONE_COLORS.slice(0, 3).map((c) => c.toLowerCase())).toEqual([
      '#2f9c97',
      '#5681c4',
      '#df8448',
    ]);
    expect(PATCH_COLORS.deck.toLowerCase()).toBe('#e7ece9');
    expect(PATCH_COLORS.bottom.toLowerCase()).toBe('#cdd5d1');
  });
});

describe('the tuck', () => {
  it('keeps 0.8 of its blend, fading in across the strip band', () => {
    expect(TUCK_SHADE).toBe(0.8);
    expect(tuckFactor(0)).toBe(1);
    expect(tuckFactor(1)).toBe(TUCK_SHADE);
    expect(tuckFactor(0.5)).toBeCloseTo(0.9, 12);
  });

  const zones: RailZones = { plus: [z(10, 10, red), z(50, 50, green)], minus: [z(10, 10, red)] };
  const place = (patch: number, tuck: number, y = 3) => ({ patch, tuck, x: 10, y });

  it('shades the rail, the tail edge and the corner, each to 0.8 of its blend', () => {
    for (const patch of [PATCH.rail, PATCH.tailEdge, PATCH.corner]) {
      const above = patchColorAt(place(patch, 0), zones);
      const below = patchColorAt(place(patch, 1), zones);
      for (let i = 0; i < 3; i++) expect(below[i]).toBeCloseTo(above[i]! * 0.8, 12);
    }
  });

  it('leaves the panels as they are: they have no tuck', () => {
    for (const patch of [PATCH.deck, PATCH.bottom]) {
      expect(patchColorAt(place(patch, 0), zones)).toEqual(
        hexToLinear(patch === PATCH.deck ? PATCH_COLORS.deck : PATCH_COLORS.bottom),
      );
    }
  });

  it('shades a rail zone colour as the colour it has at the place', () => {
    const c = patchColorAt({ patch: PATCH.rail, tuck: 1, x: 30, y: 3 }, zones);
    const zone = zoneColorAt(zones.plus, 30);
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(zone[i]! * 0.8, 12);
  });
});

describe('the look of a choice', () => {
  const zones: RailZones = { plus: [z(10, 10, red), z(50, 50, green)], minus: [z(10, 10, red)] };
  const deck = { patch: PATCH.deck, tuck: 0, x: 40, y: 0 };
  const railAt = (x: number, y = 3) => ({ patch: PATCH.rail, tuck: 0, x, y });

  it('is one place for its constants, the dimming gentle and the lift clear', () => {
    expect(SELECTION_LOOK.dim).toBe(0.8);
    expect(SELECTION_LOOK.grey).toBe(0.2);
    expect(SELECTION_LOOK.lift).toBeGreaterThan(1);
  });

  it('changes nothing with no choice', () => {
    const c = patchColorAt(deck, zones);
    expect(c).toEqual(hexToLinear(PATCH_COLORS.deck));
  });

  it('dims what is not chosen to 0.8 of its light, a fifth of the way to grey', () => {
    const sel = selectionUniforms({ patch: 'bottom' }, zones);
    const base = hexToLinear(PATCH_COLORS.deck);
    const off = patchColorAt(deck, zones, sel);
    expect(luminance(off)).toBeCloseTo(0.8 * luminance(base), 12);
    // a fifth of the way from its colour to the grey of equal luminance
    const grey = luminance(base);
    for (let i = 0; i < 3; i++) expect(off[i]).toBeCloseTo((base[i]! * 0.8 + grey * 0.2) * 0.8, 12);
  });

  it('lifts what is chosen, clearly above what is not, for every colour of the look', () => {
    const colours = [
      ...Object.values(PATCH_COLORS).map((c) => hexToLinear(c)),
      ...RAIL_ZONE_COLORS.map((c) => hexToLinear(c)),
    ];
    for (const c of colours) {
      const on = luminance(selectionTint(c, 1));
      const off = luminance(selectionTint(c, 0));
      expect(on / off, `${c}`).toBeGreaterThan(1.4);
      expect(selectionTint(c, 0.5)[1]).toBeGreaterThan(selectionTint(c, 0)[1]);
    }
  });

  it('lights a chosen rail span, and dims the rest of the rail like the other parts', () => {
    const sel = selectionUniforms({ patch: 'rail', side: 'plus', zone: 1 }, zones);
    // zone 1 (the 50 cm key) lights from halfway across the gap, 30 cm, to the end
    const lit = patchColorAt(railAt(50), zones, sel);
    const unlit = patchColorAt(railAt(10), zones, sel);
    expect(luminance(lit)).toBeGreaterThan(luminance(zoneColorAt(zones.plus, 50)));
    expect(luminance(unlit)).toBeLessThan(luminance(zoneColorAt(zones.plus, 10)));
    // the other side of the board is not the chosen side's rail
    const other = patchColorAt(railAt(50, -3), zones, sel);
    expect(luminance(other)).toBeLessThan(luminance(zoneColorAt(zones.minus, 50)));
  });

  it('fades the span at its ends over the feather, and agrees with the unfeathered rule beyond it', () => {
    const sel = selectionUniforms({ patch: 'rail', side: 'plus', blend: 0 }, zones);
    expect(sel.lo).toBe(10);
    expect(sel.hi).toBe(50);
    expect(spanLit(sel, 10, 3)).toBeCloseTo(0.5, 12);
    expect(spanLit(sel, 50, 3)).toBeCloseTo(0.5, 12);
    expect(spanLit(sel, 10 - SPAN_FEATHER, 3)).toBe(0);
    expect(spanLit(sel, 10 + SPAN_FEATHER, 3)).toBeCloseTo(1, 12);
    for (const x of [-20, 5, 11, 30, 49, 51, 90]) {
      const outside = x < 10 - SPAN_FEATHER || x > 50 + SPAN_FEATHER;
      const inside = x > 10 + SPAN_FEATHER && x < 50 - SPAN_FEATHER;
      if (outside) expect(spanLit(sel, x, 3)).toBe(0);
      if (inside) expect(spanLit(sel, x, 3)).toBeCloseTo(1, 12);
      if (inside || outside) expect(spanLit(sel, x, 3) === 1).toBe(isLit(sel, PATCH.rail, x, 3));
    }
    // the other side is never lit
    expect(spanLit(sel, 30, -3)).toBe(0);
  });
});

describe('the patch under a tap', () => {
  // Three vertices of patches rail, rail, corner; one triangle.
  const patch = Uint8Array.from([
    PATCH.rail,
    PATCH.rail,
    PATCH.corner,
    PATCH.deck,
    PATCH.deck,
    PATCH.deck,
  ]);
  const indices = Uint32Array.from([0, 1, 2, 3, 4, 5]);
  const zones: RailZones = { plus: [z(10, 10, red), z(50, 50, green)], minus: [z(10, 10, red)] };

  it('takes the patch of the heaviest vertex', () => {
    const near = pickPatch(
      patch,
      indices,
      { triangle: 0, bary: [0.2, 0.2, 0.6], x: 30, y: 4 },
      zones,
    );
    expect(near?.patch).toBe('corner');
    const side = pickPatch(
      patch,
      indices,
      { triangle: 0, bary: [0.5, 0.3, 0.2], x: 30, y: 4 },
      zones,
    );
    expect(side?.patch).toBe('rail');
    const second = pickPatch(
      patch,
      indices,
      { triangle: 0, bary: [0.1, 0.6, 0.3], x: 30, y: 4 },
      zones,
    );
    expect(second?.patch).toBe('rail');
  });

  it('gives the place and the side, y >= 0 being the plus side', () => {
    const p = pickPatch(patch, indices, { triangle: 1, bary: [1, 0, 0], x: 77, y: 0 }, zones)!;
    expect(p).toEqual({ patch: 'deck', side: 'plus', x: 77, y: 0 });
    const m = pickPatch(patch, indices, { triangle: 1, bary: [1, 0, 0], x: 77, y: -0.01 }, zones)!;
    expect(m.side).toBe('minus');
  });

  it('gives a rail its zone, or its blend between zone and the next', () => {
    const at = (x: number, y = 3) =>
      pickPatch(patch, indices, { triangle: 0, bary: [1, 0, 0], x, y }, zones)!;
    expect(at(10)).toMatchObject({ patch: 'rail', side: 'plus', zone: 0 });
    expect(at(30)).toMatchObject({ patch: 'rail', side: 'plus', blend: 0 });
    expect(at(30)).not.toHaveProperty('zone');
    expect(at(90)).toMatchObject({ zone: 1 });
    // the minus side reads its own list
    expect(at(30, -3)).toMatchObject({ side: 'minus', zone: 0 });
  });

  it('gives a rail with no zones no zone', () => {
    const p = pickPatch(
      patch,
      indices,
      { triangle: 0, bary: [1, 0, 0], x: 30, y: 3 },
      { plus: [], minus: [] },
    )!;
    expect(p).toEqual({ patch: 'rail', side: 'plus', x: 30, y: 3 });
  });

  it('reads a vertex on the tuck as its patch, whatever the heaviest vertex is', () => {
    const onTuck = Uint8Array.from([
      PATCH.rail + TUCK,
      PATCH.rail + TUCK,
      PATCH.corner + TUCK,
      PATCH.tailEdge + TUCK,
      PATCH.tailEdge,
      PATCH.deck,
    ]);
    const tap = (triangle: number, bary: [number, number, number]) =>
      pickPatch(onTuck, indices, { triangle, bary, x: 30, y: 4 }, zones);
    expect(tap(0, [0.6, 0.3, 0.1])).toMatchObject({ patch: 'rail', blend: 0 });
    expect(tap(0, [0.6, 0.3, 0.1])).not.toHaveProperty('zone');
    expect(tap(0, [0.1, 0.1, 0.8])?.patch).toBe('corner');
    expect(tap(1, [0.8, 0.1, 0.1])?.patch).toBe('tailEdge');
    expect(tap(1, [0.1, 0.8, 0.1])?.patch).toBe('tailEdge');
    expect(tap(1, [0.1, 0.1, 0.8])?.patch).toBe('deck');
  });

  it('says nothing for an id no patch has or a triangle that is not there', () => {
    expect(
      pickPatch(
        Uint8Array.from([5, 6, 7]),
        indices,
        { triangle: 0, bary: [1, 0, 0], x: 0, y: 0 },
        zones,
      ),
    ).toBeNull();
    expect(
      pickPatch(patch, indices, { triangle: 5, bary: [1, 0, 0], x: 0, y: 0 }, zones),
    ).toBeNull();
  });

  it('feeds a pick back as the selection that lights what was tapped', () => {
    const pick = pickPatch(patch, indices, { triangle: 0, bary: [1, 0, 0], x: 30, y: 3 }, zones)!;
    const u = selectionUniforms(pick, zones);
    expect(isLit(u, PATCH.rail, 30, 3)).toBe(true);
    expect(isLit(u, PATCH.rail, 60, 3)).toBe(false);
  });
});
