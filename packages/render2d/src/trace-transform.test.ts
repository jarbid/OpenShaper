// SPDX-License-Identifier: GPL-3.0-or-later
import { vec2, type Vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  imageCenterWorld,
  imgToWorld,
  scaleFromTypedLength,
  setRotationAboutCenter,
  solveSimilarity,
  toggleFlip,
  traceCanvasMatrix,
  worldToImg,
} from './trace-transform';
import { worldToScreen, type Viewport } from './viewport';

const near = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe('solveSimilarity', () => {
  it('maps both image points onto their world points (no flip)', () => {
    const p1 = vec2(120, 340);
    const p2 = vec2(880, 410);
    const q1 = vec2(-15, 6);
    const q2 = vec2(48, 9);
    const t = solveSimilarity(p1, p2, q1, q2, false);
    near(imgToWorld(t, p1), q1, 1e-6);
    near(imgToWorld(t, p2), q2, 1e-6);
  });

  it('maps both image points onto their world points (mirrored)', () => {
    const p1 = vec2(120, 340);
    const p2 = vec2(880, 410);
    const q1 = vec2(-15, 6);
    const q2 = vec2(48, 9);
    const t = solveSimilarity(p1, p2, q1, q2, true);
    expect(t.flipX).toBe(true);
    near(imgToWorld(t, p1), q1, 1e-6);
    near(imgToWorld(t, p2), q2, 1e-6);
  });

  it('recovers a pure 90° rotation with unit scale', () => {
    // image +u axis (0,0)->(1,0) should map to world (0,0)->(0,1)
    const t = solveSimilarity(vec2(0, 0), vec2(1, 0), vec2(0, 0), vec2(0, 1), false);
    expect(t.scale).toBeCloseTo(1, 9);
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 9);
    near(imgToWorld(t, vec2(1, 0)), vec2(0, 1), 1e-9);
  });

  it('recovers a pure scale', () => {
    // 10 image px -> 25 world cm, no rotation. image y-down maps to world y-up.
    const t = solveSimilarity(vec2(0, 0), vec2(10, 0), vec2(0, 0), vec2(25, 0), false);
    expect(t.scale).toBeCloseTo(2.5, 9);
    expect(t.rotation).toBeCloseTo(0, 9);
  });
});

describe('imgToWorld / worldToImg', () => {
  it('are inverses', () => {
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), false);
    for (const p of [vec2(0, 0), vec2(500, 200), vec2(1000, 750)]) {
      near(worldToImg(t, imgToWorld(t, p)), p, 1e-6);
    }
  });

  it('are inverses when flipped', () => {
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), true);
    for (const p of [vec2(0, 0), vec2(500, 200), vec2(1000, 750)]) {
      near(worldToImg(t, imgToWorld(t, p)), p, 1e-6);
    }
  });
});

describe('scaleFromTypedLength', () => {
  it('is world cm per image pixel', () => {
    expect(scaleFromTypedLength(vec2(50, 50), vec2(150, 50), 200)).toBeCloseTo(2, 9);
    expect(scaleFromTypedLength(vec2(0, 0), vec2(0, 40), 10)).toBeCloseTo(0.25, 9);
  });
});

describe('toggleFlip', () => {
  it('keeps the image center fixed in world space', () => {
    const w = 1000;
    const h = 750;
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), false);
    const before = imageCenterWorld(t, w, h);
    const flipped = toggleFlip(t, w, h);
    expect(flipped.flipX).toBe(true);
    near(imageCenterWorld(flipped, w, h), before, 1e-6);
    // flipping twice returns to the original transform
    near(imageCenterWorld(toggleFlip(flipped, w, h), w, h), before, 1e-6);
  });
});

describe('setRotationAboutCenter', () => {
  it('keeps the image center fixed and sets the rotation', () => {
    const w = 1000;
    const h = 750;
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), false);
    const before = imageCenterWorld(t, w, h);
    const rotated = setRotationAboutCenter(t, w, h, t.rotation + 0.7);
    expect(rotated.rotation).toBeCloseTo(t.rotation + 0.7, 9);
    near(imageCenterWorld(rotated, w, h), before, 1e-6);
  });
});

describe('traceCanvasMatrix', () => {
  it('matches worldToScreen∘imgToWorld at the image corners (dpr=1)', () => {
    const vp: Viewport = { scale: 12, originX: 300, originY: 500 };
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), false);
    const w = 1000;
    const h = 750;
    const m = traceCanvasMatrix(vp, t, 1);
    const apply = (u: number, v: number) => vec2(m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f);
    for (const [u, v] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      const expected = worldToScreen(vp, imgToWorld(t, vec2(u, v)));
      near(apply(u, v), expected, 1e-6);
    }
  });

  it('scales every term by dpr', () => {
    const vp: Viewport = { scale: 12, originX: 300, originY: 500 };
    const t = solveSimilarity(vec2(120, 340), vec2(880, 410), vec2(-15, 6), vec2(48, 9), false);
    const m1 = traceCanvasMatrix(vp, t, 1);
    const m2 = traceCanvasMatrix(vp, t, 2);
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(m2[k]).toBeCloseTo(m1[k] * 2, 9);
    }
  });
});
