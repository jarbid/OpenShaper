// SPDX-License-Identifier: GPL-3.0-or-later
import { knot, splineFromKnots, type Vec2 } from './index';
import { describe, expect, it } from 'vitest';
import { balanceTunni, moveTunniLine, moveTunniPoint, tunniGeometry } from './tunni';

const p = (x: number, y: number): Vec2 => ({ x, y });
const curve = (c1 = p(2, 4), c2 = p(8, 4)) =>
  splineFromKnots([knot(p(0, 0), p(-2, -4), c1), knot(p(10, 0), c2, p(12, -4))]);
const near = (actual: Vec2, expected: Vec2) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

describe('Tunni geometry (analytic cubics, tolerance 1e-10)', () => {
  it('locates the point and preserves the original handles for a zero move', () => {
    const g = tunniGeometry(curve(), 0)!;
    near(g.point!, p(5, 6));
    expect(moveTunniPoint(g, g.point!)).toEqual([g.c1, g.c2]);
    expect(moveTunniLine(g, p(0, 0))).toEqual([g.c1, g.c2]);
  });
  it('moves the point while keeping both handles on their original rays', () => {
    const g = tunniGeometry(curve(), 0)!;
    const result = moveTunniPoint(g, p(6, 8))!;
    near(result[0], p(2.5, 5));
    near(result[1], p(8, 4));
  });
  it('translates the line normally and ignores motion along it', () => {
    const g = tunniGeometry(curve(), 0)!;
    const result = moveTunniLine(g, p(100, 1))!;
    near(result[0], p(2.5, 5));
    near(result[1], p(7.5, 5));
    expect(moveTunniLine(g, p(100, 0))).toEqual([g.c1, g.c2]);
  });
  it('balances unequal handles into a line parallel to the endpoint chord', () => {
    const g = tunniGeometry(curve(p(1, 2), p(8, 4)), 0)!;
    const result = balanceTunni(g)!;
    near(result[0], p(1.5, 3));
    near(result[1], p(8.5, 3));
  });
  it('allows a line for parallel tangent rays but hides the undefined point', () => {
    const g = tunniGeometry(curve(p(2, 4), p(12, 4)), 0)!;
    expect(g.point).toBeNull();
    expect(moveTunniLine(g, p(0, 1))).not.toBeNull();
    expect(moveTunniPoint(g, p(5, 5))).toBeNull();
    expect(balanceTunni(g)).toBeNull();
  });
  it('rejects straight, collapsed and nearly singular handles', () => {
    expect(tunniGeometry(curve(p(2, 0), p(8, 0)), 0)).toBeNull();
    expect(tunniGeometry(curve(p(0, 0)), 0)).toBeNull();
    expect(tunniGeometry(curve(), 10)).toBeNull();
    expect(tunniGeometry(curve(p(2, 4), p(8, -4)), 0)?.point).toBeNull();
  });
  it('rejects handle reversal and non-finite updates', () => {
    const g = tunniGeometry(curve(), 0)!;
    expect(moveTunniLine(g, p(0, -5))).toBeNull();
    expect(moveTunniPoint(g, p(5, -20))).toBeNull();
    expect(moveTunniPoint(g, p(Infinity, 5))).toBeNull();
  });
  it('is invariant under translation and scaling', () => {
    const s = curve();
    const transform = (v: Vec2) => p(v.x * 100 + 20, v.y * 100 - 30);
    const scaled = splineFromKnots(
      s.knots.map((k) =>
        knot(transform(k.end), transform(k.tangentToPrev), transform(k.tangentToNext)),
      ),
    );
    near(tunniGeometry(scaled, 0)!.point!, transform(tunniGeometry(s, 0)!.point!));
  });
});
