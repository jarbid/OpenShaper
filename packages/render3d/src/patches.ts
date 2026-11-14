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

/** The patch of an id, or null for an id no patch has. */
export const patchNamed = (id: number): PatchName | null => PATCH_NAMES[id] ?? null;

/** The side of the board a place is on: the plus side is y >= 0. */
export type Side = 'plus' | 'minus';
export const sideAt = (y: number): Side => (y >= 0 ? 'plus' : 'minus');

// --- colours --------------------------------------------------------------------------------

/**
 * The fixed colours, sRGB. The 3D canvas is dark in both themes of the app (its background is
 * part of the lighting preset), so these are read against that: two neutrals a clear step apart
 * in lightness for the broad faces, a pale warm white for the tail's edge and a pink, a hue the
 * rail's zones never take, for the corners.
 */
export const PATCH_COLORS: Readonly<Record<Exclude<PatchName, 'rail'>, string>> = {
  deck: '#BDB8AC',
  bottom: '#6A7280',
  tailEdge: '#F6F1E4',
  corner: '#CC79A7',
};

/**
 * The rail's zone colours, in the order a list of zones takes them, then round again. They are
 * Okabe and Ito's colour-blind safe set without its pink (the corners') and black, ordered so
 * that two neighbours differ in hue and in lightness: orange, sky blue, bluish green,
 * vermillion, yellow, blue. The last-to-first pair (blue, orange) differs as much as the rest.
 */
export const RAIL_ZONE_COLORS: readonly string[] = [
  '#E69F00',
  '#56B4E9',
  '#009E73',
  '#D55E00',
  '#F0E442',
  '#0072B2',
];

/** The rail's colour on a board that has no zones. */
export const RAIL_NO_ZONES_COLOR = '#9AA3B0';

/** The colour of zone `index` (counted from the tail along a side). */
export const railZoneColor = (index: number): string => {
  const n = RAIL_ZONE_COLORS.length;
  return RAIL_ZONE_COLORS[((index % n) + n) % n]!;
};

/** How a chosen patch is drawn: brighter by `lift` and a little added, the rest dimmed and greyed. */
export const SELECTION_LOOK = { lift: 1.25, add: 0.08, dim: 0.5, grey: 0.35 } as const;

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

/** Where the rail keys of a document are, cm from the tail, per side. */
export interface RailKeyPlaces {
  readonly plus: readonly number[];
  /** Absent on a mirror board. */
  readonly minus?: readonly number[];
}

/**
 * Zones from a document's rail keys: each key a zone of no length at its place, coloured by its
 * index along its side. A mirror board's minus side takes the plus side's zones.
 */
export function zonesFromRailKeys(keys: RailKeyPlaces | null | undefined): RailZones {
  if (!keys) return { plus: [], minus: [] };
  const side = (xs: readonly number[]): RailZone[] =>
    xs.map((x, i) => ({ from: x, to: x, color: railZoneColor(i) }));
  const plus = side(keys.plus);
  return { plus, minus: keys.minus ? side(keys.minus) : plus };
}

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
}

/** What a tap on the board found: the patch, where, and for a rail the zone or blend there. */
export interface PatchPick extends PatchSelection {
  readonly side: Side;
  /** The place in board coordinates, cm: x from the tail, y from the stringer. */
  readonly x: number;
  readonly y: number;
}

/** A span no place is outside of. */
const EVERYWHERE = 1e9;

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
  /** 0 plus, 1 minus; -1 for a patch that is not one side's. */
  readonly side: number;
  readonly lo: number;
  readonly hi: number;
}

export const NO_SELECTION: SelectionUniforms = { patch: -1, side: -1, lo: 0, hi: 0 };

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
  return { patch: PATCH.rail, side: side === 'plus' ? 0 : 1, lo: span[0], hi: span[1] };
}

/**
 * Whether the place `(x, y)` on a patch is lit by a selection, as the shader decides it (the
 * shader softens the span's ends by a small feather; this is the unfeathered rule).
 */
export function isLit(sel: SelectionUniforms, patch: number, x: number, y: number): boolean {
  if (sel.patch !== patch) return false;
  if (patch !== PATCH.rail) return true;
  return (y >= 0 ? 0 : 1) === sel.side && x >= sel.lo && x <= sel.hi;
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
  if (vertex === undefined) return null;
  const name = patchNamed(patch[vertex] ?? -1);
  if (name === null) return null;
  const side = sideAt(hit.y);
  const base = { patch: name, side, x: hit.x, y: hit.y } as const;
  if (name !== 'rail') return base;
  const at = locateZone(sortedZones(side === 'plus' ? zones.plus : zones.minus), hit.x);
  if (at === null) return base;
  return at.kind === 'zone' ? { ...base, zone: at.zone } : { ...base, blend: at.blend };
}
