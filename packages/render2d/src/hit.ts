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
      // bias endpoints slightly so they win ties with overlapping handles
      const adj = kind === 'end' ? d - 0.5 : d;
      if (adj <= bestDist) {
        bestDist = adj;
        best = { index, kind };
      }
    }
  });
  return best;
};
