// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  splineFromKnots,
  splineLength,
  splineLengthToX,
  tangentAt,
  valueAt,
} from './bezier-spline';
import { board } from './board';
import { knotFromArray } from './knot';
import { developHorizontalRailBand, developRailBand } from './rail-band';
import { boxBoard, curvyBoard } from './test-support/synthetic-boards';

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

const swallowBoard = () => {
  const base = curvyBoard();
  const outline = splineFromKnots([
    knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
    knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 50, 25)], false, false),
    knotFromArray([50, 25, ...third(50, 25, 0, 9), ...third(50, 25, 100, 0)], false, false),
    knotFromArray([100, 0, ...third(100, 0, 50, 25), 100, 0], false, false),
  ]);
  return board(outline, base.bottom, base.deck, base.crossSections, base.interpolationType);
};

const maxAbs = (vals: number[]): number => vals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('splineLengthToX', () => {
  it('is 0 at the start and the full length at the end', () => {
    const b = curvyBoard();
    expect(splineLengthToX(b.bottom, 0)).toBeCloseTo(0, 6);
    expect(splineLengthToX(b.bottom, 100)).toBeCloseTo(splineLength(b.bottom), 4);
  });

  it('equals x on a flat curve and √(1+k²)·x on a linear rocker', () => {
    const flat = boxBoard({ length: 100 });
    expect(splineLengthToX(flat.bottom, 40)).toBeCloseTo(40, 4);
    const k = 0.1;
    const sloped = boxBoard({ length: 100, rockerSlope: k });
    expect(splineLengthToX(sloped.bottom, 40)).toBeCloseTo(40 * Math.hypot(1, k), 3);
  });
});

describe('developRailBand — box board (analytic)', () => {
  const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5 });

  it('is an exact rectangle: length = L − trims, edges at thickness and 0', () => {
    const r = developRailBand(b, { offset: 3, tailTrim: 5, noseTrim: 5, flatten: false });
    expect(r.length).toBeCloseTo(90, 3);
    expect(r.deck.length).toBeGreaterThan(4);
    expect(maxAbs(r.deck.map((p) => p.y - 5))).toBeLessThan(1e-3);
    expect(maxAbs(r.bottom.map((p) => p.y))).toBeLessThan(1e-3);
    expect(r.domain.x0).toBeCloseTo(5, 6);
    expect(r.domain.x1).toBeCloseTo(95, 6);
  });

  it('skin compensation on a flat surface is an exact vertical inset', () => {
    const r = developRailBand(b, { offset: 3, skinThickness: 0.4, flatten: false });
    expect(maxAbs(r.deck.map((p) => p.y - 4.6))).toBeLessThan(1e-2);
    expect(maxAbs(r.bottom.map((p) => p.y - 0.4))).toBeLessThan(1e-2);
  });

  it('flatten centres the strip about 0 without changing its height', () => {
    const raw = developRailBand(b, { offset: 3, flatten: false });
    const flat = developRailBand(b, { offset: 3, flatten: true });
    expect(flat.deck.length).toBe(raw.deck.length);
    for (let i = 0; i < flat.deck.length; i++) {
      const hFlat = flat.deck[i]!.y - flat.bottom[i]!.y;
      const hRaw = raw.deck[i]!.y - raw.bottom[i]!.y;
      expect(hFlat).toBeCloseTo(hRaw, 6);
      expect(flat.deck[i]!.y + flat.bottom[i]!.y).toBeCloseTo(0, 6);
    }
  });

  it('stations map to u = x − tailTrim; out-of-domain stations are NaN', () => {
    const r = developRailBand(b, {
      offset: 3,
      tailTrim: 5,
      noseTrim: 5,
      stations: [2, 20, 50, 80, 98],
    });
    expect(Number.isNaN(r.stationU[0])).toBe(true);
    expect(Number.isNaN(r.stationU[4])).toBe(true);
    expect(r.stationU[1]).toBeCloseTo(15, 2);
    expect(r.stationU[2]).toBeCloseTo(45, 2);
    expect(r.stationU[3]).toBeCloseTo(75, 2);
  });
});

describe('developRailBand — rocker (the mode distinction)', () => {
  const k = 0.12;
  const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5, rockerSlope: k });

  it('exact mode: u is PLAN arc length (rocker shows as sloped edges)', () => {
    const r = developRailBand(b, { offset: 3, tailTrim: 5, noseTrim: 5, flatten: false });
    expect(r.length).toBeCloseTo(90, 2);
    // Edges carry the raw rocker rise.
    const rise = r.deck[r.deck.length - 1]!.y - r.deck[0]!.y;
    expect(rise).toBeCloseTo(k * 90, 1);
  });

  it('flattened mode: u is the 3D mid-curve arc length (longer), edges level', () => {
    const r = developRailBand(b, { offset: 3, tailTrim: 5, noseTrim: 5, flatten: true });
    expect(r.length).toBeCloseTo(90 * Math.hypot(1, k), 2);
    // Strip is level: constant height about 0.
    expect(maxAbs(r.deck.map((p) => p.y - 2.5))).toBeLessThan(1e-2);
    expect(maxAbs(r.bottom.map((p) => p.y + 2.5))).toBeLessThan(1e-2);
  });
});

describe('developRailBand — curvy board', () => {
  const b = curvyBoard();

  it('parallel-curve oracle: developed length ≈ outline arc − d·Δφ over the domain', () => {
    const d = 2;
    const r = developRailBand(b, { offset: d, tailTrim: 10, noseTrim: 10, flatten: false });
    // Outline arc length over [x0, x1] by dense plan sampling of (x, outlineY).
    const N = 4000;
    let arc = 0;
    let prevY = valueAt(b.outline, r.domain.x0);
    for (let i = 1; i <= N; i++) {
      const x = r.domain.x0 + ((r.domain.x1 - r.domain.x0) * i) / N;
      const y = valueAt(b.outline, x);
      arc += Math.hypot((r.domain.x1 - r.domain.x0) / N, y - prevY);
      prevY = y;
    }
    // Tangent turning between the ends (compass convention: atan2(dx, dy)).
    const dPhi = Math.abs(tangentAt(b.outline, r.domain.x1) - tangentAt(b.outline, r.domain.x0));
    const expected = arc - d * dPhi;
    expect(Math.abs(r.length - expected) / expected).toBeLessThan(0.01);
  });

  it('converges as the tolerance is halved', () => {
    const coarse = developRailBand(b, { offset: 2, tolerance: 0.08 });
    const fine = developRailBand(b, { offset: 2, tolerance: 0.01 });
    expect(Math.abs(coarse.length - fine.length)).toBeLessThan(0.25);
  });

  it('skin compensation stays bounded (≤ 2·skin per edge)', () => {
    const skin = 0.5;
    const raw = developRailBand(b, { offset: 2, flatten: false });
    const skinned = developRailBand(b, { offset: 2, skinThickness: skin, flatten: false });
    expect(skinned.deck.length).toBe(raw.deck.length);
    for (let i = 0; i < raw.deck.length; i++) {
      const shrink =
        raw.deck[i]!.y - skinned.deck[i]!.y + (skinned.bottom[i]!.y - raw.bottom[i]!.y);
      expect(shrink).toBeGreaterThan(0);
      expect(shrink).toBeLessThanOrEqual(2 * (2 * skin) + 1e-6);
    }
  });

  it('produces no NaNs and a monotone u axis', () => {
    const r = developRailBand(b, { offset: 2.5 });
    for (let i = 0; i < r.deck.length; i++) {
      expect(Number.isFinite(r.deck[i]!.x)).toBe(true);
      expect(Number.isFinite(r.deck[i]!.y)).toBe(true);
      expect(Number.isFinite(r.bottom[i]!.y)).toBe(true);
      if (i > 0) expect(r.deck[i]!.x).toBeGreaterThan(r.deck[i - 1]!.x);
    }
  });

  it('an offset wider than the board yields a clean empty result', () => {
    const r = developRailBand(b, { offset: 30 });
    expect(r.deck.length).toBe(0);
    expect(r.length).toBe(0);
  });

  it('swallow tail: the domain starts past the notch apex', () => {
    const r = developRailBand(swallowBoard(), { offset: 1.5 });
    expect(r.domain.x0).toBeGreaterThanOrEqual(17.9);
    expect(r.deck.length).toBeGreaterThan(4);
  });
});

describe('developHorizontalRailBand', () => {
  it('box board, flat rocker: exact rectangle (L − trims) × offset', () => {
    const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5 });
    const r = developHorizontalRailBand(b, { offset: 3, tailTrim: 5, noseTrim: 5 });
    expect(r.length).toBeCloseTo(90, 3);
    expect(maxAbs(r.outer.map((p) => p.y - 20))).toBeLessThan(1e-3);
    expect(maxAbs(r.inner.map((p) => p.y - 17))).toBeLessThan(1e-3);
  });

  it('linear rocker stretches the developed length by √(1+k²)', () => {
    const k = 0.12;
    const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5, rockerSlope: k });
    const r = developHorizontalRailBand(b, { offset: 3, tailTrim: 5, noseTrim: 5 });
    expect(r.length).toBeCloseTo(90 * Math.hypot(1, k), 2);
  });

  it('curvy board: finite, inner inside outer, monotone u, stations mapped', () => {
    const b = curvyBoard();
    const r = developHorizontalRailBand(b, {
      offset: 2,
      tailTrim: 8,
      noseTrim: 8,
      stations: [30, 50, 70],
    });
    expect(r.outer.length).toBeGreaterThan(4);
    for (let i = 0; i < r.outer.length; i++) {
      expect(Number.isFinite(r.outer[i]!.y)).toBe(true);
      expect(r.inner[i]!.y).toBeLessThan(r.outer[i]!.y);
      if (i > 0) expect(r.outer[i]!.x).toBeGreaterThan(r.outer[i - 1]!.x);
    }
    expect(r.stationU.every((u) => Number.isFinite(u))).toBe(true);
    for (let i = 1; i < r.stationU.length; i++) {
      expect(r.stationU[i]!).toBeGreaterThan(r.stationU[i - 1]!);
    }
  });

  it('swallow tail: domain starts past the notch apex', () => {
    const r = developHorizontalRailBand(swallowBoard(), { offset: 1.5 });
    expect(r.domain.x0).toBeGreaterThanOrEqual(17.9);
  });
});
