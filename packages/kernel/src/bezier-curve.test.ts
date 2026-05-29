import { describe, expect, it } from 'vitest';
import {
  coeffsOf,
  curveFromPoints,
  curveLength,
  tangent,
  tForX,
  value,
  xValue,
  yForX,
} from './bezier-curve';
import { vec2 } from './vec2';

// A straight diagonal y = x, parameterized so x = 3t.
const diagonal = coeffsOf(
  curveFromPoints(vec2(0, 0), vec2(1, 1), vec2(2, 2), vec2(3, 3)),
);

describe('bezier-curve (straight diagonal)', () => {
  it('evaluates the Horner form', () => {
    expect(xValue(diagonal, 0.5)).toBeCloseTo(1.5, 12);
    expect(value(diagonal, 0.5)).toEqual({ x: 1.5, y: 1.5 });
  });

  it('solves tForX and yForX', () => {
    expect(tForX(diagonal, 1.5)).toBeCloseTo(0.5, 6);
    expect(yForX(diagonal, 2.25)).toBeCloseTo(2.25, 6);
  });

  it('measures arc length (linear case = chord)', () => {
    expect(curveLength(diagonal)).toBeCloseTo(Math.hypot(3, 3), 9);
  });
});

describe('bezier-curve (curved)', () => {
  // Endpoints (0,0)->(10,0) with handles pulling up: a symmetric arch.
  const arch = coeffsOf(curveFromPoints(vec2(0, 0), vec2(3, 6), vec2(7, 6), vec2(10, 0)));

  it('is symmetric about the midpoint', () => {
    expect(value(arch, 0.5)).toEqual({ x: 5, y: 4.5 });
    expect(xValue(arch, 0.25)).toBeCloseTo(10 - xValue(arch, 0.75), 9);
  });

  it('round-trips tForX within tolerance', () => {
    const x = 3.7;
    const t = tForX(arch, x);
    expect(xValue(arch, t)).toBeCloseTo(x, 2);
  });

  it('uses the legacy atan2(dx,dy) tangent convention', () => {
    // At the apex (t=0.5) the curve is horizontal: dy=0, dx>0 => atan2(dx,0)=+pi/2.
    expect(tangent(arch, 0.5)).toBeCloseTo(Math.PI / 2, 9);
  });
});
