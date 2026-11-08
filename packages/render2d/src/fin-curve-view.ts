// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The pure half of `FinCurveEditor` (docs/design/fin-designer.md, step 10): which
 * handle or curve a pointer is on, where a drag takes a handle, and how the layers are
 * drawn. No React, no store: the editor is told what to draw and reports what the user
 * did, and the app decides what that means for the fin.
 *
 * View space is data space through a linear map (`ViewScale`): y stretched, so a foil
 * 10% of its chord thick can be drawn taller than it is and still be dragged
 * accurately, or the axes swapped, so the taper stands upright beside the profile.
 * Everything here works in view space; `fromView` turns a result back into data.
 */
import { splineFromKnots, knot, vec2, type Spline, type Vec2 } from '@openshaper/kernel';
import { defaultStyle, drawControlPoints, drawSpline, type DrawStyle } from './draw';
import { hitTest, type HandleKind } from './hit';
import { boundsOf, sampleSpline } from './sample';
import {
  screenToWorld,
  worldToScreen,
  type Bounds,
  type ScreenPoint,
  type Viewport,
} from './viewport';

/** One curve the editor shows. */
export interface FinCurveLayer {
  readonly id: string;
  readonly spline: Spline;
  /** Whether its points can be picked and dragged. */
  readonly editable: boolean;
  readonly color?: string;
  /** Dashed and muted: a reference, such as the mirrored half of a symmetric foil. */
  readonly ghost?: boolean;
}

/** A picked control point: which layer, which knot, which part of it. */
export interface FinCurvePick {
  readonly layer: string;
  readonly index: number;
  readonly kind: HandleKind;
}

/** Hit radii, px: a fingertip needs more room than a mouse. */
/**
 * Text drawn on the fin views' canvases: the app's own typeface (a system face beside it
 * read as a mistake), at one size.
 */
export const FIN_CANVAS_FONT =
  "12px 'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif";

/** Labels on the canvases: the app's muted text colour, at full strength (6.5:1). */
export const FIN_CANVAS_LABEL = '#8A9BB3';

export const HIT_TOL_PX = 8;
export const TOUCH_HIT_TOL_PX = 22;

/**
 * A linear map from data to view: view = (a·x + b·y, c·x + d·y). It can stretch an axis
 * (a foil drawn four times taller) or swap them (the taper drawn upright: height up,
 * thickness across).
 */
export interface ViewMap {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/** A view map, or a number: that vertical stretch (data y × it), x as is. */
export type ViewScale = number | ViewMap;

const asMap = (v: ViewScale): ViewMap => (typeof v === 'number' ? { a: 1, b: 0, c: 0, d: v } : v);

const isIdentity = (v: ViewScale): boolean => {
  const m = asMap(v);
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
};

export const toView = (p: Vec2, v: ViewScale): Vec2 => {
  const m = asMap(v);
  return vec2(m.a * p.x + m.b * p.y, m.c * p.x + m.d * p.y);
};

export const fromView = (p: Vec2, v: ViewScale): Vec2 => {
  const m = asMap(v);
  const det = m.a * m.d - m.b * m.c;
  return vec2((m.d * p.x - m.b * p.y) / det, (m.a * p.y - m.c * p.x) / det);
};

/** Data-space bounds mapped to view space: the box around its four mapped corners. */
export const boundsToView = (b: Bounds, v: ViewScale): Bounds => {
  const corners = [
    toView(vec2(b.minX, b.minY), v),
    toView(vec2(b.maxX, b.minY), v),
    toView(vec2(b.minX, b.maxY), v),
    toView(vec2(b.maxX, b.maxY), v),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
};

/** A spline in view space. */
export const splineToView = (s: Spline, yScale: ViewScale): Spline =>
  isIdentity(yScale)
    ? s
    : splineFromKnots(
        s.knots.map((k) =>
          knot(
            toView(k.end, yScale),
            toView(k.tangentToPrev, yScale),
            toView(k.tangentToNext, yScale),
            k.continuous,
            k.other,
          ),
        ),
      );

/**
 * The handle under `screen`, among the editable layers, nearest within `tolPx`. Later
 * layers are on top, so they win ties; a `preferred` pick (the current selection) wins
 * over anything at the same spot, so a collapsed handle can still be grabbed.
 */
export const pickHandle = (
  layers: readonly FinCurveLayer[],
  vp: Viewport,
  screen: ScreenPoint,
  yScale: ViewScale,
  tolPx: number,
  preferred?: FinCurvePick | null,
): FinCurvePick | null => {
  // The selection first, across layers: where curves share a point (a foil's two faces
  // meet at the leading and trailing edges), the one already picked stays picked.
  const pl = preferred && layers.find((l) => l.id === preferred.layer && l.editable);
  if (pl) {
    const hit = hitTest(splineToView(pl.spline, yScale), vp, screen, tolPx, preferred);
    if (hit && hit.index === preferred.index && hit.kind === preferred.kind) return preferred;
  }
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (!l.editable) continue;
    const hit = hitTest(splineToView(l.spline, yScale), vp, screen, tolPx);
    if (hit) return { layer: l.id, index: hit.index, kind: hit.kind };
  }
  return null;
};

/**
 * The nearest point on an editable layer's curve to `screen`, within `tolPx`, in data
 * space: where a double-click adds a point.
 */
export const pickCurve = (
  layers: readonly FinCurveLayer[],
  vp: Viewport,
  screen: ScreenPoint,
  yScale: ViewScale,
  tolPx: number,
): { layer: string; point: Vec2 } | null => {
  let best: { layer: string; point: Vec2 } | null = null;
  let bestD = tolPx;
  for (const l of layers) {
    if (!l.editable) continue;
    const pts = sampleSpline(splineToView(l.spline, yScale)).map((p) => worldToScreen(vp, p));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 > 0
          ? Math.max(0, Math.min(1, ((screen.x - a.x) * dx + (screen.y - a.y) * dy) / len2))
          : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(screen.x - q.x, screen.y - q.y);
      if (d <= bestD) {
        bestD = d;
        best = { layer: l.id, point: fromView(screenToWorld(vp, q), yScale) };
      }
    }
  }
  return best;
};

/**
 * Where a dragged handle goes: its position when grabbed, plus how far the pointer has
 * travelled since, never the pointer itself. Grabbing off-centre (normal with a finger)
 * must not jump the handle under the pointer.
 */
export const dragTo = (grabbed: Vec2, pointerAtGrab: Vec2, pointerNow: Vec2): Vec2 =>
  vec2(grabbed.x + pointerNow.x - pointerAtGrab.x, grabbed.y + pointerNow.y - pointerAtGrab.y);

/** Bounds of all layers in view space, joined with any `extra` (e.g. the tab). */
export const layersBounds = (
  layers: readonly FinCurveLayer[],
  yScale: ViewScale,
  extra?: Bounds,
): Bounds | null => {
  const all = layers.map((l) => boundsOf(sampleSpline(splineToView(l.spline, yScale))));
  if (extra) all.push(extra);
  if (all.length === 0) return null;
  return {
    minX: Math.min(...all.map((b) => b.minX)),
    minY: Math.min(...all.map((b) => b.minY)),
    maxX: Math.max(...all.map((b) => b.maxX)),
    maxY: Math.max(...all.map((b) => b.maxY)),
  };
};

/** Draw the layers: ghosts first and dashed, then curves, then editable points. */
export const drawFinCurves = (
  ctx: CanvasRenderingContext2D,
  layers: readonly FinCurveLayer[],
  vp: Viewport,
  yScale: ViewScale,
  selection: FinCurvePick | null,
  hovered: FinCurvePick | null,
  /** Endpoints selected along with `selection`, on its layer. */
  alsoSelected: readonly number[] = [],
): void => {
  const styleOf = (l: FinCurveLayer): DrawStyle => ({
    ...defaultStyle,
    curve: l.color ?? defaultStyle.curve,
  });
  const ordered = [...layers.filter((l) => l.ghost), ...layers.filter((l) => !l.ghost)];
  for (const l of ordered) {
    ctx.save();
    if (l.ghost) {
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.55;
    }
    drawSpline(ctx, splineToView(l.spline, yScale), vp, styleOf(l));
    ctx.restore();
  }
  for (const l of layers) {
    if (!l.editable) continue;
    const sel = selection?.layer === l.id ? selection : null;
    const hov = hovered?.layer === l.id ? { index: hovered.index, kind: hovered.kind } : null;
    drawControlPoints(
      ctx,
      splineToView(l.spline, yScale),
      vp,
      styleOf(l),
      sel ? sel.index : null,
      undefined,
      sel?.kind ?? 'end',
      hov,
      sel && alsoSelected.length ? new Set(alsoSelected) : null,
    );
  }
};

/**
 * A draggable straight guide across the view: data `axis` held at `at` (y = at for a
 * horizontal line in the profile; x = at in the taper, which stands upright). The fin
 * designer's foil slices are these.
 */
export interface FinCurveGuide {
  readonly id: string;
  readonly axis: 'x' | 'y';
  readonly at: number;
  /**
   * A curved guide instead (data space): drawn and picked along this line, `axis` and `at`
   * ignored (a control section on the smooth surface, along its row).
   */
  readonly path?: readonly Vec2[];
  readonly color?: string;
  readonly selected?: boolean;
  /** Drawn beside the line, at its start. */
  readonly label?: string;
}

/** Two screen points on the guide's line, far apart. */
const guideLine = (
  g: FinCurveGuide,
  vp: Viewport,
  yScale: ViewScale,
): [ScreenPoint, ScreenPoint] => {
  const far = 1e4;
  const a = g.axis === 'y' ? vec2(-far, g.at) : vec2(g.at, -far);
  const b = g.axis === 'y' ? vec2(far, g.at) : vec2(g.at, far);
  return [worldToScreen(vp, toView(a, yScale)), worldToScreen(vp, toView(b, yScale))];
};

const distToLine = (p: ScreenPoint, [a, b]: [ScreenPoint, ScreenPoint]): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len : Infinity;
};

/** A curved guide's line on screen. */
const screenPath = (path: readonly Vec2[], vp: Viewport, yScale: ViewScale): ScreenPoint[] =>
  path.map((p) => worldToScreen(vp, toView(p, yScale)));

/** Distance from `p` to a polyline (screen pixels). */
const distToPath = (p: ScreenPoint, pts: readonly ScreenPoint[]): number => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
};

/** The data-space point under `screen`: where a curved guide is dragged to. */
export const guidePointAt = (vp: Viewport, screen: ScreenPoint, yScale: ViewScale): Vec2 =>
  fromView(screenToWorld(vp, screen), yScale);

/** The guide under `screen`, nearest within `tolPx`. */
export const pickGuide = (
  guides: readonly FinCurveGuide[],
  vp: Viewport,
  screen: ScreenPoint,
  yScale: ViewScale,
  tolPx: number,
): FinCurveGuide | null => {
  let best: FinCurveGuide | null = null;
  let bestD = tolPx;
  for (const g of guides) {
    const d = g.path
      ? distToPath(screen, screenPath(g.path, vp, yScale))
      : distToLine(screen, guideLine(g, vp, yScale));
    if (d <= bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
};

/** The value of the guide's axis at a screen point: where a dragged guide goes. */
export const guideValueAt = (
  g: FinCurveGuide,
  vp: Viewport,
  screen: ScreenPoint,
  yScale: ViewScale,
): number => {
  const p = fromView(screenToWorld(vp, screen), yScale);
  return g.axis === 'y' ? p.y : p.x;
};

/** Draw the guides: dashed, the selected one solid and heavier, labels at the left. */
export const drawGuides = (
  ctx: CanvasRenderingContext2D,
  guides: readonly FinCurveGuide[],
  vp: Viewport,
  yScale: ViewScale,
): void => {
  for (const g of guides) {
    if (g.path) {
      const pts = screenPath(g.path, vp, yScale);
      ctx.save();
      ctx.strokeStyle = g.color ?? 'rgba(244,114,182,0.9)';
      ctx.lineWidth = g.selected ? 2 : 1;
      if (!g.selected) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      if (g.label && pts.length) {
        // Beside the line's start, on the leading edge.
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.font = FIN_CANVAS_FONT;
        ctx.textAlign = 'left';
        ctx.fillText(g.label, pts[0]!.x + 6, pts[0]!.y - 4);
      }
      ctx.restore();
      continue;
    }
    const [a, b] = guideLine(g, vp, yScale);
    ctx.save();
    ctx.strokeStyle = g.color ?? 'rgba(244,114,182,0.9)';
    ctx.lineWidth = g.selected ? 2 : 1;
    if (!g.selected) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (g.label) {
      // At the view's left edge for a line that runs across the screen, at its top for
      // one that runs up it, whichever way the view maps the data.
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.font = FIN_CANVAS_FONT;
      ctx.textAlign = 'left';
      const level = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      if (level) {
        const y = a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x);
        ctx.fillText(g.label, 6, y - 4);
      } else {
        const x = a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y);
        ctx.fillText(g.label, x + 4, 14);
      }
    }
    ctx.restore();
  }
};
