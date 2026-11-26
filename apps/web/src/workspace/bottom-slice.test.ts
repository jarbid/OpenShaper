// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom slice, with no React: how much the relief is magnified, where the depth handle stands for each
 * kind, the relief of a contour at a station, and the depth a pointer at a height means.
 */
import type { RailsBoard } from '@openshaper/board2';
import { addContour, contourDepth, contourReliefAt } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { sampleRailsBoard } from '../test/rails-board';
import {
  HANDLE_SHAPE_MIN,
  RELIEF_FACTORS,
  RELIEF_SPAN,
  depthForRelief,
  handlePlace,
  reliefAcross,
  reliefAt,
  reliefAtPointer,
  reliefFactor,
} from './bottom-slice';

const withAll = async (): Promise<RailsBoard> => {
  let doc = await sampleRailsBoard();
  for (const kind of ['vee', 'single-concave', 'double-concave', 'channels'] as const) {
    doc = addContour(doc, kind);
  }
  return doc;
};

describe('the magnification', () => {
  it('is the greatest of the usual factors at which a centimetre of relief fits the strip', () => {
    // 6.6 px per cm, a strip 60 px high: 0.9 * 60 / 6.6 = 8.2, so ×5
    expect(reliefFactor(6.6, 60, RELIEF_SPAN)).toBe(5);
    expect(reliefFactor(6.6, 120, RELIEF_SPAN)).toBe(10);
    expect(RELIEF_FACTORS).toContain(reliefFactor(3.3, 80, RELIEF_SPAN));
    // never under ×1, and ×1 for a drawing with no room
    expect(reliefFactor(50, 20, RELIEF_SPAN)).toBe(1);
    expect(reliefFactor(0, 60, RELIEF_SPAN)).toBe(1);
    expect(reliefFactor(6, 0, RELIEF_SPAN)).toBe(1);
  });

  it('is never more than the strip holds', () => {
    for (const px of [2, 4, 6.6, 12]) {
      for (const strip of [40, 64, 100, 150]) {
        const k = reliefFactor(px, strip, RELIEF_SPAN);
        expect(k * RELIEF_SPAN * px).toBeLessThanOrEqual(Math.max(strip * 0.9, px));
      }
    }
  });
});

describe('the handle', () => {
  it('stands where each kind’s relief is greatest', async () => {
    const doc = await withAll();
    const w = 20;
    const [vee, single, double, channels] = doc.features;
    expect(handlePlace(vee!, w)).toBe(w);
    expect(handlePlace(single!, w)).toBe(0);
    expect(handlePlace(double!, w)).toBeCloseTo(0.4 * w, 9);
    expect(handlePlace(channels!, w)).toBeCloseTo(w - (3 + 0.4), 9);
  });

  it('reads the relief there as the depth times the contour’s share of it at the station', async () => {
    const doc = await withAll();
    const w = 20;
    for (const f of doc.features) {
      const keys = f.depth.keys;
      const x = (keys[1]!.s + keys[2]!.s) / 2;
      const y = handlePlace(f, w);
      expect(reliefAt(f, x, y, w)).toBeCloseTo(contourReliefAt(f, x, y, w), 9);
      expect(reliefAt(f, x, y, w)).toBeCloseTo(contourDepth(f), 6);
    }
  });

  it('gives back the depth that makes a relief, and none where the station has too little of the contour', async () => {
    const doc = await withAll();
    const w = 20;
    const f = doc.features[1]!;
    const keys = f.depth.keys;
    const mid = (keys[1]!.s + keys[2]!.s) / 2;
    expect(depthForRelief(f, mid, w, 0.25)).toBeCloseTo(0.25, 6);
    expect(depthForRelief(f, mid, w, -1)).toBe(0);
    // halfway up the ramp the contour has half its depth: twice the depth makes the same relief
    const ramp = (keys[0]!.s + keys[1]!.s) / 2;
    const d = depthForRelief(f, ramp, w, 0.1)!;
    expect(
      reliefAt(
        {
          ...f,
          depth: {
            keys: f.depth.keys.map((k, i) => (i === 0 || i === 3 ? k : { ...k, value: d })),
          },
        },
        ramp,
        handlePlace(f, w),
        w,
      ),
    ).toBeCloseTo(0.1, 6);
    expect(depthForRelief(f, keys[0]!.s, w, 0.1)).toBeNull();
    expect(depthForRelief(f, keys[3]!.s + 5, w, 0.1)).toBeNull();
    expect(HANDLE_SHAPE_MIN).toBeGreaterThan(0);
  });
});

describe('the relief across the bottom', () => {
  it('is the sum of the contours, from the stringer to the wall', async () => {
    const doc = await withAll();
    const w = 20;
    const x = 60;
    const pts = reliefAcross(doc.features, x, w, 20);
    expect(pts).toHaveLength(21);
    expect(pts[0]![0]).toBe(0);
    expect(pts[20]![0]).toBeCloseTo(w, 9);
    for (const [y, r] of pts) {
      const sum = doc.features.reduce((t, f) => t + reliefAt(f, x, y, w), 0);
      expect(r).toBeCloseTo(sum, 12);
    }
    expect(reliefAcross([], x, w, 4).every(([, r]) => r === 0)).toBe(true);
  });
});

describe('the pointer', () => {
  it('means the relief the height above the baseline makes, at the magnification and the section’s scale', () => {
    expect(reliefAtPointer(100, 120, 10, 5)).toBeCloseTo(0.4, 9);
    expect(reliefAtPointer(120, 120, 10, 5)).toBe(0);
    expect(reliefAtPointer(130, 120, 10, 5)).toBeLessThan(0);
  });
});
