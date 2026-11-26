// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Contours: a board's bottom features as a shaper names them, and the numbers between a panel and the
 * feature edits of the store (`sections/features.ts`). A contour adds no geometry of its own: it is a bottom
 * feature, a depth over x times a profile across the bottom, and every edit here is a feature edit, held by
 * the limits `featureLimits` reports, so a control stops where it has to and never makes the engine refuse the
 * board.
 *
 * ## What each kind is, and its dials
 *
 * Every contour has **a depth** and **an extent** (where along the board it runs, from the tail). A kind adds
 * at most one more dial to its face; the rest is under More.
 *
 * | Kind            | Depth is                                              | Second dial | Under More                      |
 * | --------------- | ----------------------------------------------------- | ----------- | ------------------------------- |
 * | Single concave  | how far the bottom is raised into the board           | Width       |                                 |
 * | Double concave  | how far the bottom is raised in each hollow           | Width       | Centre                          |
 * | Vee             | how far the rails rise above the line of the stringer |             | Stringer blend                  |
 * | Channels        | how far the bottom is raised in each channel          | Count       | Channel width, Spacing, Rail inset |
 *
 * A concave's width is the share of the bottom's half width it reaches out to each side of its centre, a
 * channel count is channels each side of the stringer; both are the numbers the engine holds, shown as they
 * are. Depth is the same word for all four because it is the same number of the engine's, the height the
 * profile is scaled by at the deepest place along the board; what it measures, in a shaper's words, is on the
 * kind ({@link CONTOUR_KINDS}).
 *
 * ## Extent
 *
 * The extent is the first and last key of the depth curve ({@link contourExtent}). {@link setContourExtent}
 * moves them and carries the keys between with them, each keeping its share of the span, so the curve is
 * stretched or squeezed and never reshaped; the ends are held inside the station range and a least span apart,
 * and a notched tail's station range starts at the notch bottom, so a contour never runs into the notch: the
 * pins behind the notch bottom stay flat. {@link moveContour} slides the whole run, keeping its length.
 *
 * ## New contours
 *
 * {@link addContour} places a new contour by the kind's own run and depth ({@link CONTOUR_DEFAULTS}): shares of
 * the station range and centimetres that follow where a shaper cuts each kind. The contours the project's own
 * boards carry are a few fixtures that sit forward of the middle, so they are reported there and not followed.
 */
import type { BottomFeature, RailsBoard } from '@openshaper/board2';
import {
  FEATURE_MIN_SPAN,
  addFeature,
  depthPolyline,
  featureKindOf,
  featureLimits,
  featureRange,
  setFeatureDepth,
  setFeatureExtent,
  setFeatureKey,
  setFeatureParams,
  type ChordProvider,
  type FeatureKind,
  type FeatureParams,
} from '../sections/features';
import { halfWidthFn } from './measure';
import { stationSplines } from './project';

/** The kinds of contour a board can have. */
export type ContourKind = FeatureKind;

/**
 * The half width a contour edit measures channels against: the engine's, with a notch filled in (the engine
 * reads a feature across the board's filled outline, so a contour at a notch is read as if it were not there).
 */
export const chordsOf: ChordProvider<RailsBoard> = (doc, side) => halfWidthFn(doc.outline, side);

/**
 * The most contours a board holds: the engine's own limit on a board's bottom features. The engine refuses a
 * board with more (`board2/params.ts`), so Add stops here; a test builds a board with this many and shows that
 * one more is refused.
 */
export const MAX_CONTOURS = 64;

// --- the words -------------------------------------------------------------------------------------

/** The numbers a contour has: its depth, the two ends of its extent, and the parameters of its kind. */
export type DialKey = 'depth' | 'from' | 'to' | keyof FeatureParams;

/** A number a contour has: what it is called, how it is shown, and what it is in a shaper's words. */
export interface DialInfo {
  readonly key: DialKey;
  readonly label: string;
  /** `length` is centimetres in the document, `percent` a fraction of the bottom's half width, `count` a whole number. */
  readonly unit: 'length' | 'percent' | 'count';
  readonly note: string;
}

export interface ContourKindInfo {
  readonly kind: ContourKind;
  /** What the kind is called. */
  readonly name: string;
  /** What the kind is, in a sentence. */
  readonly note: string;
  /** The dial every kind shows. */
  readonly depth: DialInfo;
  /** The one other dial on the face, for the kinds that have one. */
  readonly second: DialInfo | null;
  /** The rest, under More. */
  readonly more: readonly DialInfo[];
}

const DEPTH_LABEL = 'Depth';

/** The kinds, in the order a shaper lists them. */
export const CONTOUR_KINDS: readonly ContourKindInfo[] = [
  {
    kind: 'single-concave',
    name: 'Single concave',
    note: 'One hollow along the middle of the bottom, centred on the stringer.',
    depth: {
      key: 'depth',
      label: DEPTH_LABEL,
      unit: 'length',
      note: 'How far the bottom is raised into the board along the stringer, at the deepest place along the contour.',
    },
    second: {
      key: 'width',
      label: 'Width',
      unit: 'percent',
      note: 'How far out towards the rails the hollow reaches on each side of the stringer, as a share of half the width of the bottom.',
    },
    more: [],
  },
  {
    kind: 'double-concave',
    name: 'Double concave',
    note: 'Two hollows, one each side of the stringer, with a ridge between them.',
    depth: {
      key: 'depth',
      label: DEPTH_LABEL,
      unit: 'length',
      note: 'How far the bottom is raised into the board in each hollow, at the deepest place along the contour.',
    },
    second: {
      key: 'width',
      label: 'Width',
      unit: 'percent',
      note: 'How wide each hollow is: how far it reaches on either side of its own centre, as a share of half the width of the bottom.',
    },
    more: [
      {
        key: 'centre',
        label: 'Centre',
        unit: 'percent',
        note: 'How far each hollow’s centre is from the stringer, as a share of half the width of the bottom.',
      },
    ],
  },
  {
    kind: 'vee',
    name: 'Vee',
    note: 'The bottom rises from the stringer to the rails, so the two halves meet in a ridge along the stringer.',
    depth: {
      key: 'depth',
      label: DEPTH_LABEL,
      unit: 'length',
      note: 'How far the rails rise above the line of the stringer, at the deepest place along the contour.',
    },
    second: null,
    more: [
      {
        key: 'stringerRadius',
        label: 'Stringer blend',
        unit: 'percent',
        note: 'How much of the half width is rounded off at the stringer, so the ridge is soft. A small share leaves a sharp ridge.',
      },
    ],
  },
  {
    kind: 'channels',
    name: 'Channels',
    note: 'Narrow grooves along the bottom, parallel to the rails, the same on both sides of the stringer.',
    depth: {
      key: 'depth',
      label: DEPTH_LABEL,
      unit: 'length',
      note: 'How deep each channel is cut: how far the bottom is raised into the board in a channel, at the deepest place along the contour.',
    },
    second: {
      key: 'count',
      label: 'Count',
      unit: 'count',
      note: 'How many channels there are on each side of the stringer.',
    },
    more: [
      { key: 'width', label: 'Channel width', unit: 'length', note: 'How wide one channel is.' },
      {
        key: 'pitch',
        label: 'Spacing',
        unit: 'length',
        note: 'Centre to centre of two neighbouring channels.',
      },
      {
        key: 'railInset',
        label: 'Rail inset',
        unit: 'length',
        note: 'How far the outermost channel is from the outline.',
      },
    ],
  },
];

export const contourKindInfo = (kind: ContourKind): ContourKindInfo =>
  CONTOUR_KINDS.find((k) => k.kind === kind)!;

/** The dial of the extent's two ends, in the words the panel uses. */
export const EXTENT_DIALS = {
  from: {
    label: 'From',
    note: 'Where the contour starts along the board, measured from the tail. The least it can be means it runs out the tail.',
  },
  to: {
    label: 'To',
    note: 'Where the contour ends along the board, measured from the tail.',
  },
} as const;

// --- reading a contour -----------------------------------------------------------------------------

/** One contour as a list shows it. */
export interface Contour {
  readonly id: string;
  readonly kind: ContourKind;
  /** The kind's name, numbered when the board has more than one of the kind ("Vee 2"). */
  readonly name: string;
  readonly enabled: boolean;
  /** The deepest place of the depth curve, cm. */
  readonly depth: number;
  /** Where it runs along the board, cm from the tail. */
  readonly from: number;
  readonly to: number;
}

/** The depth curve's greatest value, cm. */
export const contourDepth = (f: BottomFeature): number =>
  f.depth.keys.reduce((m, k) => Math.max(m, k.value), 0);

/** Where a contour runs along the board: its first and last depth key, cm from the tail. */
export const contourExtent = (
  f: BottomFeature,
): { readonly from: number; readonly to: number } => ({
  from: f.depth.keys[0]!.s,
  to: f.depth.keys[f.depth.keys.length - 1]!.s,
});

/** The contours of a board, in the order the document holds them. */
export function contoursOf(doc: Pick<RailsBoard, 'features'>): readonly Contour[] {
  const seen = new Map<ContourKind, number>();
  const total = new Map<ContourKind, number>();
  for (const f of doc.features) {
    const k = featureKindOf(f);
    total.set(k, (total.get(k) ?? 0) + 1);
  }
  return doc.features.map((f) => {
    const kind = featureKindOf(f);
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    return {
      id: f.id,
      kind,
      name:
        total.get(kind)! > 1 ? `${contourKindInfo(kind).name} ${n}` : contourKindInfo(kind).name,
      enabled: f.enabled,
      depth: contourDepth(f),
      ...contourExtent(f),
    };
  });
}

/** The station range a contour's ends stay inside: it starts at the notch bottom of a notched tail. */
export const contourRoom = (doc: RailsBoard): { readonly min: number; readonly max: number } =>
  featureRange(doc);

/** A number of a contour with the range it is held to on this board. */
export interface ContourDial extends DialInfo {
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

export interface ContourDials {
  readonly info: ContourKindInfo;
  readonly depth: ContourDial;
  readonly second: ContourDial | null;
  readonly more: readonly ContourDial[];
  /** The two ends of the extent. */
  readonly from: ContourDial;
  readonly to: ContourDial;
}

/** A parameter of a feature as the document holds it. */
function paramOf(f: BottomFeature, key: keyof FeatureParams): number {
  switch (key) {
    case 'stringerRadius':
      return f.kind === 'vee' ? f.stringerRadius : 0;
    case 'width':
      return f.kind === 'vee' ? 0 : f.width;
    case 'centre':
      return f.kind === 'concave' ? f.centre : 0;
    case 'count':
      return f.kind === 'channels' ? f.count : 0;
    case 'pitch':
      return f.kind === 'channels' ? f.pitch : 0;
    case 'railInset':
      return f.kind === 'channels' ? f.railInset : 0;
  }
}

/**
 * The numbers of the contour `id`, each with the range the board holds it to (never copied: read from
 * `featureLimits` for this board and these other numbers). Null for an id the board has not.
 */
export function contourDials(doc: RailsBoard, id: string): ContourDials | null {
  const f = doc.features.find((q) => q.id === id);
  if (!f) return null;
  const limits = featureLimits(doc, f, chordsOf);
  const info = contourKindInfo(featureKindOf(f));
  const dial = (d: DialInfo, value: number, key: keyof typeof limits): ContourDial => {
    const r = limits[key] ?? { min: value, max: value };
    return { ...d, value, min: r.min, max: Math.max(r.min, r.max) };
  };
  const param = (d: DialInfo): ContourDial =>
    dial(d, paramOf(f, d.key as keyof FeatureParams), d.key as keyof typeof limits);
  const { from, to } = contourExtent(f);
  const depth = dial(info.depth, contourDepth(f), 'depth');
  return {
    info,
    depth: { ...depth, max: Math.max(depth.min, Math.min(depth.max, contourDepthMax(doc, f))) },
    second: info.second ? param(info.second) : null,
    more: info.more.map(param),
    from: dial({ key: 'from', unit: 'length', ...EXTENT_DIALS.from }, from, 'from'),
    to: dial({ key: 'to', unit: 'length', ...EXTENT_DIALS.to }, to, 'to'),
  };
}

// --- editing a contour ----------------------------------------------------------------------------

/** Depths this close (cm) are the same depth: scaling a curve to a peak leaves it within an ulp of it. */
const SAME_DEPTH = 1e-9;

/**
 * The contour's depth, held between nothing and the most the board lets it have ({@link contourDepthMax}); the
 * keys between the ends keep their share of it. The depth it already has gives the document back.
 */
export function setContourDepth(doc: RailsBoard, id: string, depth: number): RailsBoard {
  const f = doc.features.find((q) => q.id === id);
  if (!f || !Number.isFinite(depth)) return doc;
  const held = Math.min(Math.max(depth, 0), contourDepthMax(doc, f));
  return Math.abs(held - contourDepth(f)) <= SAME_DEPTH ? doc : setFeatureDepth(doc, id, held);
}

/** The contour with the depth it has held to what the board lets it have under its new run, or the keys it has. */
const holdDepth = (doc: RailsBoard, id: string): RailsBoard => {
  const f = doc.features.find((q) => q.id === id);
  return f ? setContourDepth(doc, id, contourDepth(f)) : doc;
};

/**
 * Where a contour runs, cm from the tail. An end that is not given stays; the ends are held as
 * {@link setFeatureExtent} holds them, the keys between keep their share of the span, and the depth is held to
 * what the board lets the contour have where it now runs.
 */
export const setContourExtent = (
  doc: RailsBoard,
  id: string,
  from?: number,
  to?: number,
): RailsBoard => holdDepth(setFeatureExtent(doc, id, { from, to }, chordsOf), id);

/**
 * One key of the law between the ends: where it stands along the board (between its neighbours) and how deep it
 * is, held to the depth the contour may have. The ends are the extent, not keys of the law.
 */
export function setContourKey(
  doc: RailsBoard,
  id: string,
  index: number,
  patch: { s?: number; value?: number },
): RailsBoard {
  const f = doc.features.find((q) => q.id === id);
  if (!f) return doc;
  const max = contourDepthMax(doc, f);
  const held = patch.value === undefined ? patch : { ...patch, value: Math.min(patch.value, max) };
  return holdDepth(setFeatureKey(doc, id, index, held, chordsOf), id);
}

/**
 * The contour slid along the board so that it starts at `from`, keeping its length: it stops where an
 * end meets the station range and never gets shorter.
 */
export function moveContour(doc: RailsBoard, id: string, from: number): RailsBoard {
  const f = doc.features.find((q) => q.id === id);
  if (!f || !Number.isFinite(from)) return doc;
  const { from: a, to: b } = contourExtent(f);
  const room = featureRange(doc);
  const start = Math.min(Math.max(from, room.min), Math.max(room.min, room.max - (b - a)));
  return setContourExtent(doc, id, start, start + (b - a));
}

/** One parameter of a contour (the second dial, or one under More), held to its range. */
export const setContourParams = (doc: RailsBoard, id: string, patch: FeatureParams): RailsBoard =>
  setFeatureParams(doc, id, patch, chordsOf);

// --- new contours ---------------------------------------------------------------------------------

/**
 * Where a new contour of each kind runs, as shares of the station range from the tail (the notch bottom of
 * a notched tail to the nose), and how deep it is, cm. They are where a shaper cuts each kind, not where the
 * project's own boards have them.
 *
 * Three of the nine boards the project ships and makes carry contours, four in all, one of each kind. The six
 * others, the five starter templates among them, have none, and the four are fixtures drawn to exercise the
 * engine, forward of the middle of their boards:
 *
 * | Kind           | Board      | Runs (share of the range) | Deepest, cm |
 * | -------------- | ---------- | ------------------------- | ----------- |
 * | Single concave | fish       | 0.21 to 0.82              | 0.35        |
 * | Double concave | swallow    | 0.40 to 0.74              | 0.30        |
 * | Vee            | swallow    | 0.28 to 0.91              | 0.20        |
 * | Channels       | asymmetric | 0.39 to 0.83              | 0.30        |
 *
 * So the runs follow shaping practice: a single concave through the middle third; a vee and a double concave
 * out of the tail, the vee as far as the middle and the double concave a little past it; channels in the tail
 * half, no nearer the tip than the first tenth of the range, where the half width holds their reach (5 cm at
 * the defaults) on every board that is shipped or made. The depths are the fixtures': 2 to 3.5 mm, which is
 * what is cut, the median 3 mm and the vee's 2 mm. A depth is held to what the board lets the contour have.
 */
export const CONTOUR_DEFAULTS: Readonly<
  Record<ContourKind, { readonly from: number; readonly to: number; readonly depth: number }>
> = {
  'single-concave': { from: 1 / 3, to: 2 / 3, depth: 0.3 },
  'double-concave': { from: 0, to: 0.55, depth: 0.3 },
  vee: { from: 0, to: 0.5, depth: 0.2 },
  channels: { from: 0.1, to: 0.45, depth: 0.3 },
};

/**
 * Whether a board has room for another contour. The panel offers Add only while it does, and
 * {@link addContour} gives the board back unchanged when it does not.
 */
export const canAddContour = (doc: Pick<RailsBoard, 'features'>): boolean =>
  doc.features.length < MAX_CONTOURS;

/**
 * A new contour of `kind`, on, at the kind's own run and depth unless `options` say otherwise. An end
 * that is given wins and the other gives way to the least span; the ends are held inside the station range
 * and the depth to what the board holds, so a contour asked for anywhere with any depth is added, held at
 * the nearest it can be, and the board stays one the engine builds. Gives `doc` back when the board has
 * {@link MAX_CONTOURS} already.
 */
export function addContour(
  doc: RailsBoard,
  kind: ContourKind,
  options: { from?: number; to?: number; depth?: number } = {},
): RailsBoard {
  if (!canAddContour(doc)) return doc;
  const d = CONTOUR_DEFAULTS[kind];
  const room = featureRange(doc);
  const start = doc.outline.plus.knots[0]!.p[0];
  const run = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0] - start;
  const given = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);
  const near = (x: number): number => Math.min(Math.max(x, room.min), room.max);
  let from = given(options.from) ? near(options.from) : near(start + d.from * run);
  let to = given(options.to) ? near(options.to) : near(start + d.to * run);
  // an end that was given stays where there is room; the other gives way to the least span
  if (to - from < FEATURE_MIN_SPAN) {
    if (given(options.to) && !given(options.from)) from = near(to - FEATURE_MIN_SPAN);
    else to = near(from + FEATURE_MIN_SPAN);
  }
  const added = addFeature(doc, kind, chordsOf, {
    from,
    to,
    depth: given(options.depth) ? options.depth : d.depth,
  });
  return holdDepth(added, added.features[added.features.length - 1]!.id);
}

// --- the relief a contour makes ---------------------------------------------------------------------

/** `(1 - t^2)^2` on |t| < 1, else 0: the engine's bump (`board2/features.ts`). */
const bump = (t: number): number => {
  if (!(Math.abs(t) < 1)) return 0;
  const s = 1 - t * t;
  return s * s;
};

/** The vee's profile: flat at the stringer, linear to 1 at the outline, blended over `r` (`board2/features.ts`). */
const veeProfile = (t: number, r: number): number =>
  (t < r ? (t * t) / (2 * r) : t - r / 2) / (1 - r / 2);

/**
 * The profile of a contour across the bottom at `u`, the distance from the stringer as a share of the half
 * width (0 at the stringer, 1 at the outline), with `chord` the half width in cm (channels are measured from the
 * outline in cm). Times the depth at that place along the board, it is the height the contour raises the
 * bottom by: the engine's relief, before the mesh fades it along the rail. A test holds it to the engine's own.
 */
export function contourProfile(f: BottomFeature, u: number, chord: number): number {
  switch (f.kind) {
    case 'vee':
      return veeProfile(u, f.stringerRadius);
    case 'concave':
      return bump((u - (f.layout === 'single' ? 0 : f.centre)) / f.width);
    case 'channels': {
      let s = 0;
      for (let k = 0; k < f.count; k++) {
        const offset = f.railInset + f.width / 2 + k * f.pitch;
        s += bump((chord * (u - 1) + offset) / (f.width / 2));
      }
      return s;
    }
  }
}

/** Points of the depth curve's polyline per segment. */
const DEPTH_POINTS = 96;

/** A depth curve's polyline, made once for each curve: the plan reads a contour's depth thousands of times a draw. */
const polylines = new WeakMap<object, readonly { readonly x: number; readonly depth: number }[]>();

function polylineOf(f: BottomFeature): readonly { readonly x: number; readonly depth: number }[] {
  let line = polylines.get(f.depth);
  if (line === undefined) {
    line = depthPolyline(f.depth, DEPTH_POINTS);
    polylines.set(f.depth, line);
  }
  return line;
}

/** The contour's depth at `x` cm from the tail (cm; zero outside its extent), read off the curve's polyline. */
export function contourDepthAt(f: BottomFeature, x: number): number {
  const keys = f.depth.keys;
  if (!(x > keys[0]!.s && x < keys[keys.length - 1]!.s)) return 0;
  const line = polylineOf(f);
  let lo = 0;
  let hi = line.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line[mid]!.x <= x) lo = mid;
    else hi = mid;
  }
  const a = line[lo]!;
  const b = line[hi]!;
  return b.x > a.x ? a.depth + ((b.depth - a.depth) * (x - a.x)) / (b.x - a.x) : a.depth;
}

/**
 * The share (0 to 1) of its greatest depth the contour has at `x`: its law along the board. A contour at no
 * depth has no law of its own: raised from nothing it takes the plateau of its keys (the ends at nothing,
 * every key between them level), so that is the shape it is read for, and the number does not jump as the
 * depth leaves zero.
 */
export function contourShapeAt(f: BottomFeature, x: number): number {
  const peak = contourDepth(f);
  if (peak > 0) return contourDepthAt(f, x) / peak;
  const plateau: BottomFeature = {
    ...f,
    depth: {
      keys: f.depth.keys.map((k, i, all) => ({
        s: k.s,
        value: i === 0 || i === all.length - 1 ? 0 : 1,
      })),
    },
  };
  return contourDepthAt(plateau, x);
}

// --- how deep the board lets a contour be -------------------------------------------------------------

/**
 * The share of the board's thickness at the wall that a contour may take. The depth the shared rule allows is
 * a share of the stringer's thickness (`featureLimits`), which does not look at the rail, where the board is
 * thinnest: a vee raises the bottom by its whole depth there, and at a notch's bottom or a tip the wall is a
 * millimetre or two thick. A contour of half the wall's thickness leaves half of it, at the wall, which is
 * the least the board is anywhere across: no kind raises the bottom by more than its depth.
 */
export const WALL_SHARE = 0.5;

/** Places along a contour's run where the wall's thickness is read. */
const WALL_SAMPLES = 32;

/** A place where the depth is under this share of its greatest does not bind the depth: its relief is too small to matter. */
const WALL_SHAPE_FLOOR = 0.02;

/** The thickness of the board at the wall (cm) at each station that has one: the least of the two sides. */
function wallThickness(doc: RailsBoard): readonly { readonly x: number; readonly t: number }[] {
  const sides =
    doc.outline.minus === undefined ? (['plus'] as const) : (['plus', 'minus'] as const);
  const entries = sides.map((side) => stationSplines(doc, side));
  const out: { x: number; t: number }[] = [];
  doc.stations.forEach((station, i) => {
    let t = Infinity;
    for (const side of entries) {
      const e = side[i]!;
      if (!(e.w > 0 && e.T > 0)) continue;
      const deck = e.deck.knots;
      const bottom = e.bottom.knots;
      t = Math.min(t, deck[deck.length - 1]!.end.y - bottom[bottom.length - 1]!.end.y);
    }
    if (Number.isFinite(t)) out.push({ x: station.x, t: Math.max(0, t) });
  });
  return out;
}

/** The wall's thickness at `x`, between the stations either side of it. */
function wallAt(wall: readonly { readonly x: number; readonly t: number }[], x: number): number {
  if (x <= wall[0]!.x) return wall[0]!.t;
  for (let i = 1; i < wall.length; i++) {
    const b = wall[i]!;
    if (x <= b.x) {
      const a = wall[i - 1]!;
      return a.t + ((b.t - a.t) * (x - a.x)) / (b.x - a.x);
    }
  }
  return wall[wall.length - 1]!.t;
}

/**
 * The most depth (cm) the board lets this contour have where it runs: the depth the shared rule gives
 * ({@link featureLimits}), and the least of {@link WALL_SHARE} of the wall's thickness at each place along the
 * run divided by how much of the depth the contour has there. A run over a thin stretch, a notch's bottom or a
 * tip, takes less.
 */
export function contourDepthMax(doc: RailsBoard, f: BottomFeature): number {
  const shared = featureLimits(doc, f, chordsOf).depth!.max;
  const wall = wallThickness(doc);
  if (wall.length === 0) return shared;
  const { from, to } = contourExtent(f);
  let bound = Infinity;
  for (let i = 1; i < WALL_SAMPLES; i++) {
    const x = from + ((to - from) * i) / WALL_SAMPLES;
    const shape = contourShapeAt(f, x);
    if (shape > WALL_SHAPE_FLOOR) bound = Math.min(bound, (WALL_SHARE * wallAt(wall, x)) / shape);
  }
  return Math.min(shared, bound);
}

/** The height a contour raises the bottom by at the plan point (x, y): `y` cm from the stringer on the side the half width `w` is of. */
export const contourReliefAt = (f: BottomFeature, x: number, y: number, w: number): number =>
  w > 0 ? contourDepthAt(f, x) * contourProfile(f, Math.min(Math.abs(y) / w, 1), w) : 0;

/** A stretch across the bottom, cm from the stringer. */
export interface Band {
  readonly from: number;
  readonly to: number;
}

/**
 * Where across the bottom a contour acts at a place where the half width is `w`, as stretches measured from
 * the stringer (cm): the hollow of a single concave, each hollow of a double, the whole bottom for a vee, each
 * channel. The profile is zero outside them.
 */
export function contourBands(f: BottomFeature, w: number): readonly Band[] {
  switch (f.kind) {
    case 'vee':
      return [{ from: 0, to: w }];
    case 'concave': {
      const centre = f.layout === 'single' ? 0 : f.centre;
      return [
        { from: Math.max(0, (centre - f.width) * w), to: Math.min(w, (centre + f.width) * w) },
      ];
    }
    case 'channels': {
      const out: Band[] = [];
      for (let k = 0; k < f.count; k++) {
        const middle = w - (f.railInset + f.width / 2 + k * f.pitch);
        out.push({
          from: Math.max(0, middle - f.width / 2),
          to: Math.min(w, middle + f.width / 2),
        });
      }
      return out;
    }
  }
}

/**
 * The contour at a plan point, or null: the enabled contour whose run and bottom stretch (all its bands
 * and what lies between them) hold the point, the narrowest of those when there are several, so a
 * hollow on top of a vee is the hollow. `x` is cm from the tail, `y` cm from the stringer, `side` the side of
 * the board `y` is on.
 */
export function contourAt(
  doc: RailsBoard,
  x: number,
  y: number,
  side: 'plus' | 'minus' = 'plus',
): string | null {
  const w = halfWidthFn(doc.outline, side === 'minus' ? 'minus' : undefined)(x);
  if (!(w > 0)) return null;
  const across = Math.abs(y);
  let best: { id: string; width: number; depth: number } | null = null;
  for (const f of doc.features) {
    const { from, to } = contourExtent(f);
    if (!f.enabled || !(x > from && x < to)) continue;
    const bands = contourBands(f, w);
    const lo = Math.min(...bands.map((b) => b.from));
    const hi = Math.max(...bands.map((b) => b.to));
    if (!(across >= lo && across <= hi)) continue;
    const width = hi - lo;
    const depth = contourDepth(f);
    if (best === null || width < best.width || (width === best.width && depth > best.depth)) {
      best = { id: f.id, width, depth };
    }
  }
  return best?.id ?? null;
}

// --- the law along the board -----------------------------------------------------------------------

/** A key of a contour's depth curve between its ends, with what it may be moved to. */
export interface ContourKey {
  /** The key's index in the depth curve (the ends are 0 and the last, and are the extent). */
  readonly index: number;
  /** Where along the board, cm from the tail. */
  readonly s: number;
  /** The depth there, cm. */
  readonly value: number;
  /** Where it may stand: between its neighbours. */
  readonly sMin: number;
  readonly sMax: number;
  /** The most depth it may have on this board. */
  readonly valueMax: number;
  /** Whether it may be removed: a curve keeps its ends and one key between. */
  readonly removable: boolean;
}

/** The keys of the depth curve between the ends, the contour's law along the board. */
export function contourKeys(doc: RailsBoard, id: string): readonly ContourKey[] {
  const f = doc.features.find((q) => q.id === id);
  if (!f) return [];
  const keys = f.depth.keys;
  const depthMax = contourDepthMax(doc, f);
  return keys.slice(1, -1).map((k, i) => ({
    index: i + 1,
    s: k.s,
    value: k.value,
    sMin: keys[i]!.s,
    sMax: keys[i + 2]!.s,
    valueMax: depthMax,
    removable: keys.length > 3,
  }));
}
