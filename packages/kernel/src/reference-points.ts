// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reference points: measurements taken off a physical board, kept beside the board
 * model rather than inside it (the legacy BoardCAD-LE "guide points").
 *
 * A point lives in the plane of the curve it is measured against, in the same
 * coordinates as that curve's knots (cm, tail at x = 0):
 *   - `outline`: x along the board, y the half-width;
 *   - `rocker`:  x along the board, y the height of the `bottom` or `deck` curve;
 *   - `section`: x the distance from the stringer, y the height, at `station` cm
 *     along the board. A section point belongs to that measured station, not to a
 *     cross-section; it is shown on whichever cross-section sits at the station.
 *
 * Board edits never touch these points, so nothing here depends on `BezierBoard`
 * beyond finding the cross-section at a station.
 */
import { value } from './bezier-curve';
import { closestPointOnSpline, valueAt, type Spline } from './bezier-spline';
import type { BezierBoard } from './board';
import type { Vec2 } from './vec2';

interface RefPointBase extends Vec2 {
  /** Stable within a document; assigned on read when a file has none. */
  readonly id: string;
  /** Optional user label; a point is otherwise identified by where it is. */
  readonly label?: string;
}

export interface OutlineRefPoint extends RefPointBase {
  readonly plane: 'outline';
  /** The minus half of an asymmetric board; absent for the plus (or only) half. */
  readonly side?: 'minus';
}

export interface RockerRefPoint extends RefPointBase {
  readonly plane: 'rocker';
  readonly curve: 'bottom' | 'deck';
}

export interface SectionRefPoint extends RefPointBase {
  readonly plane: 'section';
  /** Measured station, cm from the tail. */
  readonly station: number;
  readonly side?: 'minus';
}

export type RefPoint = OutlineRefPoint | RockerRefPoint | SectionRefPoint;
export type RefPoints = readonly RefPoint[];

/** A section point shows on a cross-section within this distance of its station (0.5 mm). */
export const REF_SECTION_TOLERANCE = 0.05;

/** Index of the cross-section a section point sits on, or -1 when none is within tolerance. */
export const refPointSectionIndex = (b: BezierBoard, p: SectionRefPoint): number => {
  let best = -1;
  let bestDistance = REF_SECTION_TOLERANCE;
  b.crossSections.forEach((cs, i) => {
    const d = Math.abs(cs.position - p.station);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
};

/** y of a length-wise curve at x, or null outside its x range (where valueAt reads 0). */
const valueWithin = (s: Spline, x: number): number | null => {
  const first = s.knots[0]?.end.x;
  const last = s.knots[s.knots.length - 1]?.end.x;
  if (first === undefined || last === undefined) return null;
  return x < Math.min(first, last) || x > Math.max(first, last) ? null : valueAt(s, x);
};

/**
 * What the board measures where a point was measured, in the point's own terms: the
 * outline's half-width, or the bottom/deck height, at the point's x. Null for a section
 * point (a section's curve has two heights at most distances from the stringer, bottom
 * and deck, so "the" value there is not defined) and outside the board.
 */
export const refPointBoardValue = (b: BezierBoard, p: RefPoint): number | null => {
  switch (p.plane) {
    case 'outline':
      return valueWithin(b.outline, p.x);
    case 'rocker':
      return valueWithin(p.curve === 'deck' ? b.deck : b.bottom, p.x);
    case 'section':
      return null;
  }
};

/**
 * How far the board on screen is from a measurement, in cm, or null where there is
 * nothing to compare against (outside the board, or a section point with no section at
 * its station).
 *
 * - Outline: board full width minus measured full width at the point's x. Positive means
 *   the board is wider than measured.
 * - Rocker: board height minus measured height on the point's curve. Positive means the
 *   board is higher than measured.
 * - Section: the distance from the point to the section's curve, unsigned: a section is
 *   a closed-ish profile, so "above" or "below" it is not one direction.
 */
export const refPointGap = (b: BezierBoard, p: RefPoint): number | null => {
  if (p.plane === 'section') {
    const cs = b.crossSections[refPointSectionIndex(b, p)];
    if (!cs) return null;
    const hit = closestPointOnSpline(cs.spline, p);
    if (!hit) return null;
    const q = value(cs.spline.coeffs[hit.index]!, hit.t);
    return Math.hypot(q.x - p.x, q.y - p.y);
  }
  const board = refPointBoardValue(b, p);
  if (board === null) return null;
  return p.plane === 'outline' ? 2 * (board - Math.abs(p.y)) : board - p.y;
};

/** Whether a gap is within `tolerance` (cm), or null when there is no gap to judge. */
export const refPointWithin = (b: BezierBoard, p: RefPoint, tolerance: number): boolean | null => {
  const gap = refPointGap(b, p);
  return gap === null ? null : Math.abs(gap) <= tolerance;
};

/** Ids `r1`, `r2`, … not already used in `taken`; the set is updated as ids are handed out. */
export const refIdAllocator = (taken: Iterable<string>): (() => string) => {
  const used = new Set(taken);
  let n = 1;
  return () => {
    while (used.has(`r${n}`)) n++;
    const id = `r${n++}`;
    used.add(id);
    return id;
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A point whose id is not settled yet. */
type Draft<T> = T extends RefPoint ? Omit<T, 'id'> & { readonly id?: string } : never;
type RefPointDraft = Draft<RefPoint>;

/** One point's fields, or null when it cannot be a reference point. Ids are settled later. */
const reviveOne = (v: unknown): RefPointDraft | null => {
  if (!isRecord(v) || !isFiniteNumber(v.x) || !isFiniteNumber(v.y)) return null;
  const id = typeof v.id === 'string' && v.id ? v.id : undefined;
  const label = typeof v.label === 'string' && v.label.trim() ? v.label : undefined;
  const side = v.side === 'minus' ? ('minus' as const) : undefined;
  const common = {
    ...(id ? { id } : {}),
    x: v.x,
    y: v.y,
    ...(label ? { label } : {}),
  };
  switch (v.plane) {
    case 'outline':
      return { ...common, plane: 'outline', ...(side ? { side } : {}) };
    case 'rocker':
      return v.curve === 'bottom' || v.curve === 'deck'
        ? { ...common, plane: 'rocker', curve: v.curve }
        : null;
    case 'section':
      return isFiniteNumber(v.station)
        ? { ...common, plane: 'section', station: v.station, ...(side ? { side } : {}) }
        : null;
    default:
      return null;
  }
};

/** Plain JSON for a file, in a fixed key order so a save is byte-stable. */
export const refPointsToJson = (points: RefPoints): Record<string, unknown>[] =>
  points.map((p) => ({
    id: p.id,
    plane: p.plane,
    ...(p.plane === 'rocker' ? { curve: p.curve } : {}),
    ...(p.plane === 'section' ? { station: p.station } : {}),
    x: p.x,
    y: p.y,
    ...(p.plane !== 'rocker' && p.side ? { side: p.side } : {}),
    ...(p.label ? { label: p.label } : {}),
  }));

/**
 * Read reference points from untrusted JSON (the inverse of {@link refPointsToJson}).
 * Never throws: they are optional data beside a board, so a damaged point is dropped
 * (and counted) rather than costing the user the board. Unknown fields are ignored,
 * so a later version can add some. Missing or repeated ids are replaced with fresh ones.
 */
export const reviveRefPoints = (json: unknown): { points: RefPoint[]; dropped: number } => {
  if (json === undefined || json === null) return { points: [], dropped: 0 };
  if (!Array.isArray(json)) return { points: [], dropped: 1 };
  const revived = json.map(reviveOne);
  const kept = revived.filter((p): p is RefPointDraft => p !== null);
  const seen = new Set<string>();
  const unique = kept.map((p) => {
    const ok = p.id !== undefined && !seen.has(p.id);
    if (ok) seen.add(p.id!);
    return ok ? p : { ...p, id: undefined };
  });
  const nextId = refIdAllocator(seen);
  const points = unique.map((p) => ({ ...p, id: p.id ?? nextId() }) as RefPoint);
  return { points, dropped: json.length - kept.length };
};
