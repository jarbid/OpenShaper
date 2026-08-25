import type { Spline, Vec2 } from '@openshaper/kernel';
import { worldToScreen, type Viewport } from './viewport';

export type HandleKind = 'end' | 'prev' | 'next';
export interface Hit {
  index: number;
  kind: HandleKind;
}

const distPx = (vp: Viewport, a: Vec2, screen: { x: number; y: number }): number => {
  const s = worldToScreen(vp, a);
  return Math.hypot(s.x - screen.x, s.y - screen.y);
};

/**
 * Find the nearest control-point handle to a screen position, within `tolPx`.
 * Endpoints take priority over tangent handles at equal distance. Returns null
 * if nothing is within tolerance.
 */
export const hitTest = (
  spline: Spline,
  vp: Viewport,
  screen: { x: number; y: number },
  tolPx = 8,
  /** Prefer an already-selected overlapping handle (needed to re-extend zero-length handles). */
  preferred?: Hit,
): Hit | null => {
  let best: Hit | null = null;
  let bestDist = tolPx;
  spline.knots.forEach((k, index) => {
    const candidates: [HandleKind, Vec2][] = [
      ['end', k.end],
      ['prev', k.tangentToPrev],
      ['next', k.tangentToNext],
    ];
    for (const [kind, p] of candidates) {
      const d = distPx(vp, p, screen);
      // Endpoints normally win ties. An explicitly selected handle wins more strongly,
      // so a zero-length handle can still be right-clicked or dragged away from its knot.
      const adj =
        preferred?.index === index && preferred.kind === kind
          ? d - 1
          : kind === 'end'
            ? d - 0.5
            : d;
      if (adj <= bestDist) {
        bestDist = adj;
        best = { index, kind };
      }
    }
  });
  return best;
};
