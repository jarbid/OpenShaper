// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A sections document to a rails board (docs/design/trim-blend-plan.md, "Converting a sections
 * board").
 *
 * At each station, per side, the stored section is read in physical units (u times the half
 * width, v times the thickness) and its two halves give up their rail (`sectionRail`). A usable
 * station gets a rail key; a tip, too thin or too narrow to carry a rail, gets none. Each half's
 * curve is the stored section's own chain as far as the panel's end, split there, then one
 * straight segment on to the wall at the panel's slope. Every knot and handle inboard of the
 * split is the designer's own.
 *
 * A conversion adds nothing between stations: no station and no rail key is placed to follow
 * the sections engine's surface there. Between stations that surface is one interpolation of
 * the designer's stations and the rails engine's is another; neither is the design, so a
 * converted board keeps its own stations and the new engine runs between them
 * (docs/design/trim-blend-engine.md, "Decided by the project owner"). So only the document is
 * read; nothing is read off a built surface.
 */
import { chainEval, chainParamAtX, chainXRange, compileChain, funcEval, segEval } from '../chain';
import type { CompiledChain } from '../chain';
import { board2Err, board2Ok, makeIssue } from '../issues';
import { TRIM } from '../params';
import type {
  Board2Issue,
  Board2Result,
  BoardDoc,
  Chain,
  ChainKnot,
  Pair,
  Section,
} from '../types';
import type { RailKey, RailsBoard, RailsStation, StationCurves } from './board';
import { defaultCorners, filledOutline, halfWidthOf } from './outline';
import { sameShape } from './same';
import { sectionRail } from './station';
import type { HalfRail, SectionRail } from './station';

const DEG = 180 / Math.PI;

/** What became of one half (bottom or deck) of one side of a station. */
export interface ConvertHalf {
  /** u at which the curve leaves the stored section for its straight end. */
  readonly share: number;
  /** dv/du of the straight end, normalised. */
  readonly slope: number;
  /** The knot at the split is a corner: the section's own tangent there is not the panel's. */
  readonly corner: boolean;
  /**
   * The stored half, inboard of the cut, is not a function of u: a sample's u falls back, or a
   * run at one u climbs (a vertical piece at the stringer, a fold). It is kept as drawn and the
   * loft reads it with the samples that do not rise in u dropped.
   */
  readonly folds: boolean;
  /** The half's fit; `null` at a tip, which borrows its share. */
  readonly fit: {
    /** Width of the band (deck) or tuck (bottom) square to the outline, cm, as the rail key holds it. */
    readonly width: number;
    /** The band is 0 wide: the panel runs to the wall. */
    readonly hard: boolean;
    /** The panel was ended short of a crease. */
    readonly crease: boolean;
    /** Worst gap between the section and the panel and blend that replace it, cm. */
    readonly gap: number;
  } | null;
}

/** One side of one station. */
export interface ConvertStation {
  readonly id: string;
  readonly x: number;
  readonly side: 'plus' | 'minus';
  /** Half width (notch filled) and thickness at the station, cm. */
  readonly halfWidth: number;
  readonly thickness: number;
  /** Too thin or too narrow to carry a rail: no key; its shares are the `borrowed` station's. */
  readonly tip: boolean;
  readonly borrowed?: string;
  readonly bottom: ConvertHalf;
  readonly deck: ConvertHalf;
}

export interface ConvertReport {
  /** Per side (plus first) and station, tail to nose. */
  readonly stations: readonly ConvertStation[];
  /** The worst fit gap over the board's usable stations, cm. */
  readonly worstGap: number;
  /** How many halves (over both sides, bottom and deck) have `folds`. */
  readonly foldedHalves: number;
  /** The tip stations, per side. */
  readonly tips: readonly {
    readonly id: string;
    readonly x: number;
    readonly side: 'plus' | 'minus';
  }[];
}

/** A chain read the other way: knots reversed, each knot's `in` and `out` swapped. */
function reversedChain(knots: readonly ChainKnot[]): Chain {
  return { knots: knots.map((k) => ({ ...k, in: k.out, out: k.in })).reverse() };
}

/** The two halves of a section as chains, each from the stringer out to the apex knot. */
export function sectionHalves(section: Section): { readonly bottom: Chain; readonly deck: Chain } {
  const k = section.chain.knots;
  return {
    bottom: { knots: k.slice(0, section.apex + 1) },
    deck: reversedChain(k.slice(section.apex)),
  };
}

/** A half chain sampled as `[y, z, …]` in physical units: y = u·w, z = v·T. */
export function physicalHalf(ch: CompiledChain, w: number, t: number): Float64Array {
  const n = TRIM.convertSegmentSamples;
  const out = new Float64Array(2 * (ch.segments * n + 1));
  const p = new Float64Array(2);
  let j = 0;
  for (let k = 0; k < ch.segments; k++) {
    for (let i = k === 0 ? 0 : 1; i <= n; i++) {
      segEval(ch.c, 8 * k, i / n, 0, p, 0);
      out[j++] = p[0]! * w;
      out[j++] = p[1]! * t;
    }
  }
  return out;
}

/** The cosine of the outline's angle with the stringer at x, by a central difference over its x range. */
export function outlineCos(w: (x: number) => number, lo: number, hi: number, x: number): number {
  const a = Math.max(lo, x - TRIM.convertSlopeStep);
  const c = Math.min(hi, x + TRIM.convertSlopeStep);
  const slope = c > a ? (w(c) - w(a)) / (c - a) : 0;
  return 1 / Math.hypot(1, slope);
}

const pair = (a: Pair, b: Pair, t: number): Pair => [
  a[0] + t * (b[0] - a[0]),
  a[1] + t * (b[1] - a[1]),
];

/**
 * A half chain (stringer to apex) cut where u = `share` and carried on straight to the wall at
 * u = 1 with dv/du = `slope`. The segment that holds the cut is split by de Casteljau; the
 * knots before it are kept as they are, and the one that starts it keeps its point and `in`.
 * Returns the curve and the section's own tangent at the cut, (du, dv).
 */
function cutCurve(
  half: Chain,
  ch: CompiledChain,
  share: number,
  slope: number,
): { readonly curve: Chain; readonly tangent: Pair } {
  const s = chainParamAtX(ch, Math.min(1, Math.max(0, share)), 0, ch.segments);
  const k = Math.min(Math.floor(s), ch.segments - 1);
  const t = s - k;
  const knots = half.knots;
  const d = new Float64Array(4);
  chainEval(ch, s, 1, d, 0);
  const tangent: Pair = [d[2]!, d[3]!];
  let head: ChainKnot[];
  let cut: { readonly p: Pair; readonly in: Pair; readonly lock?: ChainKnot['lock'] };
  if (t === 0) {
    // the cut is on knot k: it keeps its point and its `in`
    head = knots.slice(0, k);
    cut = knots[k]!;
  } else {
    const a = knots[k]!;
    const b = knots[k + 1]!;
    const p01 = pair(a.p, a.out, t);
    const p12 = pair(a.out, b.in, t);
    const p23 = pair(b.in, b.p, t);
    const p012 = pair(p01, p12, t);
    const p123 = pair(p12, p23, t);
    head = [...knots.slice(0, k), { ...a, out: p01 }];
    cut = { p: pair(p012, p123, t), in: p012 };
  }
  const p = cut.p;
  const end: Pair = [1, p[1] + slope * (1 - p[0])];
  const third = (f: number): Pair => pair(p, end, f);
  // a lock on the knot's outward handle no longer applies: that handle is now the straight end's
  const prev = cut.lock?.prev;
  const split: ChainKnot = {
    p,
    in: cut.in,
    out: third(1 / 3),
    smooth: true,
    ...(prev === undefined ? {} : { lock: { prev } }),
  };
  const wall: ChainKnot = { p: end, in: third(2 / 3), out: end, smooth: true };
  return { curve: { knots: [...head, split, wall] }, tangent };
}

/** The angle (degrees) between a normalised tangent (du, dv) and a physical slope, in physical units. */
function turnBetween(tangent: Pair, w: number, t: number, slope: number): number {
  return Math.abs(Math.atan2(tangent[1] * t, tangent[0] * w) - Math.atan(slope)) * DEG;
}

/**
 * Whether sampled half `pts` (`[y, z, …]`, physical) is not a function of u inboard of `cutY`:
 * a sample whose u falls back from the largest before it by more than `convertFoldBack`, or a
 * run of samples within that of one u that climbs more than `convertFoldClimb` in v.
 */
function foldsInboard(pts: Float64Array, w: number, t: number, cutY: number): boolean {
  let top = -Infinity;
  let runU = 0;
  let runV = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i]! >= cutY) break;
    const u = pts[i]! / w;
    const v = pts[i + 1]! / t;
    if (u < top - TRIM.convertFoldBack) return true;
    if (i === 0 || u - runU > TRIM.convertFoldBack) {
      runU = u;
      runV = v;
    } else if (Math.abs(v - runV) > TRIM.convertFoldClimb) {
      return true;
    }
    top = Math.max(top, u);
  }
  return false;
}

interface HalfIn {
  readonly chain: Chain;
  readonly compiled: CompiledChain;
}

/** What a station side's fit read and made: everything of it that depends on the section's shape, the half width, the thickness and the outline's angle. */
interface Fitted {
  /** The side's section (its shape and apex are the key). */
  readonly section: Section;
  readonly w: number;
  readonly t: number;
  readonly cos: number;
  readonly bottom: CompiledChain;
  readonly top: CompiledChain;
  readonly bottomPts: Float64Array;
  readonly deckPts: Float64Array;
  /** `null` at a tip. */
  readonly rail: SectionRail | null;
}

/**
 * Fits kept between conversions of one document, which the caller holds. A station side is
 * refitted only when what its fit reads has changed by value: the shape of its section (each
 * knot's place and handles) and its apex, the half width and thickness there, and the cosine of
 * the outline's angle there. Nothing else reaches the fit: the rail rules and sample counts are
 * fixed (`TRIM`), and the curves cut from it are remade from the current section every time.
 * It keeps the fits of the last conversion and up to `TRIM.convertCacheSpare` older ones.
 */
export interface ConvertCache {
  /** Station sides fitted through this cache, and served from it. */
  fits: number;
  reused: number;
  /** Newest first. */
  entries: Fitted[];
}

/** An empty converter cache. */
export const convertCache = (): ConvertCache => ({ fits: 0, reused: 0, entries: [] });

const sameSection = (a: Section, b: Section): boolean =>
  a === b || (a.apex === b.apex && sameShape(a.chain, b.chain));

/** One half's curve and report from its fit (usable) or a borrowed share (tip). */
function convertHalf(
  half: HalfIn,
  pts: Float64Array,
  w: number,
  t: number,
  fit: HalfRail | null,
  borrowedShare: number,
  cos: number,
): { readonly curve: Chain; readonly report: ConvertHalf } {
  if (fit !== null) {
    const share = Math.min(1, fit.panel.y / w);
    const slope = (fit.panel.slope * w) / t;
    const { curve, tangent } = cutCurve(half.chain, half.compiled, share, slope);
    const corner = turnBetween(tangent, w, t, fit.panel.slope) > TRIM.convertSmoothAngle;
    const knots = curve.knots.map((kn, i) =>
      i === curve.knots.length - 2 ? { ...kn, smooth: !corner } : kn,
    );
    return {
      curve: { knots },
      report: {
        share,
        slope,
        corner,
        folds: foldsInboard(pts, w, t, fit.panel.y),
        fit: {
          width: fit.width * cos,
          hard: fit.width === 0,
          crease: fit.panel.crease,
          gap: fit.gap,
        },
      },
    };
  }
  // a tip: the section's own tangent at the borrowed share, carried on straight
  const share = Math.min(1, Math.max(0, borrowedShare));
  const s = chainParamAtX(half.compiled, share, 0, half.compiled.segments);
  const d = new Float64Array(4);
  chainEval(half.compiled, s, 1, d, 0);
  // a vertical tangent has no slope across: the end is level
  const slope = d[2]! > TRIM.tiny ? d[3]! / d[2]! : 0;
  const { curve } = cutCurve(half.chain, half.compiled, share, slope);
  return {
    curve,
    report: { share, slope, corner: false, folds: foldsInboard(pts, w, t, share * w), fit: null },
  };
}

interface SideOut {
  readonly curves: StationCurves[];
  readonly keys: RailKey[];
  readonly report: ConvertStation[];
}

/** One side of the board: every station's two curves, its rail keys and its report. */
function convertSide(
  doc: BoardDoc,
  side: 'plus' | 'minus',
  cache: ConvertCache | undefined,
  used: Fitted[],
): SideOut | Board2Issue {
  const filled = filledOutline(doc.outline);
  const wOf = halfWidthOf(doc.outline, side === 'minus' ? 'minus' : undefined);
  const outlineChain = side === 'minus' ? (filled.minus ?? filled.plus) : filled.plus;
  const [lo, hi] = chainXRange(compileChain(outlineChain));
  const rocker = compileChain(doc.rocker);
  const deck = compileChain(doc.deck);
  const r = new Float64Array(3);
  const z = new Float64Array(3);

  const read = doc.stations.map((st) => {
    const section = side === 'minus' ? (st.minus ?? st.plus) : st.plus;
    const halves = sectionHalves(section);
    funcEval(rocker, st.x, r, 0);
    funcEval(deck, st.x, z, 0);
    const t = z[0]! - r[0]!;
    const w = wOf(st.x);
    const cos = outlineCos(wOf, lo, hi, st.x);
    let f = cache?.entries.find(
      (e) => e.w === w && e.t === t && e.cos === cos && sameSection(e.section, section),
    );
    if (f !== undefined) {
      cache!.reused++;
    } else {
      const bottom = compileChain(halves.bottom);
      const top = compileChain(halves.deck);
      const bottomPts = physicalHalf(bottom, w, t);
      const deckPts = physicalHalf(top, w, t);
      const tip = !(t >= TRIM.convertMinThickness) || !(w >= TRIM.convertMinChord);
      const rail = tip ? null : sectionRail(bottomPts, deckPts, cos);
      f = { section, w, t, cos, bottom, top, bottomPts, deckPts, rail };
      if (cache !== undefined) cache.fits++;
    }
    if (!used.includes(f)) used.push(f);
    const bottom: HalfIn = { chain: halves.bottom, compiled: f.bottom };
    const top: HalfIn = { chain: halves.deck, compiled: f.top };
    const { bottomPts, deckPts, rail } = f;
    return { st, bottom, top, bottomPts, deckPts, t, w, cos, rail };
  });

  const usable = read.filter((s) => s.rail !== null);
  if (usable.length === 0) {
    return makeIssue(
      'too-few-sections',
      `the ${side} side has no station thick and wide enough for a rail`,
      {
        at: { side },
      },
    );
  }
  const nearest = (x: number) =>
    usable.reduce((a, b) => (Math.abs(b.st.x - x) < Math.abs(a.st.x - x) ? b : a));

  const curves: StationCurves[] = [];
  const keys: RailKey[] = [];
  const report: ConvertStation[] = [];
  for (const s of read) {
    const from = s.rail === null ? nearest(s.st.x) : null;
    const share = (fit: HalfRail | undefined): number =>
      from === null || fit === undefined ? 0 : fit.panel.y / from.w;
    const b = convertHalf(
      s.bottom,
      s.bottomPts,
      s.w,
      s.t,
      s.rail?.bottom ?? null,
      share(from?.rail?.bottom),
      s.cos,
    );
    const d = convertHalf(
      s.top,
      s.deckPts,
      s.w,
      s.t,
      s.rail?.deck ?? null,
      share(from?.rail?.deck),
      s.cos,
    );
    curves.push({ bottom: b.curve, deck: d.curve });
    if (s.rail !== null) keys.push({ x: s.st.x, rail: s.rail.recipe });
    report.push({
      id: s.st.id,
      x: s.st.x,
      side,
      halfWidth: s.w,
      thickness: s.t,
      tip: s.rail === null,
      ...(from === null ? {} : { borrowed: from.st.id }),
      bottom: b.report,
      deck: d.report,
    });
  }
  return { curves, keys, report };
}

/** What `convertSections` is given besides the document. */
export interface ConvertOptions {
  /** Fits kept from the caller's earlier conversions of the same document (`convertCache`). */
  readonly cache?: ConvertCache;
}

/**
 * A sections document to a rails board, with a report of what each station became. Refused
 * when the document is not a sections board, has no station, or has a side with no station
 * that can carry a rail. With a `cache` the result is the same, and only station sides whose
 * fit inputs changed are refitted.
 */
export function convertSections(
  doc: BoardDoc,
  opts: ConvertOptions = {},
): Board2Result<{ board: RailsBoard; report: ConvertReport }> {
  if ((doc.model as string) !== 'sections') {
    return board2Err([
      makeIssue('doc-malformed', `a ${String(doc.model)} board is not a sections board`),
    ]);
  }
  if (doc.stations.length === 0) {
    return board2Err([makeIssue('too-few-sections', 'the board has no station to convert')]);
  }
  const asym = doc.symmetry === 'asymmetric';
  const cache = opts.cache;
  const used: Fitted[] = [];
  const plus = convertSide(doc, 'plus', cache, used);
  const minus = asym ? convertSide(doc, 'minus', cache, used) : null;
  if (cache !== undefined) {
    const older = cache.entries.filter((e) => !used.includes(e));
    cache.entries = [...used, ...older.slice(0, TRIM.convertCacheSpare)];
  }
  const failed = [plus, minus].filter((s): s is Board2Issue => s !== null && !('curves' in s));
  if (failed.length > 0) return board2Err(failed);
  const p = plus as SideOut;
  const m = minus as SideOut | null;

  const stations: RailsStation[] = doc.stations.map((st, i) => ({
    id: st.id,
    x: st.x,
    plus: p.curves[i]!,
    ...(m === null ? {} : { minus: m.curves[i]! }),
  }));
  const board: RailsBoard = {
    model: 'rails',
    meta: doc.meta,
    symmetry: doc.symmetry,
    outline: doc.outline,
    corners: defaultCorners(doc.outline, doc.tail.kind === 'notched'),
    rocker: doc.rocker,
    deck: doc.deck,
    stations,
    rails: { plus: p.keys, ...(m === null ? {} : { minus: m.keys }) },
    features: doc.features,
    ...(doc.fins === undefined ? {} : { fins: doc.fins }),
    build: doc.build,
  };
  const all = [...p.report, ...(m?.report ?? [])];
  let worstGap = 0;
  for (const s of all) {
    for (const h of [s.bottom, s.deck])
      if (h.fit !== null) worstGap = Math.max(worstGap, h.fit.gap);
  }
  let foldedHalves = 0;
  for (const s of all) foldedHalves += (s.bottom.folds ? 1 : 0) + (s.deck.folds ? 1 : 0);
  const tips = all.filter((s) => s.tip).map((s) => ({ id: s.id, x: s.x, side: s.side }));
  return board2Ok({ board, report: { stations: all, worstGap, foldedHalves, tips } });
}
