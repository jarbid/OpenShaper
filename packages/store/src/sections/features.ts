// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom-feature edits of a section document (docs/design/m2-editor.md §2, step 4): add, remove, enable
 * and disable, set a parameter or a depth key of a vee, a single or double concave and channels. Pure
 * functions of a document, a section document (`BoardDoc`) or a rails board alike: each reads only
 * the fields of {@link FeatureDoc}. A feature edit changes `features` and nothing else, so every `Chain`,
 * `Section` and `Station` is passed through by reference and `buildBoard`'s fit cache stays warm.
 *
 * **Bounds.** Every parameter has a range ({@link featureLimits}) that the edits clamp to and the sidebar
 * shows, chosen so a value inside it never makes the validator refuse the feature: fractions of the chord
 * stay inside (0, 1] (a double concave's bumps stay apart and off the outline), channels keep clear of the
 * stringer (the chord limit is a conservative lower bound taken from the outline), and the depth keys stay
 * strictly inside the station range (`feature-invalid` otherwise).
 *
 * **Tail changes.** A feature's keys must lie strictly inside `(xi0, L)`, `xi0` the notch bottom
 * ({@link refitFeatures}): when a tail change or a deeper notch moves `xi0` past a key, the curve is
 * squeezed into the room that is left rather than refused.
 */
import type {
  BottomFeature,
  Chain,
  ChannelsFeature,
  ConcaveFeature,
  KeyedCurve,
  LawKey,
  Outline,
  TailSpec,
  VeeFeature,
} from '@openshaper/board2';
import { valueAt } from '@openshaper/kernel';
import { chainToSpline } from './project';

/**
 * What the feature edits read of a document: its features, outline, rocker and deck, and its tail
 * where it stores one. A document without a `tail` (a rails board) is notched when its outline's
 * first knot lies past x = 0, the tail being at x = 0.
 */
export interface FeatureDoc {
  readonly features: readonly BottomFeature[];
  readonly outline: Outline;
  readonly rocker: Chain;
  readonly deck: Chain;
  readonly tail?: TailSpec;
}

/**
 * The half width (chord) of one side of a document at x, where the outline alone cannot give it (a
 * notched tail): the section store's `NotchChords`, or the rails store's half width.
 */
export type ChordProvider<D> = (doc: D, side?: 'minus') => (x: number) => number;

const isNotched = (doc: FeatureDoc): boolean =>
  doc.tail !== undefined ? doc.tail.kind === 'notched' : doc.outline.plus.knots[0]!.p[0] > 0;

/** What the sidebar offers to add. A concave's layout is part of the kind. */
export type FeatureKind = 'vee' | 'single-concave' | 'double-concave' | 'channels';

export const FEATURE_KINDS: readonly FeatureKind[] = [
  'vee',
  'single-concave',
  'double-concave',
  'channels',
];

/** The kind of a feature as the sidebar names it. */
export const featureKindOf = (f: BottomFeature): FeatureKind =>
  f.kind === 'concave' ? (f.layout === 'single' ? 'single-concave' : 'double-concave') : f.kind;

/** The parameters {@link setFeatureParams} takes (those that do not apply to the kind are ignored). */
export interface FeatureParams {
  /** Vee: half-width of the blend at the stringer, fraction of the chord. */
  stringerRadius?: number;
  /** Concave: lateral half-width of a bump, fraction of the chord. Channels: channel width, cm. */
  width?: number;
  /** Double concave: lateral centre of each bump, fraction of the chord. */
  centre?: number;
  /** Channels: how many. */
  count?: number;
  /** Channels: centre to centre, cm. */
  pitch?: number;
  /** Channels: the outermost one's distance from the outline, cm. */
  railInset?: number;
}

export type FeatureParamName = keyof FeatureParams | 'depth';

export interface Range {
  readonly min: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// Constants (the editor's, not the model's)
// ---------------------------------------------------------------------------

/** Keys stay this far (cm) inside the station range. */
const KEY_MARGIN = 0.5;
/** The least a depth curve spans (cm). */
const MIN_SPAN = 2;
/** The least a fraction of the chord. */
const MIN_FRACTION = 0.05;
/** Depth is held to this share of the thinnest stringer thickness under the feature, and to this many cm. */
const DEPTH_SHARE = 0.3;
const DEPTH_CAP = 1.5;
/** Channels: counts, widths (cm) and the share of the chord they may reach. */
const MAX_CHANNELS = 4;
const MIN_CHANNEL_WIDTH = 0.2;
const MAX_CHANNEL_WIDTH = 3;
const CHORD_SHARE = 0.95;
const CHORD_SAMPLES = 48;

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];
const firstX = (c: Chain): number => c.knots[0]!.p[0];

/** The station range the keys lie inside: `(xi0, L)` shrunk by the margin. */
export function featureRange<D extends FeatureDoc>(doc: D): Range {
  const L = lengthOf(doc.outline.plus);
  return { min: firstX(doc.outline.plus) + KEY_MARGIN, max: L - KEY_MARGIN };
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

// ---------------------------------------------------------------------------
// The depth curve
// ---------------------------------------------------------------------------

const peakOf = (c: KeyedCurve): number => c.keys.reduce((m, k) => Math.max(m, k.value), 0);

/** Monotone slope of every key, as `autoSlopes` in board2's features (the editor draws the curve itself). */
function slopes(keys: readonly LawKey[]): number[] {
  const n = keys.length;
  const m = new Array<number>(n).fill(0);
  const delta = (i: number): number =>
    (keys[i + 1]!.value - keys[i]!.value) / (keys[i + 1]!.s - keys[i]!.s);
  for (let k = 1; k < n - 1; k++) {
    const da = delta(k - 1);
    const db = delta(k);
    if (!(da * db > 0)) continue;
    const ha = keys[k]!.s - keys[k - 1]!.s;
    const hb = keys[k + 1]!.s - keys[k]!.s;
    const three = (hb * da + ha * db) / (ha + hb);
    const limit = 3 * Math.min(Math.abs(da), Math.abs(db));
    m[k] = Math.sign(three) * Math.min(Math.abs(three), limit);
  }
  return m;
}

/**
 * The depth curve as a polyline `(x, depth)`: `perSegment` points on each Bézier segment, taken on the
 * curve itself, so no inversion is needed. Exact to the pixel for the read-only strip in the rocker pane;
 * the model evaluates the same curve with board2's `keyedEvaluator`.
 */
export function depthPolyline(
  curve: KeyedCurve,
  perSegment = 12,
): readonly { readonly x: number; readonly depth: number }[] {
  const keys = curve.keys;
  const m = slopes(keys);
  const clampTo = (x: number, span: number): number =>
    Math.min(Math.max(x, Math.min(0, span)), Math.max(0, span));
  const out: { x: number; depth: number }[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const h = b.s - a.s;
    const span = b.value - a.value;
    const oh = a.out ?? { ds: h / 3, dv: clampTo(m[i]! * (h / 3), span) };
    const ih = b.in ?? { ds: h / 3, dv: clampTo(m[i + 1]! * (h / 3), span) };
    const xs = [a.s, a.s + oh.ds, b.s - ih.ds, b.s];
    const vs = [a.value, a.value + oh.dv, b.value - ih.dv, b.value];
    for (let j = i === 0 ? 0 : 1; j <= perSegment; j++) {
      const t = j / perSegment;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      out.push({
        x: w[0]! * xs[0]! + w[1]! * xs[1]! + w[2]! * xs[2]! + w[3]! * xs[3]!,
        depth: w[0]! * vs[0]! + w[1]! * vs[1]! + w[2]! * vs[2]! + w[3]! * vs[3]!,
      });
    }
  }
  return out;
}

/** The depth curve's value at `s` (by the polyline; the table's new key starts there). */
function depthAt(curve: KeyedCurve, s: number): number {
  const pts = depthPolyline(curve, 24);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (s >= a.x && s <= b.x)
      return b.x > a.x ? a.depth + ((b.depth - a.depth) * (s - a.x)) / (b.x - a.x) : a.depth;
  }
  return 0;
}

/** Ease handles are in the old segment's units: scale them with a squeeze of the keys. */
const scaleHandle = (h: LawKey['in'], r: number): LawKey['in'] =>
  h === undefined ? undefined : { ds: h.ds * r, dv: h.dv };

/** The curve with its keys mapped affinely from `[a, b]` onto `[a2, b2]`. */
function remap(c: KeyedCurve, a: number, b: number, a2: number, b2: number): KeyedCurve {
  const r = (b2 - a2) / (b - a);
  return {
    keys: c.keys.map((k, i, all): LawKey => {
      const s = i === 0 ? a2 : i === all.length - 1 ? b2 : a2 + (k.s - a) * r;
      const inn = scaleHandle(k.in, r);
      const out = scaleHandle(k.out, r);
      return { s, value: k.value, ...(inn ? { in: inn } : {}), ...(out ? { out } : {}) };
    }),
  };
}

/** The curve moved to start at `from` and end at `to` (the keys in between keep their place on the curve). */
const withSpan = (c: KeyedCurve, from: number, to: number): KeyedCurve =>
  remap(c, c.keys[0]!.s, c.keys[c.keys.length - 1]!.s, from, to);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * A lower bound on the chord length (cm) over `[a, b]` on both halves. A standard tail's chord is the
 * half-width at x, sampled from the outline. In a notch zone it fans across the rail and is short near the
 * notch bottom, which only board2's frame knows: the injected `chords` (as the projection takes them)
 * measure it; without them the floor of a notched board is zero (no channel fits), which the app avoids by
 * loading the provider before it opens a notched board.
 */
function chordFloor<D extends FeatureDoc>(
  doc: D,
  a: number,
  b: number,
  chords?: ChordProvider<D>,
): number {
  let m = Infinity;
  const notched = isNotched(doc);
  if (notched && chords === undefined) return 0;
  const sides = doc.outline.minus === undefined ? [undefined] : [undefined, 'minus' as const];
  for (const side of sides) {
    const outline = side === 'minus' ? doc.outline.minus! : doc.outline.plus;
    const fn = notched ? chords!(doc, side) : null;
    const spline = chainToSpline(outline);
    for (let i = 0; i <= CHORD_SAMPLES; i++) {
      const x = a + ((b - a) * i) / CHORD_SAMPLES;
      m = Math.min(m, fn ? fn(x) : valueAt(spline, x));
    }
  }
  return m;
}

/** The thinnest stringer thickness (cm) over `[a, b]`. */
function thicknessFloor<D extends FeatureDoc>(doc: D, a: number, b: number): number {
  const deck = chainToSpline(doc.deck);
  const rocker = chainToSpline(doc.rocker);
  let m = Infinity;
  for (let i = 0; i <= CHORD_SAMPLES; i++) {
    const x = a + ((b - a) * i) / CHORD_SAMPLES;
    m = Math.min(m, valueAt(deck, x) - valueAt(rocker, x));
  }
  return m;
}

/** How far the outermost channel's far edge reaches from the outline. */
const reachOf = (f: ChannelsFeature): number => f.railInset + f.width + (f.count - 1) * f.pitch;

/** The most a feature's channels may reach from the outline (cm). */
const reachLimit = <D extends FeatureDoc>(
  doc: D,
  f: BottomFeature,
  chords?: ChordProvider<D>,
): number => {
  const keys = f.depth.keys;
  return CHORD_SHARE * chordFloor(doc, keys[0]!.s, keys[keys.length - 1]!.s, chords);
};

/** The range of the depth (cm) of a feature on this board. */
function depthRange<D extends FeatureDoc>(doc: D, f: BottomFeature): Range {
  const keys = f.depth.keys;
  const t = thicknessFloor(doc, keys[0]!.s, keys[keys.length - 1]!.s);
  return { min: 0, max: Math.max(0.05, Math.min(DEPTH_CAP, DEPTH_SHARE * t)) };
}

/**
 * The range of every parameter of a feature given the others (what the sidebar's fields clamp to), plus
 * `depth` (the greatest depth) and `from` and `to` (the first and last key's x).
 */
export function featureLimits<D extends FeatureDoc>(
  doc: D,
  f: BottomFeature,
  chords?: ChordProvider<D>,
): Partial<Record<FeatureParamName | 'from' | 'to', Range>> {
  const room = featureRange(doc);
  const keys = f.depth.keys;
  const first = keys[0]!.s;
  const last = keys[keys.length - 1]!.s;
  const out: Partial<Record<FeatureParamName | 'from' | 'to', Range>> = {
    depth: depthRange(doc, f),
    from: { min: room.min, max: Math.max(room.min, last - MIN_SPAN) },
    to: { min: Math.min(room.max, first + MIN_SPAN), max: room.max },
  };
  switch (f.kind) {
    case 'vee':
      out.stringerRadius = { min: MIN_FRACTION, max: 1 };
      break;
    case 'concave':
      if (f.layout === 'single') {
        out.width = { min: MIN_FRACTION, max: 1 };
      } else {
        out.width = { min: MIN_FRACTION, max: 0.5 };
        out.centre = { min: f.width, max: 1 - f.width };
      }
      break;
    case 'channels': {
      const limit = reachLimit(doc, f, chords);
      const rest = (f.count - 1) * f.pitch;
      out.count = { min: 1, max: Math.max(1, Math.min(MAX_CHANNELS, countFor(f, limit))) };
      out.width = {
        min: MIN_CHANNEL_WIDTH,
        max: Math.max(
          MIN_CHANNEL_WIDTH,
          Math.min(MAX_CHANNEL_WIDTH, f.pitch, limit - f.railInset - rest),
        ),
      };
      out.pitch = {
        min: f.width,
        max: Math.max(f.width, f.count > 1 ? (limit - f.railInset - f.width) / (f.count - 1) : 10),
      };
      out.railInset = { min: 0, max: Math.max(0, limit - f.width - rest) };
      break;
    }
  }
  return out;
}

/** The most channels that fit in `limit`. */
const countFor = (f: ChannelsFeature, limit: number): number =>
  Math.floor((limit - f.railInset - f.width) / f.pitch) + 1;

/** `f` with its channels brought inside `limit`, giving way in the order the user is least likely to mind. */
function fitChannels(
  f: ChannelsFeature,
  limit: number,
  first?: keyof FeatureParams,
): ChannelsFeature {
  let g = f;
  if (reachOf(g) <= limit) return g;
  const order: (keyof FeatureParams)[] = (
    ['railInset', 'pitch', 'count', 'width'] as (keyof FeatureParams)[]
  ).filter((k) => k !== first);
  if (first !== undefined) order.unshift(first);
  for (const key of order) {
    if (reachOf(g) <= limit) break;
    if (key === 'railInset') {
      g = { ...g, railInset: Math.max(0, limit - g.width - (g.count - 1) * g.pitch) };
    } else if (key === 'pitch' && g.count > 1) {
      g = { ...g, pitch: Math.max(g.width, (limit - g.railInset - g.width) / (g.count - 1)) };
    } else if (key === 'count') {
      g = { ...g, count: clamp(countFor(g, limit), 1, g.count) };
    } else if (key === 'width') {
      const width = Math.max(MIN_CHANNEL_WIDTH, limit - g.railInset - (g.count - 1) * g.pitch);
      g = {
        ...g,
        width: Math.min(g.width, width),
        pitch: Math.max(Math.min(g.width, width), g.pitch),
      };
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Where a new feature starts and ends, as shares of the station range, and how deep it is (cm). */
const DEFAULTS: Record<FeatureKind, { from: number; to: number; depth: number }> = {
  vee: { from: 0.1, to: 0.92, depth: 0.25 },
  'single-concave': { from: 0.3, to: 0.85, depth: 0.3 },
  'double-concave': { from: 0.1, to: 0.55, depth: 0.3 },
  channels: { from: 0.1, to: 0.45, depth: 0.25 },
};

/** A trapezoid depth: in, a plateau, out. */
const plateau = (from: number, to: number, depth: number): KeyedCurve => ({
  keys: [
    { s: from, value: 0 },
    { s: from + 0.3 * (to - from), value: depth },
    { s: from + 0.7 * (to - from), value: depth },
    { s: to, value: 0 },
  ],
});

const freshId = <D extends FeatureDoc>(doc: D, kind: FeatureKind): string => {
  const used = new Set(doc.features.map((f) => f.id));
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
};

/** A new feature of `kind`, enabled, with its defaults fitted to this board. */
function newFeature<D extends FeatureDoc>(
  doc: D,
  kind: FeatureKind,
  chords?: ChordProvider<D>,
): BottomFeature {
  const d = DEFAULTS[kind];
  const xi0 = firstX(doc.outline.plus);
  const R = lengthOf(doc.outline.plus) - xi0;
  const room = featureRange(doc);
  const depth = plateau(
    clamp(xi0 + d.from * R, room.min, room.max - MIN_SPAN),
    clamp(xi0 + d.to * R, room.min + MIN_SPAN, room.max),
    d.depth,
  );
  const base = { id: freshId(doc, kind), enabled: true, depth };
  let f: BottomFeature;
  switch (kind) {
    case 'vee':
      f = { ...base, kind: 'vee', stringerRadius: 0.3 } satisfies VeeFeature;
      break;
    case 'single-concave':
      f = {
        ...base,
        kind: 'concave',
        layout: 'single',
        centre: 0,
        width: 0.7,
      } satisfies ConcaveFeature;
      break;
    case 'double-concave':
      f = {
        ...base,
        kind: 'concave',
        layout: 'double',
        centre: 0.4,
        width: 0.3,
      } satisfies ConcaveFeature;
      break;
    case 'channels':
      f = { ...base, kind: 'channels', count: 2, width: 0.8, pitch: 1.2, railInset: 3 };
      break;
  }
  return fitFeature(doc, f, chords);
}

/** `f` with its depth within this board's range and its channels inside the chord. */
function fitFeature<D extends FeatureDoc>(
  doc: D,
  f: BottomFeature,
  chords?: ChordProvider<D>,
): BottomFeature {
  const range = depthRange(doc, f);
  const peak = peakOf(f.depth);
  let g: BottomFeature = f;
  if (peak > range.max) g = { ...g, depth: scaleDepth(g.depth, range.max) };
  if (g.kind === 'channels') {
    const fitted = fitChannels(g, reachLimit(doc, g, chords));
    if (fitted !== g) g = fitted;
  }
  return g;
}

/** The depth curve with its peak at `peak` (explicit ease handles scale with it). */
function scaleDepth(c: KeyedCurve, peak: number): KeyedCurve {
  const now = peakOf(c);
  const r = now > 0 ? peak / now : 1;
  const n = c.keys.length;
  const handle = (h: LawKey['in']): LawKey['in'] =>
    h === undefined ? undefined : { ds: h.ds, dv: h.dv * r };
  return {
    keys: c.keys.map((k, i): LawKey => {
      const edge = i === 0 || i === n - 1;
      const value = edge ? 0 : now > 0 ? k.value * r : peak;
      const inn = handle(k.in);
      const out = handle(k.out);
      return { s: k.s, value, ...(inn ? { in: inn } : {}), ...(out ? { out } : {}) };
    }),
  };
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

const replace = <D extends FeatureDoc>(
  doc: D,
  id: string,
  to: (f: BottomFeature) => BottomFeature,
): D => {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) return doc;
  const was = doc.features[i]!;
  const next = to(was);
  if (next === was) return doc;
  return { ...doc, features: doc.features.map((f, j) => (j === i ? next : f)) };
};

/** The document with a new feature of `kind` appended. Its id is `kind`, or `kind-2`, `kind-3`, … */
export function addFeature<D extends FeatureDoc>(
  doc: D,
  kind: FeatureKind,
  chords?: ChordProvider<D>,
): D {
  return { ...doc, features: [...doc.features, newFeature(doc, kind, chords)] };
}

/** The document without the feature. */
export function removeFeature<D extends FeatureDoc>(doc: D, id: string): D {
  return doc.features.some((f) => f.id === id)
    ? { ...doc, features: doc.features.filter((f) => f.id !== id) }
    : doc;
}

/** The feature switched on or off (a disabled one is kept, with its settings, and not built). */
export const setFeatureEnabled = <D extends FeatureDoc>(
  doc: D,
  id: string,
  enabled: boolean,
  chords?: ChordProvider<D>,
): D =>
  replace(doc, id, (f) => (f.enabled === enabled ? f : fitFeature(doc, { ...f, enabled }, chords)));

/**
 * Parameters of a feature, each held to its range given the others. A double concave's centre follows its
 * width (it stays between the width and one minus the width); channels give way to fit inside the chord,
 * the one being edited last.
 */
export function setFeatureParams<D extends FeatureDoc>(
  doc: D,
  id: string,
  patch: FeatureParams,
  chords?: ChordProvider<D>,
): D {
  return replace(doc, id, (f) => {
    const num = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);
    switch (f.kind) {
      case 'vee': {
        if (!num(patch.stringerRadius)) return f;
        const stringerRadius = clamp(patch.stringerRadius, MIN_FRACTION, 1);
        return stringerRadius === f.stringerRadius ? f : { ...f, stringerRadius };
      }
      case 'concave': {
        if (f.layout === 'single') {
          if (!num(patch.width)) return f;
          const width = clamp(patch.width, MIN_FRACTION, 1);
          return width === f.width ? f : { ...f, width };
        }
        const width = num(patch.width) ? clamp(patch.width, MIN_FRACTION, 0.5) : f.width;
        const centre = clamp(num(patch.centre) ? patch.centre : f.centre, width, 1 - width);
        return width === f.width && centre === f.centre ? f : { ...f, width, centre };
      }
      case 'channels': {
        let g: ChannelsFeature = { ...f };
        let edited: keyof FeatureParams | undefined;
        if (num(patch.count)) {
          g = { ...g, count: clamp(Math.round(patch.count), 1, MAX_CHANNELS) };
          edited = 'count';
        }
        if (num(patch.width)) {
          const width = clamp(patch.width, MIN_CHANNEL_WIDTH, MAX_CHANNEL_WIDTH);
          g = { ...g, width, pitch: Math.max(g.pitch, width) };
          edited = 'width';
        }
        if (num(patch.pitch)) {
          g = { ...g, pitch: clamp(patch.pitch, g.width, 10) };
          edited = 'pitch';
        }
        if (num(patch.railInset)) {
          g = { ...g, railInset: clamp(patch.railInset, 0, 20) };
          edited = 'railInset';
        }
        const fitted = fitChannels(g, reachLimit(doc, g, chords), edited);
        return fitted.count === f.count &&
          fitted.width === f.width &&
          fitted.pitch === f.pitch &&
          fitted.railInset === f.railInset
          ? f
          : fitted;
      }
    }
  });
}

/** The greatest depth (cm) of the feature: the keys between the ends scale to it, held to the board's range. */
export function setFeatureDepth<D extends FeatureDoc>(doc: D, id: string, depth: number): D {
  if (!Number.isFinite(depth)) return doc;
  return replace(doc, id, (f) => {
    const peak = clamp(depth, 0, depthRange(doc, f).max);
    return peak === peakOf(f.depth) ? f : { ...f, depth: scaleDepth(f.depth, peak) };
  });
}

/**
 * One key of the depth curve. The first and last key move along x only (their depth is zero) and keep
 * the room for {@link MIN_SPAN}; an inner key moves between its neighbours, and its depth is held between
 * zero and the board's range.
 */
export function setFeatureKey<D extends FeatureDoc>(
  doc: D,
  id: string,
  index: number,
  patch: { s?: number; value?: number },
  chords?: ChordProvider<D>,
): D {
  return replace(doc, id, (f) => {
    const keys = f.depth.keys;
    const k = keys[index];
    if (k === undefined) return f;
    const last = keys.length - 1;
    if (index === 0 || index === last) {
      if (patch.s === undefined || !Number.isFinite(patch.s)) return f;
      const first = keys[0]!.s;
      const end = keys[last]!.s;
      const lim = featureLimits(doc, f, chords);
      const s = clamp(
        patch.s,
        (index === 0 ? lim.from : lim.to)!.min,
        (index === 0 ? lim.from : lim.to)!.max,
      );
      if (s === k.s) return f;
      const g: BottomFeature = {
        ...f,
        depth: index === 0 ? withSpan(f.depth, s, end) : withSpan(f.depth, first, s),
      };
      return g.kind === 'channels' ? fitChannels(g, reachLimit(doc, g, chords)) : g;
    }
    const gap = 1e-3;
    const s = clamp(
      patch.s !== undefined && Number.isFinite(patch.s) ? patch.s : k.s,
      keys[index - 1]!.s + gap,
      keys[index + 1]!.s - gap,
    );
    const value = clamp(
      patch.value !== undefined && Number.isFinite(patch.value) ? patch.value : k.value,
      0,
      depthRange(doc, f).max,
    );
    if (s === k.s && value === k.value) return f;
    // handles are in the segment's own units: an explicit one that no longer fits is dropped
    return {
      ...f,
      depth: { keys: keys.map((q, i) => (i === index ? { s, value } : q)) },
    };
  });
}

/** A key added in the middle of the widest gap (or at `s`, between the ends), on the curve as it is. */
export function addFeatureKey<D extends FeatureDoc>(doc: D, id: string, s?: number): D {
  return replace(doc, id, (f) => {
    const keys = f.depth.keys;
    let at = s;
    if (at === undefined) {
      let best = 0;
      for (let i = 0; i + 1 < keys.length; i++) {
        if (keys[i + 1]!.s - keys[i]!.s > keys[best + 1]!.s - keys[best]!.s) best = i;
      }
      at = (keys[best]!.s + keys[best + 1]!.s) / 2;
    }
    if (!(at > keys[0]!.s && at < keys[keys.length - 1]!.s)) return f;
    if (keys.some((k) => Math.abs(k.s - at) < 1e-3)) return f;
    const key: LawKey = { s: at, value: depthAt(f.depth, at) };
    const next = [...keys, key].sort((a, b) => a.s - b.s);
    return { ...f, depth: { keys: next } };
  });
}

/** An inner key removed; a curve keeps its two ends and at least one key between. */
export function removeFeatureKey<D extends FeatureDoc>(doc: D, id: string, index: number): D {
  return replace(doc, id, (f) => {
    const keys = f.depth.keys;
    if (keys.length <= 3 || index <= 0 || index >= keys.length - 1) return f;
    return { ...f, depth: { keys: keys.filter((_, i) => i !== index) } };
  });
}

// ---------------------------------------------------------------------------
// Following the tail
// ---------------------------------------------------------------------------

/**
 * The features of `doc` made valid for its station range (a tail change or a deeper notch moved `xi0`):
 * a curve that starts behind the notch bottom (or ends past the nose) is squeezed into the room that is
 * left, and channels are brought inside the chord. Returns `doc.features` itself when nothing moved.
 */
export function refitFeatures<D extends FeatureDoc>(
  doc: D,
  chords?: ChordProvider<D>,
): readonly BottomFeature[] {
  const room = featureRange(doc);
  let changed = false;
  const features = doc.features.map((f): BottomFeature => {
    const keys = f.depth.keys;
    const first = keys[0]!.s;
    const last = keys[keys.length - 1]!.s;
    let g: BottomFeature = f;
    if (first < room.min || last > room.max) {
      let from = Math.max(first, room.min);
      let to = Math.min(last, room.max);
      if (to - from < MIN_SPAN) {
        if (from + MIN_SPAN <= room.max) to = from + MIN_SPAN;
        else {
          to = room.max;
          from = Math.max(room.min, to - MIN_SPAN);
        }
      }
      g = { ...g, depth: remap(g.depth, first, last, from, to) };
    }
    if (g.enabled && g.kind === 'channels') g = fitChannels(g, reachLimit(doc, g, chords));
    if (g !== f) changed = true;
    return g;
  });
  return changed ? features : doc.features;
}
