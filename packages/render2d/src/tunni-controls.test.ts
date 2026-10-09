import { knot, splineFromKnots } from '@openshaper/kernel';
import { expect, it, vi } from 'vitest';
import { drawTunniControls, hitTunniControls } from './tunni-controls';
import { worldToScreen } from './viewport';

const curve = splineFromKnots([
  knot({ x: 0, y: 0 }, { x: -2, y: -4 }, { x: 2, y: 4 }),
  knot({ x: 10, y: 0 }, { x: 8, y: 4 }, { x: 12, y: -4 }),
]);
const vp = { scale: 20, originX: 200, originY: 200 };

it('draws one Tunni line and diamond per segment', () => {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
  };
  drawTunniControls(ctx as unknown as CanvasRenderingContext2D, curve, vp);
  expect(ctx.stroke).toHaveBeenCalledTimes(1);
  expect(ctx.fill).toHaveBeenCalledTimes(1);
  expect(ctx.moveTo).toHaveBeenCalledWith(240, 120);
  expect(ctx.moveTo).toHaveBeenCalledWith(300, 75);
});

it('hits the point before the line it sits beside, and the line along its length', () => {
  const at = (x: number, y: number) => worldToScreen(vp, { x, y });
  expect(hitTunniControls(curve, vp, at(5, 6), 8)?.kind).toBe('point');
  // Nearer the line (10 px) than the point (30 px), but both within 50 px: the point wins.
  expect(hitTunniControls(curve, vp, at(5, 4.5), 50)?.kind).toBe('point');
  expect(hitTunniControls(curve, vp, at(3, 4), 8)?.kind).toBe('line');
  expect(hitTunniControls(curve, vp, at(5, 2), 8)).toBeNull();
});
