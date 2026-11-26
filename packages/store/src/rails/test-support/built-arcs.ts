// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: the corner arcs the engine built for a rails board. The engine rounds a corner with an arc
 * of the radius asked and, where none of that radius fits, retries a smaller one without saying so, so
 * what a radius dial holds a corner to is what is measured here: the built arc's own radius, from the
 * samples the loop gives it.
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails } from '@openshaper/board2';

/** One arc of the built outline: its radius (cm), whether it is convex, and where it stands. */
export interface BuiltArc {
  /** The circle through the arc's first, middle and last samples; Infinity where they are in line (a very small arc). */
  readonly radius: number;
  /** The distance (cm) between the arc's first and last samples. */
  readonly chord: number;
  readonly convex: boolean;
  /** The arc's samples, `[x, y, x, y, ...]`, cm (y signed: the minus side is below the stringer). */
  readonly points: readonly number[];
}

/** The circle through three points: its radius (cm), or Infinity when they are in line. */
function circumradius(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const a = Math.hypot(bx - cx, by - cy);
  const b = Math.hypot(ax - cx, ay - cy);
  const c = Math.hypot(ax - bx, ay - by);
  const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  return area2 < 1e-12 ? Infinity : (a * b * c) / (2 * area2);
}

/** The arcs of the outline `doc` is built with, or null when the engine does not build it. */
export function builtArcs(doc: RailsBoard): BuiltArc[] | null {
  const built = buildRails(doc);
  if (!built.ok) return null;
  const { loop } = built.value;
  const arcs: BuiltArc[] = [];
  let i = 0;
  while (i < loop.n) {
    if (loop.corner[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < loop.n &&
      loop.corner[j + 1] === loop.corner[i] &&
      loop.seg[j + 1] === loop.seg[i]
    )
      j++;
    const m = Math.floor((i + j) / 2);
    const points: number[] = [];
    for (let k = i; k <= j; k++) points.push(loop.x[k]!, loop.y[k]!);
    arcs.push({
      radius: circumradius(loop.x[i]!, loop.y[i]!, loop.x[m]!, loop.y[m]!, loop.x[j]!, loop.y[j]!),
      convex: loop.corner[i]! > 0,
      chord: Math.hypot(loop.x[j]! - loop.x[i]!, loop.y[j]! - loop.y[i]!),
      points,
    });
    i = j + 1;
  }
  return arcs;
}

/**
 * The radius (cm) of an arc that turns the outline by `turn` radians: the chord over twice the sine of half the turn.
 * It needs two samples only, where the circle through three needs them apart.
 */
export const radiusOfTurn = (arc: BuiltArc, turn: number): number =>
  arc.chord / (2 * Math.sin(turn / 2));

/** The distance (cm) from (x, y) to the nearest sample of an arc. */
export function distanceToArc(arc: BuiltArc, x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k < arc.points.length; k += 2) {
    best = Math.min(best, Math.hypot(arc.points[k]! - x, arc.points[k + 1]! - y));
  }
  return best;
}

/**
 * The arc built for the corner at (x, y): the nearest to it, with how far it is. The minus side's corners are
 * below the stringer, so a corner of that side is asked for at -y.
 */
export function arcAt(
  arcs: readonly BuiltArc[],
  x: number,
  y: number,
): { arc: BuiltArc; distance: number } | null {
  let best: { arc: BuiltArc; distance: number } | null = null;
  for (const arc of arcs) {
    const distance = distanceToArc(arc, x, y);
    if (best === null || distance < best.distance) best = { arc, distance };
  }
  return best;
}
