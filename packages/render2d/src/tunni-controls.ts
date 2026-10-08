import type { Spline, Vec2 } from '@openshaper/kernel';
import { tunniGeometry, type TunniGeometry } from '@openshaper/store';
import { worldToScreen, type Viewport } from './viewport';

export interface TunniHit {
  index: number;
  kind: 'point' | 'line';
  geometry: TunniGeometry;
}

export const drawTunniControls = (ctx: CanvasRenderingContext2D, spline: Spline, vp: Viewport) => {
  ctx.save();
  ctx.strokeStyle = '#FBBF24';
  ctx.fillStyle = '#FBBF24';
  ctx.lineWidth = 1;
  for (let index = 0; index < spline.knots.length - 1; index++) {
    const g = tunniGeometry(spline, index);
    if (!g) continue;
    const screen = (p: Vec2) => worldToScreen(vp, p);
    const a = screen(g.c1),
      b = screen(g.c2);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (g.point) {
      const p = screen(g.point);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x + 5, p.y);
      ctx.lineTo(p.x, p.y + 5);
      ctx.lineTo(p.x - 5, p.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
};

export const hitTunniControls = (
  spline: Spline,
  vp: Viewport,
  screen: Vec2,
  tolerance: number,
): TunniHit | null => {
  let best: TunniHit | null = null;
  let distance = tolerance;
  // Points take precedence over lines, even from another segment.
  for (const kind of ['point', 'line'] as const) {
    for (let index = 0; index < spline.knots.length - 1; index++) {
      const g = tunniGeometry(spline, index);
      if (!g) continue;
      const a = worldToScreen(vp, g.c1);
      const b = worldToScreen(vp, g.c2);
      let d: number;
      if (kind === 'point') {
        if (!g.point) continue;
        const p = worldToScreen(vp, g.point);
        d = Math.hypot(screen.x - p.x, screen.y - p.y);
      } else {
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const length = dx * dx + dy * dy;
        if (!length) continue;
        const t = Math.max(
          0,
          Math.min(1, ((screen.x - a.x) * dx + (screen.y - a.y) * dy) / length),
        );
        d = Math.hypot(screen.x - a.x - t * dx, screen.y - a.y - t * dy);
      }
      if (d <= distance) {
        distance = d;
        best = { index, kind, geometry: g };
      }
    }
    if (best) return best;
  }
  return best;
};
