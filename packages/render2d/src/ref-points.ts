import type { RefPoint } from '@openshaper/kernel';
import { fillTextUpright } from './draw';
import { worldToScreen, type Viewport } from './viewport';

/** Reference points read as measurements, not curve handles: a yellow crosshair. */
export const REF_POINT_COLOR = '#FACC15';
/** The selection colour control points use, so "selected" reads the same everywhere. */
export const REF_POINT_SELECTED_COLOR = '#F97316';

/**
 * Draw reference points as crosshairs at a constant screen size. They are drawn where
 * they were measured only — never reflected into the mirrored half — and a labelled
 * point carries its label beside it.
 */
export const drawRefPoints = (
  ctx: CanvasRenderingContext2D,
  points: readonly RefPoint[],
  vp: Viewport,
  selectedId: string | null,
  turned: boolean,
  /** Arm length in px; the control-point size, so both scale together. */
  radius = 6,
): void => {
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const p of points) {
    const s = worldToScreen(vp, p);
    const selected = p.id === selectedId;
    const color = selected ? REF_POINT_SELECTED_COLOR : REF_POINT_COLOR;
    const r = selected ? radius + 2 : radius;
    // A gap at the centre keeps the measured spot itself visible under the mark.
    const gap = 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y);
    ctx.lineTo(s.x - gap, s.y);
    ctx.moveTo(s.x + gap, s.y);
    ctx.lineTo(s.x + r, s.y);
    ctx.moveTo(s.x, s.y - r);
    ctx.lineTo(s.x, s.y - gap);
    ctx.moveTo(s.x, s.y + gap);
    ctx.lineTo(s.x, s.y + r);
    ctx.stroke();
    if (p.label) {
      ctx.fillStyle = color;
      fillTextUpright(ctx, p.label, s.x + r + 3, s.y - r, turned);
    }
  }
  ctx.restore();
};

/** The reference point nearest a screen position within `tolPx`, or null. */
export const hitRefPoint = (
  points: readonly RefPoint[],
  vp: Viewport,
  screen: { x: number; y: number },
  tolPx = 8,
): RefPoint | null => {
  let best: RefPoint | null = null;
  let bestDist = tolPx;
  for (const p of points) {
    const s = worldToScreen(vp, p);
    const d = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (d <= bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
};
