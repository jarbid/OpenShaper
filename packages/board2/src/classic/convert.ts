// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The direct classic converter (docs/design/m1-model.md §4).
 *
 * - **Outline, rocker and deck** are copied as Bézier chains, knot for knot. The classic
 *   deck carries a vertical wall at each end (tail and nose thickness); the section model
 *   keeps z(x) over [0, L], so the walls are dropped and the deck starts and ends at the
 *   wall's top. A handle whose x steps outside its segment (a classic nose handle 0.002 cm
 *   past the end) is pulled back so x stays a function along the chain; the largest move
 *   is reported.
 * - **Slices** are normalised one by one (cached by the classic slice's identity, so an
 *   edit that leaves a slice alone returns the very same `Section` object, which is what
 *   the fit cache of `buildBoard` is keyed by): the chain is split at its widest point (an
 *   exact de Casteljau split; that knot is the apex), x is divided by that half-width and y
 *   by the centre thickness, and the centre handles are made horizontal. A control point
 *   that still leaves 0 ≤ u ≤ 1 has its segment halved (exact) until it does not.
 * - **Swallow and fish tails** (a classic outline with a cutout) become a `notched` tail
 *   whose notch zone is the shortest of a short ladder that validates; the stations of the
 *   zone are placed where their chords meet the outer rail at the classic x.
 *
 * The result is validated; anything the model cannot hold is refused with the reason (the
 * validator's own issues, or one of the `convert-*` codes). It never throws.
 */
import {
  hasTailCutout,
  type BezierBoard,
  type CrossSection,
  type Knot,
  type Spline,
} from '@openshaper/kernel';
import { chainParamAtX, compileChain, segmentXIncreasing } from '../chain';
import { deepFreeze } from '../freeze';
import { makeFrame, xiOfParam } from '../frame';
import { board2Err, board2Ok, makeIssue } from '../issues';
import {
  CONVERT_CENTRE_TOL,
  CONVERT_CONTENT_CACHE,
  CONVERT_CONTENT_DIGITS,
  CONVERT_MAX_ADJUST,
  CONVERT_MAX_SPLIT_DEPTH,
  CONVERT_MIN_SIZE,
  CONVERT_SNAP,
  CONVERT_TIE,
  CONVERT_WALL_TOL,
  NOTCH_ZONE_LADDER,
  DEFAULT_BUILD,
  PLAN_EXACT_TOL,
  SECTION_APEX_TOL,
} from '../params';
import type {
  Board2Issue,
  Board2Result,
  BoardDoc,
  Chain,
  ChainKnot,
  JsonValue,
  Pair,
  Section,
  Station,
  TailSpec,
} from '../types';
import { validateBoard } from '../validate';

export interface ConvertOptions {
  readonly name?: string;
  readonly source?: string;
}

export interface ConversionReport {
  readonly stations: number;
  readonly tail: 'standard' | 'notched';
  /** The notch zone length chosen (cm); 0 on a standard tail. */
  readonly zone: number;
  /** Largest move (cm) of a handle of the outline, rocker or deck to keep x a function. */
  readonly lineAdjust: number;
  /** Largest move (cm) of a section control point (centre handles made horizontal, bounds). */
  readonly sectionAdjust: number;
  /** Knots added by halving section segments to satisfy 0 <= u <= 1 (the apex split excluded). */
  readonly addedKnots: number;
  /** The deck's end walls (tail, nose) were dropped. */
  readonly deckWalls: readonly [boolean, boolean];
  /** The outline ended off the stringer at the tail, nose: a straight edge to the stringer was added. */
  readonly bluntEnds: readonly [boolean, boolean];
  /**
   * Classic x (cm) of the slices inside the notch zone, which are not stations (empty on a standard
   * tail): the zone's chords fan across the rail, and a station squeezed that close to the next one
   * makes the blend swing (15.8 mm from the classic loft instead of 4.6 mm on a classic swallow).
   * The zone takes the section of the first station beyond it.
   */
  readonly zoneSlices: readonly number[];
  /** A notched tail was reshaped: its inner wall has a real rail (the classic pod wall is vertical). */
  readonly notchReshaped: boolean;
}

export interface ClassicConversion {
  readonly doc: BoardDoc;
  readonly report: ConversionReport;
}

// ---------------------------------------------------------------------------
// Working knots
// ---------------------------------------------------------------------------

interface K {
  p: [number, number];
  in: [number, number];
  out: [number, number];
  smooth: boolean;
}

const fromKnots = (ks: readonly Knot[]): K[] =>
  ks.map((k) => ({
    p: [k.end.x, k.end.y],
    in: [k.tangentToPrev.x, k.tangentToPrev.y],
    out: [k.tangentToNext.x, k.tangentToNext.y],
    smooth: k.continuous,
  }));

/** The chain with the unused end handles set to their points. */
function toChain(ks: readonly K[]): Chain {
  const knots: ChainKnot[] = ks.map((k, i) => {
    const p: Pair = [k.p[0], k.p[1]];
    return {
      p,
      in: i === 0 ? p : [k.in[0], k.in[1]],
      out: i === ks.length - 1 ? p : [k.out[0], k.out[1]],
      smooth: k.smooth,
    };
  });
  return { knots };
}

const lerp = (
  a: readonly [number, number],
  b: readonly [number, number],
  t: number,
): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Splits the segment `a → b` at `t` (de Casteljau): updates the neighbours' handles, returns the new knot. */
function splitSegment(a: K, b: K, t: number): K {
  const q0 = lerp(a.p, a.out, t);
  const q1 = lerp(a.out, b.in, t);
  const q2 = lerp(b.in, b.p, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  a.out = q0;
  b.in = q2;
  return { p: s, in: r0, out: r1, smooth: true };
}

/**
 * Repairs a chain so that x is a function along it (non-decreasing from knot `from` on) and, optionally,
 * lifts handles' y up to 0. A segment whose *curve* already has x non-decreasing is left alone, even if its
 * handles overlap in x (the first beyond the second: the control polygon is not monotone, the curve is);
 * only a segment whose curve goes backwards has its handles' x pulled into [x0, x3]. Returns the largest move.
 */
function monotoneX(ks: K[], from: number, clampY: boolean): number {
  let moved = 0;
  const set = (q: [number, number], x: number, y: number): void => {
    moved = Math.max(moved, Math.hypot(q[0] - x, q[1] - y));
    q[0] = x;
    q[1] = y;
  };
  for (let k = from; k + 1 < ks.length; k++) {
    const a = ks[k]!;
    const b = ks[k + 1]!;
    const c0 = a.p[0];
    const c3 = b.p[0];
    if (c3 >= c0 && !segmentXIncreasing(c0, a.out[0], b.in[0], c3, PLAN_EXACT_TOL)) {
      const c1 = Math.min(Math.max(a.out[0], c0), c3);
      const c2 = Math.min(Math.max(b.in[0], c1), c3);
      set(a.out, c1, a.out[1]);
      set(b.in, c2, b.in[1]);
    }
    if (clampY) {
      set(a.out, a.out[0], Math.max(a.out[1], 0));
      set(b.in, b.in[0], Math.max(b.in[1], 0));
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// One slice
// ---------------------------------------------------------------------------

type SliceResult =
  | {
      readonly section: Section;
      /** The largest control-point move (cm) the rules needed, and what it was. */
      readonly adjust: number;
      readonly why: string;
      readonly added: number;
    }
  | { readonly error: string };

const sliceCache = new WeakMap<Spline, SliceResult>();

/** The widest point of the chain: the segment, the local parameter (0 at a knot) and x. */
function widest(ks: readonly K[]): { k: number; t: number; x: number }[] {
  const cand: { k: number; t: number; x: number }[] = [];
  const n = ks.length;
  for (let k = 0; k < n; k++) cand.push({ k, t: 0, x: ks[k]!.p[0] });
  for (let k = 0; k + 1 < n; k++) {
    const c0 = ks[k]!.p[0];
    const c1 = ks[k]!.out[0];
    const c2 = ks[k + 1]!.in[0];
    const c3 = ks[k + 1]!.p[0];
    // x'(t) / 3 = A t² + B t + C with the Bézier differences
    const d0 = c1 - c0;
    const d1 = c2 - c1;
    const d2 = c3 - c2;
    const A = d0 - 2 * d1 + d2;
    const B = 2 * (d1 - d0);
    const roots: number[] = [];
    if (A === 0) {
      if (B !== 0) roots.push(-d0 / B);
    } else {
      const disc = B * B - 4 * A * d0;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        roots.push((-B - r) / (2 * A), (-B + r) / (2 * A));
      }
    }
    for (const t of roots) {
      // a root at a knot (to rounding) is that knot, which is a candidate already
      if (!(t > CONVERT_SNAP && t < 1 - CONVERT_SNAP)) continue;
      const u = 1 - t;
      cand.push({
        k,
        t,
        x: u * u * u * c0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * c3,
      });
    }
  }
  return cand;
}

function normalise(spline: Spline): SliceResult {
  const ks = fromKnots(spline.knots);
  const n0 = ks.length;
  if (n0 < 3) return { error: `has ${n0} knots; a section needs at least 3` };
  const first = ks[0]!;
  const last = ks[n0 - 1]!;
  if (Math.abs(first.p[0]) > CONVERT_CENTRE_TOL || Math.abs(last.p[0]) > CONVERT_CENTRE_TOL) {
    return { error: 'its centre knots are off the stringer (x != 0)' };
  }
  const y0 = first.p[1];
  const T = last.p[1] - y0;
  if (!(T > CONVERT_MIN_SIZE))
    return { error: 'has no thickness (the deck centre is not above the bottom centre)' };

  // the widest point; a tie (a vertical plateau) takes the middle candidate
  const cand = widest(ks);
  let W = -Infinity;
  for (const c of cand) W = Math.max(W, c.x);
  if (!(W > CONVERT_MIN_SIZE)) return { error: 'has no width' };
  const ties = cand
    .filter((c) => c.x >= W - CONVERT_TIE * W)
    .sort((a, b) => a.k + a.t - (b.k + b.t));
  const pick = ties[(ties.length - 1) >> 1]!;
  let apex = pick.k;
  if (pick.t > 0) {
    ks.splice(pick.k + 1, 0, splitSegment(ks[pick.k]!, ks[pick.k + 1]!, pick.t));
    apex = pick.k + 1;
    // the split point is the widest point exactly, with a vertical tangent
    const a = ks[apex]!;
    a.in[0] = a.p[0];
    a.out[0] = a.p[0];
  }
  if (apex < 1 || apex > ks.length - 2) return { error: 'is widest at its centre knot' };
  W = ks[apex]!.p[0];

  // normalise
  let adjust = 0;
  let why = '';
  const note = (cm: number, what: string): void => {
    if (cm > adjust) {
      adjust = cm;
      why = what;
    }
  };
  for (const k of ks) {
    for (const q of [k.p, k.in, k.out]) {
      q[0] = q[0] / W;
      q[1] = (q[1] - y0) / T;
    }
  }
  const f = ks[0]!;
  const l = ks[ks.length - 1]!;
  f.p[0] = 0;
  f.p[1] = 0;
  l.p[0] = 0;
  l.p[1] = 1;
  // The centre handles are kept as stored (a V bottom or a pitched deck leaves the stringer at an
  // angle); only rounding of a horizontal one is removed.
  if (Math.abs(f.out[1]) <= CONVERT_SNAP) f.out[1] = 0;
  if (Math.abs(l.in[1] - 1) <= CONVERT_SNAP) l.in[1] = 1;
  f.in = [0, 0];
  l.out = [0, 1];
  ks[apex]!.p[0] = 1;
  // The apex tangent is vertical: a handle within SECTION_APEX_TOL of it (a classic file stores a few
  // micrometres of sideways run) is made exactly vertical, so both sides of the apex are G1.
  {
    const a = ks[apex]!;
    for (const h of [a.in, a.out]) {
      const run = 1 - h[0];
      if (
        Math.abs(run * W) <=
        Math.sin(SECTION_APEX_TOL) * Math.hypot(run * W, (h[1] - a.p[1]) * T)
      ) {
        h[0] = 1;
      }
    }
  }

  // bounds 0 <= u <= 1: halve the offending segments, then clamp what is left
  const snap = (q: [number, number]): void => {
    if (Math.abs(q[0]) <= CONVERT_SNAP) q[0] = 0;
    else if (Math.abs(q[0] - 1) <= CONVERT_SNAP) q[0] = 1;
  };
  const outside = (u: number): boolean => u < 0 || u > 1;
  let added = 0;
  for (let depth = 0; ; depth++) {
    for (const k of ks) {
      snap(k.p);
      snap(k.in);
      snap(k.out);
    }
    const bad: number[] = [];
    for (let k = 0; k + 1 < ks.length; k++) {
      if (outside(ks[k]!.out[0]) || outside(ks[k + 1]!.in[0])) bad.push(k);
    }
    const pointsBad = ks.some((k) => outside(k.p[0]));
    if (bad.length === 0 && !pointsBad) break;
    if (depth === CONVERT_MAX_SPLIT_DEPTH || bad.length === 0) {
      for (const k of ks) {
        for (const q of [k.p, k.in, k.out]) {
          const u = Math.min(Math.max(q[0], 0), 1);
          note(Math.abs(u - q[0]) * W, 'a control point lies beyond the rail or the stringer');
          q[0] = u;
        }
      }
      break;
    }
    for (let i = bad.length - 1; i >= 0; i--) {
      const k = bad[i]!;
      ks.splice(k + 1, 0, splitSegment(ks[k]!, ks[k + 1]!, 0.5));
      if (k + 1 <= apex) apex++;
      added++;
    }
  }
  const section: Section = deepFreeze({ chain: toChain(ks), apex });
  return { section, adjust, why, added };
}

/**
 * Normalised sections by content (the coordinates rounded to CONVERT_CONTENT_DIGITS decimals). The
 * classic editor's "resize cross-sections" scales a slice with the outline, rocker and deck, which
 * leaves the *normalised* section unchanged up to rounding: such a slice gets the earlier `Section`
 * object back, so `buildBoard`'s fit cache (keyed by that object) stays warm during a drag.
 */
const contentCache = new Map<string, Section>();
const CONTENT_SCALE = 10 ** CONVERT_CONTENT_DIGITS;

function contentKey(section: Section): string {
  const parts: string[] = [String(section.apex)];
  for (const k of section.chain.knots) {
    for (const q of [k.p, k.in, k.out]) {
      parts.push(
        String(Math.round(q[0] * CONTENT_SCALE)),
        String(Math.round(q[1] * CONTENT_SCALE)),
      );
    }
    parts.push(k.smooth ? 's' : 'c');
  }
  return parts.join(',');
}

function sliceOf(cs: CrossSection): SliceResult {
  let r = sliceCache.get(cs.spline);
  if (r === undefined) {
    r = normalise(cs.spline);
    if (!('error' in r)) {
      const key = contentKey(r.section);
      const known = contentCache.get(key);
      if (known === undefined) {
        contentCache.set(key, r.section);
        if (contentCache.size > CONVERT_CONTENT_CACHE) {
          contentCache.delete(contentCache.keys().next().value as string);
        }
      } else {
        r = { ...r, section: known };
      }
    }
    sliceCache.set(cs.spline, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const issue = (
  code:
    | 'convert-slice'
    | 'convert-plan'
    | 'convert-adjusted'
    | 'chain-too-short'
    | 'too-few-sections',
  message: string,
  extras?: { severity?: 'error' | 'warning'; value?: number; station?: string },
): Board2Issue =>
  makeIssue(code, message, {
    ...(extras?.severity === undefined ? {} : { severity: extras.severity }),
    ...(extras?.value === undefined ? {} : { value: extras.value }),
    ...(extras?.station === undefined ? {} : { at: { station: extras.station } }),
  });

/**
 * Converts a classic board to the section model, or refuses it with the reasons.
 * Pure, cheap (the slices are cached by identity) and never throws.
 */
export function convertClassic(
  board: BezierBoard,
  opts: ConvertOptions = {},
): Board2Result<ClassicConversion> {
  try {
    return convert(board, opts);
  } catch (e) {
    return board2Err([
      issue(
        'convert-plan',
        `the board could not be read: ${e instanceof Error ? e.message : String(e)}`,
      ),
    ]);
  }
}

function convert(board: BezierBoard, opts: ConvertOptions): Board2Result<ClassicConversion> {
  const errors: Board2Issue[] = [];
  const warnings: Board2Issue[] = [];
  if (
    board.outline.knots.length < 2 ||
    board.bottom.knots.length < 2 ||
    board.deck.knots.length < 3
  ) {
    return board2Err([
      issue('chain-too-short', 'the outline, rocker and deck need at least 2, 2 and 3 knots'),
    ]);
  }
  const real = board.crossSections.slice(1, -1);
  if (real.length === 0) {
    return board2Err([
      issue('too-few-sections', 'the board has no cross-sections between the tail and the nose'),
    ]);
  }

  // curves
  const cutout = hasTailCutout(board.outline);
  const outline = fromKnots(board.outline.knots);
  // A blunt tail (a squash tail: the outline starts at x = 0 with a half-width) or nose gets a
  // straight edge to the stringer: the model's outline runs from stringer to stringer.
  const blunt: [boolean, boolean] = [false, false];
  if (!cutout) {
    const first = outline[0]!;
    if (first.p[1] > PLAN_EXACT_TOL) {
      blunt[0] = true;
      first.in = [first.p[0], first.p[1]];
      first.smooth = false;
      outline.unshift({
        p: [first.p[0], 0],
        in: [first.p[0], 0],
        out: [first.p[0], 0],
        smooth: false,
      });
    }
    const last = outline[outline.length - 1]!;
    if (last.p[1] > PLAN_EXACT_TOL) {
      blunt[1] = true;
      last.out = [last.p[0], last.p[1]];
      last.smooth = false;
      outline.push({
        p: [last.p[0], 0],
        in: [last.p[0], 0],
        out: [last.p[0], 0],
        smooth: false,
      });
    }
  }
  let tip = 0;
  if (cutout) {
    for (let i = 1; i < outline.length; i++) if (outline[i]!.p[0] < outline[tip]!.p[0]) tip = i;
  }
  const outlineMove = monotoneX(outline, tip, true);
  const rocker = fromKnots(board.bottom.knots);
  const rockerMove = monotoneX(rocker, 0, false);
  const deckAll = fromKnots(board.deck.knots);
  const wallTail = Math.abs(deckAll[1]!.p[0] - deckAll[0]!.p[0]) <= CONVERT_WALL_TOL;
  const nl = deckAll.length;
  const wallNose = Math.abs(deckAll[nl - 1]!.p[0] - deckAll[nl - 2]!.p[0]) <= CONVERT_WALL_TOL;
  const deck = deckAll.slice(wallTail ? 1 : 0, nl - (wallNose ? 1 : 0));
  const deckMove = deck.length >= 2 ? monotoneX(deck, 0, false) : 0;
  const lineAdjust = Math.max(outlineMove, rockerMove, deckMove);
  if (lineAdjust > CONVERT_MAX_ADJUST) {
    errors.push(
      issue(
        'convert-plan',
        `a handle of the outline, rocker or deck would have to move ${lineAdjust.toPrecision(2)} cm to keep x a function along it`,
        { value: lineAdjust },
      ),
    );
  }

  // slices
  const sections: { x: number; section: Section }[] = [];
  let sectionAdjust = 0;
  let added = 0;
  let lastX = -Infinity;
  real.forEach((cs, i) => {
    const id = `s${i + 1}`;
    const r = sliceOf(cs);
    if ('error' in r) {
      errors.push(
        issue('convert-slice', `slice at x = ${cs.position}: ${r.error}`, { station: id }),
      );
      return;
    }
    if (!(cs.position > lastX)) {
      warnings.push(
        issue(
          'convert-adjusted',
          `slice at x = ${cs.position} repeats an earlier position and is left out`,
          {
            severity: 'warning',
            station: id,
          },
        ),
      );
      return;
    }
    lastX = cs.position;
    if (r.adjust > CONVERT_MAX_ADJUST) {
      errors.push(
        issue(
          'convert-slice',
          `slice at x = ${cs.position}: ${r.why}; the section model would have to move a control point ${r.adjust.toPrecision(2)} cm`,
          { station: id, value: r.adjust },
        ),
      );
    }
    sectionAdjust = Math.max(sectionAdjust, r.adjust);
    added += r.added;
    sections.push({ x: cs.position, section: r.section });
  });
  if (errors.length > 0) return board2Err(errors);
  if (lineAdjust > CONVERT_SNAP || sectionAdjust > CONVERT_SNAP) {
    warnings.push(
      issue(
        'convert-adjusted',
        `converted with a handle move of up to ${Math.max(lineAdjust, sectionAdjust).toPrecision(2)} cm`,
        { severity: 'warning', value: Math.max(lineAdjust, sectionAdjust) },
      ),
    );
  }

  const outlineChain = toChain(outline);
  const d = outline[0]!.p[0];
  const L = outline[outline.length - 1]!.p[0];
  const make = (tail: TailSpec): { doc: BoardDoc; zoneSlices: number[] } => {
    let stations: Station[];
    const zoneSlices: number[] = [];
    if (tail.kind === 'notched') {
      const frame = makeFrame(compileChain(outlineChain), tail);
      const n = frame.notch!;
      // Slices behind the zone's end (x < xiEnd) are not stations: the zone's chords fan across the rail,
      // so such a slice is squeezed close to the next station (the tip slice of a swallow 10 cm from the
      // first slice beyond the zone, against 62 cm to the next) and the blend between stations swings. The
      // zone takes the section of the first station beyond it. (If every slice is behind the end, the
      // last one stays.)
      const keep = sections.filter((s) => s.x >= n.xiEnd);
      if (keep.length === 0) keep.push(sections[sections.length - 1]!);
      stations = [];
      sections.forEach((s, i) => {
        if (!keep.includes(s)) {
          zoneSlices.push(s.x);
          return;
        }
        stations.push({
          id: `s${i + 1}`,
          x:
            s.x >= n.xiEnd
              ? s.x
              : xiOfParam(frame, chainParamAtX(frame.chain, s.x, n.sTip, frame.chain.segments)),
          plus: s.section,
        });
      });
    } else {
      stations = sections.map((s, i) => ({ id: `s${i + 1}`, x: s.x, plus: s.section }));
    }
    const doc = deepFreeze({
      format: 'openshaper',
      version: 3,
      model: 'sections',
      meta: { name: opts.name ?? 'Classic board', source: opts.source ?? 'classic' },
      symmetry: 'mirror',
      tail,
      outline: { plus: outlineChain },
      rocker: toChain(rocker),
      deck: toChain(deck),
      stations,
      features: [],
      fins: JSON.parse(JSON.stringify(board.fins ?? null)) as JsonValue,
      build: { ...DEFAULT_BUILD },
    }) as BoardDoc;
    return { doc, zoneSlices };
  };

  const report = (tail: TailSpec, zoneSlices: readonly number[]): ConversionReport => ({
    stations: sections.length - zoneSlices.length,
    tail: tail.kind,
    zone: tail.kind === 'notched' ? tail.zone : 0,
    lineAdjust,
    sectionAdjust,
    addedKnots: added,
    deckWalls: [wallTail, wallNose],
    bluntEnds: blunt,
    zoneSlices,
    notchReshaped: tail.kind === 'notched',
  });

  if (!cutout) {
    const tail: TailSpec = { kind: 'standard' };
    const { doc, zoneSlices } = make(tail);
    const issues = validateBoard(doc);
    if (issues.some((i) => i.severity === 'error')) return board2Err([...issues, ...warnings]);
    return board2Ok({ doc, report: report(tail, zoneSlices) }, [...issues, ...warnings]);
  }

  // a swallow or fish: the shortest notch zone of the ladder that validates
  let last: readonly Board2Issue[] = [];
  for (const m of NOTCH_ZONE_LADDER) {
    const zone = m * d;
    if (!(d > 0 && d + zone < L)) continue;
    const tail: TailSpec = { kind: 'notched', zone };
    const { doc, zoneSlices } = make(tail);
    const issues = validateBoard(doc);
    if (!issues.some((i) => i.severity === 'error')) {
      const plural = zoneSlices.length > 1;
      const reshaped = issue(
        'convert-adjusted',
        `the notched tail is reshaped: sections run across the rail inside the notch zone (x < ${(d + zone).toPrecision(3)} cm) and the inner wall gets a real rail` +
          (zoneSlices.length > 0
            ? `; the slice${plural ? 's' : ''} at x = ${zoneSlices.join(', ')} cm ${plural ? 'lie' : 'lies'} in the zone and ${plural ? 'are' : 'is'} not a station (the zone takes the section of the first station beyond it)`
            : ''),
        { severity: 'warning' },
      );
      // the document asks for the zone to be re-picked when the outline is edited (`resolveTail`)
      const auto: BoardDoc = { ...doc, tail: Object.freeze({ kind: 'notched', zone, auto: true }) };
      return board2Ok({ doc: auto, report: report(tail, zoneSlices) }, [
        reshaped,
        ...issues,
        ...warnings,
      ]);
    }
    last = issues;
  }
  return board2Err([
    issue('convert-plan', 'the notched tail does not validate with any notch zone length tried'),
    ...last,
    ...warnings,
  ]);
}
