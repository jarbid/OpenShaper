// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin's side profile, editable, front on the left, drawn over its tab: the base line and the tab
 * itself, and on a Futures tab the 4 mm front-overhang limit and the
 * insertion-clearance line behind the tab (fin-clearance.ts). Over the fin, the foil
 * sweep (sweep-overlay.ts): its start along the base and its end across the tip, each a
 * soft green band, and the thickness path between them, all draggable. An FCS single tab drops
 * straight into its plug, so it has neither. Points are dragged through the fin store, which clamps
 * every move to the fin's rules.
 */
import {
  FIN_MAX_FRONT_OVERHANG,
  clearanceAt,
  finTabOutline,
  futuresKind,
  rearClearance,
  tabProfilePoints,
  type FinBase,
  type Spline,
} from '@openshaper/kernel';
import {
  FIN_CANVAS_FONT,
  FinCurveEditor,
  boundsOf,
  sampleSpline,
  type Viewport,
} from '@openshaper/render2d';
import { TIP_FOIL, type FinState } from '@openshaper/store';
import { memo, useCallback, useMemo } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { LengthUnit } from '../format';
import { alsoFromSelection, curveEditorHandlers, pickFromSelection } from './curve-editor-wiring';
import { GhostControl } from './VectorImport';
import { drawGhost, ghostMarkers, makeGhost, withGhostHandles, type Ghost } from './ghost';
import { vectorLines, type VectorFacing, type VectorPath } from './vector-import';
import { sliceGuideHandlers, sliceGuides } from './slice-guides';
import {
  PATH_COLOR,
  SWEEP_BAND,
  SWEEP_LINE,
  pickSweepLine,
  sweepMarkerHandlers,
  sweepOverlay,
} from './sweep-overlay';
import { useFinState } from './use-fin';

/**
 * The profile drawn front on the left, rear on the right, as fin designers draw it and as
 * the foil view runs (owner request): the outline's x (+ toward the nose) mirrored.
 */
const FRONT_LEFT = { a: -1, b: 0, c: 0, d: 1 } as const;

const TAB_FILL = 'rgba(138,155,179,0.18)';
const TAB_LINE = 'rgba(138,155,179,0.7)';
const LIMIT = 'rgba(249,115,22,0.85)';

/** Each tab's profile and its holes in the blade frame (tab top at y = 0), for drawing. */
const tabPolygons = (base: FinBase, outline?: Spline) => {
  const tab = finTabOutline(base, outline);
  const ring = (segs: Parameters<typeof tabProfilePoints>[0]) =>
    tabProfilePoints(segs, 0.002).map((p) => ({ x: p.x, y: p.y - tab.height }));
  return tab.parts.flatMap((part) => [ring(part.segments), ...part.holes.map(ring)]);
};

export const FinOutlinePane = memo(function FinOutlinePane({
  store,
  units,
  onViewport,
  frameKey = '',
  gridStep,
  ghost,
  onGhost,
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
  onViewport?: (vp: Viewport) => void;
  /** Change it to re-fit the view (the pane moving large or small). */
  frameKey?: string;
  /** The grid's spacing (cm, File settings); fits the zoom if unset. */
  gridStep?: number;
  /** The drawing shown behind the profile to trace over, and setting it. */
  ghost?: Ghost | null;
  onGhost?: (g: Ghost | null) => void;
}) {
  const design = useFinState(store, (s) => s.design);
  const selection = useFinState(store, (s) => s.selection);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  const position = design?.position ?? 'side';
  const guides = useMemo(
    () => (design ? sliceGuides(design, activeFoil, units, 'y') : []),
    [design, activeFoil, units],
  );
  const guideHandlers = useMemo(() => sliceGuideHandlers(store, 'y'), [store]);

  const base = design?.base ?? 'futures-side';
  // A US box head follows the fin; every other base is fixed.
  const follows = base === 'us-box' ? design?.outline : undefined;
  const tab = useMemo(() => tabPolygons(base, follows), [base, follows]);
  const kind = futuresKind(base);
  const { rear: tabRear, length: tabLen, height: tabHeight } = finTabOutline(base, follows);
  const frameBounds = useMemo(
    () => ({ minX: tabRear, maxX: tabRear + tabLen, minY: -tabHeight, maxY: 0 }),
    [tabRear, tabLen, tabHeight],
  );

  const sweep = useMemo(() => (design ? sweepOverlay(design) : null), [design]);
  const markerHandlers = useMemo(
    () => withGhostHandles(sweepMarkerHandlers(store), ghost, onGhost),
    [store, ghost, onGhost],
  );
  const markers = useMemo(
    () => [...(sweep?.markers ?? []), ...(ghost ? ghostMarkers(ghost) : [])],
    [sweep, ghost],
  );
  // Real size, standing on the tab top in the middle of the fin.
  const makeGhostHere = useCallback(
    (paths: readonly VectorPath[], facing: VectorFacing) =>
      makeGhost(vectorLines(paths, facing, true), ({ h }) => {
        const k = design?.outline.knots ?? [];
        const x = ((k[0]?.end.x ?? 0) + (k[k.length - 1]?.end.x ?? 0)) / 2;
        return { x, y: h / 2, scale: 1 };
      }),
    [design],
  );

  const layers = useMemo(
    () => (design ? [{ id: 'outline', spline: design.outline, editable: true }] : []),
    [design],
  );

  const drawUnder = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      _vp: Viewport,
      toScreen: (p: { x: number; y: number }) => { x: number; y: number },
    ) => {
      if (!design) return;
      if (ghost) drawGhost(ctx, ghost, toScreen);
      // The tab, with its weight-saving holes cut out.
      ctx.beginPath();
      for (const ring of tab) {
        ring.forEach((p, i) => {
          const s = toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = TAB_FILL;
      ctx.fill('evenodd');
      ctx.strokeStyle = TAB_LINE;
      ctx.lineWidth = 1;
      ctx.stroke();

      const line = (a: { x: number; y: number }, b: { x: number; y: number }, color: string) => {
        const sa = toScreen(a);
        const sb = toScreen(b);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      ctx.save();
      ctx.setLineDash([5, 4]);
      // The base: the board's bottom surface, across the whole view.
      const rear = Math.min(-3, boundsOf(sampleSpline(design.outline)).minX - 1);
      line({ x: rear, y: 0 }, { x: tabLen + 3, y: 0 }, TAB_LINE);
      if (kind) {
        // Front-overhang limit.
        const front = tabLen + FIN_MAX_FRONT_OVERHANG;
        line({ x: front, y: -0.6 }, { x: front, y: 1.2 }, LIMIT);
        // Insertion clearance behind the tab.
        const c = rearClearance(kind);
        line({ x: 0, y: clearanceAt(c, 0) }, { x: rear, y: clearanceAt(c, rear) }, LIMIT);
      }
      ctx.restore();

      if (sweep) {
        ctx.save();
        const path = (pts: readonly { x: number; y: number }[]) => {
          ctx.beginPath();
          pts.forEach((p, i) => {
            const q = toScreen(p);
            if (i === 0) ctx.moveTo(q.x, q.y);
            else ctx.lineTo(q.x, q.y);
          });
        };
        // The sweep's start and end: thin lines; the one whose foil is being edited
        // glows. Click either to edit its foil.
        ctx.lineCap = 'round';
        for (const [foil, line] of [
          [0, sweep.base],
          [TIP_FOIL, sweep.tip],
        ] as const) {
          path(line);
          if (activeFoil === foil) {
            ctx.strokeStyle = SWEEP_BAND;
            ctx.lineWidth = 10;
            ctx.stroke();
          }
          ctx.strokeStyle = SWEEP_LINE;
          ctx.lineWidth = activeFoil === foil ? 2 : 1.25;
          ctx.stroke();
        }
        // The thickness path.
        path(sweep.path);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = PATH_COLOR;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = FIN_CANVAS_FONT;
        ctx.fillStyle = SWEEP_LINE;
        // Labels placed in pixels from their lines, so they read at any zoom.
        const mid = (pts: readonly { x: number; y: number }[]) =>
          toScreen(pts[Math.floor(pts.length / 2)]!);
        const b = mid(sweep.base);
        ctx.textAlign = 'center';
        ctx.fillText('Base foil', b.x, b.y - 10);
        const t = mid(sweep.tip);
        ctx.textAlign = 'left';
        ctx.fillText('Tip foil', t.x + 12, t.y + 4);
        ctx.restore();
      }
    },
    [design, tab, tabLen, kind, sweep, activeFoil, ghost],
  );

  const onBackgroundClick = useCallback(
    (at: { x: number; y: number }, unitsPerPx: number) => {
      const foil = sweep && pickSweepLine(sweep, at, unitsPerPx);
      if (foil !== null && foil !== undefined) store.getState().setActiveFoil(foil);
    },
    [sweep, store],
  );

  const handlers = useMemo(() => curveEditorHandlers(store), [store]);
  return (
    <div className="relative h-full">
      {onGhost && (
        <GhostControl
          what="vector outline"
          ghost={ghost ?? null}
          make={makeGhostHere}
          onGhost={onGhost}
        />
      )}
      <FinCurveEditor
        gridStep={gridStep}
        label="Profile"
        layers={layers}
        selection={pickFromSelection(selection, ['outline'])}
        alsoSelected={alsoFromSelection(selection, ['outline'])}
        frameBounds={frameBounds}
        yScale={FRONT_LEFT}
        frameKey={`${position}-${base}-${frameKey}`}
        drawUnder={drawUnder}
        onViewport={onViewport}
        guides={guides}
        markers={markers}
        onBackgroundClick={onBackgroundClick}
        {...markerHandlers}
        {...guideHandlers}
        {...handlers}
      />
    </div>
  );
});
