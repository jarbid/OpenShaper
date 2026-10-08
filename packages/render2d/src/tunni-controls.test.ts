import { knot, splineFromKnots } from '@openshaper/kernel';
import { expect, it, vi } from 'vitest';
import { drawTunniControls, hitTunniControls } from './tunni-controls';
import { worldToScreen } from './viewport';

const curve = splineFromKnots([
  knot({ x: 0, y: 0 }, { x: -2, y: -4 }, { x: 2, y: 4 }),
  knot({ x: 10, y: 0 }, { x: 8, y: 4 }, { x: 12, y: -4 }),
]);
const vp = { scale: 20, originX: 200, originY: 200 };

it('draws one Tunni line and diamond only on the editable side', () => {
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

it('hits the original point and line but ignores either mirrored half', () => {
  expect(hitTunniControls(curve, vp, worldToScreen(vp, { x: 5, y: 6 }), 8)?.kind).toBe('point');
  expect(hitTunniControls(curve, vp, worldToScreen(vp, { x: 5, y: 4 }), 8)?.kind).toBe('line');
  for (const point of [
    { x: 5, y: -6 },
    { x: 5, y: -4 },
    { x: -5, y: 6 },
    { x: -5, y: 4 },
  ]) {
    expect(hitTunniControls(curve, vp, worldToScreen(vp, point), 8)).toBeNull();
  }
});
