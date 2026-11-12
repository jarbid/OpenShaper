// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A sections board put through the trim kernel, for measuring one against the other
 * (docs/design/trim-blend-plan.md, step 2). Test-only: it reads its panels off the current
 * engine's surface on a grid, which is far too slow for the app and is not how the app will
 * do it. What it shares with the real conversion is the part that matters here: the outline
 * as a rounded loop, a rail fitted at chosen stations (`station.ts`) and interpolated between
 * them, and panels that end where their rail begins.
 *
 * A notched board's sections are not plane inside its notch zone, so its surface cannot be read
 * as a height over each station there. Its panels and rail keys are read off its notch-free twin
 * (`notchFreeTwin`) instead, and the notch is cut by the loop of the notched outline.
 */
import { chainEval, compileChain, funcEval } from '../../chain';
import { createChordFn } from '../../probe';
import { MIN_CHORD, MIN_THICKNESS } from '../../railproto/rail-params';
import { createEvaluator } from '../../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../../surface';
import type { BoardDoc, Chain, ChainKnot } from '../../types';
import { buildLoop } from '../loop';
import type { Loop, LoopPiece } from '../loop';
import { railLaws } from '../rails';
import type { RailLaws, RailRecipe } from '../rails';
import type { Panels } from '../solid';
import { builtWidth, panelCurve, recipeGap, sectionRail } from '../station';

/** Default radii, cm: the ball on a nose, on a tail tip or corner, and in a notch's crotch. */
export const BRIDGE_RADII = { nose: 0.8, tail: 0.6, crotch: 0.2 } as const;
/** Samples of one outline piece per Bézier segment in it, gathered towards the piece's ends. */
const PIECE_SAMPLES = 160;
/** Spacing of the panel grid read off the current surface, cm: along the board and across it. */
const FIELD_DX = 0.5;
const FIELD_DY = 0.05;
/** Samples of each half of a section when a row of that grid is read, and when a rail is fitted to one. */
const FIELD_ROW = 700;
const KEY_ROW = 600;
/** Half the length (cm) the outline's angle at a key is read over. */
const KEY_SLOPE_STEP = 0.5;

/** A notched outline chain with the notch filled: a straight tail end from (0, 0) to the tip. */
function filledChain(chain: Chain): Chain {
  const [, tip, ...rest] = chain.knots;
  if (tip === undefined) return chain;
  const end: ChainKnot = { p: [0, 0], in: [0, 0], out: [0, 0], smooth: false };
  return { knots: [end, { ...tip, in: tip.p }, ...rest] };
}

/**
 * The same board with its notch filled in: a standard tail whose outline runs straight from
 * (0, 0) to each tip. Its sections are plane everywhere, so the bridge can read it.
 */
export function notchFreeTwin(doc: BoardDoc): BoardDoc {
  if (doc.tail.kind !== 'notched') return doc;
  const minus = doc.outline.minus;
  return {
    ...doc,
    tail: { kind: 'standard' },
    outline: {
      plus: filledChain(doc.outline.plus),
      ...(minus === undefined ? {} : { minus: filledChain(minus) }),
    },
  };
}

/** One side of the outline as smooth pieces, tail to nose, split at its corner knots. */
function sidePieces(chain: Chain, sign: 1 | -1): Float64Array[] {
  const ch = compileChain(chain);
  const cuts = [0];
  for (let k = 1; k < chain.knots.length - 1; k++) if (!chain.knots[k]!.smooth) cuts.push(k);
  cuts.push(ch.segments);
  const out: Float64Array[] = [];
  const tmp = new Float64Array(2);
  for (let c = 0; c + 1 < cuts.length; c++) {
    const s0 = cuts[c]!;
    const s1 = cuts[c + 1]!;
    const n = PIECE_SAMPLES * (s1 - s0);
    const pts = new Float64Array(2 * (n + 1));
    for (let i = 0; i <= n; i++) {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
      chainEval(ch, s0 + u * (s1 - s0), 0, tmp, 0);
      pts[2 * i] = tmp[0]!;
      pts[2 * i + 1] = sign * tmp[1]!;
    }
    out.push(pts);
  }
  return out;
}

function reversed(p: Float64Array): Float64Array {
  const n = p.length / 2;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)]!;
    out[2 * i + 1] = p[2 * (n - 1 - i) + 1]!;
  }
  return out;
}

/** The board's outline as a loop: nose, down the plus side to the tail, back up the minus side. */
export function boardLoop(built: BuiltBoard): Loop {
  const doc = built.doc;
  const plus = sidePieces(doc.outline.plus, 1);
  const minus = sidePieces(doc.outline.minus ?? doc.outline.plus, -1);
  const pieces: LoopPiece[] = [];
  const corners: number[] = [];
  for (let i = plus.length - 1; i >= 0; i--) {
    pieces.push({ pts: reversed(plus[i]!), kind: 0 });
    corners.push(
      i > 0
        ? BRIDGE_RADII.tail
        : doc.tail.kind === 'notched'
          ? BRIDGE_RADII.crotch
          : BRIDGE_RADII.tail,
    );
  }
  for (let i = 0; i < minus.length; i++) {
    pieces.push({ pts: minus[i]!, kind: 0 });
    corners.push(i + 1 < minus.length ? BRIDGE_RADII.tail : BRIDGE_RADII.nose);
  }
  return buildLoop({ pieces, corners });
}

/** The two halves of the current surface's section at `xi`, each `[y, z, …]` from the stringer out to the apex. */
export function halves(
  ev: SurfaceEvaluator,
  side: 0 | 1,
  xi: number,
  samples: number,
): { bottom: Float64Array; deck: Float64Array } {
  const out = new Float64Array(3);
  const bottom = new Float64Array(2 * (samples + 1));
  const deck = new Float64Array(2 * (samples + 1));
  ev.row(side, xi, 0);
  for (let k = 0; k <= samples; k++) {
    ev.eval((0.5 * k) / samples, 0, out);
    bottom[2 * k] = Math.abs(out[1]!);
    bottom[2 * k + 1] = out[2]!;
    ev.eval(1 - (0.5 * k) / samples, 0, out);
    deck[2 * k] = Math.abs(out[1]!);
    deck[2 * k + 1] = out[2]!;
  }
  return { bottom, deck };
}

/** Half width of one side of the current surface at `xi`. */
function halfWidth(ev: SurfaceEvaluator, side: 0 | 1, xi: number, out: Float64Array): number {
  ev.at(side, xi, 0.5, 0, out);
  return Math.abs(out[1]!);
}

/**
 * A panel of one side as a height over the plan, stored against the share of the half width,
 * so what runs along the outline (a band edge, a crease) stays on one column from row to row.
 */
class Field {
  readonly z: Float32Array;
  readonly half: Float64Array;
  constructor(
    private readonly x0: number,
    private readonly rows: number,
    private readonly cols: number,
  ) {
    this.z = new Float32Array(rows * cols);
    this.half = new Float64Array(rows);
  }

  /** Cubic across the board, so the slope is smooth where the rail's tangent is read; linear along it. */
  at(x: number, y: number): number {
    const fx = Math.min(this.rows - 1, Math.max(0, (x - this.x0) / FIELD_DX));
    const i = Math.min(this.rows - 2, Math.floor(fx));
    const tx = fx - i;
    const half = this.half[i]! + tx * (this.half[i + 1]! - this.half[i]!);
    const fu = half > 0 ? Math.min(1, Math.max(0, y / half)) * (this.cols - 1) : 0;
    const j = Math.min(this.cols - 2, Math.floor(fu));
    const tu = fu - j;
    const row = (r: number): number => {
      const b = r * this.cols;
      const p0 = this.z[b + Math.max(0, j - 1)]!;
      const p1 = this.z[b + j]!;
      const p2 = this.z[b + j + 1]!;
      const p3 = this.z[b + Math.min(this.cols - 1, j + 2)]!;
      return (
        0.5 *
        (2 * p1 +
          (p2 - p0) * tu +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * tu * tu +
          (3 * p1 - p0 - 3 * p2 + p3) * tu * tu * tu)
      );
    };
    return row(i) + tx * (row(i + 1) - row(i));
  }
}

const RECIPE_KEYS = [
  'band',
  'hardness',
  'tuck',
  'tuckShape',
  'bottomEdge',
  'deckEdge',
  'apex',
] as const;

/** How the rail's numbers run along one side of the board. */
export type RailLawsAlong = Record<(typeof RECIPE_KEYS)[number], (x: number) => number>;

/**
 * The deck and bottom panels of one side: at every row the current section inboard of that
 * row's band edge, and the panel's own tangent beyond it (`panelCurve`). Past the band edge
 * the current surface is rail, not panel.
 */
function readSide(
  built: BuiltBoard,
  ev: SurfaceEvaluator,
  side: 0 | 1,
  laws: RailLawsAlong,
): [Field, Field] {
  const rows = Math.ceil((built.xiMax - built.xiMin) / FIELD_DX) + 1;
  const out = new Float64Array(3);
  const xiOf = (r: number): number => Math.min(built.xiMax, built.xiMin + r * FIELD_DX);
  let halfMax = 0;
  const half = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    half[r] = halfWidth(ev, side, xiOf(r), out);
    halfMax = Math.max(halfMax, half[r]!);
  }
  const cols = Math.ceil(halfMax / FIELD_DY) + 1;
  const deck = new Field(built.xiMin, rows, cols);
  const bottom = new Field(built.xiMin, rows, cols);
  deck.half.set(half);
  bottom.half.set(half);
  for (let r = 0; r < rows; r++) {
    const xi = xiOf(r);
    // the band is measured square to the outline; a row cuts it at the outline's angle
    const a = Math.max(0, r - 1);
    const c = Math.min(rows - 1, r + 1);
    const cos = 1 / Math.hypot(1, c > a ? (half[c]! - half[a]!) / (xiOf(c) - xiOf(a) || 1) : 0);
    const h = halves(ev, side, xi, FIELD_ROW);
    const panelB = panelCurve(h.bottom, 1, builtWidth(laws.tuck(xi), cos));
    const panelD = panelCurve(h.deck, -1, builtWidth(laws.band(xi), cos));
    for (let j = 0; j < cols; j++) {
      const y = (j / (cols - 1)) * half[r]!;
      bottom.z[r * cols + j] = panelB(y);
      deck.z[r * cols + j] = panelD(y);
    }
  }
  return [deck, bottom];
}

/** The board's panels, given how wide the rail's bands are along each side. */
export function boardPanels(built: BuiltBoard, plus: RailLawsAlong, minus: RailLawsAlong): Panels {
  const ev = createEvaluator(built);
  const p = readSide(built, ev, 0, plus);
  const m = built.doc.symmetry === 'asymmetric' ? readSide(built, ev, 1, minus) : p;
  return {
    deck: (x, y) => (y >= 0 ? p[0] : m[0]).at(x, Math.abs(y)),
    bottom: (x, y) => (y >= 0 ? p[1] : m[1]).at(x, Math.abs(y)),
  };
}

/** A rail key: the rail fitted to the current surface at one station. */
export interface RailKey extends RailRecipe {
  readonly x: number;
  /** Worst gap between the section there and the panels and blends that replace it, cm. */
  readonly fit: number;
}

/** The stations of one side that carry a rail worth fitting: not the lens of a tip. */
export function usableStations(built: BuiltBoard, side: 'plus' | 'minus'): number[] {
  const doc = built.doc;
  const chordOf = side === 'minus' ? createChordFn(doc, 'minus') : createChordFn(doc);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  const out: number[] = [];
  for (const st of doc.stations) {
    funcEval(built.rocker, st.x, r, 0);
    funcEval(built.deck, st.x, d, 0);
    if (d[0]! - r[0]! < MIN_THICKNESS || chordOf(st.x) < MIN_CHORD) continue;
    out.push(st.x);
  }
  return out;
}

/** A station's section as `sectionRail` and `recipeGap` read it: the two halves and the outline's cosine there. */
function sectionAt(
  built: BuiltBoard,
  ev: SurfaceEvaluator,
  s: 0 | 1,
  x: number,
  out: Float64Array,
): { bottom: Float64Array; deck: Float64Array; cos: number } {
  const a = Math.max(built.xiMin, x - KEY_SLOPE_STEP);
  const c = Math.min(built.xiMax, x + KEY_SLOPE_STEP);
  const slope = (halfWidth(ev, s, c, out) - halfWidth(ev, s, a, out)) / (c - a);
  return { ...halves(ev, s, x, KEY_ROW), cos: 1 / Math.hypot(1, slope) };
}

/** One rail key at each of `xs`, fitted to the current surface of one side. */
export function railKeysAt(
  built: BuiltBoard,
  side: 'plus' | 'minus',
  xs: readonly number[],
): RailKey[] {
  const ev = createEvaluator(built);
  const s: 0 | 1 = side === 'minus' && built.doc.symmetry === 'asymmetric' ? 1 : 0;
  const out = new Float64Array(3);
  return xs.map((x) => {
    const h = sectionAt(built, ev, s, x, out);
    const rail = sectionRail(h.bottom, h.deck, h.cos);
    return { x, ...rail.recipe, fit: Math.max(rail.bottom.gap, rail.deck.gap) };
  });
}

/** Monotone cubic through `(xs, ys)`, held flat outside. */
function monotone(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0]!;
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  const m: number[] = [d[0]!];
  for (let i = 1; i + 1 < n; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i + 1 < n; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * d[i]!) / h;
      m[i + 1] = (3 * b * d[i]!) / h;
    }
  }
  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i + 2 < n && xs[i + 1]! < x) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h * m[i + 1]!
    );
  };
}

/** Each of a rail's numbers interpolated along the board between the keys. */
export function railsAlong(keys: readonly RailKey[]): RailLawsAlong {
  const xs = keys.map((k) => k.x);
  const out = {} as RailLawsAlong;
  for (const name of RECIPE_KEYS) {
    out[name] = monotone(
      xs,
      keys.map((k) => k[name]),
    );
  }
  return out;
}

/** The rail at every sample of the loop. */
export function boardRails(loop: Loop, plus: RailLawsAlong, minus: RailLawsAlong): RailLaws {
  return railLaws(loop, (i) => {
    const l = loop.y[i]! >= 0 ? plus : minus;
    const x = loop.x[i]!;
    return {
      band: l.band(x),
      hardness: l.hardness(x),
      tuck: l.tuck(x),
      tuckShape: l.tuckShape(x),
      bottomEdge: l.bottomEdge(x),
      deckEdge: l.deckEdge(x),
      apex: l.apex(x),
    };
  });
}

/**
 * Where one side of a board needs rail keys, decided without building a mesh. Starting from the
 * keys at `start`, it interpolates the rail between them and asks, at each `check` station, how far
 * the rail the kernel would build stands off that station's section (`recipeGap`). It adds a key at
 * the station that stands off most, if that is over `bar` (cm) and at least `apart` (cm) from every
 * key, and repeats until none qualifies or there are `most` keys. Returns the keys' x, sorted.
 */
export function placeKeys(
  built: BuiltBoard,
  side: 'plus' | 'minus',
  start: readonly number[],
  check: readonly number[],
  options: { bar: number; most: number; apart: number },
): number[] {
  const ev = createEvaluator(built);
  const s: 0 | 1 = side === 'minus' && built.doc.symmetry === 'asymmetric' ? 1 : 0;
  const out = new Float64Array(3);
  const sections = check.map((x) => sectionAt(built, ev, s, x, out));
  const xs = [...start].sort((a, c) => a - c);
  while (xs.length < options.most) {
    const along = railsAlong(railKeysAt(built, side, xs));
    let worst = -1;
    let worstGap = options.bar;
    for (let i = 0; i < check.length; i++) {
      const x = check[i]!;
      if (xs.some((k) => Math.abs(k - x) < options.apart)) continue;
      const sec = sections[i]!;
      const g = recipeGap(
        sec.bottom,
        sec.deck,
        {
          band: along.band(x),
          hardness: along.hardness(x),
          tuck: along.tuck(x),
          tuckShape: along.tuckShape(x),
          bottomEdge: along.bottomEdge(x),
          deckEdge: along.deckEdge(x),
          apex: along.apex(x),
        },
        sec.cos,
      );
      if (g > worstGap) {
        worstGap = g;
        worst = i;
      }
    }
    if (worst < 0) break;
    xs.push(check[worst]!);
    xs.sort((a, c) => a - c);
  }
  return xs;
}
