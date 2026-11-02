// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the section editor asks of the surface (docs/design/m2-editor.md §3, §4): the length of a
 * station's chord, and the section the built surface really has at a station coordinate.
 *
 * - {@link createChordFn}: the chord length `w(ξ)` from the stringer point (ξ, 0) to the outline point
 *   P(ξ), as the evaluator measures it. On a standard board it is the half-width at x = ξ; inside a
 *   notch zone it is the length of the fan chord across the rail, which no function of x alone gives.
 *   The section store projects a station's normalised section to a physical slice with it, and takes
 *   it by injection (the store may not import this package's code).
 * - {@link probeSection}: the as-built section at ξ (blend, features and all) as a polyline in the
 *   section editor's own frame: `x` the distance along the chord from the stringer, `y` the height
 *   above the rocker scaled to the station's thickness `T(ξ)`, so it overlays the stored section of
 *   the station it was probed at.
 */
import { compileChain, funcEval } from './chain';
import { frameAt, makeFrame } from './frame';
import type { PlanFrame } from './frame';
import type { SurfaceEvaluator, BuiltBoard } from './surface';
import type { BoardDoc } from './types';
import { resolveTail } from './validate';

/** `w(ξ)` of one side of a document. */
export type ChordFn = (xi: number) => number;

const p = new Float64Array(6);

const chordOf = (frame: PlanFrame, xi: number): number => {
  frameAt(frame, xi, p);
  return Math.hypot(p[0]! - xi, p[1]!);
};

/**
 * The chord-length function of a document's plus side. The notch zone is resolved the way `buildBoard`
 * resolves it (`resolveTail`), so a station is measured on the chords the surface is built with.
 */
export function createChordFn(doc: BoardDoc): ChordFn {
  const resolved = resolveTail(doc);
  const frame = makeFrame(compileChain(resolved.outline.plus), resolved.tail);
  return (xi) => chordOf(frame, xi);
}

/**
 * One side of the as-built section at `xi` as `[x0, y0, x1, y1, …]` over `samples` points of the
 * section parameter t in [0, 1] (bottom centre, over the rail, to the deck centre).
 *
 * `x` is the distance from the stringer along the chord and `y = v · T(ξ)`, with v the surface's own
 * normalised height `(Z - R(X)) / T(X)` at the point (X, Y, Z), so a bottom feature's depth shows
 * as a dip and the section at a station is the stored one to the fit tolerance.
 */
export function probeSection(
  built: BuiltBoard,
  ev: SurfaceEvaluator,
  side: 0 | 1,
  xi: number,
  samples: number,
): number[] {
  const out = new Float64Array(3);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  funcEval(built.rocker, xi, r, 0);
  funcEval(built.deck, xi, d, 0);
  const thickness = d[0]! - r[0]!;
  const pts: number[] = [];
  ev.row(side, xi, 0);
  for (let i = 0; i < samples; i++) {
    ev.eval(i / (samples - 1), 0, out);
    const X = out[0]!;
    const Y = out[1]!;
    funcEval(built.rocker, X, r, 0);
    funcEval(built.deck, X, d, 0);
    const t = d[0]! - r[0]!;
    const v = t > 0 ? (out[2]! - r[0]!) / t : 0;
    pts.push(Math.hypot(X - xi, Y), v * thickness);
  }
  return pts;
}
