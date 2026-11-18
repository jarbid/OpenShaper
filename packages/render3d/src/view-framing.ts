/**
 * Pure framing maths for the 3D view.
 *
 * Split out of `Board3DView` so it can be tested without a WebGL context: the
 * component file pulls in three, fiber and drei, none of which belong in a unit
 * test of two arithmetic rules.
 */

/** A fitted board fills 1 / this much of the view's width (or height): the rest is room around it. */
const FIT_MARGIN = 1.25;

/**
 * Orthographic zoom that fits `span` cm across ~80% of a `viewportWidth`-px view.
 *
 * An orthographic camera has no distance-driven scale, so framing is entirely this
 * number. Clamped above zero: a zero or negative zoom collapses the projection
 * matrix and the board vanishes.
 */
export const orthographicZoomFor = (viewportWidth: number, span: number): number =>
  Math.max(0.01, viewportWidth / (span * FIT_MARGIN));

/** A box's side lengths along the board's axes: X tail to nose, Y rail to rail, Z up. */
export interface BoxSize {
  x: number;
  y: number;
  z: number;
}

/** How far a silhouette reaches across the screen and up it. */
export interface ScreenExtent {
  horizontal: number;
  vertical: number;
}

const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

const unit = (v: readonly number[]): [number, number, number] => {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!);
  return length > 0 ? [v[0]! / length, v[1]! / length, v[2]! / length] : [0, 0, 1];
};

/**
 * How far a box centred on the origin reaches across the screen and up it when the camera sits at `from`
 * and looks at the centre, with the up `upForViewDirection` gives that view. A box reaches along any
 * direction as far as each of its sides, weighted by how much that side's axis lies along it.
 */
export const projectedExtent = (
  size: BoxSize,
  from: readonly [number, number, number],
): ScreenExtent => {
  const toCamera = unit(from);
  const forward: [number, number, number] = [-toCamera[0], -toCamera[1], -toCamera[2]];
  const right = unit(cross(forward, upForViewDirection({ z: toCamera[2] })));
  const up = cross(right, forward);
  const reach = (axis: readonly number[]) =>
    Math.abs(axis[0]!) * size.x + Math.abs(axis[1]!) * size.y + Math.abs(axis[2]!) * size.z;
  return { horizontal: reach(right), vertical: reach(up) };
};

/**
 * Orthographic zoom that fits a silhouette of `extent` inside a `viewport`-px view, in both directions,
 * with the same room around it as `orthographicZoomFor`. A view that is wide and short (the 3D pane of
 * the workspace) is limited by its height when the board is seen obliquely, which the width alone
 * cannot know. Clamped above zero, as `orthographicZoomFor` is.
 */
export const orthographicZoomForBox = (
  viewport: { width: number; height: number },
  extent: ScreenExtent,
): number => {
  const fits = (px: number, reach: number) => (reach > 0 ? px / (reach * FIT_MARGIN) : Infinity);
  const zoom = Math.min(
    fits(viewport.width, extent.horizontal),
    fits(viewport.height, extent.vertical),
  );
  return Number.isFinite(zoom) ? Math.max(0.01, zoom) : 0.01;
};

/** The pose the camera starts at when there is no restored one. */
export type DefaultView = 'side' | 'threeQuarter';

/**
 * The camera's starting position for a board framed at distance `d`, as a direction: an orthographic
 * camera has no distance-driven scale, so only the direction matters. `side` looks across the board
 * from its right rail, a little above; `threeQuarter` from behind the tail, to the right and above, so
 * the deck, the right rail and the tail are all in sight (the view the workspace opens on, where a
 * side view shows the deck edge-on).
 */
export const defaultCameraPosition = (
  d: number,
  view: DefaultView = 'side',
): [number, number, number] =>
  view === 'threeQuarter' ? [-0.55 * d, -0.8 * d, 0.7 * d] : [0, -d, d * 0.45];

/**
 * The camera's up vector when snapping to a view along `direction`.
 *
 * Board axes are X tail→nose, Y rail→rail, Z vertical. Looking straight down or up
 * the Z axis (deck and bottom views) leaves Z useless as "up", so Y takes over —
 * signed so the nose stays on the right of the screen from both. Every other view
 * keeps the deck upright with Z.
 */
export const upForViewDirection = (direction: { z: number }): [number, number, number] =>
  Math.abs(direction.z) > 0.999 ? [0, Math.sign(direction.z), 0] : [0, 0, 1];
