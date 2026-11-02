// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board-shape edits of a section document (docs/design/m2-editor.md §2, step 3): symmetry, tail type
 * and notch depth. Pure functions of a `BoardDoc`; every part an edit does not touch is passed through by
 * reference, so `buildBoard`'s fit cache stays warm (switching to asymmetric shares every `Section`, and
 * switching back keeps the chosen side's objects bit for bit).
 *
 * **Tails.** A standard tail starts at the tip (0, 0). A notched tail (swallow, fish) starts at the notch
 * bottom (d, 0) on the stringer, runs along the inner wall to the corner tip (0, w) and on along the
 * outer rail. The two kinds of notch differ only in the wall: a swallow's is straight, a fish's is
 * rounded (it leaves the notch bottom steeply and meets the tip level). `tail.auto` is set, so the notch
 * zone re-picks itself whenever the outline changes. The kind is not stored: {@link tailTypeOf} reads it
 * back from the wall.
 */
import type { BoardDoc, Chain, ChainKnot, Pair, Station } from '@openshaper/board2';

/** What the sidebar offers for the tail. */
export type TailType = 'standard' | 'swallow' | 'fish';

/** Which half of an asymmetric board to keep when it goes back to mirrored. */
export type KeepSide = 'plus' | 'minus';

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];
const firstX = (c: Chain): number => c.knots[0]!.p[0];

/** The default notch depth (cm) of a tail type: the share of the board's length setTail starts from. */
const DEPTH_SHARE = { swallow: 0.06, fish: 0.035 } as const;
export const defaultNotchDepth = (type: 'swallow' | 'fish', length: number): number =>
  DEPTH_SHARE[type] * length;

/** The notch depth is held between these shares of the board's length. */
const MIN_DEPTH_SHARE = 0.005;
const MAX_DEPTH_SHARE = 0.3;
/** The notch zone `setTail` starts from, in notch depths (the first rung of board2's ladder). */
const START_ZONE = 1.5;
/** A swallow's tip is this share of the board's greatest half-width wide; a fish's the other. */
const TIP_SHARE = { swallow: 0.42, fish: 0.5 } as const;
/** Outline knots nearer the tail than this share of the length belong to the tail being replaced. */
const TAIL_KNOT_SHARE = 0.08;
/** A wall whose handles stray more than this share of its length from the straight line is a fish's. */
const FISH_BULGE = 0.08;
/** Stations stay at least this far (cm) apart. */
const STATION_GAP = 1e-3;
/** The fewest stations a board keeps (same as `edits.ts`). */
const MIN_STATIONS = 2;

const corner = (p: Pair, inn?: Pair, out?: Pair): ChainKnot => ({
  p,
  in: inn ?? p,
  out: out ?? p,
  smooth: false,
});

const dist = (a: Pair, b: Pair): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Index of the rearmost knot: the tail tip of a notched outline (its first knot is the notch bottom). */
const tipIndex = (c: Chain): number => {
  let tip = 0;
  c.knots.forEach((k, i) => {
    if (k.p[0] < c.knots[tip]!.p[0]) tip = i;
  });
  return tip;
};

// ---------------------------------------------------------------------------
// Symmetry
// ---------------------------------------------------------------------------

/**
 * The document made asymmetric: the minus half starts as a copy of the plus half **by reference** (the
 * outline chain and every station's section are the same objects), so nothing refits. Returns the
 * document itself when it already is.
 */
export function toAsymmetric(doc: BoardDoc): BoardDoc {
  if (doc.symmetry === 'asymmetric') return doc;
  return {
    ...doc,
    symmetry: 'asymmetric',
    outline: { plus: doc.outline.plus, minus: doc.outline.plus },
    stations: doc.stations.map((s): Station => ({ ...s, minus: s.plus })),
  };
}

/**
 * The document made mirror-symmetric, keeping the `keep` half's outline and sections (the objects
 * themselves, bit for bit; the other half is dropped). Returns the document itself when it already is.
 */
export function toMirror(doc: BoardDoc, keep: KeepSide): BoardDoc {
  if (doc.symmetry === 'mirror') return doc;
  const minus = doc.outline.minus;
  const useMinus = keep === 'minus' && minus !== undefined;
  return {
    ...doc,
    symmetry: 'mirror',
    outline: { plus: useMinus ? minus : doc.outline.plus },
    stations: doc.stations.map((s): Station => {
      const { minus: m, ...rest } = s;
      return useMinus && m !== undefined ? { ...rest, plus: m } : rest;
    }),
  };
}

/** `setSymmetry(doc, 'mirror', keep)` keeps that half; `keep` is ignored when going asymmetric. */
export function setSymmetry(
  doc: BoardDoc,
  symmetry: BoardDoc['symmetry'],
  keep?: KeepSide,
): BoardDoc {
  return symmetry === 'asymmetric' ? toAsymmetric(doc) : toMirror(doc, keep ?? 'plus');
}

// ---------------------------------------------------------------------------
// Tail type
// ---------------------------------------------------------------------------

/** The tail type of a document: standard, or the swallow or fish its notch wall is. */
export function tailTypeOf(doc: BoardDoc): TailType {
  if (doc.tail.kind === 'standard') return 'standard';
  const knots = doc.outline.plus.knots;
  const tip = tipIndex(doc.outline.plus);
  // a wall of several segments is not one of ours: call it a fish (a rounded wall)
  if (tip !== 1) return 'fish';
  const [a, b, c, e] = [knots[0]!.p, knots[0]!.out, knots[1]!.in, knots[1]!.p];
  const len = dist(a, e);
  if (len === 0) return 'swallow';
  const off = (q: Pair): number =>
    Math.abs((q[0] - a[0]) * (e[1] - a[1]) - (q[1] - a[1]) * (e[0] - a[0])) / len;
  return Math.max(off(b), off(c)) > FISH_BULGE * len ? 'fish' : 'swallow';
}

/** The inner wall from the notch bottom `(d, 0)` to the tip `(0, w)`: [notch bottom, tip] with their wall handles. */
function wall(type: 'swallow' | 'fish', d: number, w: number): { out: Pair; tipIn: Pair } {
  if (type === 'swallow') {
    // straight: the handles on the chord, a third in from each end
    return { out: [d * (2 / 3), w / 3], tipIn: [d / 3, (w * 2) / 3] };
  }
  // rounded: up from the notch bottom, bowed out from the straight line (it must not run level into the
  // tip or steeply from the bottom, or a notch-zone chord would run along the wall: `notch-chord-angle`)
  return { out: [d * 0.6, w * 0.4], tipIn: [d * 0.1, w * 0.6] };
}

/** The outline chain of a notched tail of `type`, depth `d`, built on the rest of `chain`'s outline. */
function notchedOutline(
  chain: Chain,
  type: 'swallow' | 'fish',
  d: number,
  fromStandard: boolean,
): Chain {
  const knots = chain.knots;
  const L = lengthOf(chain);
  let tipP: Pair;
  let tipOut: Pair;
  let rest: ChainKnot[];
  if (fromStandard) {
    const widest = Math.max(...knots.map((k) => k.p[1]));
    const cut = TAIL_KNOT_SHARE * L;
    // the old tail: the tip and any knots that only round it; the first knot beyond is where the new tail meets the outline
    rest = knots.filter((k, i) => i > 0 && (k.p[0] >= cut || i === knots.length - 1));
    const next = rest[0]!;
    const w = Math.min(TIP_SHARE[type] * widest, next.p[1]);
    tipP = [0, w];
    const rise = Math.max(0, Math.min(0.15 * widest, 0.5 * (next.p[1] - w)));
    tipOut = [0.13 * widest, w + rise];
  } else {
    const tip = tipIndex(chain);
    tipP = knots[tip]!.p;
    tipOut = knots[tip]!.out;
    rest = knots.slice(tip + 1);
  }
  const w = tipP[1];
  const { out, tipIn } = wall(type, d, w);
  return {
    knots: [corner([d, 0], undefined, out), corner(tipP, tipIn, tipOut), ...rest],
  };
}

/** The outline chain of a standard tail built on the rest of the notched `chain`'s outline. */
function standardOutline(chain: Chain): Chain {
  const tip = tipIndex(chain);
  const t = chain.knots[tip]!;
  const rest = chain.knots.slice(tip + 1);
  // a round tail leaving the tip steeply: the old corner's rise, from the stringer
  const out: Pair = [(t.out[0] - t.p[0]) * 0.5, t.p[1] + (t.out[1] - t.p[1])];
  return { knots: [corner([0, 0], undefined, out), ...rest] };
}

/**
 * The stations a board keeps when its station range starts at `xi0`: those behind it are dropped, and the
 * one sitting on the old notch bottom `follows` it there. Null when fewer than two stations would remain.
 */
function stationsFrom(
  stations: readonly Station[],
  xi0: number,
  follows?: number,
): Station[] | null {
  const next: Station[] = [];
  for (const s of stations) {
    const moved = follows !== undefined && Math.abs(s.x - follows) < STATION_GAP;
    const x = moved ? xi0 : s.x;
    if (x < xi0) continue;
    if (next.length > 0 && !(x > next[next.length - 1]!.x)) continue;
    next.push(moved ? { ...s, x } : s);
  }
  return next.length >= MIN_STATIONS ? next : null;
}

/**
 * The document with its tail changed to `type`. A notch of depth `d` (the default of the type when `d` is
 * omitted and the board is not notched yet; the current depth otherwise) gets `tail.auto`, and the stations
 * behind the notch bottom are dropped (an undo restores them). Changing between swallow and fish keeps the
 * depth and the tip and rebuilds the wall. An asymmetric board gets the same tail on both halves. Returns
 * the document itself for no change, or when it would leave fewer than two stations.
 */
export function setTail(doc: BoardDoc, type: TailType, d?: number): BoardDoc {
  const L = lengthOf(doc.outline.plus);
  const was = tailTypeOf(doc);
  if (type === 'standard') {
    if (was === 'standard') return doc;
    const outline = {
      plus: standardOutline(doc.outline.plus),
      ...(doc.outline.minus === undefined ? {} : { minus: standardOutline(doc.outline.minus) }),
    };
    return { ...doc, tail: { kind: 'standard' }, outline };
  }
  const fromStandard = was === 'standard';
  const current = fromStandard ? undefined : firstX(doc.outline.plus);
  const depth = clampDepth(d ?? current ?? defaultNotchDepth(type, L), L);
  if (!fromStandard && was === type && depth === current) return doc;
  const stations = stationsFrom(doc.stations, depth, fromStandard ? undefined : current);
  if (stations === null) return doc;
  const outline = {
    plus: notchedOutline(doc.outline.plus, type, depth, fromStandard),
    ...(doc.outline.minus === undefined
      ? {}
      : { minus: notchedOutline(doc.outline.minus, type, depth, fromStandard) }),
  };
  return {
    ...doc,
    tail: { kind: 'notched', zone: START_ZONE * depth, auto: true },
    outline,
    stations:
      stations.every((s, i) => s === doc.stations[i]) && stations.length === doc.stations.length
        ? doc.stations
        : stations,
  };
}

// ---------------------------------------------------------------------------
// Notch depth
// ---------------------------------------------------------------------------

/** The depth limits (cm) for a board of length `L`. */
export const notchDepthRange = (L: number): { readonly min: number; readonly max: number } => ({
  min: MIN_DEPTH_SHARE * L,
  max: MAX_DEPTH_SHARE * L,
});

const clampDepth = (d: number, L: number): number => {
  const { min, max } = notchDepthRange(L);
  return Math.min(max, Math.max(min, d));
};

/** The wall of `chain` with its x scaled by `r` about the tail tip (x = 0), and the notch bottom put at `d`. */
function movedNotch(chain: Chain, d: number): Chain {
  const was = firstX(chain);
  const r = d / was;
  const [first, tip, ...rest] = chain.knots;
  if (first === undefined || tip === undefined) return chain;
  // the wall is the first segment: the notch bottom, its out handle, the tip's in handle, the tip
  return {
    knots: [
      { ...first, p: [d, first.p[1]], in: [d, first.in[1]], out: [first.out[0] * r, first.out[1]] },
      { ...tip, in: [tip.in[0] * r, tip.in[1]] },
      ...rest,
    ],
  };
}

/**
 * The notch bottom moved to depth `d` (held between 0.5% and 30% of the length): the wall's x scales with
 * it and the tail tip stays at x = 0. A station sitting at the old notch bottom follows it; stations the
 * new notch bottom passes are dropped. A standard tail has no notch: returns the document itself, as it
 * does for no change or when the move would leave fewer than two stations.
 */
export function setNotchDepth(doc: BoardDoc, d: number): BoardDoc {
  if (doc.tail.kind !== 'notched' || !Number.isFinite(d)) return doc;
  const L = lengthOf(doc.outline.plus);
  const was = firstX(doc.outline.plus);
  const depth = clampDepth(d, L);
  if (depth === was || !(was > 0)) return doc;
  const stations = stationsFrom(doc.stations, depth, was);
  if (stations === null) return doc;
  const outline = {
    plus: movedNotch(doc.outline.plus, depth),
    ...(doc.outline.minus === undefined ? {} : { minus: movedNotch(doc.outline.minus, depth) }),
  };
  const tail =
    doc.tail.kind === 'notched' && doc.tail.auto === true
      ? { kind: 'notched' as const, zone: START_ZONE * depth, auto: true }
      : doc.tail;
  return { ...doc, outline, tail, stations };
}
