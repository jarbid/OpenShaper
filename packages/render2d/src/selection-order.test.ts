import { expect, it } from 'vitest';
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { nextSplineHandle } from './selection-order';

it('uses actual horizontal position for returning cross-section handles', () => {
  const spline = splineFromKnots([
    knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0)),
    knot(vec2(10, 5), vec2(12, 3), vec2(8, 5)),
  ]);
  expect(nextSplineHandle(spline, { index: 1, kind: 'next' }, 1)).toEqual({
    index: 1,
    kind: 'end',
  });
  expect(nextSplineHandle(spline, { index: 1, kind: 'end' }, 1)).toEqual({
    index: 1,
    kind: 'prev',
  });
  expect(nextSplineHandle(spline, { index: 1, kind: 'end' }, -1)).toEqual({
    index: 1,
    kind: 'next',
  });
});

it('keeps coincident handles reachable in a stable reversible order', () => {
  const spline = splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]);
  expect(nextSplineHandle(spline, { index: 0, kind: 'end' }, 1)).toEqual({
    index: 0,
    kind: 'next',
  });
  expect(nextSplineHandle(spline, { index: 0, kind: 'end' }, -1)).toEqual({
    index: 0,
    kind: 'prev',
  });
  expect(nextSplineHandle(spline, { index: 0, kind: 'next' }, 1)).toEqual({
    index: 0,
    kind: 'prev',
  });
});
