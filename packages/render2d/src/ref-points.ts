import type { RefPoint } from '@openshaper/kernel';
import { fillTextUpright } from './draw';
import { worldToScreen, type Viewport } from './viewport';

/** Reference points read as measurements, not curve handles: a yellow crosshair. */
export const REF_POINT_COLOR = '#FACC15';
/** The selection colour control points use, so "selected" reads the same everywhere. */
export const REF_POINT_SELECTED_COLOR = '#F97316';
/** The board is within tolerance of this measurement. */
export const REF_POINT_OK_COLOR = '#22C55E';
/** The board is further from this measurement than the tolerance. */
export const REF_POINT_OFF_COLOR = '#EF4444';

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
  /**
   * Whether the board is within tolerance of each point (green / red), or null where
   * there is nothing to compare (yellow). Omitted: every point is yellow.
   */
  within?: (p: RefPoint) => boolean | null,
): void => {
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const p of points) {
    const s = worldToScreen(vp, p);
    const selected = p.id === selectedId;
    const verdict = within ? within(p) : null;
    const color = selected
      ? REF_POINT_SELECTED_COLOR
      : verdict === null
        ? REF_POINT_COLOR
        : verdict
          ? REF_POINT_OK_COLOR
          : REF_POINT_OFF_COLOR;
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

/** Length of a measured-station tick, in px, at each edge of a length-wise pane. */
const STATION_TICK_PX = 10;

/**
 * Mark the stations where cross-section reference points were measured, as short ticks
 * on the top and bottom edges of a length-wise pane, so it is plain where a section is
 * expected (and where one has been moved away from).
 */
export const drawMeasuredStations = (
  ctx: CanvasRenderingContext2D,
  stations: readonly number[],
  vp: Viewport,
  height: number,
): void => {
  if (stations.length === 0) return;
  ctx.save();
  ctx.strokeStyle = REF_POINT_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const x of stations) {
    const sx = worldToScreen(vp, { x, y: 0 }).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, STATION_TICK_PX);
    ctx.moveTo(sx, height - STATION_TICK_PX);
    ctx.lineTo(sx, height);
  }
  ctx.stroke();
  ctx.restore();
};
