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
