import type { Vec2 } from '@openshaper/kernel';

/**
 * Maps world coordinates (board centimeters, y-up) to screen pixels (y-down).
 * `scale` is pixels per cm; `(originX, originY)` is the screen pixel at world (0,0).
 */
export interface Viewport {
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * CSS reference scale: pixels per centimetre at 1:1 (life-size).
 *
 * CSS defines exactly 1 in = 96 px (the "reference pixel") and 1 in = 2.54 cm,
 * therefore 1 cm = 96 / 2.54 ≈ 37.795 CSS px.
 *
 * Note: this is the CSS *reference* pixel anchor, not a calibrated physical
 * measurement. On high-DPI monitors the backing-store canvas is scaled by
 * `devicePixelRatio` (handled separately in the canvas `setTransform` call)
 * but the viewport scale is always in CSS px — do NOT multiply by dpr here.
 * Whether 1 CSS px truly equals one physical pixel depends on the monitor's
 * actual PPI; per-monitor calibration is left as future work.
 */
export const CSS_PX_PER_CM: number = 96 / 2.54;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export const worldToScreen = (vp: Viewport, p: Vec2): ScreenPoint => ({
  x: vp.originX + p.x * vp.scale,
  y: vp.originY - p.y * vp.scale,
});

export const screenToWorld = (vp: Viewport, s: ScreenPoint): Vec2 => ({
  x: (s.x - vp.originX) / vp.scale,
  y: (vp.originY - s.y) / vp.scale,
});

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Compute a viewport that fits `bounds` (with px padding) centered in the canvas. */
export const fitToBounds = (
  bounds: Bounds,
  canvasW: number,
  canvasH: number,
  padding = 24,
): Viewport => {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((canvasW - 2 * padding) / w, (canvasH - 2 * padding) / h);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    originX: canvasW / 2 - cx * scale,
    originY: canvasH / 2 + cy * scale,
  };
};

/** Zoom by `factor` about a screen anchor, keeping that point fixed. */
export const zoomAt = (vp: Viewport, anchor: ScreenPoint, factor: number): Viewport => {
  const world = screenToWorld(vp, anchor);
  const scale = vp.scale * factor;
  return {
    scale,
    originX: anchor.x - world.x * scale,
    originY: anchor.y + world.y * scale,
  };
};

export const pan = (vp: Viewport, dxPx: number, dyPx: number): Viewport => ({
  ...vp,
  originX: vp.originX + dxPx,
  originY: vp.originY + dyPx,
});

/**
 * Return a viewport zoomed to 1:1 (life-size) with the canvas centre held fixed.
 *
 * The resulting `scale` is exactly `CSS_PX_PER_CM` (≈ 37.795 CSS px per cm).
 * The world point that was under the canvas centre before the call remains under
 * the canvas centre after the call — i.e. the zoom is anchored at the centre of
 * the visible canvas area.
 *
 * `canvasW` / `canvasH` are the CSS-pixel dimensions of the canvas element (not
 * the backing-store dimensions, which are multiplied by devicePixelRatio).
 */
export const lifeSizeViewport = (current: Viewport, canvasW: number, canvasH: number): Viewport =>
  zoomAt(current, { x: canvasW / 2, y: canvasH / 2 }, CSS_PX_PER_CM / current.scale);
