import {
  closestPointOnSpline,
  value,
  type BezierBoard,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { type BoardState, type SplineTarget, getTargetSpline } from '@openshaper/store';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { StoreApi } from 'zustand/vanilla';
import {
  clear,
  defaultStyle,
  drawControlPoints,
  drawCurvatureComb,
  drawDistribution,
  drawFins,
  drawGhostSpline,
  drawSectionMarkers,
  drawSpline,
  drawVerticalMarkers,
  hitSectionMarker,
  type DrawStyle,
  type EditorOverlays,
  type SectionMarker,
} from './draw';
import { hitTest, type Hit } from './hit';
import { boundsOf, sampleSpline } from './sample';
import { fitToBounds, pan, screenToWorld, worldToScreen, zoomAt, type Viewport } from './viewport';

export interface SplineEditorProps {
  store: StoreApi<BoardState>;
  /** One or more splines to draw + edit in this view (e.g. [deck, bottom]). */
  targets: SplineTarget[];
  /** Mirror across y=0 (for the outline, a half-width). */
  mirrorY?: boolean;
  /** Mirror across x=0 (for cross-sections, drawn on the +x half). */
  mirrorX?: boolean;
  /** Per-target curve colors (cycled if shorter than targets). */
  colors?: string[];
  /** Pickable cross-section position markers (e.g. drawn along the outline). */
  sectionMarkers?: SectionMarker[];
  /** Called when a section marker is clicked. */
  onPickSection?: (index: number) => void;
  /** Live measurements for the hovered world point, shown as a corner HUD. */
  readout?: (world: Vec2) => { label: string; value: string }[];
  /** Toggleable analysis overlays (curvature comb, CoM marker, distribution). */
  overlays?: EditorOverlays;
  /** Reference (ghost) splines drawn dashed underneath for comparison. */
  ghostSplines?: Spline[];
  /** Reference image drawn behind the curves for tracing (world-space rect, centered). */
  background?: {
    image: CanvasImageSource;
    opacity: number;
    rect: { x: number; y: number; w: number; h: number };
  };
  className?: string;
}

type DragState =
  | { mode: 'edit'; target: SplineTarget; hit: Hit }
  | { mode: 'pan'; lastX: number; lastY: number }
  | null;

const PALETTE = ['#22D3EE', '#38BDF8', '#2DD4BF', '#A78BFA'];

const useBoard = (store: StoreApi<BoardState>): BezierBoard | null =>
  useSyncExternalStore(store.subscribe, () => store.getState().board);

const sameTarget = (a: SplineTarget, b: SplineTarget): boolean =>
  a.kind === b.kind && (a.kind !== 'crossSection' || (b as { index: number }).index === a.index);

/** Distance from a world point to the nearest point on a spline. */
const splineDistance = (s: Spline, p: Vec2): number => {
  const hit = closestPointOnSpline(s, p);
  if (!hit) return Infinity;
  const pt = value(s.coeffs[hit.index]!, hit.t);
  return Math.hypot(pt.x - p.x, pt.y - p.y);
};

/** A canvas editor for one or more board splines (outline / deck+bottom / cross-section). */
export function SplineEditor({
  store,
  targets,
  mirrorY = false,
  mirrorX = false,
  colors,
  sectionMarkers,
  onPickSection,
  readout,
  overlays,
  ghostSplines,
  background,
  className,
}: SplineEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const board = useBoard(store);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);
  const drag = useRef<DragState>(null);
  const spaceHeld = useRef(false);
  const [cursor, setCursor] = useState<'crosshair' | 'grab' | 'grabbing'>('crosshair');
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);
  const key = JSON.stringify(targets);

  // Space-bar pan (CAD standard): holding Space turns any left-drag into a pan,
  // shown by a grab cursor. Ignore key events while typing in a form field, and
  // only swallow the default (page scroll) when not typing.
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return (
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      spaceHeld.current = true;
      setCursor((c) => (c === 'grabbing' ? c : 'grab'));
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeld.current = false;
      setCursor((c) => (c === 'grabbing' ? c : 'crosshair'));
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Re-fit when the target set changes, or we first get a board + a size.
  useEffect(() => {
    if (!board || size.w === 0) return;
    const all = targets.flatMap((t) => sampleSpline(getTargetSpline(board, t)));
    if (all.length === 0) return;
    let pts = all;
    if (mirrorY) pts = pts.flatMap((p) => [p, { x: p.x, y: -p.y }]);
    if (mirrorX) pts = pts.flatMap((p) => [p, { x: -p.x, y: p.y }]);
    setVp(fitToBounds(boundsOf(pts), size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, board === null, size.w, size.h]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vp || !board || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clear(ctx, size.w, size.h);
    if (background) {
      const { image, opacity, rect } = background;
      const tl = worldToScreen(vp, { x: rect.x - rect.w / 2, y: rect.y + rect.h / 2 });
      const br = worldToScreen(vp, { x: rect.x + rect.w / 2, y: rect.y - rect.h / 2 });
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.drawImage(image, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.restore();
    }
    if (sectionMarkers && sectionMarkers.length > 0) {
      drawSectionMarkers(ctx, sectionMarkers, vp, size.h);
    }
    if (overlays?.distribution) drawDistribution(ctx, overlays.distribution, vp, size.h);
    if (overlays?.verticalMarkers) drawVerticalMarkers(ctx, overlays.verticalMarkers, vp, size.h);
    if (overlays?.fins) drawFins(ctx, overlays.fins, vp);
    if (ghostSplines) {
      for (const g of ghostSplines) drawGhostSpline(ctx, g, vp, { mirrorX, mirrorY });
    }
    const palette = colors ?? PALETTE;
    targets.forEach((t, i) => {
      const spline = getTargetSpline(board, t);
      const style: DrawStyle = { ...defaultStyle, curve: palette[i % palette.length]! };
      drawSpline(ctx, spline, vp, style, { mirrorX, mirrorY });
      if (overlays?.curvatureComb) drawCurvatureComb(ctx, spline, vp);
      const sel = selection && sameTarget(selection.target, t) ? selection.index : null;
      drawControlPoints(ctx, spline, vp, style, sel);
    });
  }, [
    board,
    vp,
    size,
    selection,
    key,
    mirrorX,
    mirrorY,
    colors,
    targets,
    sectionMarkers,
    overlays,
    ghostSplines,
    background,
  ]);

  const localPoint = (e: React.MouseEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!vp || !board) return;
      canvasRef.current!.setPointerCapture(e.pointerId);
      const p = localPoint(e);
      // Space-held or middle-button => pan, regardless of what's under the cursor.
      // preventDefault on the middle button stops the browser's autoscroll bubble.
      if (spaceHeld.current || e.button === 1) {
        e.preventDefault();
        drag.current = { mode: 'pan', lastX: p.x, lastY: p.y };
        setCursor('grabbing');
        return;
      }
      for (const t of targets) {
        const hit = hitTest(getTargetSpline(board, t), vp, p);
        if (hit) {
          store.getState().select({ target: t, index: hit.index });
          store.getState().beginEdit();
          drag.current = { mode: 'edit', target: t, hit };
          return;
        }
      }
      // Picking a section marker (outline view) doesn't start a drag or deselect.
      if (sectionMarkers && onPickSection) {
        const picked = hitSectionMarker(sectionMarkers, vp, p.x);
        if (picked !== null) {
          onPickSection(picked);
          return;
        }
      }
      store.getState().select(null);
      drag.current = { mode: 'pan', lastX: p.x, lastY: p.y };
      setCursor('grabbing');
    },
    [vp, board, store, targets, sectionMarkers, onPickSection],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!vp) return;
      const p = localPoint(e);
      if (!d) {
        // No drag: report the hovered world point for the readout HUD.
        if (readout) setHover(screenToWorld(vp, p));
        return;
      }
      if (d.mode === 'pan') {
        setVp((cur) => (cur ? pan(cur, p.x - d.lastX, p.y - d.lastY) : cur));
        d.lastX = p.x;
        d.lastY = p.y;
        return;
      }
      const world = screenToWorld(vp, p);
      if (d.hit.kind === 'end') store.getState().moveControlPoint(d.target, d.hit.index, world);
      else store.getState().moveTangent(d.target, d.hit.index, d.hit.kind, world);
    },
    [vp, store, readout],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (drag.current?.mode === 'edit') store.getState().endEdit();
      drag.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      setCursor(spaceHeld.current ? 'grab' : 'crosshair');
    },
    [store],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!vp) return;
      const p = localPoint(e);
      setVp(zoomAt(vp, p, e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    [vp],
  );

  // Double-click on a curve inserts a control point there (legacy add-point tool).
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!vp || !board) return;
      const p = localPoint(e);
      // Don't stack a new point on top of an existing handle.
      for (const t of targets) {
        if (hitTest(getTargetSpline(board, t), vp, p)) return;
      }
      // Reflect into the canonical half the splines are defined on (control points
      // only live there; the other half is a drawn mirror).
      let world = screenToWorld(vp, p);
      if (mirrorY && world.y < 0) world = { x: world.x, y: -world.y };
      if (mirrorX && world.x < 0) world = { x: -world.x, y: world.y };
      // Insert on whichever target spline is nearest, within a click tolerance.
      const tolWorld = 14 / vp.scale;
      let best: { target: SplineTarget; dist: number } | null = null;
      for (const t of targets) {
        const dist = splineDistance(getTargetSpline(board, t), world);
        if (!best || dist < best.dist) best = { target: t, dist };
      }
      if (best && best.dist <= tolWorld) {
        store.getState().addControlPoint(best.target, world);
        return;
      }
      // Empty space (no nearby curve): re-home the view to fit the curves.
      if (size.w === 0) return;
      const all = targets.flatMap((t) => sampleSpline(getTargetSpline(board, t)));
      if (all.length === 0) return;
      let fitPts = all;
      if (mirrorY) fitPts = fitPts.flatMap((p) => [p, { x: p.x, y: -p.y }]);
      if (mirrorX) fitPts = fitPts.flatMap((p) => [p, { x: -p.x, y: p.y }]);
      setVp(fitToBounds(boundsOf(fitPts), size.w, size.h));
    },
    [vp, board, store, targets, mirrorX, mirrorY, size.w, size.h],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
          cursor,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      {readout && hover && <ReadoutHud rows={readout(hover)} />}
    </div>
  );
}

/** Small corner HUD showing live measurements at the hovered point. */
function ReadoutHud({ rows }: { rows: { label: string; value: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        pointerEvents: 'none',
        background: 'rgba(15,28,48,0.78)',
        color: '#E6EDF5',
        font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '4px 8px',
        borderRadius: 4,
        lineHeight: 1.5,
      }}
    >
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          <span style={{ opacity: 0.7 }}>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
