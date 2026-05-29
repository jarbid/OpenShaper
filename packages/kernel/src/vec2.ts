/**
 * Vec2 — immutable 2D vector / point.
 *
 * Replaces the legacy reliance on `java.awt.geom.Point2D.Double` throughout
 * `cadcore` and `board`. Pure data + pure functions, no AWT/UI coupling, so the
 * kernel can run in a Web Worker, in Node tests, or (later) be mirrored in WASM.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const vec2 = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product magnitude (z component of the 3D cross). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
};

/** Linear interpolation between a and b at parameter t in [0,1]. */
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Signed angle of the vector from the +x axis, in radians. */
export const angle = (a: Vec2): number => Math.atan2(a.y, a.x);
