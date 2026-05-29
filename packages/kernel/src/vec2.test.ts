import { describe, expect, it } from 'vitest';
import { add, angle, cross, distance, dot, lerp, length, normalize, scale, sub, vec2 } from './vec2';

describe('vec2', () => {
  it('adds and subtracts', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(vec2(3, 4), vec2(1, 2))).toEqual({ x: 2, y: 2 });
  });

  it('scales', () => {
    expect(scale(vec2(2, -3), 2)).toEqual({ x: 4, y: -6 });
  });

  it('computes dot and cross', () => {
    expect(dot(vec2(1, 2), vec2(3, 4))).toBe(11);
    expect(cross(vec2(1, 0), vec2(0, 1))).toBe(1);
  });

  it('computes length and distance', () => {
    expect(length(vec2(3, 4))).toBe(5);
    expect(distance(vec2(0, 0), vec2(3, 4))).toBe(5);
  });

  it('normalizes (and handles zero)', () => {
    expect(normalize(vec2(0, 5))).toEqual({ x: 0, y: 1 });
    expect(normalize(vec2(0, 0))).toEqual({ x: 0, y: 0 });
  });

  it('lerps', () => {
    expect(lerp(vec2(0, 0), vec2(10, 20), 0.5)).toEqual({ x: 5, y: 10 });
  });

  it('computes angle', () => {
    expect(angle(vec2(1, 1))).toBeCloseTo(Math.PI / 4, 10);
  });
});
