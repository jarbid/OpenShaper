import { curvature, value, xDeriv, yDeriv, type Spline, type Vec2 } from '@openshaper/kernel';
import { boundsOf, sampleSpline } from './sample';
import { worldToScreen, type Viewport } from './viewport';
import type { Hit } from './hit';

export interface DrawStyle {
  curve: string;
  curveWidth: number;
  handleLine: string;
  point: string;
  pointSelected: string;
  tangent: string;
}

export const defaultStyle: DrawStyle = {
  curve: '#cc785c',
  curveWidth: 2,
  handleLine: 'rgba(140,140,150,0.6)',
  point: '#e8e3dd',
  pointSelected: '#cc785c',
  tangent: '#8a8a93',
};

/** Reflection options: outline mirrors across y=0; cross-sections across x=0. */
export interface Mirror {
  mirrorX?: boolean;
  mirrorY?: boolean;
}

const reflections = (m: Mirror): ((p: Vec2) => Vec2)[] => {
  const fns: ((p: Vec2) => Vec2)[] = [(p) => p];
  if (m.mirrorY) fns.push((p) => ({ x: p.x, y: -p.y }));
  if (m.mirrorX) fns.push((p) => ({ x: -p.x, y: p.y }));
  return fns;
};

/** Stroke a spline as a sampled polyline, plus any requested mirror reflections. */
export const drawSpline = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  style: DrawStyle,
  mirror: Mirror = {},
): void => {
  const pts = sampleSpline(spline);
  if (pts.length === 0) return;
  ctx.strokeStyle = style.curve;
  ctx.lineWidth = style.curveWidth;
  for (const f of reflections(mirror)) {
    ctx.beginPath();
    const first = worldToScreen(vp, f(pts[0]!));
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const s = worldToScreen(vp, f(pts[i]!));
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
};

/** Stroke a ghost/reference spline (dashed, muted, no handles) under the live curves. */
export const drawGhostSpline = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  mirror: Mirror = {},
): void => {
  const pts = sampleSpline(spline);
  if (pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(180,184,196,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const f of reflections(mirror)) {
    ctx.beginPath();
    const first = worldToScreen(vp, f(pts[0]!));
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const s = worldToScreen(vp, f(pts[i]!));
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
  ctx.restore();
};

const dot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

const square = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.fillStyle = fill;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
};

/**
 * Draw control points + tangent handles for a spline. Smooth (continuous) knots
 * render as circles; corner knots as squares — mirroring the legacy editor so the
 * continuity of a point is readable at a glance.
 */
export const drawControlPoints = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  style: DrawStyle,
  selectedIndex: number | null,
): void => {
  spline.knots.forEach((k, i) => {
    const end = worldToScreen(vp, k.end);
    const prev = worldToScreen(vp, k.tangentToPrev);
    const next = worldToScreen(vp, k.tangentToNext);

    ctx.strokeStyle = style.handleLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();

    dot(ctx, prev.x, prev.y, 3, style.tangent);
    dot(ctx, next.x, next.y, 3, style.tangent);
    const fill = i === selectedIndex ? style.pointSelected : style.point;
    if (k.continuous) dot(ctx, end.x, end.y, 5, fill);
    else square(ctx, end.x, end.y, 4, fill);
  });
};

/** Toggleable analysis overlays drawn on a 2D editor pane. */
export interface EditorOverlays {
  /** Curvature comb on the edited spline(s). */
  curvatureComb?: boolean;
  /** Vertical reference lines (e.g. center of mass). */
  verticalMarkers?: { x: number; color: string; label?: string }[];
  /** Longitudinal distribution strip (e.g. cross-sectional area vs. length). */
  distribution?: { x: number; value: number }[];
  /** Fin markers (plan view): board-x, lateral offset from stringer, fore-aft base. */
  fins?: { x: number; offset: number; base: number }[];
}

/** A cross-section's longitudinal position, shown as a pickable line on the outline. */
export interface SectionMarker {
  /** Board length position (world x). */
  pos: number;
  /** Cross-section index, passed back on pick. */
  index: number;
  active: boolean;
}

/** Draw vertical section-position markers across the outline view (legacy "cross-section positions"). */
export const drawSectionMarkers = (
  ctx: CanvasRenderingContext2D,
  markers: readonly SectionMarker[],
  vp: Viewport,
  height: number,
): void => {
  for (const m of markers) {
    const x = worldToScreen(vp, { x: m.pos, y: 0 }).x;
    ctx.strokeStyle = m.active ? '#cc785c' : 'rgba(140,140,150,0.35)';
    ctx.lineWidth = m.active ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
};

/** Index of the section marker nearest `screenX` within `tolPx`, or null. */
export const hitSectionMarker = (
  markers: readonly SectionMarker[],
  vp: Viewport,
  screenX: number,
  tolPx = 6,
): number | null => {
  let best: { index: number; d: number } | null = null;
  for (const m of markers) {
    const x = worldToScreen(vp, { x: m.pos, y: 0 }).x;
    const d = Math.abs(x - screenX);
    if (d <= tolPx && (!best || d < best.d)) best = { index: m.index, d };
  }
  return best ? best.index : null;
};

/**
 * Draw a curvature comb ("porcupine") for a spline: at samples along each
 * segment, a quill normal to the curve scaled by signed curvature, with the
 * quill tips joined into an envelope. The classic fairing aid — kinks and flat
 * spots that are invisible on the curve jump out on the comb. Auto-scaled so the
 * largest quill is a fixed fraction of the curve's extent.
 */
export const drawCurvatureComb = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  color = '#6ca0cc',
  samplesPerSegment = 14,
): void => {
  if (spline.coeffs.length === 0) return;
  const pts: Vec2[] = [];
  const curvs: number[] = [];
  for (const k of spline.coeffs) {
    for (let i = 0; i <= samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      pts.push(value(k, t));
      curvs.push(curvature(k, t));
    }
  }
  const maxAbs = curvs.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
  if (maxAbs < 1e-9) return;
  const b = boundsOf(pts);
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1;
  const scale = (diag * 0.12) / maxAbs; // world cm per unit curvature

  const tips: Vec2[] = pts.map((p, i) => {
    const k =
      spline.coeffs[Math.min(Math.floor(i / (samplesPerSegment + 1)), spline.coeffs.length - 1)]!;
    const t = (i % (samplesPerSegment + 1)) / samplesPerSegment;
    const dx = xDeriv(k, t);
    const dy = yDeriv(k, t);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // unit normal to the curve direction
    const ny = dx / len;
    const d = curvs[i]! * scale;
    return { x: p.x + nx * d, y: p.y + ny * d };
  });

  // Quills.
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const a = worldToScreen(vp, pts[i]!);
    const c = worldToScreen(vp, tips[i]!);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(c.x, c.y);
  }
  ctx.stroke();
  // Envelope joining the tips.
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  tips.forEach((tp, i) => {
    const s = worldToScreen(vp, tp);
    i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
};

/** Labeled vertical reference lines at world-x positions (e.g. center of mass). */
export const drawVerticalMarkers = (
  ctx: CanvasRenderingContext2D,
  markers: readonly { x: number; color: string; label?: string }[],
  vp: Viewport,
  height: number,
): void => {
  for (const m of markers) {
    const x = worldToScreen(vp, { x: m.x, y: 0 }).x;
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.fillStyle = m.color;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(m.label, x + 3, 12);
    }
  }
};

/**
 * Longitudinal distribution strip (e.g. cross-sectional area vs. length) drawn
 * along the bottom of the view: normalized to its own max, filled translucent.
 */
export const drawDistribution = (
  ctx: CanvasRenderingContext2D,
  data: readonly { x: number; value: number }[],
  vp: Viewport,
  height: number,
  color = '#8fbf73',
): void => {
  if (data.length < 2) return;
  const maxV = data.reduce((m, d) => Math.max(m, d.value), 1e-9);
  const stripH = Math.min(70, height * 0.25);
  const base = height - 6;
  const sx = (x: number) => worldToScreen(vp, { x, y: 0 }).x;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = sx(d.x);
    const y = base - (d.value / maxV) * stripH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(sx(data[data.length - 1]!.x), base);
  ctx.lineTo(sx(data[0]!.x), base);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 1;
};

/**
 * Draw fin markers in plan view: each fin is near edge-on from above, so it reads
 * as a short fore-aft segment at its lateral offset, with a small leading dot.
 */
export const drawFins = (
  ctx: CanvasRenderingContext2D,
  fins: readonly { x: number; offset: number; base: number }[],
  vp: Viewport,
  color = '#c08fcf',
): void => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const f of fins) {
    const a = worldToScreen(vp, { x: f.x - f.base / 2, y: f.offset });
    const b = worldToScreen(vp, { x: f.x + f.base / 2, y: f.offset });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2); // leading (toward-tail) dot
    ctx.fill();
  }
  ctx.restore();
};

export const clear = (ctx: CanvasRenderingContext2D, w: number, h: number, bg = '#1b1b1f') => {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
};

export type { Hit };
