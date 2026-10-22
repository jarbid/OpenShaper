import type { Spline, Vec2 } from '@openshaper/kernel';
import { handlePoint, type Hit } from './hit';

/** Spatial order, with top-to-bottom ties and a stable order for coincident points. */
export function nextHorizontalPoint(
  points: readonly Vec2[],
  current: number,
  direction: 1 | -1,
): number | null {
  const order = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.x - b.point.x || b.point.y - a.point.y || a.index - b.index);
  const at = order.findIndex((entry) => entry.index === current);
  if (at < 0) return null;
  return order[(at + direction + order.length) % order.length]!.index;
}

/** All drawn handles remain reachable, including collapsed and endpoint handles. */
export function nextSplineHandle(spline: Spline, current: Hit, direction: 1 | -1): Hit | null {
  const handles = spline.knots.flatMap((_, index) =>
    (['prev', 'end', 'next'] as const).map((kind) => ({ index, kind })),
  );
  const at = handles.findIndex((hit) => hit.index === current.index && hit.kind === current.kind);
  const next = nextHorizontalPoint(
    handles.map((hit) => handlePoint(spline.knots[hit.index]!, hit.kind)),
    at,
    direction,
  );
  return next === null ? null : handles[next]!;
}
