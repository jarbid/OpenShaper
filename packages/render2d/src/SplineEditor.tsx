import {
  closestPointOnSpline,
  value,
  type BezierBoard,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { type BoardState, type SplineTarget, getTargetSpline, sameTarget } from '@openshaper/store';
import { ContextMenu, type MenuItem } from '@openshaper/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  drawFinsPlan,
  drawFinsProfile,
  hitFin,
  drawGhostSpline,
  drawSectionMarkers,
  drawSpline,
  drawVerticalMarkers,
  hitSectionMarker,
  type DrawStyle,
  type EditorOverlays,
  type SectionHandle,
  type SectionMarker,
} from './draw';
import { handlePoint, hitTest, type Hit } from './hit';
import { boundsOf, sampleSpline } from './sample';
import {
  fitToBounds,
  lifeSizeViewport,
  pan,
  reframeForSize,
  paneToTurnedCanvas,
  screenToWorld,
  turnFitsLarger,
  viewportCenter,
  viewportFromCenter,
  worldToScreen,
  zoomAt,
  type ScreenPoint,
  type ViewCenter,
  type Viewport,
} from './viewport';
import {
  imageCenterWorld,
  imgToWorld,
  setRotationAboutCenter,
  traceCanvasMatrix,
  worldToImg,
  type SimilarityParams,
} from './trace-transform';

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
  /** Section marker with explicit interaction focus, or null. */
  focusedSection?: number | null;
  /** Focus or blur a section marker. */
  onFocusSection?: (index: number | null) => void;
  /** Move a focused section marker along the board length axis. */
  onMoveSection?: (index: number, position: number) => void;
  /** Called when a section marker's context menu requests deletion. */
  onDeleteSection?: (index: number) => void;
  /**
   * Formats a board-length position for the chip shown beside a station while it
   * is dragged. Omit to drag without a readout.
   */
  formatSectionPosition?: (cm: number) => string;
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
  /**
   * Reference image drawn behind the curves for tracing. Placed by a similarity
   * transform (translate + uniform scale + rotation + mirror) mapping image-pixel
   * space to world cm; see `trace-transform.ts`.
   */
  background?: {
    image: CanvasImageSource;
    opacity: number;
    naturalWidth: number;
    naturalHeight: number;
    transform: SimilarityParams;
  };
  /**
   * When true, the trace image is directly manipulable: drag its body to move,
   * grab the handle above it to rotate. Commits fire on pointer-up via
   * `onTraceTransform`. Ignored when there is no `background`.
   */
  traceInteractive?: boolean;
  /** Commit a new trace transform (drag/rotate end). */
  onTraceTransform?: (t: SimilarityParams) => void;
  /**
   * Active calibration flow (controlled by the owner). While set, canvas clicks
   * are captured as calibration points instead of editing splines.
   */
  calibration?: Calibration;
  /** Report a calibration click: image-pixel point for image steps, world cm for drawing steps. */
  onCalibrationClick?: (pt: Vec2) => void;
  /**
   * Color for ghost/reference splines. Defaults to the draw module's built-in
   * semi-transparent silver when omitted.
   */
  ghostColor?: string;
  /**
   * Color for the grid minor lines and axes. Defaults to the draw module's
   * built-in muted-blue-grey when omitted.
   */
  gridColor?: string;
  /**
   * Control-point dot/square radius in px. Defaults to 5 when omitted.
   */
  controlPointSize?: number;
  /**
   * Curve stroke width in px. Defaults to the `defaultStyle.curveWidth` (2) when omitted.
   */
  curveThickness?: number;
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
  /**
   * Restored framing (world center + zoom) applied instead of the first
   * auto-fit, so a reloaded session reopens looking at the same spot. Later
   * refits (target-set change, container resize) behave as usual.
   */
  initialView?: ViewCenter;
  /**
   * Report the current framing whenever it changes (zoom, pan, fit, resize),
   * for persistence by the owner. Called with world center + zoom.
   */
  onViewChange?: (v: ViewCenter) => void;
  /**
   * Allow drawing the board turned nose-up when that fits it larger.
   *
   * Only the owner knows whether this view is length-wise (outline and rocker are;
   * a cross-section is not) and whether the pointer is a fingertip. Whether the
   * turn actually *helps* is decided here, per pane, by {@link turnFitsLarger} —
   * so passing this can never shrink anything.
   */
  allowTurn?: boolean;
  className?: string;
}

type DragState =
  // `grab` is the vector from the pointer to the thing it grabbed, held for the
  // life of the drag so the thing tracks the pointer's *movement* instead of
  // teleporting to sit under it. See GRAB_OFFSET below.
  //
  // Point and fin drags open their undo step on the first real move (`started`), so a
  // click that only selects leaves history — and the redo stack — alone.
  | {
      mode: 'edit';
      target: SplineTarget;
      hit: Hit;
      grab: Vec2;
      downAt: ScreenPoint;
      started: boolean;
    }
  | { mode: 'section'; index: number; started: boolean; handle: SectionHandle; grab: number }
  // Dragging a fin to re-place it (plan pane).
  | { mode: 'fin'; index: number; grab: Vec2; downAt: ScreenPoint; started: boolean }
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
  // Dragging the trace image body to reposition it.
  | { mode: 'traceMove'; startWorld: Vec2; start: SimilarityParams }
  // Dragging the rotate handle above the trace image.
  | {
      mode: 'traceRotate';
      center: Vec2;
      startAngle: number;
      start: SimilarityParams;
      w: number;
      h: number;
    }
  | null;

/** Whether a drag holds the store's grouped edit open (a section drag only once it moved). */
const holdsEdit = (d: DragState): boolean =>
  (d?.mode === 'edit' || d?.mode === 'fin' || d?.mode === 'section') && d.started;

/**
 * A calibration flow in progress. `align` collects two image points then two
 * matching drawing points; `length` collects two image points then the owner
 * prompts for a real distance. `step` is the count of points already captured.
 */
export type Calibration =
  | { tool: 'align'; step: 0 | 1 | 2 | 3; imgPts: Vec2[]; worldPts: Vec2[] }
  | { tool: 'length'; step: 0 | 1; imgPts: Vec2[] }
  | null;

/** Rotate-handle offset above the image top edge, in screen px. */
const TRACE_HANDLE_OFFSET = 28;
/** Rotate-handle hit radius, in screen px. */
const TRACE_HANDLE_R = 9;

/**
 * Hit radius for a control-point handle, in CSS px. A fingertip is both blunter
 * and less precisely reported than a mouse cursor, so touch gets a target it can
 * actually land on. This is safe to widen only because a drag preserves the grab
 * offset (see GRAB_OFFSET): grabbing a handle from 14px away moves it by what the
 * finger moves, it does not yank it 14px sideways first.
 */
const HIT_TOL_PX = 8;
const TOUCH_HIT_TOL_PX = 14;

/**
 * Travel (px) past which a press is a drag rather than a tap.
 *
 * Two different questions share this number and they want different answers, so it
 * is only the mouse one: did a right-button press become a pan?
 */
const TAP_SLOP = 4;

/**
 * Travel (px) past which a *finger* resting on empty canvas counts as having moved.
 *
 * Larger than {@link TAP_SLOP} because a fingertip's contact centroid wanders a few
 * pixels while the hand believes it is holding still, so a mouse-sized budget makes a
 * deliberate long-press on blank canvas fail at random. Generous is safe here —
 * nothing is at stake on empty canvas, and the only cost of waiting is the menu
 * opening a moment later.
 */
const TOUCH_STILL_SLOP = 10;

/** Hold time (ms) for a single-finger touch to open the context menu (right-click stand-in). */
const LONG_PRESS_MS = 500;

const PALETTE = ['#22D3EE', '#38BDF8', '#2DD4BF', '#A78BFA'];

const useBoard = (store: StoreApi<BoardState>): BezierBoard | null =>
  useSyncExternalStore(store.subscribe, () => store.getState().board);

/** Distance from a world point to the nearest point on a spline. */
const splineDistance = (s: Spline, p: Vec2): number => {
  const hit = closestPointOnSpline(s, p);
  if (!hit) return Infinity;
  const pt = value(s.coeffs[hit.index]!, hit.t);
  return Math.hypot(pt.x - p.x, pt.y - p.y);
};

interface TraceBackground {
  image: CanvasImageSource;
  opacity: number;
  naturalWidth: number;
  naturalHeight: number;
  transform: SimilarityParams;
}

/** Screen-space geometry of the trace image: its four corners, centre, and rotate handle. */
const traceScreenGeom = (vp: Viewport, bg: TraceBackground) => {
  const { naturalWidth: w, naturalHeight: h, transform } = bg;
  const toScreen = (u: number, v: number) =>
    worldToScreen(vp, imgToWorld(transform, { x: u, y: v }));
  const corners = [toScreen(0, 0), toScreen(w, 0), toScreen(w, h), toScreen(0, h)];
  const center = worldToScreen(vp, imageCenterWorld(transform, w, h));
  const topMid = toScreen(w / 2, 0);
  // Push the handle out past the top edge, along the (center → top-mid) direction.
  const dx = topMid.x - center.x;
  const dy = topMid.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const handle = {
    x: topMid.x + (dx / len) * TRACE_HANDLE_OFFSET,
    y: topMid.y + (dy / len) * TRACE_HANDLE_OFFSET,
  };
  return { corners, center, topMid, handle };
};

/** Outline the trace image and draw its rotate handle (interactive mode). */
const drawTraceHandles = (
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  bg: TraceBackground,
): void => {
  const { corners, topMid, handle } = traceScreenGeom(vp, bg);
  ctx.save();
  ctx.strokeStyle = '#22D3EE';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(corners[0]!.x, corners[0]!.y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
  ctx.closePath();
  ctx.stroke();
  // stem + knob for the rotate handle
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(topMid.x, topMid.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.stroke();
  ctx.fillStyle = '#22D3EE';
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, TRACE_HANDLE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

/**
 * Draw captured calibration points and the rubber-band lines between a pair. The
 * instruction text is rendered as a DOM overlay (see `CalibrationHud`), not on the
 * canvas, so it can sit above the readout HUD instead of being clipped by it.
 */
const drawCalibrationOverlay = (
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  cal: NonNullable<Calibration>,
  bg: TraceBackground | undefined,
): void => {
  const pts: { x: number; y: number }[] = [];
  // Image points map through the current transform; drawing points are already world.
  if (bg) for (const p of cal.imgPts) pts.push(worldToScreen(vp, imgToWorld(bg.transform, p)));
  if (cal.tool === 'align') for (const q of cal.worldPts) pts.push(worldToScreen(vp, q));

  ctx.save();
  ctx.strokeStyle = '#F59E0B';
  ctx.fillStyle = '#F59E0B';
  ctx.lineWidth = 1.5;
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(String(i + 1), p.x + 7, p.y - 7);
    ctx.fillStyle = '#F59E0B';
  });
  ctx.setLineDash([4, 3]);
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  if (pts.length >= 2) line(pts[0]!, pts[1]!); // image pair
  if (cal.tool === 'align' && pts.length >= 4) line(pts[2]!, pts[3]!); // drawing pair
  ctx.restore();
};

/** Instruction text for the current calibration step. */
const calibrationHint = (cal: NonNullable<Calibration>): string => {
  if (cal.tool === 'length') {
    return cal.step === 0
      ? 'Click the first point on the image'
      : 'Click the second point on the image';
  }
  switch (cal.step) {
    case 0:
      return 'Align: click the first reference point on the image (e.g. tail tip)';
    case 1:
      return 'Align: click the second reference point on the image (e.g. nose tip)';
    case 2:
      return 'Align: click the matching first point on the drawing';
    default:
      return 'Align: click the matching second point on the drawing';
  }
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
  focusedSection,
  onFocusSection,
  onMoveSection,
  onDeleteSection,
  formatSectionPosition,
  onAddSectionAt,
  onScrub,
  readout,
  measureCursor = false,
  overlays,
  ghostSplines,
  background,
  traceInteractive = false,
  onTraceTransform,
  calibration,
  onCalibrationClick,
  ghostColor,
  gridColor,
  controlPointSize,
  curveThickness,
  viewCommand,
  initialView,
  onViewChange,
  allowTurn = false,
  className,
}: SplineEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const board = useBoard(store);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);
  const [hoveredControl, setHoveredControl] = useState<{
    target: SplineTarget;
    hit: Hit;
  } | null>(null);
  const [hoveredSection, setHoveredSection] = useState<number | null>(null);
  // Which marker is mid-drag and which of its grips was grabbed, so the position
  // chip renders beside the handle under the cursor and clears with the drag.
  const [draggingSection, setDraggingSection] = useState<{
    index: number;
    handle: SectionHandle;
  } | null>(null);
  // Live trace transform while dragging/rotating the image; committed on pointer-up.
  const [liveTrace, setLiveTrace] = useState<SimilarityParams | null>(null);
  const drag = useRef<DragState>(null);
  // A drag holds the store's grouped edit open (beginEdit … endEdit). If this editor
  // unmounts mid-drag — a view switch, a station change remounting the section pane —
  // no pointerup will ever reach it, so close the edit here. Otherwise the store stays
  // `editing`: later edits merge into the dead drag's undo step and the settled specs
  // stop updating.
  useEffect(
    () => () => {
      if (holdsEdit(drag.current)) store.getState().endEdit();
    },
    [store],
  );
  const spaceHeld = useRef(false);
  // Active touch points (by pointerId) for multi-touch gestures, plus the last
  // pinch centroid/spread and a long-press timer (touch's stand-in for right-click).
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const longPress = useRef<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const [cursor, setCursor] = useState<'crosshair' | 'pointer' | 'grab' | 'grabbing' | 'ew-resize'>(
    'crosshair',
  );
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);
  const selectedFin = useSyncExternalStore(store.subscribe, () => store.getState().selectedFin);
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
    const ro = new ResizeObserver(() => setPane({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setPane({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /**
   * The world extent being drawn, mirrors included.
   *
   * Three things need it — the auto-fit, the "fit view" command, and the turn
   * decision — and the first two used to sample and mirror the splines separately
   * with identical code.
   */
  const bounds = useMemo(() => {
    if (!board) return null;
    const all = targets.flatMap((t) => sampleSpline(getTargetSpline(board, t)));
    if (all.length === 0) return null;
    let pts = all;
    if (mirrorY) pts = pts.flatMap((p) => [p, { x: p.x, y: -p.y }]);
    if (mirrorX) pts = pts.flatMap((p) => [p, { x: -p.x, y: p.y }]);
    return boundsOf(pts);
  }, [board, targets, mirrorX, mirrorY]);

  /**
   * TURNED: draw the board nose-up, by rotating the canvas ELEMENT rather than the
   * transform inside it.
   *
   * The canvas keeps an ordinary, unrotated coordinate system — it simply believes
   * it is a landscape canvas of the swapped size. So every screen-space consumer
   * (`draw.ts`, `hit.ts`, `trace-transform.ts`, `pan`, `zoomAt`, `fitToBounds`) is
   * untouched and keeps working in exactly the space it always did. Only two things
   * know about the rotation: the CSS transform on the element, and `localPoint`,
   * which maps a page coordinate back into that space.
   *
   * `size` is what the rest of the component sees, so swapping it here is what puts
   * everything downstream into the turned space.
   */
  const turned = allowTurn && pane.w > 0 && !!bounds && turnFitsLarger(bounds, pane.w, pane.h);
  const size = turned ? { w: pane.h, h: pane.w } : pane;

  // Re-fit when the target set changes, or we first get a board + a size.
  // A restored framing (initialView) replaces only the first fit of the mount;
  // every later refit trigger behaves as before.
  //
  // A *resize* is deliberately not a refit trigger. Re-fitting on resize threw
  // away the user's pan/zoom, and worse, it moved the screen<->world mapping out
  // from under a gesture already in flight: grabbing a control point selects it,
  // which on a narrow pane wraps the pane header onto a second row, which shrinks
  // the canvas, which re-fitted — so the held point teleported and every
  // subsequent move wrote the wrong position. That made control points unusable
  // on phones. A resize now carries the framing over instead, and while a gesture
  // is in flight the viewport is left untouched entirely so the grabbed handle
  // stays pinned under the pointer.
  const initialViewApplied = useRef(false);
  // The canvas size and target set the current framing was computed for, so a
  // resize can be told apart from a retarget. `framedSize` only advances when a
  // new framing is actually applied — a resize frozen mid-gesture leaves it on the
  // last applied one so a later carry-over still starts from the right centre.
  const framedSize = useRef({ w: 0, h: 0 });
  const framedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!board || size.w === 0) return;
    const prev = framedSize.current;
    const resized = prev.w !== 0 && (prev.w !== size.w || prev.h !== size.h);
    const retargeted = framedKey.current !== key;
    framedKey.current = key;

    if (!initialViewApplied.current) {
      initialViewApplied.current = true;
      if (initialView) {
        framedSize.current = { w: size.w, h: size.h };
        setVp(viewportFromCenter(initialView, size.w, size.h));
        return;
      }
    }

    if (resized && !retargeted) {
      // A gesture in flight keeps the mapping frozen outright; carrying the centre
      // over would still shift it by half the size delta.
      if (drag.current || pinch.current) return;
      framedSize.current = { w: size.w, h: size.h };
      setVp((cur) => (cur ? reframeForSize(cur, prev.w, prev.h, size.w, size.h) : cur));
      return;
    }

    if (!bounds) return;
    framedSize.current = { w: size.w, h: size.h };
    setVp(fitToBounds(bounds, size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, board === null, size.w, size.h]);

  // Report the current framing (world center + zoom) for persistence. The
  // callback lives in a ref so a new identity per owner render doesn't refire.
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    if (!vp || size.w === 0) return;
    onViewChangeRef.current?.(viewportCenter(vp, size.w, size.h));
  }, [vp, size.w, size.h]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vp || !board || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    // Assigning width/height reallocates the backing store (MBs at high DPR) as well
    // as clearing it and resetting the context state. Only a size change needs the
    // reallocation; otherwise reset() does exactly the rest. Where reset() is missing,
    // reassigning is what this always did.
    if (
      !ctx?.reset ||
      canvas.width !== Math.trunc(size.w * dpr) ||
      canvas.height !== Math.trunc(size.h * dpr)
    ) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    } else {
      ctx.reset();
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clear(ctx, size.w, size.h);
    if (overlays?.grid) drawGrid(ctx, vp, size.w, size.h, gridColor);
    const effBg = background
      ? { ...background, transform: liveTrace ?? background.transform }
      : undefined;
    if (effBg) {
      const { image, opacity, transform } = effBg;
      const m = traceCanvasMatrix(vp, transform, dpr);
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage(image, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // restore base transform
      ctx.restore();
      if (traceInteractive) drawTraceHandles(ctx, vp, effBg);
    }
    if (calibration) drawCalibrationOverlay(ctx, vp, calibration, effBg);
    if (sectionMarkers && sectionMarkers.length > 0) {
      const dragged = draggingSection
        ? sectionMarkers.find((m) => m.index === draggingSection.index)
        : undefined;
      drawSectionMarkers(
        ctx,
        sectionMarkers,
        vp,
        size.h,
        hoveredSection,
        focusedSection,
        dragged && draggingSection && formatSectionPosition
          ? {
              index: dragged.index,
              handle: draggingSection.handle,
              text: formatSectionPosition(dragged.pos),
            }
          : null,
        turned,
      );
    }
    if (overlays?.distribution) drawDistribution(ctx, overlays.distribution, vp, size.h);
    if (overlays?.verticalMarkers)
      drawVerticalMarkers(ctx, overlays.verticalMarkers, vp, size.h, turned);
    if (overlays?.fins && overlays.fins.length > 0) {
      if (overlays.finView === 'profile') drawFinsProfile(ctx, overlays.fins, vp, selectedFin);
      else drawFinsPlan(ctx, overlays.fins, vp, selectedFin);
    }
    if (ghostSplines) {
      for (const g of ghostSplines) drawGhostSpline(ctx, g, vp, { mirrorX, mirrorY }, ghostColor);
    }
    const palette = colors ?? PALETTE;
    targets.forEach((t, i) => {
      const spline = getTargetSpline(board, t);
      const style: DrawStyle = {
        ...defaultStyle,
        curve: palette[i % palette.length]!,
        ...(curveThickness != null ? { curveWidth: curveThickness } : {}),
        ...(controlPointSize != null
          ? { point: defaultStyle.point, pointSelected: defaultStyle.pointSelected }
          : {}),
      };
      drawSpline(ctx, spline, vp, style, { mirrorX, mirrorY });
      if (overlays?.curvatureComb) drawCurvatureComb(ctx, spline, vp);
      const sel = selection && sameTarget(selection.target, t) ? selection.index : null;
      const hovered =
        hoveredControl && sameTarget(hoveredControl.target, t) ? hoveredControl.hit : null;
      drawControlPoints(
        ctx,
        spline,
        vp,
        style,
        sel,
        controlPointSize,
        selection?.kind ?? 'end',
        hovered,
      );
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
    hoveredControl,
    selectedFin,
    key,
    mirrorX,
    mirrorY,
    colors,
    targets,
    sectionMarkers,
    hoveredSection,
    focusedSection,
    draggingSection,
    formatSectionPosition,
    overlays,
    ghostSplines,
    background,
    liveTrace,
    traceInteractive,
    calibration,
    measureCursor,
    hover,
    ghostColor,
    gridColor,
    controlPointSize,
    curveThickness,
  ]);

  // Canvas-local coordinates. While a gesture is in flight the canvas's page
  // position is pinned to what it was when the gesture started: selecting a point
  // can change the layout around the canvas (a pane header growing a row pushes it
  // down without necessarily resizing it), and a rect that moved mid-drag would
  // silently re-map the pointer and teleport whatever it was holding.
  const gestureRect = useRef<{ left: number; top: number } | null>(null);
  const localPoint = (e: React.MouseEvent): { x: number; y: number } => {
    const pinned = (drag.current || pinch.current) && gestureRect.current;
    const r = pinned ?? canvasRef.current!.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    // TURNED: the element is rotated -90° about its own top-left and slid down by
    // its width, so canvas-local (lx, ly) sits at pane (ly, size.w - lx). This is
    // that, inverted. `getBoundingClientRect` on a rotated element returns the
    // axis-aligned box, which for an exact quarter turn is the pane box — so
    // `dx`/`dy` are already pane-relative and only the axes have to be undone.
    //
    // The single place a mistake here shows up is "the point does not follow my
    // finger", which is the bug this whole branch started with, so it is pinned by
    // a round-trip test rather than trusted.
    return turned ? paneToTurnedCanvas({ x: dx, y: dy }, size.w) : { x: dx, y: dy };
  };

  // Re-home the view to fit the curves (shared by double-click and the context menu).
  const fitView = useCallback(() => {
    if (!bounds || size.w === 0) return;
    setVp(fitToBounds(bounds, size.w, size.h));
  }, [bounds, size.w, size.h]);

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
    (
      p: { x: number; y: number },
      tolPx = HIT_TOL_PX,
    ): { target: SplineTarget; hit: Hit } | null => {
      if (!vp || !board) return null;
      for (const t of targets) {
        const preferred =
          selection && sameTarget(selection.target, t)
            ? { index: selection.index, kind: selection.kind ?? ('end' as const) }
            : undefined;
        const hit = hitTest(getTargetSpline(board, t), vp, p, tolPx, preferred);
        if (hit) return { target: t, hit };
      }
      return null;
    },
    [vp, board, targets, selection],
  );

  const sectionMarkerAt = useCallback(
    (p: { x: number; y: number }) =>
      vp && sectionMarkers ? hitSectionMarker(sectionMarkers, vp, p, size.h) : null,
    [vp, sectionMarkers, size.h],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPress.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!vp || !board) return;
      setMenu(null);
      const p = localPoint(e);
      const touch = e.pointerType === 'touch';
      // Pin the mapping for whatever gesture this press starts.
      gestureRect.current = canvasRef.current!.getBoundingClientRect();

      // Trace calibration takes precedence over all editing: a click captures a point.
      // Steps that pick points ON THE IMAGE report image-pixel coords; steps that pick
      // points ON THE DRAWING report world cm.
      if (calibration && onCalibrationClick && e.button === 0) {
        const world = screenToWorld(vp, p);
        const onImage = calibration.tool === 'length' || calibration.step <= 1;
        if (onImage) {
          if (!background) return;
          onCalibrationClick(worldToImg(background.transform, world));
        } else {
          onCalibrationClick(world);
        }
        return;
      }

      // Touch: track the pointer and route multi-touch / long-press gestures. A single
      // finger then falls through to the normal left-button select/edit path below.
      if (touch) {
        pointers.current.set(e.pointerId, p);
        if (pointers.current.size === 2) {
          // Second finger: abandon any in-progress one-finger edit and start a pinch.
          cancelLongPress();
          if (holdsEdit(drag.current)) store.getState().endEdit();
          setDraggingSection(null);
          drag.current = null;
          const pts = [...pointers.current.values()];
          const a = pts[0]!;
          const b = pts[1]!;
          pinch.current = {
            dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
          };
          canvasRef.current!.setPointerCapture(e.pointerId);
          return;
        }
        if (pointers.current.size > 2) return;
        // First finger: arm a long-press that opens the context menu if held in place.
        cancelLongPress();
        longPress.current = { x: p.x, y: p.y };
        const clientX = e.clientX;
        const clientY = e.clientY;
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null;
          if (pointers.current.size !== 1 || !vp || !board) return;
          if (holdsEdit(drag.current)) store.getState().endEdit();
          setDraggingSection(null);
          drag.current = null;
          const marker = sectionMarkerAt(p);
          if (marker) onPickSection?.(marker.index);
          // The touch radius, not the mouse one: this path is only ever reached by a
          // finger, and picking a point up to drag it used to have a target nearly
          // twice the size of long-pressing the same point for its menu.
          const picked = marker ? null : hitAny(p, TOUCH_HIT_TOL_PX);
          if (picked)
            store
              .getState()
              .select({ target: picked.target, index: picked.hit.index, kind: picked.hit.kind });
          const items = buildContextMenuItems({
            board,
            targets,
            vp,
            screen: p,
            tolPx: TOUCH_HIT_TOL_PX,
            mirrorX,
            mirrorY,
            store,
            onFitView: fitView,
            onAddSectionAt,
            sectionMarker: marker ?? undefined,
            onDeleteSection,
          });
          setMenu({ x: clientX, y: clientY, items });
        }, LONG_PRESS_MS);
      }
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
      const marker = sectionMarkerAt(p);
      if (marker && onPickSection) {
        if (focusedSection === marker.index && onMoveSection) {
          drag.current = {
            mode: 'section',
            index: marker.index,
            started: false,
            handle: p.y < size.h / 2 ? 'top' : 'bottom',
            grab: marker.pos - screenToWorld(vp, p).x,
          };
          setCursor('ew-resize');
          return;
        }
        onFocusSection?.(marker.index);
        onPickSection(marker.index);
        return;
      }
      onFocusSection?.(null);
      const picked = hitAny(p, touch ? TOUCH_HIT_TOL_PX : HIT_TOL_PX);
      if (picked) {
        store
          .getState()
          .select({ target: picked.target, index: picked.hit.index, kind: picked.hit.kind });
        // GRAB_OFFSET: remember where the handle sits relative to the pointer, and
        // move it by the pointer's delta for the rest of the drag. Assigning the
        // pointer's own position instead snapped the handle under the cursor on the
        // first move — up to the hit radius in one frame, which is most of a phone's
        // board width. That snap is what made mobile edits jump.
        const handle = handlePoint(
          getTargetSpline(board, picked.target).knots[picked.hit.index]!,
          picked.hit.kind,
        );
        const at = screenToWorld(vp, p);
        drag.current = {
          mode: 'edit',
          target: picked.target,
          hit: picked.hit,
          grab: { x: handle.x - at.x, y: handle.y - at.y },
          downAt: p,
          started: false,
        };
        return;
      }
      // Interactive trace image (after control points so curve edits still win): grab the
      // rotate handle above the image, or drag its body to reposition it.
      if (traceInteractive && background && e.button === 0 && !spaceHeld.current) {
        const { naturalWidth: iw, naturalHeight: ih, transform } = background;
        const geom = traceScreenGeom(vp, background);
        if (Math.hypot(p.x - geom.handle.x, p.y - geom.handle.y) <= TRACE_HANDLE_R + 4) {
          const center = imageCenterWorld(transform, iw, ih);
          const w = screenToWorld(vp, p);
          drag.current = {
            mode: 'traceRotate',
            center,
            startAngle: Math.atan2(w.y - center.y, w.x - center.x),
            start: transform,
            w: iw,
            h: ih,
          };
          return;
        }
        const uv = worldToImg(transform, screenToWorld(vp, p));
        if (uv.x >= 0 && uv.x <= iw && uv.y >= 0 && uv.y <= ih) {
          drag.current = { mode: 'traceMove', startWorld: screenToWorld(vp, p), start: transform };
          return;
        }
      }
      // A fin (plan pane) takes the click after control points: select + start dragging.
      if (overlays?.fins && overlays.finView !== 'profile') {
        const finIndex = hitFin(overlays.fins, vp, p, touch ? TOUCH_HIT_TOL_PX : HIT_TOL_PX);
        if (finIndex !== null) {
          store.getState().selectFin(finIndex);
          // `moveFin` reads the point as the fin's base centre, so that midpoint is
          // what the grab offset is measured from (see GRAB_OFFSET).
          const { fore, aft } = overlays.fins[finIndex]!.baseLine;
          const at = screenToWorld(vp, p);
          drag.current = {
            mode: 'fin',
            index: finIndex,
            grab: { x: (fore.x + aft.x) / 2 - at.x, y: (fore.y + aft.y) / 2 - at.y },
            downAt: p,
            started: false,
          };
          return;
        }
      }
      // Empty space: just deselect.
      store.getState().select(null);
    },
    [
      vp,
      board,
      store,
      hitAny,
      onPickSection,
      focusedSection,
      onFocusSection,
      onMoveSection,
      onDeleteSection,
      overlays,
      cancelLongPress,
      targets,
      mirrorX,
      mirrorY,
      fitView,
      onAddSectionAt,
      calibration,
      onCalibrationClick,
      traceInteractive,
      background,
      sectionMarkerAt,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!vp) return;
      const p = localPoint(e);

      // Touch gestures take precedence over the mouse drag modes below.
      if (e.pointerType === 'touch') {
        if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
        // Two fingers: pinch-zoom about the centroid and pan by its movement.
        if (pointers.current.size >= 2 && pinch.current) {
          const pts = [...pointers.current.values()];
          const a = pts[0]!;
          const b = pts[1]!;
          const nd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const ncx = (a.x + b.x) / 2;
          const ncy = (a.y + b.y) / 2;
          const factor = nd / pinch.current.dist;
          const dx = ncx - pinch.current.cx;
          const dy = ncy - pinch.current.cy;
          setVp((cur) => (cur ? pan(zoomAt(cur, { x: ncx, y: ncy }, factor), dx, dy) : cur));
          pinch.current = { dist: nd, cx: ncx, cy: ncy };
          return;
        }
        // One finger that has moved is a drag, not a long-press — but how far it has
        // to move depends entirely on what it is holding.
        //
        // With a live edit underway the answer is "at all". This is the gesture that
        // made fine adjustment impossible on a phone: press a control point, nudge it
        // a couple of pixels, hold for half a second to check the line, and the timer
        // fired — `endEdit()` cut the drag dead and dropped a menu over the board
        // while the finger was still on the point. A mouse-sized 4px budget could not
        // catch it, because at a phone's ~1.5px/cm a deliberate 1cm nudge is under two
        // pixels. Anything the user can see is a drag.
        //
        // With nothing under the finger there is no drag to protect, so the finger's
        // own noise floor is the right threshold instead.
        const dragging =
          drag.current?.mode === 'edit' ||
          drag.current?.mode === 'fin' ||
          drag.current?.mode === 'section';
        if (
          longPress.current &&
          Math.hypot(p.x - longPress.current.x, p.y - longPress.current.y) >
            (dragging ? 0 : TOUCH_STILL_SLOP)
        ) {
          cancelLongPress();
        }
      }

      if (!d) {
        // No drag: report the hovered world point for the readout HUD + cross-pane scrub.
        const w = screenToWorld(vp, p);
        if (readout) setHover(w);
        onScrub?.(w.x);
        const marker = sectionMarkerAt(p);
        setHoveredSection(marker?.index ?? null);
        const picked = marker ? null : hitAny(p);
        setHoveredControl(picked);
        if (!spaceHeld.current)
          setCursor(
            marker && marker.index === focusedSection
              ? 'ew-resize'
              : marker
                ? 'pointer'
                : picked
                  ? 'pointer'
                  : 'crosshair',
          );
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
      if (d.mode === 'section') {
        if (d.started && !store.getState().editing) {
          // Closed under the drag (see the point-drag case below).
          setDraggingSection(null);
          drag.current = null;
          return;
        }
        if (!d.started) {
          store.getState().beginEdit('Move cross-section');
          d.started = true;
          setDraggingSection({ index: d.index, handle: d.handle });
          // The HUD freezes at wherever the pointer last hovered, so it would sit
          // there showing a stale position next to a live one. Drop it for the drag.
          setHover(null);
        }
        onMoveSection?.(d.index, world.x + d.grab);
        return;
      }
      if (d.mode === 'traceMove') {
        setLiveTrace({
          ...d.start,
          tx: d.start.tx + (world.x - d.startWorld.x),
          ty: d.start.ty + (world.y - d.startWorld.y),
        });
        return;
      }
      if (d.mode === 'traceRotate') {
        const ang = Math.atan2(world.y - d.center.y, world.x - d.center.x);
        setLiveTrace(
          setRotationAboutCenter(d.start, d.w, d.h, d.start.rotation + (ang - d.startAngle)),
        );
        return;
      }
      // GRAB_OFFSET: what the pointer moves, the handle moves — it is never assigned
      // the pointer's own position, which would snap it under the cursor.
      const held = { x: world.x + d.grab.x, y: world.y + d.grab.y };
      if (d.started && !store.getState().editing) {
        // The edit was closed under the drag — undo, redo or delete pressed while the
        // point was still held. Drop the drag: carrying on would commit every further
        // move as its own undo step, against a board that may no longer have the knot.
        drag.current = null;
        return;
      }
      if (!d.started) {
        // A move event at the press point (some browsers send one) is not a drag.
        if (p.x === d.downAt.x && p.y === d.downAt.y) return;
        store.getState().beginEdit(d.mode === 'fin' ? 'Move fin' : undefined);
        d.started = true;
      }
      if (d.mode === 'fin') {
        store.getState().moveFin(d.index, held);
        return;
      }
      if (d.hit.kind === 'end') store.getState().moveControlPoint(d.target, d.hit.index, held);
      else store.getState().moveTangent(d.target, d.hit.index, d.hit.kind, held);
    },
    [
      vp,
      store,
      readout,
      onScrub,
      cancelLongPress,
      sectionMarkerAt,
      focusedSection,
      onMoveSection,
      hitAny,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      // Touch: drop the lifted finger; if a pinch was active, end the gesture cleanly
      // (the one-finger edit was already abandoned when the second finger landed).
      if (e.pointerType === 'touch') {
        cancelLongPress();
        pointers.current.delete(e.pointerId);
        if (pinch.current) {
          if (pointers.current.size < 2) pinch.current = null;
          drag.current = null;
          canvasRef.current?.releasePointerCapture(e.pointerId);
          setCursor('crosshair');
          return;
        }
      }
      const d = drag.current;
      // Commit a trace move/rotate: hand the live transform to the owner, then clear it.
      if (d?.mode === 'traceMove' || d?.mode === 'traceRotate') {
        if (liveTrace) onTraceTransform?.(liveTrace);
        setLiveTrace(null);
        drag.current = null;
        canvasRef.current?.releasePointerCapture(e.pointerId);
        return;
      }
      if (holdsEdit(d)) store.getState().endEdit();
      if (d?.mode === 'section') setDraggingSection(null);
      // A right-button tap (no pan) opens the context menu at the cursor.
      if (d?.mode === 'rightpan' && !d.moved && vp && board) {
        const p = localPoint(e);
        const marker = sectionMarkerAt(p);
        if (marker) onPickSection?.(marker.index);
        const picked = marker ? null : hitAny(p);
        if (picked)
          store
            .getState()
            .select({ target: picked.target, index: picked.hit.index, kind: picked.hit.kind });
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
          sectionMarker: marker ?? undefined,
          onDeleteSection,
        });
        setMenu({ x: e.clientX, y: e.clientY, items });
      }
      drag.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      setCursor(spaceHeld.current ? 'grab' : 'crosshair');
    },
    [
      store,
      vp,
      board,
      targets,
      mirrorX,
      mirrorY,
      hitAny,
      fitView,
      onAddSectionAt,
      onPickSection,
      onDeleteSection,
      sectionMarkerAt,
      cancelLongPress,
      liveTrace,
      onTraceTransform,
    ],
  );

  // A cancelled pointer (browser claimed the gesture, palm-rejection, etc.) ends any drag
  // cleanly without firing a context menu, so state never gets stuck mid-pan.
  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      cancelLongPress();
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (holdsEdit(drag.current)) store.getState().endEdit();
      if (drag.current?.mode === 'section') setDraggingSection(null);
      if (drag.current?.mode === 'traceMove' || drag.current?.mode === 'traceRotate') {
        setLiveTrace(null); // drop the uncommitted preview
      }
      drag.current = null;
      setCursor(spaceHeld.current ? 'grab' : 'crosshair');
    },
    [store, cancelLongPress],
  );

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
          // Turned, the element is laid out at its own (landscape) size and rotated
          // into the pane; upright, it just fills it. Rotating the ELEMENT rather
          // than the drawing keeps the canvas's coordinate system ordinary, which
          // is what leaves every hit test and draw routine untouched.
          ...(turned
            ? {
                position: 'absolute' as const,
                top: 0,
                left: 0,
                width: `${size.w}px`,
                height: `${size.h}px`,
                transformOrigin: '0 0',
                transform: `translate(0px, ${size.w}px) rotate(-90deg)`,
              }
            : { width: '100%', height: '100%' }),
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
          setHoveredControl(null);
          setHoveredSection(null);
          if (!spaceHeld.current) setCursor('crosshair');
          onScrub?.(null);
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      {readout && hover && !calibration && <ReadoutHud rows={readout(hover)} />}
      {calibration && <CalibrationHud text={calibrationHint(calibration)} />}
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

/** Calibration instruction banner, pinned top-center above the canvas overlays. */
function CalibrationHud({ text }: { text: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100% - 16px)',
        pointerEvents: 'none',
        background: 'rgba(217,119,6,0.92)',
        color: '#fff',
        font: '12px system-ui, sans-serif',
        padding: '5px 10px',
        borderRadius: 6,
        textAlign: 'center',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      }}
    >
      {text} <span style={{ opacity: 0.8 }}>· Esc to cancel</span>
    </div>
  );
}
