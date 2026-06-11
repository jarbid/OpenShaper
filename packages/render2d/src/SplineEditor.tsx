import {
  closestPointOnSpline,
  value,
  type BezierBoard,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { type BoardState, type SplineTarget, getTargetSpline } from '@openshaper/store';
import { ContextMenu, type MenuItem } from '@openshaper/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { buildContextMenuItems } from './context-menu-items';
import {
  clear,
  defaultStyle,
  drawControlPoints,
  drawCurvatureComb,
  drawDistribution,
  drawGrid,
  drawMeasureCursor,
  drawVProbe,
  MEASURE_COLORS,
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
import {
  fitToBounds,
  lifeSizeViewport,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './viewport';

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
  /**
   * Insert a cross-section at a board-length position (cursor x), surfaced as an
   * "Add cross-section here" context-menu item. Length-axis panes (outline/rocker) only.
   */
  onAddSectionAt?: (x: number) => void;
  /**
   * Report the hovered board-length x for the cross-pane scrub cursor (length-axis panes
   * only); called with null when the pointer leaves. The owner mirrors it to the other
   * panes (a vertical guide + an interpolated section preview).
   */
  onScrub?: (x: number | null) => void;
  /** Live measurements for the hovered world point, shown as a corner HUD. */
  readout?: (world: Vec2) => { label: string; value: string; color?: string }[];
  /**
   * Draw the cross-section measurement cursor at the hovered point: a crosshair
   * that is solid inside the section profile and dashed outside (legacy "sliding
   * info"). Cross-section pane only — length-axis panes use the scrub guide.
   */
  measureCursor?: boolean;
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
  /**
   * Imperative view command. When `seq` changes the editor executes `kind`:
   * - `'fit'`      — re-home to fit all curves (same as double-clicking empty space).
   * - `'lifeSize'` — zoom to 1:1 CSS-pixel scale (≈ 37.795 px/cm, anchored at canvas centre).
   *
   * Using a sequence counter (rather than a callback ref or a boolean flag) means
   * the same command kind can be fired multiple times without the prop value needing
   * to go back to `undefined` between presses — every increment triggers the effect.
   */
  viewCommand?: { seq: number; kind: 'fit' | 'lifeSize' };
  className?: string;
}

type DragState =
  | { mode: 'edit'; target: SplineTarget; hit: Hit }
  // Middle-button / Space+left pan.
  | { mode: 'pan'; lastX: number; lastY: number }
  // Right button: a tap opens the context menu, a drag pans (tracked via `moved`).
  | {
      mode: 'rightpan';
      lastX: number;
      lastY: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | null;

/** Max pointer travel (px) for a right-button press+release to count as a tap, not a pan. */
const TAP_SLOP = 4;

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
  onAddSectionAt,
  onScrub,
  readout,
  measureCursor = false,
  overlays,
  ghostSplines,
  background,
  viewCommand,
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
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);
  const key = JSON.stringify(targets);

  // Space-bar pan (CAD standard): holding Space turns any left-drag into a pan,
  // shown by a grab cursor. Ignore key events while typing in a form field, and
  // only swallow the default (page scroll) when not typing.
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
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
    if (overlays?.grid) drawGrid(ctx, vp, size.w, size.h);
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
    // Sliding-location probes: a closed board outline for the pane lets the cursor /
    // scrub line be drawn solid where it's inside the board and dashed outside.
    //  - mirrorX (cross-section) / mirrorY (outline): half-spline + its mirror.
    //  - otherwise (rocker): deck + reversed bottom form the side profile.
    const wantProbe = (measureCursor && hover) || overlays?.scrubProbe != null;
    if (wantProbe) {
      let profile: Vec2[] | null = null;
      if ((mirrorX || mirrorY) && targets[0]) {
        const pts = sampleSpline(getTargetSpline(board, targets[0]));
        if (pts.length > 1) {
          const m = mirrorX
            ? (p: Vec2) => ({ x: -p.x, y: p.y })
            : (p: Vec2) => ({ x: p.x, y: -p.y });
          profile = [...pts, ...pts.map(m).reverse()];
        }
      } else if (targets[0] && targets[1]) {
        const top = sampleSpline(getTargetSpline(board, targets[0]));
        const bot = sampleSpline(getTargetSpline(board, targets[1]));
        if (top.length > 1 && bot.length > 1) profile = [...top, ...[...bot].reverse()];
      }
      if (profile) {
        if (measureCursor && hover) drawMeasureCursor(ctx, profile, vp, size.w, size.h, hover);
        if (overlays?.scrubProbe != null)
          drawVProbe(ctx, profile, vp, size.h, overlays.scrubProbe, MEASURE_COLORS.fromCl);
      }
    }
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
    measureCursor,
    hover,
  ]);

  const localPoint = (e: React.MouseEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Re-home the view to fit the curves (shared by double-click and the context menu).
  const fitView = useCallback(() => {
    if (!board || size.w === 0) return;
    const all = targets.flatMap((t) => sampleSpline(getTargetSpline(board, t)));
    if (all.length === 0) return;
    let pts = all;
    if (mirrorY) pts = pts.flatMap((p) => [p, { x: p.x, y: -p.y }]);
    if (mirrorX) pts = pts.flatMap((p) => [p, { x: -p.x, y: p.y }]);
    setVp(fitToBounds(boundsOf(pts), size.w, size.h));
  }, [board, targets, mirrorX, mirrorY, size.w, size.h]);

  // Respond to imperative view commands (fit / lifeSize) driven by the seq counter.
  // The effect only fires when seq changes — the same kind can be issued multiple
  // times without requiring a round-trip to undefined between presses.
  useEffect(() => {
    if (!viewCommand || size.w === 0) return;
    if (viewCommand.kind === 'fit') {
      fitView();
    } else if (viewCommand.kind === 'lifeSize') {
      // Zoom to 1:1 CSS-pixel scale, anchored at the canvas centre.
      // CSS_PX_PER_CM ≈ 37.795 px/cm (96 px/in ÷ 2.54 cm/in).
      setVp((cur) => (cur ? lifeSizeViewport(cur, size.w, size.h) : cur));
    }
    // Deliberately omit `fitView` from the dep array: we only want this to trigger
    // when `viewCommand.seq` changes — not on every board edit that recreates fitView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewCommand?.seq]);

  // Nearest control-point handle under a screen point, across all target splines.
  const hitAny = useCallback(
    (p: { x: number; y: number }): { target: SplineTarget; hit: Hit } | null => {
      if (!vp || !board) return null;
      for (const t of targets) {
        const hit = hitTest(getTargetSpline(board, t), vp, p);
        if (hit) return { target: t, hit };
      }
      return null;
    },
    [vp, board, targets],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!vp || !board) return;
      setMenu(null);
      const p = localPoint(e);
      // Right button => pan-or-menu. A drag pans; a tap (no drag) opens the context menu
      // on pointer-up. `preventDefault` here plus the canvas-level `contextmenu` blocker
      // stops the browser claiming the gesture (which otherwise fires `pointercancel` and
      // kills the drag, so right-drag never pans).
      if (e.button === 2) {
        e.preventDefault();
        canvasRef.current!.setPointerCapture(e.pointerId);
        drag.current = {
          mode: 'rightpan',
          lastX: p.x,
          lastY: p.y,
          startX: p.x,
          startY: p.y,
          moved: false,
        };
        return;
      }
      canvasRef.current!.setPointerCapture(e.pointerId);
      // Middle-button or Space+left => pan. preventDefault stops middle-click autoscroll.
      if (e.button === 1 || spaceHeld.current) {
        e.preventDefault();
        drag.current = { mode: 'pan', lastX: p.x, lastY: p.y };
        setCursor('grabbing');
        return;
      }
      // Left button is select/edit only — never pans.
      const picked = hitAny(p);
      if (picked) {
        store.getState().select({ target: picked.target, index: picked.hit.index });
        store.getState().beginEdit();
        drag.current = { mode: 'edit', target: picked.target, hit: picked.hit };
        return;
      }
      // Clicking a section marker (outline view) picks that section.
      if (sectionMarkers && onPickSection) {
        const marker = hitSectionMarker(sectionMarkers, vp, p.x);
        if (marker !== null) {
          onPickSection(marker);
          return;
        }
      }
      // Empty space: just deselect.
      store.getState().select(null);
    },
    [vp, board, store, hitAny, sectionMarkers, onPickSection],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!vp) return;
      const p = localPoint(e);
      if (!d) {
        // No drag: report the hovered world point for the readout HUD + cross-pane scrub.
        const w = screenToWorld(vp, p);
        if (readout) setHover(w);
        onScrub?.(w.x);
        return;
      }
      if (d.mode === 'pan') {
        // Compute the delta from the ref BEFORE mutating it, and pass primitives into the
        // setVp updater. React may defer the updater past these lines, so it must not read
        // d.lastX/lastY (which we're about to overwrite) — otherwise the delta is always 0.
        const dx = p.x - d.lastX;
        const dy = p.y - d.lastY;
        d.lastX = p.x;
        d.lastY = p.y;
        setVp((cur) => (cur ? pan(cur, dx, dy) : cur));
        return;
      }
      if (d.mode === 'rightpan') {
        // Past a small threshold the right-button gesture becomes a pan (not a menu tap).
        if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > TAP_SLOP) {
          d.moved = true;
          setCursor('grabbing');
        }
        if (d.moved) {
          const dx = p.x - d.lastX;
          const dy = p.y - d.lastY;
          d.lastX = p.x;
          d.lastY = p.y;
          setVp((cur) => (cur ? pan(cur, dx, dy) : cur));
        }
        return;
      }
      const world = screenToWorld(vp, p);
      if (d.hit.kind === 'end') store.getState().moveControlPoint(d.target, d.hit.index, world);
      else store.getState().moveTangent(d.target, d.hit.index, d.hit.kind, world);
    },
    [vp, store, readout, onScrub],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (d?.mode === 'edit') store.getState().endEdit();
      // A right-button tap (no pan) opens the context menu at the cursor.
      if (d?.mode === 'rightpan' && !d.moved && vp && board) {
        const p = localPoint(e);
        const picked = hitAny(p);
        if (picked) store.getState().select({ target: picked.target, index: picked.hit.index });
        const items = buildContextMenuItems({
          board,
          targets,
          vp,
          screen: p,
          mirrorX,
          mirrorY,
          store,
          onFitView: fitView,
          onAddSectionAt,
        });
        setMenu({ x: e.clientX, y: e.clientY, items });
      }
      drag.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      setCursor(spaceHeld.current ? 'grab' : 'crosshair');
    },
    [store, vp, board, targets, mirrorX, mirrorY, hitAny, fitView, onAddSectionAt],
  );

  // A cancelled pointer (browser claimed the gesture, palm-rejection, etc.) ends any drag
  // cleanly without firing a context menu, so state never gets stuck mid-pan.
  const onPointerCancel = useCallback(() => {
    if (drag.current?.mode === 'edit') store.getState().endEdit();
    drag.current = null;
    setCursor(spaceHeld.current ? 'grab' : 'crosshair');
  }, [store]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!vp) return;
      setMenu(null);
      const p = localPoint(e);
      setVp(zoomAt(vp, p, e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    [vp],
  );

  // Suppress the browser's native context menu on the canvas (ours opens from the
  // right-tap). A native non-passive listener is more reliable than React's onContextMenu:
  // it guarantees the default is cancelled so the right-button gesture stays ours and a
  // right-drag pans instead of the browser cancelling it for its own menu.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const block = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', block);
    return () => canvas.removeEventListener('contextmenu', block);
  }, []);

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
      fitView();
    },
    [vp, board, store, targets, mirrorX, mirrorY, fitView],
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
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          setHover(null);
          onScrub?.(null);
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      {readout && hover && <ReadoutHud rows={readout(hover)} />}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** Small corner HUD showing live measurements at the hovered point. */
function ReadoutHud({ rows }: { rows: { label: string; value: string; color?: string }[] }) {
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
          <span style={{ opacity: 0.7, color: r.color }}>{r.label}</span>
          <span style={{ color: r.color }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
