import { curvature, value, xDeriv, yDeriv, type Spline, type Vec2 } from '@openshaper/kernel';
import { boundsOf, sampleSpline } from './sample';
import { screenToWorld, worldToScreen, type Viewport } from './viewport';
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
  curve: '#22D3EE',
  curveWidth: 2,
  handleLine: 'rgba(138,155,179,0.55)',
  point: '#C7D2E0',
  pointSelected: '#22D3EE',
  tangent: '#8A9BB3',
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

/**
 * Round a target spacing (cm) up to a "nice" 1 / 2 / 5 × 10ᵏ value, so the grid
 * lands on round centimeters at any zoom. Returns 0 for non-finite/≤0 input.
 */
export const gridStep = (rawCm: number): number => {
  if (!Number.isFinite(rawCm) || rawCm <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(rawCm)));
  const n = rawCm / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
};

/**
 * A faint reference grid with emphasized world axes — the legacy View ▸ Show Grid
 * + Show Baseline + Show Center Line, unified into one overlay. The cell size is an
 * adaptive "nice" number of centimeters (≈ a target pixel spacing), so the grid
 * stays legible and lands on round values at any zoom. The world x = 0 axis (tail
 * station / cross-section centerline) and y = 0 axis (rocker baseline / outline
 * stringer) are drawn slightly stronger so they read as datum lines.
 */
export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  w: number,
  h: number,
): void => {
  const TARGET_PX = 64;
  const step = gridStep(TARGET_PX / vp.scale);
  if (step <= 0) return;

  const tl = screenToWorld(vp, { x: 0, y: 0 });
  const br = screenToWorld(vp, { x: w, y: h });
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);

  ctx.save();
  // Minor grid lines.
  ctx.strokeStyle = 'rgba(138,155,179,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    const sx = worldToScreen(vp, { x, y: 0 }).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
    const sy = worldToScreen(vp, { x: 0, y }).y;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();

  // Emphasized zero-axes (baseline / centerline), only when in view.
  ctx.strokeStyle = 'rgba(138,155,179,0.4)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (minX <= 0 && maxX >= 0) {
    const sx = worldToScreen(vp, { x: 0, y: 0 }).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  if (minY <= 0 && maxY >= 0) {
    const sy = worldToScreen(vp, { x: 0, y: 0 }).y;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
  ctx.restore();
};

/** Toggleable analysis overlays drawn on a 2D editor pane. */
export interface EditorOverlays {
  /** Faint reference grid + emphasized baseline/centerline axes. */
  grid?: boolean;
  /**
   * Board-x of the cross-pane "sliding location" line, drawn as a vertical probe
   * (solid inside the board, dashed outside). Length-axis panes only.
   */
  scrubProbe?: number;
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

/**
 * Draw vertical section-position markers across the outline/rocker view (legacy
 * "cross-section positions"). Dashed and cyan/teal so they read as *stations*,
 * clearly distinct from the solid neutral-grey reference grid: the active section
 * is a bold solid cyan line, the rest are faint teal dashes.
 */
export const drawSectionMarkers = (
  ctx: CanvasRenderingContext2D,
  markers: readonly SectionMarker[],
  vp: Viewport,
  height: number,
): void => {
  ctx.save();
  for (const m of markers) {
    const x = worldToScreen(vp, { x: m.pos, y: 0 }).x;
    ctx.strokeStyle = m.active ? '#22D3EE' : 'rgba(45,212,191,0.55)';
    ctx.lineWidth = m.active ? 2 : 1;
    ctx.setLineDash(m.active ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.restore();
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
 * Pick a uniform per-segment sample count adaptive to the curve's on-screen
 * length: roughly one sample per `PX_PER_SAMPLE` screen pixels, clamped, and
 * capped so the total quill count stays bounded for perf.
 */
const adaptiveCombSamples = (spline: Spline, vp: Viewport): number => {
  const PX_PER_SAMPLE = 8;
  const MIN = 12;
  const MAX = 40;
  const MAX_TOTAL = 400;
  const segCount = spline.coeffs.length;
  let screenLen = 0;
  for (const k of spline.coeffs) {
    const a = value(k, 0);
    const b = value(k, 1);
    screenLen += Math.hypot(b.x - a.x, b.y - a.y) * vp.scale;
  }
  const perSeg = Math.round(screenLen / PX_PER_SAMPLE / Math.max(1, segCount));
  const capped = Math.floor(MAX_TOTAL / Math.max(1, segCount));
  return Math.max(MIN, Math.min(MAX, capped, perSeg));
};

/**
 * Draw a curvature comb ("porcupine") for a spline: at samples along each
 * segment, a quill normal to the curve scaled by curvature magnitude, with the
 * quill tips joined into an envelope. The classic fairing aid — kinks and flat
 * spots that are invisible on the curve jump out on the comb. Auto-scaled so the
 * largest quill is a fixed fraction of the curve's extent.
 *
 * Quills always bloom *outward* (away from the curve's bounding-box centroid)
 * rather than flipping to the inside at inflections, so the comb reads
 * consistently on outline / rocker / cross-section views. `samplesPerSegment`
 * defaults to an on-screen-length-adaptive count.
 */
export const drawCurvatureComb = (
  ctx: CanvasRenderingContext2D,
  spline: Spline,
  vp: Viewport,
  color = '#38BDF8',
  samplesPerSegment?: number,
): void => {
  if (spline.coeffs.length === 0) return;
  const nSamples = samplesPerSegment ?? adaptiveCombSamples(spline, vp);
  const pts: Vec2[] = [];
  const curvs: number[] = [];
  for (const k of spline.coeffs) {
    for (let i = 0; i <= nSamples; i++) {
      const t = i / nSamples;
      pts.push(value(k, t));
      curvs.push(curvature(k, t));
    }
  }
  const maxAbs = curvs.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
  if (maxAbs < 1e-9) return;
  const b = boundsOf(pts);
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1;
  const scale = (diag * 0.12) / maxAbs; // world cm per unit curvature
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  const tips: Vec2[] = pts.map((p, i) => {
    const k = spline.coeffs[Math.min(Math.floor(i / (nSamples + 1)), spline.coeffs.length - 1)]!;
    const t = (i % (nSamples + 1)) / nSamples;
    const dx = xDeriv(k, t);
    const dy = yDeriv(k, t);
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len; // unit normal to the curve direction
    let ny = dx / len;
    // Orient the quill outward: away from the curve interior (its centroid).
    if (nx * (p.x - cx) + ny * (p.y - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const d = Math.abs(curvs[i]!) * scale; // magnitude only — never flips inward
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
  color = '#2DD4BF',
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
  color = '#A78BFA',
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

/**
 * Colours for the cross-section measurement cursor, shared with the readout HUD so
 * the line and its number are colour-coded together (legacy BoardCAD "sliding info").
 */
export const MEASURE_COLORS = {
  /** Vertical probe at the cursor x — pairs with the "From CL" readout. */
  fromCl: '#22D3EE',
  /** Horizontal probe at the cursor y — pairs with the "Height" readout. */
  height: '#FBBF24',
} as const;

/** Sorted y-values where the vertical line x=X crosses the closed polyline. */
const vCrossings = (poly: readonly Vec2[], X: number): number[] => {
  const ys: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a.x <= X === b.x <= X) continue; // both the same side → no straddle
    ys.push(a.y + ((X - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  return ys.sort((p, q) => p - q);
};

/** Sorted x-values where the horizontal line y=Y crosses the closed polyline. */
const hCrossings = (poly: readonly Vec2[], Y: number): number[] => {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a.y <= Y === b.y <= Y) continue;
    xs.push(a.x + ((Y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  return xs.sort((p, q) => p - q);
};

/**
 * Vertical "sliding location" probe at world x: a dashed full-height guide with
 * the segment(s) *inside* the board profile overdrawn solid — so the local span
 * (width in plan view, thickness in side/section view) reads straight off the
 * board. Used for the cross-pane scrub line in every 2D pane (legacy "sliding
 * info"). `profile` is the closed board outline for the pane.
 */
export const drawVProbe = (
  ctx: CanvasRenderingContext2D,
  profile: readonly Vec2[],
  vp: Viewport,
  h: number,
  x: number,
  color: string,
): void => {
  if (profile.length < 3) return;
  const sx = worldToScreen(vp, { x, y: 0 }).x;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(sx, 0);
  ctx.lineTo(sx, h);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  const ys = vCrossings(profile, x);
  for (let i = 0; i + 1 < ys.length; i += 2) {
    ctx.moveTo(sx, worldToScreen(vp, { x, y: ys[i]! }).y);
    ctx.lineTo(sx, worldToScreen(vp, { x, y: ys[i + 1]! }).y);
  }
  ctx.stroke();
  ctx.restore();
};

/** Horizontal "sliding location" probe at world y — the orthogonal partner of {@link drawVProbe}. */
export const drawHProbe = (
  ctx: CanvasRenderingContext2D,
  profile: readonly Vec2[],
  vp: Viewport,
  w: number,
  y: number,
  color: string,
): void => {
  if (profile.length < 3) return;
  const sy = worldToScreen(vp, { x: 0, y }).y;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, sy);
  ctx.lineTo(w, sy);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  const xs = hCrossings(profile, y);
  for (let i = 0; i + 1 < xs.length; i += 2) {
    ctx.moveTo(worldToScreen(vp, { x: xs[i]!, y }).x, sy);
    ctx.lineTo(worldToScreen(vp, { x: xs[i + 1]!, y }).x, sy);
  }
  ctx.stroke();
  ctx.restore();
};

/**
 * Cross-section measurement cursor (legacy "sliding info"): a full crosshair at
 * the hovered point — vertical + horizontal probes, each solid inside the section
 * profile and dashed outside — colour-coded to match the readout HUD rows.
 */
export const drawMeasureCursor = (
  ctx: CanvasRenderingContext2D,
  profile: readonly Vec2[],
  vp: Viewport,
  w: number,
  h: number,
  cursor: Vec2,
): void => {
  drawVProbe(ctx, profile, vp, h, cursor.x, MEASURE_COLORS.fromCl);
  drawHProbe(ctx, profile, vp, w, cursor.y, MEASURE_COLORS.height);
};

export const clear = (ctx: CanvasRenderingContext2D, w: number, h: number, bg = '#0A1424') => {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
};

export type { Hit };
