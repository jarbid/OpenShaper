// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The slice's arithmetic, with no React: what a section from the engine measures, how it is scaled to a
 * box so that its width and thickness keep their true proportions, and the paths it is drawn with.
 *
 * A section is the engine's flat polyline `[y0, z0, y1, z1, …]` in cm for one side: `y` the distance from
 * the stringer and `z` the height above the rocker, from the bottom centre over the rail's widest point to
 * the deck centre. The left side (the plus side) is drawn on the left of the stringer and the right on the
 * right, as the board is seen standing at its tail looking to the nose.
 */

/** What a half section measures. */
export interface SliceMeasure {
  /** The widest the section is from the stringer, cm: where the rail's apex is. */
  readonly halfWidth: number;
  /** The deck centre's height over the bottom centre's, cm. */
  readonly thickness: number;
  /** The widest point: the rail's apex as it is on the board. */
  readonly apex: { readonly y: number; readonly z: number };
  readonly zMin: number;
  readonly zMax: number;
}

/** The measure of a half section, or null for one with fewer than two points or a number that is not one. */
export function measureSlice(points: readonly number[]): SliceMeasure | null {
  const n = Math.floor(points.length / 2);
  if (n < 2 || !points.every(Number.isFinite)) return null;
  let apex = { y: points[0]!, z: points[1]! };
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = points[2 * i]!;
    const z = points[2 * i + 1]!;
    if (y > apex.y) apex = { y, z };
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  return {
    halfWidth: apex.y,
    thickness: points[2 * n - 1]! - points[1]!,
    apex,
    zMin,
    zMax,
  };
}

/** Where sections are drawn in a box: one scale for both axes, so the proportions are the board's. */
export interface SliceFrame {
  /** px per cm. */
  readonly scale: number;
  /** The stringer's x and the middle height's y, px. */
  readonly cx: number;
  readonly cy: number;
  /** The height (cm) drawn at `cy`. */
  readonly zMid: number;
}

/**
 * The frame that fits every measure in a `width` by `height` box, leaving `margin` px at the sides (`x`, at the
 * left and the right), at the top and at the bottom: the largest scale at which the widest of them
 * (both halves, so twice the half width) and the tallest fit. Null when there is nothing to fit or no
 * room.
 */
export function fitSlices(
  measures: readonly SliceMeasure[],
  box: { readonly width: number; readonly height: number },
  margin: { readonly x: number; readonly top: number; readonly bottom: number },
): SliceFrame | null {
  if (measures.length === 0) return null;
  const spanY = 2 * Math.max(...measures.map((m) => m.halfWidth));
  const zMin = Math.min(...measures.map((m) => m.zMin));
  const zMax = Math.max(...measures.map((m) => m.zMax));
  const spanZ = zMax - zMin;
  const roomX = box.width - 2 * margin.x;
  const roomY = box.height - margin.top - margin.bottom;
  if (!(spanY > 0) || !(spanZ > 0) || !(roomX > 0) || !(roomY > 0)) return null;
  return {
    scale: Math.min(roomX / spanY, roomY / spanZ),
    cx: box.width / 2,
    cy: margin.top + roomY / 2,
    zMid: (zMin + zMax) / 2,
  };
}

/** A point of a half section on the screen: the left half is left of the stringer, the right half right of it. */
export function toScreen(
  frame: SliceFrame,
  y: number,
  z: number,
  side: 'left' | 'right',
): { readonly x: number; readonly y: number } {
  return {
    x: frame.cx + (side === 'left' ? -y : y) * frame.scale,
    y: frame.cy - (z - frame.zMid) * frame.scale,
  };
}

const fixed = (n: number): string => (Math.round(n * 100) / 100).toString();

/** A half section as an open SVG path, from the bottom centre over the rail to the deck centre. */
export function halfPath(
  points: readonly number[],
  frame: SliceFrame,
  side: 'left' | 'right',
): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const p = toScreen(frame, points[i]!, points[i + 1]!, side);
    out.push(`${i === 0 ? 'M' : 'L'}${fixed(p.x)} ${fixed(p.y)}`);
  }
  return out.join(' ');
}

/**
 * The closed section as one SVG path: the left half from the bottom centre to the deck centre, then the
 * right half back from the deck centre to the bottom centre.
 */
export function closedPath(
  left: readonly number[],
  right: readonly number[],
  frame: SliceFrame,
): string {
  const back: number[] = [];
  for (let i = right.length - 2; i >= 0; i -= 2) back.push(right[i]!, right[i + 1]!);
  const rest = halfPath(back, frame, 'right').replace(/^M/, 'L');
  return `${halfPath(left, frame, 'left')} ${rest} Z`;
}

/**
 * The places the Rails step asks the engine for: the cursor's, and the two ends of the zone that is
 * chosen. No place twice.
 */
export function wantedPlaces(
  place: number,
  zone: { readonly from: number; readonly to: number } | null,
): number[] {
  return [...new Set(zone ? [place, zone.from, zone.to] : [place])];
}
