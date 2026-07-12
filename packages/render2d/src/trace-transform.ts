// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trace-image placement math.
 *
 * A trace image is positioned behind the editor with a **similarity transform**
 * (translate + uniform scale + rotation) plus an optional horizontal mirror. It
 * maps image-pixel space (u,v — origin top-left, y-DOWN) to world space
 * (centimetres, y-UP):
 *
 *   local(u,v)    = ( (flipX ? -1 : 1) * u, -v )         // fold in mirror + y-flip
 *   imgToWorld(p) = (tx,ty) + scale * rot(rotation) · local(u,v)
 *
 * Two matching point-pairs fully determine translate/scale/rotation
 * (`solveSimilarity`); the mirror is the one degree of freedom two points cannot
 * resolve, so `flipX` is chosen by the user and passed in.
 *
 * Pure module — no DOM, no React. Rendering composes {@link traceCanvasMatrix}
 * with the canvas base transform; hit-testing uses {@link worldToImg}.
 */
import { add, angle, distance, scale as scaleVec, sub, vec2, type Vec2 } from '@openshaper/kernel';
import type { Viewport } from './viewport';

export interface SimilarityParams {
  /** World-cm translation (image origin maps here after scale+rotation). */
  readonly tx: number;
  readonly ty: number;
  /** World cm per image pixel. */
  readonly scale: number;
  /** Rotation in radians, CCW in world space. */
  readonly rotation: number;
  /** Mirror across the image's vertical axis. */
  readonly flipX: boolean;
}

/** Rotate a vector by `theta` radians (CCW). */
const rot = (v: Vec2, theta: number): Vec2 => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
};

/** Fold the horizontal mirror and the image y-down→world y-up flip into one step. */
const local = (p: Vec2, flipX: boolean): Vec2 => ({ x: (flipX ? -1 : 1) * p.x, y: -p.y });

/** Map an image-pixel point to world cm. */
export const imgToWorld = (t: SimilarityParams, p: Vec2): Vec2 =>
  add(vec2(t.tx, t.ty), scaleVec(rot(local(p, t.flipX), t.rotation), t.scale));

/** Inverse of {@link imgToWorld}: world cm → image-pixel point. */
export const worldToImg = (t: SimilarityParams, w: Vec2): Vec2 => {
  const d = scaleVec(sub(w, vec2(t.tx, t.ty)), 1 / t.scale);
  const l = rot(d, -t.rotation);
  // undo local(): l = (sign*u, -v)  =>  u = sign*l.x (sign = ±1), v = -l.y
  return { x: (t.flipX ? -1 : 1) * l.x, y: -l.y };
};

/**
 * Solve the similarity transform that maps two image-pixel points onto two world
 * points. `flipX` is the caller's chosen mirror (two points cannot determine it).
 */
export const solveSimilarity = (
  imgP1: Vec2,
  imgP2: Vec2,
  worldQ1: Vec2,
  worldQ2: Vec2,
  flipX: boolean,
): SimilarityParams => {
  const a = local(imgP1, flipX);
  const b = local(imgP2, flipX);
  const s = distance(worldQ1, worldQ2) / distance(a, b);
  const rotation = angle(sub(worldQ2, worldQ1)) - angle(sub(b, a));
  // t so that  scale * rot(rotation)·a + t = worldQ1
  const ra = scaleVec(rot(a, rotation), s);
  return { tx: worldQ1.x - ra.x, ty: worldQ1.y - ra.y, scale: s, rotation, flipX };
};

/**
 * Uniform scale (world cm per image pixel) from two image points and the known
 * real-world distance between them. Mirror/rotation independent.
 */
export const scaleFromTypedLength = (imgP1: Vec2, imgP2: Vec2, worldCm: number): number =>
  worldCm / distance(imgP1, imgP2);

/** World-space position of the image centre (for handles / flip pivoting). */
export const imageCenterWorld = (t: SimilarityParams, w: number, h: number): Vec2 =>
  imgToWorld(t, vec2(w / 2, h / 2));

/** Toggle the horizontal mirror while keeping the image centre fixed in world space. */
export const toggleFlip = (t: SimilarityParams, w: number, h: number): SimilarityParams => {
  const centerWorld = imageCenterWorld(t, w, h);
  const flipped: SimilarityParams = { ...t, flipX: !t.flipX };
  // choose tx,ty so imgToWorld(flipped, center) stays at centerWorld
  const rl = scaleVec(rot(local(vec2(w / 2, h / 2), flipped.flipX), t.rotation), t.scale);
  return { ...flipped, tx: centerWorld.x - rl.x, ty: centerWorld.y - rl.y };
};

/** Set an absolute rotation while keeping the image centre fixed in world space. */
export const setRotationAboutCenter = (
  t: SimilarityParams,
  w: number,
  h: number,
  rotation: number,
): SimilarityParams => {
  const centerWorld = imageCenterWorld(t, w, h);
  const rl = scaleVec(rot(local(vec2(w / 2, h / 2), t.flipX), rotation), t.scale);
  return { ...t, rotation, tx: centerWorld.x - rl.x, ty: centerWorld.y - rl.y };
};

export interface CanvasMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/**
 * Compose `worldToScreen ∘ imgToWorld` into a single canvas affine so a rotated /
 * mirrored bitmap can be drawn with `ctx.setTransform(...); drawImage(img, 0, 0)`.
 * Every term is pre-multiplied by `dpr` because the canvas base transform is
 * `setTransform(dpr, 0, 0, dpr, 0, 0)`.
 *
 * Canvas convention: screenX = a·u + c·v + e, screenY = b·u + d·v + f.
 */
export const traceCanvasMatrix = (vp: Viewport, t: SimilarityParams, dpr: number): CanvasMatrix => {
  const sign = t.flipX ? -1 : 1;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const k = vp.scale * t.scale;
  return {
    a: dpr * k * sign * c,
    b: dpr * -k * sign * s,
    c: dpr * k * s,
    d: dpr * k * c,
    e: dpr * (vp.originX + vp.scale * t.tx),
    f: dpr * (vp.originY - vp.scale * t.ty),
  };
};
