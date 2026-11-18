// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board's patches, and everything about them that needs no GPU and no three.js: which
 * patch a vertex belongs to, the colours, the rail's zones along the board and the colour at a
 * place on them, the uniform arrays the shader reads, the span a chosen zone or blend lights,
 * and the patch under a tap. The shader (`patch-shader.ts`) mirrors {@link zoneColorAt} and
 * {@link selectionSpan}; the tests hold the two to one another's rules through these functions.
 *
 * ## The five patches
 *
 * To a shaper the board has five parts: the deck, the bottom, the rail along each side, the
 * tail's straight edge and the corners (nose, tail, wings). A mesh vertex carries one patch id.
 * A rail, a tail edge or a corner is two surfaces, the blend above its apex and the tuck below
 * it; a vertex on the tuck carries its patch id plus {@link TUCK}, and the look shades it a
 * little darker.
 *
 * ## Zones
 *
 * The rail alone is coloured by place. Each side has a short list of zones, each
 * `{ from, to, color }` in cm from the tail:
 *
 * - a place in a zone (`from <= x <= to`) takes the zone's colour;
 * - a place between two zones is the blend: a smoothstep mix of the two colours across the gap;
 * - before the first zone and after the last the colour holds;
 * - a zone with `from === to` is the one place its colour is pure.
 *
 * Zones are taken in order, earlier first: a place inside an earlier zone is that zone's even
 * where a later one overlaps it. {@link packZones} sorts them by `from`, so a list given out of
 * order reads as its sorted self.
 *
 * The mix is made in linear light (the colours are packed linear), as the lit material the
 * shader feeds expects.
 */

/** The patches, in the order of their ids. */
export const PATCH_NAMES = ['deck', 'bottom', 'rail', 'tailEdge', 'corner'] as const;
export type PatchName = (typeof PATCH_NAMES)[number];

/** The id a vertex carries for each patch. */
export const PATCH = { deck: 0, bottom: 1, rail: 2, tailEdge: 3, corner: 4 } as const;

/**
 * Added to the id of a rail, tail-edge or corner vertex that is on the tuck, below the apex. Ids
 * are small, so the tuck rides in the same byte; whatever reads an id for its patch goes through
 * {@link patchNamed} or {@link patchOfId}.
 */
export const TUCK = 8;

/** The id with the tuck taken off: the part a vertex belongs to. */
export const patchOfId = (id: number): number => id & (TUCK - 1);

/** Whether an id is of a vertex on the tuck. */
export const isTuckId = (id: number): boolean => (id & TUCK) !== 0;

/** The patch of an id (tuck or not), or null for an id no patch has. */
export const patchNamed = (id: number): PatchName | null => PATCH_NAMES[patchOfId(id)] ?? null;

/** The side of the board a place is on: the plus side is y >= 0. */
export type Side = 'plus' | 'minus';
export const sideAt = (y: number): Side => (y >= 0 ? 'plus' : 'minus');

// --- colours --------------------------------------------------------------------------------

/**
 * The fixed colours, sRGB. The two panels are light, quiet neutrals a small step apart, the deck
 * the lighter, so the rail's saturated colours carry the picture; the tail's straight edge is a
 * dark slate; the corners are a pink, a hue the rail's zones never take.
 */
export const PATCH_COLORS: Readonly<Record<Exclude<PatchName, 'rail'>, string>> = {
  deck: '#E7ECE9',
  bottom: '#CDD5D1',
  tailEdge: '#474D59',
  corner: '#E49BDB',
};

/**
 * The rail's zone colours, in the order a list of zones takes them, then round again: a teal, a
 * blue and an orange, then an indigo, a green, a brown, a lavender and a red. Each stays clear
 * of every other colour of the look, and each neighbour (the last and the first included) clear
 * of the next, for normal sight and for deuteranopia, protanopia and tritanopia
 * (`patches.palette.test.ts` measures it).
 */
export const RAIL_ZONE_COLORS: readonly string[] = [
  '#2F9C97',
  '#5681C4',
  '#DF8448',
  '#4B55BC',
  '#7AD877',
  '#9C4700',
  '#A88BFB',
  '#CF5254',
];

/** The rail's colour on a board that has no zones. */
export const RAIL_NO_ZONES_COLOR = '#877E77';

/** The colour of zone `index` (counted from the tail along a side). */
export const railZoneColor = (index: number): string => {
  const n = RAIL_ZONE_COLORS.length;
  return RAIL_ZONE_COLORS[((index % n) + n) % n]!;
};

/**
 * How a chosen patch is drawn: brighter by `lift` and a little added; the rest dimmed to `dim` of
 * their light and `grey` of the way to grey, which keeps them readable beside the one chosen.
 */
export const SELECTION_LOOK = { lift: 1.25, add: 0.08, dim: 0.8, grey: 0.2 } as const;

/** What the tuck, the half of a rail below its apex, keeps of its blend's colour. */
export const TUCK_SHADE = 0.8;

/**
 * The seam lines: a dark neutral at partial opacity, so they read on the light panels and on a
 * rail colour alike; and, on the band edges of a chosen rail zone or blend, white and nearly
 * opaque.
 */
export const SEAM_LOOK = {
  color: '#0E141C',
  opacity: 0.55,
  litColor: '#FFFFFF',
  litOpacity: 0.95,
} as const;

/**
 * The lines that mark where one patch ends and the next begins, in board coordinates (cm): the
 * engine's `Seams`, which this package does not import. Segment endpoints, the band edges first.
 */
export interface PatchSeams {
  /** `[x0, y0, z0, x1, y1, z1, …]`. */
  readonly positions: Float32Array;
  /** How many leading segments are band edges (the deck's, then the tuck's). */
  readonly bandEdges: number;
}

/** One component of an sRGB colour (0..1) in linear light. */
const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** A `#rrggbb` colour as linear-light components, the working space of the lit material. */
export const hexToLinear = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [
    toLinear(((n >> 16) & 0xff) / 255),
    toLinear(((n >> 8) & 0xff) / 255),
    toLinear((n & 0xff) / 255),
  ];
};

// --- zones ----------------------------------------------------------------------------------

/** A stretch of the rail, in cm from the tail, and its colour (`#rrggbb`). `from <= to`. */
export interface RailZone {
  readonly from: number;
  readonly to: number;
  readonly color: string;
}

/** The zones of each side. A mirror board gives the same list for both. */
export interface RailZones {
  readonly plus: readonly RailZone[];
  readonly minus: readonly RailZone[];
}

/** The most zones a side takes. */
export const MAX_ZONES = 16;

/** A place on a side's zones: in a zone, or between a zone and the next. */
export type ZoneAt =
  | { readonly kind: 'zone'; readonly zone: number }
  | { readonly kind: 'blend'; readonly blend: number; readonly t: number };

/** The smooth step the blend uses, 0 at its start and 1 at its end. */
export const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Where `x` lies on `zones` (sorted, as {@link packZones} leaves them), or null with no zones.
 * A blend's `blend` is the zone it starts from, so it runs from `blend` to `blend + 1`, and `t`
 * is how far across the gap `x` is, 0..1 and open at both ends (a place on a zone's edge is in
 * the zone). The shader runs the same steps.
 */
export function locateZone(zones: readonly RailZone[], x: number): ZoneAt | null {
  const n = zones.length;
  if (n === 0) return null;
  if (x <= zones[0]!.from) return { kind: 'zone', zone: 0 };
  for (let i = 0; i < n - 1; i++) {
    const a = zones[i]!;
    const b = zones[i + 1]!;
    if (x <= a.to) return { kind: 'zone', zone: i };
    if (x < b.from) return { kind: 'blend', blend: i, t: (x - a.to) / (b.from - a.to) };
  }
  return { kind: 'zone', zone: n - 1 };
}

/** The rail's colour at `x` on `zones` (sorted), in linear light: the shader's rule, in plain code. */
export function zoneColorAt(zones: readonly RailZone[], x: number): [number, number, number] {
  const at = locateZone(zones, x);
  if (at === null) return hexToLinear(RAIL_NO_ZONES_COLOR);
  if (at.kind === 'zone') return hexToLinear(zones[at.zone]!.color);
  const a = hexToLinear(zones[at.blend]!.color);
  const b = hexToLinear(zones[at.blend + 1]!.color);
  const s = smooth(at.t);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** The zones as the shader's uniform arrays: both sides, `MAX_ZONES` slots each, plus side first. */
export interface PackedZones {
  /** Zones in use on the plus and the minus side. */
  readonly count: [plus: number, minus: number];
  /** `from` and `to` of every slot, interleaved: `[from0, to0, from1, to1, …]`. */
  readonly span: Float32Array;
  /** Linear rgb of every slot, flat. */
  readonly color: Float32Array;
  /** A side had more than `MAX_ZONES` zones: the ones past the 16th are not drawn. */
  readonly truncated: boolean;
}

/**
 * Packs zones for the shader. Each side is sorted by `from` (a stable sort, so equal places keep
 * their order) and made well formed (`to` is never before `from`). A side with more than
 * {@link MAX_ZONES} zones keeps the first `MAX_ZONES` along the board: the rail past the last
 * kept zone holds that zone's colour, and `truncated` says so for a caller that wants to warn.
 */
export function packZones(zones: RailZones): PackedZones {
  const span = new Float32Array(2 * 2 * MAX_ZONES);
  const color = new Float32Array(2 * MAX_ZONES * 3);
  const count: [number, number] = [0, 0];
  let truncated = false;
  [zones.plus, zones.minus].forEach((list, side) => {
    const sorted = [...list]
      .map((z) => ({ ...z, to: Math.max(z.from, z.to) }))
      .sort((a, b) => a.from - b.from);
    if (sorted.length > MAX_ZONES) truncated = true;
    const n = Math.min(sorted.length, MAX_ZONES);
    count[side] = n;
    for (let i = 0; i < n; i++) {
      const slot = side * MAX_ZONES + i;
      span[2 * slot] = sorted[i]!.from;
      span[2 * slot + 1] = sorted[i]!.to;
      color.set(hexToLinear(sorted[i]!.color), 3 * slot);
    }
  });
  return { count, span, color, truncated };
}

/** The zones of a side as {@link packZones} leaves them, for the lookups that take sorted zones. */
export const sortedZones = (list: readonly RailZone[]): RailZone[] =>
  [...list]
    .map((z) => ({ ...z, to: Math.max(z.from, z.to) }))
    .sort((a, b) => a.from - b.from)
    .slice(0, MAX_ZONES);

// --- the chosen patch -----------------------------------------------------------------------

/**
 * What is chosen. For a rail, `zone` is a zone and `blend` the blend between that zone and the
 * next (at most one of the two); neither means the whole rail of that side. A deck, bottom, tail
 * edge or corner is chosen whole.
 */
export interface PatchSelection {
  readonly patch: PatchName;
  readonly side?: Side;
  readonly zone?: number;
  readonly blend?: number;
  /**
   * A rail selection that lights its span on the other side as well: a zone of a board whose two sides
   * are one list is on both. The span is read from `side`'s zones.
   */
  readonly both?: boolean;
}

/** What a tap on the board found: the patch, where, and for a rail the zone or blend there. */
export interface PatchPick extends PatchSelection {
  readonly side: Side;
  /** The place in board coordinates, cm: x from the tail, y from the stringer. */
  readonly x: number;
  readonly y: number;
}

/**
 * A span no place on a board is outside of (cm). Finite and modest, not 1e9: the shader smoothsteps across
 * the span's ends, and in float32 two ends that far out would be equal, which GLSL leaves undefined.
 */
const EVERYWHERE = 1e4;

/**
 * The stretch of the rail a chosen zone or blend lights, in cm from the tail, or null when the
 * choice names a zone or blend that is not on the list (an edit has since removed it).
 *
 * - A blend: the gap itself, from the end of the zone before to the start of the zone after.
 * - A zone: from halfway across the gap before it to halfway across the gap after it, so a zone
 *   of no length still has somewhere to light, and the first and last zones reach the board's
 *   ends.
 * - Neither: the whole side.
 */
export function selectionSpan(
  zones: readonly RailZone[],
  sel: Pick<PatchSelection, 'zone' | 'blend'>,
): [lo: number, hi: number] | null {
  const n = zones.length;
  if (sel.blend !== undefined) {
    if (!(sel.blend >= 0 && sel.blend + 1 < n)) return null;
    return [zones[sel.blend]!.to, zones[sel.blend + 1]!.from];
  }
  if (sel.zone !== undefined) {
    if (!(sel.zone >= 0 && sel.zone < n)) return null;
    const lo = sel.zone === 0 ? -EVERYWHERE : (zones[sel.zone - 1]!.to + zones[sel.zone]!.from) / 2;
    const hi =
      sel.zone === n - 1 ? EVERYWHERE : (zones[sel.zone]!.to + zones[sel.zone + 1]!.from) / 2;
    return [lo, hi];
  }
  return [-EVERYWHERE, EVERYWHERE];
}

/** The selection as the shader's uniforms. `patch` is -1 for no selection. */
export interface SelectionUniforms {
  readonly patch: number;
  /** 0 plus, 1 minus, 2 both sides; -1 for a patch that is not one side's. */
  readonly side: number;
  readonly lo: number;
  readonly hi: number;
}

export const NO_SELECTION: SelectionUniforms = { patch: -1, side: -1, lo: 0, hi: 0 };

/** The side a selection that lights both sides carries; the shader reads it as "either side". */
export const BOTH_SIDES = 2;

/** The uniforms of `sel` on `zones` (as {@link packZones} sorts them); no selection when it names nothing. */
export function selectionUniforms(
  sel: PatchSelection | null | undefined,
  zones: RailZones,
): SelectionUniforms {
  if (!sel) return NO_SELECTION;
  if (sel.patch !== 'rail') return { patch: PATCH[sel.patch], side: -1, lo: 0, hi: 0 };
  const side = sel.side ?? 'plus';
  const span = selectionSpan(sortedZones(side === 'plus' ? zones.plus : zones.minus), sel);
  if (span === null) return NO_SELECTION;
  return {
    patch: PATCH.rail,
    side: sel.both ? BOTH_SIDES : side === 'plus' ? 0 : 1,
    lo: span[0],
    hi: span[1],
  };
}

/**
 * Whether the place `(x, y)` on a patch is lit by a selection, as the shader decides it (the
 * shader softens the span's ends by a small feather; this is the unfeathered rule).
 */
export function isLit(sel: SelectionUniforms, patch: number, x: number, y: number): boolean {
  if (sel.patch !== patch) return false;
  if (patch !== PATCH.rail) return true;
  return (sel.side === BOTH_SIDES || (y >= 0 ? 0 : 1) === sel.side) && x >= sel.lo && x <= sel.hi;
}

// --- the colour of a place --------------------------------------------------------------------

/** The half width, in cm along the board, over which the edge of a lit rail span fades. */
export const SPAN_FEATHER = 0.4;

/** GLSL's `smoothstep`. */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * How far the chosen span lights the rail at `(x, y)`: 1 inside it on the chosen side (either, when
 * the selection is on both), 0 elsewhere, fading across {@link SPAN_FEATHER} at the span's two ends.
 * The shader's `spanLit`, in plain code.
 */
export function spanLit(sel: SelectionUniforms, x: number, y: number): number {
  if (sel.side !== BOTH_SIDES && (y >= 0 ? 0 : 1) !== sel.side) return 0;
  return (
    smoothstep(sel.lo - SPAN_FEATHER, sel.lo + SPAN_FEATHER, x) *
    (1 - smoothstep(sel.hi - SPAN_FEATHER, sel.hi + SPAN_FEATHER, x))
  );
}

/** What the tuck keeps of its colour at a place whose tuck weight is `tuck` (0 above the apex, 1 on the tuck). */
export const tuckFactor = (tuck: number): number => 1 - (1 - TUCK_SHADE) * tuck;

type Rgb = [number, number, number];

/** The luminance of a linear colour (Rec. 709). */
export const luminance = (c: readonly number[]): number =>
  0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/**
 * A colour drawn with a choice made, `lit` being how far the place is the one chosen (0..1): the
 * chosen part brighter, the rest dimmer and a little greyer, mixed by `lit`. The shader's rule.
 */
export function selectionTint(c: readonly number[], lit: number): Rgb {
  const { lift, add, dim, grey } = SELECTION_LOOK;
  const l = luminance(c);
  const tint = (v: number): number => {
    const on = v * lift + add;
    const off = (v + (l - v) * grey) * dim;
    return off + (on - off) * lit;
  };
  return [tint(c[0]!), tint(c[1]!), tint(c[2]!)];
}

/** A place on the board's surface: its patch, how far it is on the tuck, and where. */
export interface PatchPlace {
  /** The patch id, without the tuck (`PATCH`). */
  readonly patch: number;
  /** 0 above the apex, 1 on the tuck; between across the strip's last band. */
  readonly tuck: number;
  /** cm from the tail, and from the stringer (the sign of `y` is the side). */
  readonly x: number;
  readonly y: number;
}

/**
 * The colour the Patches look gives a place, in linear light, before the scene's lights: the
 * part's colour (the rail's by zone), darker on the tuck, then lifted or dimmed by the choice.
 * `zones` are each side's as {@link packZones} leaves them sorted. The shader's `patchColor`, in
 * plain code.
 */
export function patchColorAt(
  place: PatchPlace,
  zones: RailZones,
  sel: SelectionUniforms = NO_SELECTION,
): Rgb {
  const name = patchNamed(place.patch);
  let base: readonly number[];
  if (name === 'rail') {
    base = zoneColorAt(sortedZones(sideAt(place.y) === 'plus' ? zones.plus : zones.minus), place.x);
  } else {
    base = hexToLinear(name === null ? RAIL_NO_ZONES_COLOR : PATCH_COLORS[name]);
  }
  const k = tuckFactor(place.tuck);
  const c: Rgb = [base[0]! * k, base[1]! * k, base[2]! * k];
  if (sel.patch < 0) return c;
  let lit = place.patch === sel.patch ? 1 : 0;
  if (lit > 0 && name === 'rail') lit = spanLit(sel, place.x, place.y);
  return selectionTint(c, lit);
}

// --- a tap ----------------------------------------------------------------------------------

/** What a ray's hit gives: the triangle, the weights of its three vertices, and the place. */
export interface PatchHit {
  /** Which triangle of the index list, counting triangles. */
  readonly triangle: number;
  /** Barycentric weights of the triangle's three vertices at the hit. */
  readonly bary: readonly [number, number, number];
  /** The hit in board coordinates, cm. */
  readonly x: number;
  readonly y: number;
}

/**
 * The patch under a hit: the patch of the triangle's heaviest vertex (a triangle on the seam
 * between a side and a corner has vertices of both, and the nearer one is the one tapped), and
 * for a rail the zone or blend at the hit's place. Null when the vertices carry no known patch.
 */
export function pickPatch(
  patch: Uint8Array,
  indices: ArrayLike<number>,
  hit: PatchHit,
  zones: RailZones,
): PatchPick | null {
  const [w0, w1, w2] = hit.bary;
  const k = w0 >= w1 && w0 >= w2 ? 0 : w1 >= w2 ? 1 : 2;
  const vertex = indices[3 * hit.triangle + k];
  const id = vertex === undefined ? undefined : patch[vertex];
  const name = id === undefined ? null : patchNamed(id);
  if (name === null) return null;
  const side = sideAt(hit.y);
  const base = { patch: name, side, x: hit.x, y: hit.y } as const;
  if (name !== 'rail') return base;
  const at = locateZone(sortedZones(side === 'plus' ? zones.plus : zones.minus), hit.x);
  if (at === null) return base;
  return at.kind === 'zone' ? { ...base, zone: at.zone } : { ...base, blend: at.blend };
}
