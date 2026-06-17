import {
  curvature,
  value,
  xDeriv,
  yDeriv,
  type ResolvedFin,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
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
  color?: string,
): void => {
  const pts = sampleSpline(spline);
  if (pts.length === 0) return;
  ctx.save();
  // If a custom color is supplied use it at 55% opacity; otherwise fall back to
  // the original semi-transparent silver so callers that pass nothing are unchanged.
  ctx.strokeStyle = color ? `${color}8c` : 'rgba(180,184,196,0.55)';
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
  /** Override the control-point radius (px). Defaults to 5 for circles / 4 for squares. */
  pointSize?: number,
): void => {
  const r = pointSize ?? 5;
  const rSq = pointSize != null ? Math.max(1, pointSize - 1) : 4;
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
    if (k.continuous) dot(ctx, end.x, end.y, r, fill);
    else square(ctx, end.x, end.y, rSq, fill);
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
/**
 * Parse a 6-digit CSS hex color (#rrggbb) into an rgba() string with the given
 * alpha, falling back to the provided `fallback` if parsing fails.
 */
const hexToRgba = (hex: string, alpha: number, fallback: string): string => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return fallback;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
};

export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  w: number,
  h: number,
  /** Override grid color (6-digit hex). Defaults to the built-in muted-blue-grey. */
  color?: string,
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

  // Derive minor / axis colors: minor at 12% opacity, axes at 40%.
  const minorColor = color
    ? hexToRgba(color, 0.12, 'rgba(138,155,179,0.12)')
    : 'rgba(138,155,179,0.12)';
  const axisColor = color
    ? hexToRgba(color, 0.4, 'rgba(138,155,179,0.4)')
    : 'rgba(138,155,179,0.4)';

  ctx.save();
  // Minor grid lines.
  ctx.strokeStyle = minorColor;
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
  ctx.strokeStyle = axisColor;
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
  /** Resolved fins to draw on this pane (placement + box/blade geometry). */
  fins?: readonly ResolvedFin[];
  /** How to draw fins: `'plan'` (footprint + box, default) or `'profile'` (blade silhouette). */
  finView?: 'plan' | 'profile';
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

const FIN_COLOR = '#A78BFA';
const FIN_COLOR_SELECTED = '#22D3EE';

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len2 = (a: Vec2): number => Math.hypot(a.x, a.y);
const unit2 = (a: Vec2): Vec2 => {
  const l = len2(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Draw fins in PLAN view (bottom, looking up): each fin reads edge-on as its toed
 * base footprint, with the system box/plugs routed along it. The selected fin is
 * highlighted. Plan world coords: x = length, y = lateral (stringer at 0).
 */
export const drawFinsPlan = (
  ctx: CanvasRenderingContext2D,
  fins: readonly ResolvedFin[],
  vp: Viewport,
  selectedIndex: number | null = null,
): void => {
  ctx.save();
  ctx.lineCap = 'round';
  fins.forEach((f, i) => {
    const selected = i === selectedIndex;
    const color = selected ? FIN_COLOR_SELECTED : FIN_COLOR;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    const fore = worldToScreen(vp, f.baseLine.fore);
    const aft = worldToScreen(vp, f.baseLine.aft);

    // Footprint (the toed base line), trailing→leading.
    ctx.lineWidth = selected ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(aft.x, aft.y);
    ctx.lineTo(fore.x, fore.y);
    ctx.stroke();
    // Leading-edge tick.
    ctx.beginPath();
    ctx.arc(fore.x, fore.y, selected ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();

    // System box / plugs, centred on the base line.
    drawFinBox(ctx, f, vp, color, selected);
  });
  ctx.restore();
};

/** Draw the routed box/plug footprints (rect slots / round plugs) for one fin. */
const drawFinBox = (
  ctx: CanvasRenderingContext2D,
  f: ResolvedFin,
  vp: Viewport,
  color: string,
  selected: boolean,
): void => {
  if (f.box.kind !== 'shapes') return;
  const center = mid(f.baseLine.fore, f.baseLine.aft);
  const along = unit2(sub(f.baseLine.fore, f.baseLine.aft)); // toward nose
  const normal = { x: -along.y, y: along.x };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = selected ? 0.9 : 0.6;
  ctx.lineWidth = 1.5;
  for (const fp of f.box.footprints) {
    const cx = center.x + along.x * fp.along;
    const cy = center.y + along.y * fp.along;
    if (fp.shape.kind === 'rect') {
      const hl = fp.shape.length / 2;
      const hw = fp.shape.width / 2;
      const corner = (sa: number, sn: number): Vec2 =>
        worldToScreen(vp, {
          x: cx + along.x * hl * sa + normal.x * hw * sn,
          y: cy + along.y * hl * sa + normal.y * hw * sn,
        });
      const c = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
      ctx.beginPath();
      ctx.moveTo(c[0]!.x, c[0]!.y);
      for (let k = 1; k < 4; k++) ctx.lineTo(c[k]!.x, c[k]!.y);
      ctx.closePath();
      ctx.stroke();
    } else {
      const r = (fp.shape.diameter / 2) * vp.scale;
      const p = worldToScreen(vp, { x: cx, y: cy });
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, r), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
};

/**
 * Draw fins in PROFILE/rail view (side elevation): the blade silhouette hangs from
 * the bottom surface. Profile world coords: x = length, y = height (rocker).
 */
export const drawFinsProfile = (
  ctx: CanvasRenderingContext2D,
  fins: readonly ResolvedFin[],
  vp: Viewport,
  selectedIndex: number | null = null,
): void => {
  ctx.save();
  ctx.lineJoin = 'round';
  fins.forEach((f, i) => {
    if (f.template.length < 3) return;
    const selected = i === selectedIndex;
    const color = selected ? FIN_COLOR_SELECTED : FIN_COLOR;
    // Trailing-edge root (template local x=0) sits at the aft base point; local x runs
    // toward the nose, local y is depth downward (lower height).
    const noseDir = Math.sign(f.baseLine.fore.x - f.baseLine.aft.x) || 1;
    const rootX = f.baseLine.aft.x;
    const toScreen = (p: Vec2) =>
      worldToScreen(vp, { x: rootX + noseDir * p.x, y: f.surfaceZ - p.y });
    ctx.beginPath();
    const p0 = toScreen(f.template[0]!);
    ctx.moveTo(p0.x, p0.y);
    for (let k = 1; k < f.template.length; k++) {
      const p = toScreen(f.template[k]!);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = selected ? 0.28 : 0.16;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1.4;
    ctx.stroke();
  });
  ctx.restore();
};

/** Distance (px) from a screen point to a segment a→b. */
const segDistPx = (p: Vec2, a: Vec2, b: Vec2): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
};

/**
 * Index of the fin whose plan base line is nearest `screen` within `tolPx`, or null.
 * Used to pick / drag fins in the plan (outline) pane.
 */
export const hitFin = (
  fins: readonly ResolvedFin[],
  vp: Viewport,
  screen: Vec2,
  tolPx = 8,
): number | null => {
  let bestIndex: number | null = null;
  let bestDist = tolPx;
  for (let i = 0; i < fins.length; i++) {
    const f = fins[i]!;
    const d = segDistPx(
      screen,
      worldToScreen(vp, f.baseLine.fore),
      worldToScreen(vp, f.baseLine.aft),
    );
    if (d <= bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
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
