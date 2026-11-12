// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's section at a station, its apex and its half width (docs/design/
 * trim-blend-engine.md, "What the app asks of an engine"): what the app reads from
 * `probeSection`, `createEvaluator` and `createChordFn` on a sections board.
 *
 * The section is built in the plane x = const the way `recipeGap` builds a rail in a section's
 * plane, but from the built board: the rail's seven numbers at x from the side's keys, the
 * panels' heights and slopes at each band edge, then a blend from each band edge to the apex
 * on the wall. It is a first-order section: the kernel sweeps a blend square to the outline,
 * and here it is built in the plane, with its width seen at the outline's angle (`builtWidth`).
 * It reuses `builtWidth` from station.ts and the kernel's own relief fade; the blend, the
 * shoulders, the apex and the wall opening are the arithmetic of `solid.ts` and `rails.ts` at
 * one loop sample. Left out, as in `recipeGap`: the limit the local feature size sets on a
 * band, and the corner rounding of the loop.
 */
import { compileChain, funcEval } from '../chain';
import { TRIM } from '../params';
import type { RailsBoard } from './board';
import { railsAlong } from './keys';
import type { BuiltRails } from './native';
import { halfWidthOf } from './outline';
import { reliefFade } from './solid';
import { builtWidth } from './station';

const DEG = 180 / Math.PI;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The half width of one side of a rails board, with a notch filled in: `halfWidthOf` of its outline. */
export function halfWidthRails(board: RailsBoard, side?: 'minus'): (x: number) => number {
  return halfWidthOf(board.outline, side);
}

/** One half of a section at the plane x: the panel's end and the blend that replaces the rail. */
interface HalfBuild {
  /** Distance from the stringer of the band edge, cm. */
  readonly ye: number;
  /** Panel height at the band edge, before relief. */
  readonly ze: number;
  readonly shoulder: number;
  readonly rho: number;
  /** The panel at distance d from the stringer, with relief on the bottom. */
  readonly panel: (d: number) => number;
  /** The relief at distance d, 0 on the deck. */
  readonly lift: (d: number) => number;
}

interface Built {
  readonly w: number;
  readonly sign: 1 | -1;
  readonly rocker: number;
  /** Apex height (board z). */
  readonly za: number;
  readonly bottom: HalfBuild;
  readonly deck: HalfBuild;
}

/** The rail and the two panels at x on one side, as one loop sample of the kernel builds them but in the plane x = const. */
function buildAt(built: BuiltRails, side: 0 | 1, x: number): Built {
  const board = built.board;
  const sign: 1 | -1 = side === 0 ? 1 : -1;
  const w = built.halfWidth[side](x);
  const keys =
    side === 1 && board.symmetry === 'asymmetric' && board.rails.minus !== undefined
      ? board.rails.minus
      : board.rails.plus;
  const rail = railsAlong(keys);
  const e = TRIM.probeSlopeStep;
  const a = Math.max(built.xiMin, x - e);
  const c = Math.min(built.xiMax, x + e);
  const slope = c > a ? (built.halfWidth[side](c) - built.halfWidth[side](a)) / (c - a) : 0;
  const cosPhi = 1 / Math.hypot(1, slope);

  const panels = built.panels;
  const g = new Float64Array(6);
  const lift = new Float64Array(3);
  const zAt = (which: 0 | 1, d: number): number =>
    which === 0 ? panels.deck(x, sign * d) : panels.bottom(x, sign * d);
  /** Height of panel `which` at distance d and its slope towards the wall. */
  const edgeOf = (which: 0 | 1, d: number): { z: number; slope: number } => {
    if (panels.both !== undefined) {
      panels.both(x, sign * d, g);
      return { z: g[3 * which]!, slope: sign * g[3 * which + 2]! };
    }
    // one-sided from the panel's side: past the band edge the panel has given way to the rail
    const h = TRIM.slopeStep;
    const z = zAt(which, d);
    return { z, slope: (3 * z - 4 * zAt(which, d - h) + zAt(which, d - 2 * h)) / (2 * h) };
  };
  const reliefAt = (d: number): number => {
    if (panels.relief === undefined) return 0;
    panels.relief(x, sign * d, lift);
    return lift[0]!;
  };

  const kernelDeck = Math.max(TRIM.bandMin, rail.band(x));
  const kernelTuck = Math.max(TRIM.bandMin, rail.tuck(x));
  const yeDeck = Math.max(0, w - builtWidth(kernelDeck, cosPhi));
  const yeTuck = Math.max(0, w - builtWidth(kernelTuck, cosPhi));
  const dk = edgeOf(0, yeDeck);
  const bk = edgeOf(1, yeTuck);
  // where each panel's own tangent meets the wall
  let topWall = dk.z + (w - yeDeck) * dk.slope;
  let bottomWall = bk.z + (w - yeTuck) * bk.slope;
  const apex = clamp(rail.apex(x), TRIM.apexInset, 1 - TRIM.apexInset);
  const za = bottomWall + apex * (topWall - bottomWall);
  // a wall shorter than `wallMin` is opened about the apex
  if (topWall - bottomWall < TRIM.wallMin) {
    topWall = za + (1 - apex) * TRIM.wallMin;
    bottomWall = za - apex * TRIM.wallMin;
  }
  const deckShoulder = Math.max(
    topWall - kernelDeck * Math.tan(rail.deckEdge(x) / DEG),
    za + TRIM.edgeShort * (topWall - za),
  );
  const tuckShoulder = Math.min(
    bottomWall + kernelTuck * Math.tan(rail.bottomEdge(x) / DEG),
    za - TRIM.edgeShort * (za - bottomWall),
  );
  const rocker = new Float64Array(3);
  funcEval(compileChain(board.rocker), x, rocker, 0);
  return {
    w,
    sign,
    rocker: rocker[0]!,
    za,
    deck: {
      ye: yeDeck,
      ze: dk.z,
      shoulder: deckShoulder,
      rho: clamp(rail.hardness(x), TRIM.rhoInset, 1 - TRIM.rhoInset),
      panel: (d) => zAt(0, d),
      lift: () => 0,
    },
    bottom: {
      ye: yeTuck,
      ze: bk.z,
      shoulder: tuckShoulder,
      rho: clamp(rail.tuckShape(x), TRIM.rhoInset, 1 - TRIM.rhoInset),
      panel: (d) => zAt(1, d) + reliefAt(d),
      lift: reliefAt,
    },
  };
}

/** A half as a polyline `[d, z, …]`: the panel from the stringer to the band edge, then the blend to the apex. */
function halfPoints(b: Built, h: HalfBuild): number[] {
  const pts: number[] = [];
  const n = Math.max(1, Math.ceil(h.ye / TRIM.probePanelStep));
  for (let i = 0; i < n; i++) {
    const d = (h.ye * i) / n;
    pts.push(d, h.panel(d));
  }
  const steps = TRIM.probeBlendSteps;
  const wgt = h.rho / (1 - h.rho);
  for (let j = 0; j <= steps; j++) {
    const t = j / steps;
    const s = 1 - t;
    const den = s * s + 2 * wgt * s * t + t * t;
    const k0 = (s * s) / den;
    const k1 = (2 * wgt * s * t) / den;
    const k2 = (t * t) / den;
    const d = k0 * h.ye + (k1 + k2) * b.w;
    // the relief rides on the base blend and fades to nothing at the apex
    pts.push(d, k0 * h.ze + k1 * h.shoulder + k2 * b.za + h.lift(d) * reliefFade(t));
  }
  return pts;
}

/** A polyline `[a, b, …]` with its points in the opposite order. */
function reversePairs(pts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/** `count` points of polyline `pts` at even arc lengths from its start to its end (`count >= 2`). */
function spread(pts: readonly number[], count: number): number[] {
  const n = pts.length / 2;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] =
      arc[i - 1]! + Math.hypot(pts[2 * i]! - pts[2 * i - 2]!, pts[2 * i + 1]! - pts[2 * i - 1]!);
  }
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    const target = (arc[n - 1]! * i) / (count - 1);
    while (k + 2 < n && arc[k + 1]! < target) k++;
    const len = arc[k + 1]! - arc[k]!;
    const f = len > 0 ? clamp((target - arc[k]!) / len, 0, 1) : 0;
    out.push(
      pts[2 * k]! + f * (pts[2 * k + 2]! - pts[2 * k]!),
      pts[2 * k + 1]! + f * (pts[2 * k + 3]! - pts[2 * k + 1]!),
    );
  }
  return out;
}

/**
 * The wall of side `side` (0 plus, 1 minus) at x, and the apex height there: `y` is the
 * outline's y (negative on the minus side), `z` the apex's height in board coordinates.
 */
export function apexRails(built: BuiltRails, side: 0 | 1, x: number): { y: number; z: number } {
  const b = buildAt(built, side, x);
  return { y: b.sign * b.w, z: b.za };
}

/**
 * `samples` points of the section at x as `[d0, h0, d1, h1, …]`, from the bottom centre over
 * the apex to the deck centre: d the distance from the stringer, h the height above the rocker
 * at x (at least 3 points are returned). The bottom takes the first `ceil(samples / 2)` points, the apex the last of them (the
 * middle point when `samples` is odd), the deck the rest; each half is spread evenly by arc
 * length.
 */
export function probeRails(built: BuiltRails, side: 0 | 1, x: number, samples: number): number[] {
  const b = buildAt(built, side, x);
  const count = Math.max(3, Math.floor(samples));
  const nb = Math.ceil(count / 2);
  const bottom = spread(halfPoints(b, b.bottom), nb);
  const nd = count - nb;
  const deck = nd > 0 ? spread(reversePairs(halfPoints(b, b.deck)), nd + 1).slice(2) : [];
  const out: number[] = [];
  for (const pts of [bottom, deck]) {
    for (let i = 0; i < pts.length; i += 2) out.push(pts[i]!, pts[i + 1]! - b.rocker);
  }
  return out;
}
