// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The outline as a rounded loop, and the half width with a notch filled in. An outline chain is
 * cut into smooth pieces at its corner knots; the loop runs from the nose down the plus side to
 * the tail and back up the minus side, with a corner radius after each piece.
 */
import { chainEval, compileChain } from '../chain';
import { frameAt, makeFrame } from '../frame';
import { TRIM } from '../params';
import type { Chain, ChainKnot, Outline } from '../types';
import type { RailsCorners } from './board';
import { buildLoop } from './loop';
import type { Loop, LoopDef, LoopPiece } from './loop';

/** Indices of a chain's corner knots: the interior knots that are not smooth, tail to nose. */
function cornerKnots(chain: Chain): number[] {
  const out: number[] = [];
  for (let k = 1; k < chain.knots.length - 1; k++) if (!chain.knots[k]!.smooth) out.push(k);
  return out;
}

/** One side of the outline as smooth pieces, tail to nose, split at its corner knots; `sign` mirrors y. */
function sidePieces(chain: Chain, sign: 1 | -1): Float64Array[] {
  const ch = compileChain(chain);
  const cuts = [0, ...cornerKnots(chain), ch.segments];
  const out: Float64Array[] = [];
  const tmp = new Float64Array(2);
  for (let c = 0; c + 1 < cuts.length; c++) {
    const s0 = cuts[c]!;
    const s1 = cuts[c + 1]!;
    const n = TRIM.pieceSamples * (s1 - s0);
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

/**
 * The default radii of an outline: the nose and tail from the defaults, the crotch in place of
 * the tail where the tail is notched, and the tail radius at every corner knot of each side.
 * `minus` is set only when the outline has its own minus side.
 */
export function defaultCorners(outline: Outline, notched: boolean): RailsCorners {
  const radii = (chain: Chain): number[] => cornerKnots(chain).map(() => TRIM.radiusTail);
  return {
    nose: TRIM.radiusNose,
    tail: notched ? TRIM.radiusCrotch : TRIM.radiusTail,
    plus: radii(outline.plus),
    ...(outline.minus === undefined ? {} : { minus: radii(outline.minus) }),
  };
}

/**
 * The loop's pieces and the radius after each, nose first: the plus side's pieces from nose to
 * tail (each reversed), then the minus side's from tail to nose. The corner after the plus
 * side's first piece is the tail corner, the one after the minus side's last piece is the nose,
 * and the rest take their side's radii in order. A radius missing from `corners` is the default
 * tail radius.
 */
export function loopDefOf(outline: Outline, corners: RailsCorners): LoopDef {
  const plus = sidePieces(outline.plus, 1);
  const minus = sidePieces(outline.minus ?? outline.plus, -1);
  const minusRadii = corners.minus ?? corners.plus;
  const pieces: LoopPiece[] = [];
  const radii: number[] = [];
  for (let i = plus.length - 1; i >= 0; i--) {
    pieces.push({ pts: reversed(plus[i]!), kind: 0 });
    radii.push(i > 0 ? (corners.plus[i - 1] ?? TRIM.radiusTail) : corners.tail);
  }
  for (let i = 0; i < minus.length; i++) {
    pieces.push({ pts: minus[i]!, kind: 0 });
    radii.push(i + 1 < minus.length ? (minusRadii[i] ?? TRIM.radiusTail) : corners.nose);
  }
  return { pieces, corners: radii };
}

/** The outline as a rounded loop. */
export function loopOf(outline: Outline, corners: RailsCorners): Loop {
  return buildLoop(loopDefOf(outline, corners));
}

/** A notched outline chain with the notch filled: a straight tail end from (0, 0) to the tip. */
function filledChain(chain: Chain): Chain {
  const [, tip, ...rest] = chain.knots;
  if (tip === undefined) return chain;
  const end: ChainKnot = { p: [0, 0], in: [0, 0], out: [0, 0], smooth: false };
  return { knots: [end, { ...tip, in: tip.p }, ...rest] };
}

/**
 * A notched outline with its notch filled in: each side runs straight from (0, 0) to its tip.
 * The tail is at x = 0, so an outline is notched when its first knot (the notch bottom) lies
 * past x = 0; a standard outline is returned as the same object.
 */
export function filledOutline(outline: Outline): Outline {
  if (!(outline.plus.knots[0]!.p[0] > 0)) return outline;
  const minus = outline.minus;
  return {
    plus: filledChain(outline.plus),
    ...(minus === undefined ? {} : { minus: filledChain(minus) }),
  };
}

/** The half width of an outline at x, with a notch filled in; `side` 'minus' reads the minus chain when there is one. */
export function halfWidthOf(outline: Outline, side?: 'minus'): (x: number) => number {
  const filled = filledOutline(outline);
  const chain = side === 'minus' ? (filled.minus ?? filled.plus) : filled.plus;
  const frame = makeFrame(compileChain(chain), { kind: 'standard' });
  const p = new Float64Array(6);
  return (x) => {
    frameAt(frame, x, p);
    return Math.hypot(p[0]! - x, p[1]!);
  };
}
