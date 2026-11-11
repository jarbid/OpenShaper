// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A sections board put through the trim kernel, for measuring one against the other
 * (docs/design/trim-blend-plan.md, step 2). Test-only: it reads its panels off the current
 * engine's surface on a grid, which is far too slow for the app and is not how the app will
 * do it. What it shares with the real conversion is the part that matters here: the outline
 * as a rounded loop, and **one rail per stored station**, with the rail between stations
 * interpolated from them.
 *
 * Standard tails only. A notched board's sections are not plane in the current engine, so
 * its surface cannot be read as a height over each station.
 */
import { chainEval, compileChain, funcEval } from '../../chain';
import { createChordFn } from '../../probe';
import { FWD_NO_BLEND, fitForward } from '../../railproto/forward';
import type { ForwardFit, HalfForward } from '../../railproto/forward';
import { at as sectionPoint, realSection } from '../../railproto/rail-geom';
import type { RealSection } from '../../railproto/rail-geom';
import { MIN_CHORD, MIN_THICKNESS } from '../../railproto/rail-params';
import { createEvaluator } from '../../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../../surface';
import type { Chain } from '../../types';
import { buildLoop } from '../loop';
import type { Loop, LoopPiece } from '../loop';
import { railLaws } from '../rails';
import type { RailLaws, RailRecipe } from '../rails';
import type { Panels } from '../solid';

/** Default radii, cm: the ball on a nose, on a tail tip or corner, and in a notch's crotch. */
export const BRIDGE_RADII = { nose: 0.8, tail: 0.6, crotch: 0.2 } as const;
/** Samples of one outline piece per Bézier segment in it, gathered towards the piece's ends. */
const PIECE_SAMPLES = 160;
/** Spacing of the panel grid read off the current surface, cm: along the board and across it. */
const FIELD_DX = 0.5;
const FIELD_DY = 0.05;
/** Samples of each half of a section when a row of that grid is read. */
const FIELD_ROW = 700;
/** The deck's band is the blend that fits best; the bottom's is the widest still within this, cm. */
const WIDE_TOL = 0.02;

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

/** A height over the plan read off the current surface: one side, deck or bottom. */
class Field {
  readonly z: Float32Array;
  constructor(
    private readonly x0: number,
    private readonly rows: number,
    private readonly cols: number,
  ) {
    this.z = new Float32Array(rows * cols);
  }

  /** Cubic across the board, so the slope is smooth where the rail's tangent is read; linear along it. */
  at(x: number, y: number): number {
    const fx = Math.min(this.rows - 1, Math.max(0, (x - this.x0) / FIELD_DX));
    const i = Math.min(this.rows - 2, Math.floor(fx));
    const tx = fx - i;
    const fy = Math.min(this.cols - 1, Math.max(0, y / FIELD_DY));
    const j = Math.min(this.cols - 2, Math.floor(fy));
    const ty = fy - j;
    const row = (r: number): number => {
      const b = r * this.cols;
      const p0 = this.z[b + Math.max(0, j - 1)]!;
      const p1 = this.z[b + j]!;
      const p2 = this.z[b + j + 1]!;
      const p3 = this.z[b + Math.min(this.cols - 1, j + 2)]!;
      return (
        0.5 *
        (2 * p1 +
          (p2 - p0) * ty +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * ty * ty +
          (3 * p1 - p0 - 3 * p2 + p3) * ty * ty * ty)
      );
    };
    return row(i) + tx * (row(i + 1) - row(i));
  }
}

/** The deck and bottom of one side of the current surface, as heights over the plan. */
function readSide(
  built: BuiltBoard,
  ev: SurfaceEvaluator,
  side: 0 | 1,
  halfMax: number,
): [Field, Field] {
  const rows = Math.ceil((built.xiMax - built.xiMin) / FIELD_DX) + 1;
  const cols = Math.ceil(halfMax / FIELD_DY) + 3;
  const deck = new Field(built.xiMin, rows, cols);
  const bottom = new Field(built.xiMin, rows, cols);
  const out = new Float64Array(3);
  const ys = new Float64Array(FIELD_ROW + 1);
  const zs = new Float64Array(FIELD_ROW + 1);
  for (let r = 0; r < rows; r++) {
    const xi = Math.min(built.xiMax, built.xiMin + r * FIELD_DX);
    ev.row(side, xi, 0);
    for (const [field, from, to] of [
      [bottom, 0, 0.5],
      [deck, 1, 0.5],
    ] as const) {
      // stringer out to the apex, keeping only samples that move outward: at a crease the
      // sampled section steps back on itself by a tenth of a millimetre
      let n = 0;
      for (let k = 0; k <= FIELD_ROW; k++) {
        ev.eval(from + ((to - from) * k) / FIELD_ROW, 0, out);
        const y = Math.abs(out[1]!);
        if (n === 0 || y > ys[n - 1]!) {
          ys[n] = y;
          zs[n] = out[2]!;
          n++;
        }
      }
      let k = 0;
      for (let j = 0; j < cols; j++) {
        const y = j * FIELD_DY;
        while (k + 1 < n && ys[k + 1]! < y) k++;
        const span = k + 1 < n ? ys[k + 1]! - ys[k]! : 0;
        const f = span > 0 ? Math.min(1, Math.max(0, (y - ys[k]!) / span)) : 1;
        field.z[r * cols + j] = k + 1 < n ? zs[k]! + f * (zs[k + 1]! - zs[k]!) : zs[n - 1]!;
      }
    }
  }
  return [deck, bottom];
}

/** The current surface as panels: the deck and bottom halves, each a height over the plan. */
export function boardPanels(built: BuiltBoard, loop: Loop): Panels {
  const ev = createEvaluator(built);
  let halfMax = 0;
  for (let i = 0; i < loop.n; i++) halfMax = Math.max(halfMax, Math.abs(loop.y[i]!));
  const plus = readSide(built, ev, 0, halfMax);
  const minus = built.doc.symmetry === 'asymmetric' ? readSide(built, ev, 1, halfMax) : plus;
  return {
    deck: (x, y) => (y >= 0 ? plus[0] : minus[0]).at(x, Math.abs(y)),
    bottom: (x, y) => (y >= 0 ? plus[1] : minus[1]).at(x, Math.abs(y)),
  };
}

/** A rail key: the rail fitted at one stored station. */
export interface RailKey extends RailRecipe {
  readonly x: number;
  /** Worst gap between the fitted blends and the stored section, cm. */
  readonly fit: number;
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

function pickBottom(h: HalfForward): ForwardFit | null {
  if (h.hardEdge || h.best === null) return null;
  let wide: ForwardFit | null = null;
  for (const c of h.candidates) {
    if (c.dev.max <= WIDE_TOL && (wide === null || c.width > wide.width)) wide = c;
  }
  return wide ?? h.best;
}

/** The rail at one stored station: both blends fitted forward, in the kernel's own terms. */
export function keyAt(s: RealSection, cosPhi: number): RailKey {
  const x = s.x;
  const zA = sectionPoint(s, s.apex)[1];
  const fb = fitForward(s, 'bottom');
  const fd = fitForward(s, 'deck');
  const b = pickBottom(fb);
  const d = fd.hardEdge ? null : fd.best;
  // where each panel's own tangent meets the wall; the band edge's own height where it has none
  const wallB = b === null ? zA : Number.isFinite(b.g1) ? b.g1 : zA - b.height;
  const wallD = d === null ? zA : Number.isFinite(d.g1) ? d.g1 : zA + d.height;
  const deg = (rise: number, run: number): number =>
    run > FWD_NO_BLEND ? Math.max(0, (Math.atan2(rise, run) * 180) / Math.PI) : 0;
  const wb = b === null ? 0 : b.width * cosPhi;
  const wd = d === null ? 0 : d.width * cosPhi;
  return {
    x,
    band: wd,
    hardness: d?.rho ?? 0.5,
    tuck: wb,
    tuckShape: b?.rho ?? 0.9,
    bottomEdge: b === null ? 0 : deg(b.z1 - wallB, wb),
    deckEdge: d === null ? 0 : deg(wallD - d.z1, wd),
    apex: wallD - wallB > 0 ? (zA - wallB) / (wallD - wallB) : 0.5,
    fit: Math.max(b?.dev.max ?? 0, d?.dev.max ?? 0),
  };
}

/** One rail key per usable stored station of one side. */
export function railKeys(built: BuiltBoard, side: 'plus' | 'minus'): RailKey[] {
  const doc = built.doc;
  const chordOf = side === 'minus' ? createChordFn(doc, 'minus') : createChordFn(doc);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  const keys: RailKey[] = [];
  for (const st of doc.stations) {
    const section = side === 'minus' ? (st.minus ?? st.plus) : st.plus;
    const chord = chordOf(st.x);
    funcEval(built.rocker, st.x, r, 0);
    funcEval(built.deck, st.x, d, 0);
    const thickness = d[0]! - r[0]!;
    if (thickness < MIN_THICKNESS || chord < MIN_CHORD) continue;
    const slope = (chordOf(st.x + 0.5) - chordOf(st.x - 0.5)) / 1;
    keys.push(keyAt(realSection(section, st.x, chord, thickness), 1 / Math.hypot(1, slope)));
  }
  return keys;
}

/** One rail key at each of `sections`, which are the plus side as built: for asking how many keys a board needs. */
export function railKeysAt(built: BuiltBoard, sections: readonly RealSection[]): RailKey[] {
  const chordOf = createChordFn(built.doc);
  return sections.map((s) => {
    const slope = (chordOf(s.x + 0.5) - chordOf(s.x - 0.5)) / 1;
    return keyAt(s, 1 / Math.hypot(1, slope));
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

/** The rail at every sample of the loop, each number interpolated along the board between the keys. */
export function boardRails(
  loop: Loop,
  plus: readonly RailKey[],
  minus: readonly RailKey[],
): RailLaws {
  const laws = (
    keys: readonly RailKey[],
  ): Record<(typeof RECIPE_KEYS)[number], (x: number) => number> => {
    const xs = keys.map((k) => k.x);
    const out = {} as Record<(typeof RECIPE_KEYS)[number], (x: number) => number>;
    for (const name of RECIPE_KEYS)
      out[name] = monotone(
        xs,
        keys.map((k) => k[name]),
      );
    return out;
  };
  const p = laws(plus);
  const m = laws(minus);
  return railLaws(loop, (i) => {
    const l = loop.y[i]! >= 0 ? p : m;
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
