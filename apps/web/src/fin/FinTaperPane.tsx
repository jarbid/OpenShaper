// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The thickness taper, editable: the thickness at the foil's thickest point, from the
 * root (bottom) to the tip (top), standing upright like the profile and the 3D view
 * (docs/design/fin-designer.md, step 12; round 1, R6). The taper's data is (fraction of
 * the depth, thickness); it is drawn with height up at the fin's true depth, so it lines
 * up with the profile, and thickness across, stretched so it reads. Straight then
 * curving toward the tip is the usual shape: the curve is what controls flex. The
 * dashed line is the fin's minimum thickness (0.5 mm unless set in the box at the top
 * left, owner request); the store stops a point there. On a
 * heavily swept-back fin the curve is read along the sweep instead (kernel
 * thicknessAlongSweep), which the pane notes, as its height no longer lines up.
 */
import { finMinThickness, finReadouts, thicknessAlongSweep } from '@openshaper/kernel';
import {
  FIN_CANVAS_FONT,
  FIN_CANVAS_LABEL,
  FinCurveEditor,
  type ViewMap,
} from '@openshaper/render2d';
import type { FinState } from '@openshaper/store';
import { memo, useCallback, useMemo } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { NumericInput } from '../components/numeric-input';
import {
  cmToUnitNumber,
  fmtThick,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from '../format';
import { useSyncedText } from '../use-numeric-field';
import { alsoFromSelection, curveEditorHandlers, pickFromSelection } from './curve-editor-wiring';
import { sliceGuideHandlers, sliceGuides } from './slice-guides';
import { useFinState } from './use-fin';

const TAPER = '#F59E0B';
const GUIDE = 'rgba(138,155,179,0.7)';
const LIMIT = 'rgba(249,115,22,0.85)';

/** Thickness is drawn this many times wider than true; height is true to scale. */
export const TAPER_ACROSS = 4;

/** Data (fraction of depth, thickness) to view (thickness across, height up). */
export const taperView = (depth: number): ViewMap => ({ a: 0, b: TAPER_ACROSS, c: depth, d: 0 });

/**
 * The fin's minimum thickness, typed in the current unit (owner request): the thinnest
 * the blade may get, edges and tip included. The store keeps it within range, and the
 * taper's tip follows it. In the thickness view's toolbar, beside Base thickness; its
 * orange label ties it to the dashed line it moves.
 */
export function MinThicknessField({
  store,
  units,
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
}) {
  const min = useFinState(store, (s) => (s.design ? finMinThickness(s.design) : null));
  const shown = min === null ? '' : cmToUnitNumber(min, units).toFixed(unitDecimals(units) + 1);
  const [text, setText] = useSyncedText(shown);
  const commit = () => {
    const cm = parseTypedLen(text, units);
    if (cm === null || !store.getState().setMinThickness(cm)) setText(shown);
  };
  return (
    <label className="flex items-center gap-2">
      <span style={{ color: LIMIT }}>Min thickness</span>
      <span className="flex items-center gap-1">
        <NumericInput
          value={text}
          onValueChange={setText}
          onCommit={commit}
          onEscape={() => setText(shown)}
          ariaLabel="Fin minimum thickness"
          className="h-8 w-16 tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{unitSuffix(units)}</span>
      </span>
    </label>
  );
}

export const FinTaperPane = memo(function FinTaperPane({
  store,
  units,
  frameKey = '',
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
  /** Change it to re-fit the view (the pane moving large or small). */
  frameKey?: string;
}) {
  const design = useFinState(store, (s) => s.design);
  const selection = useFinState(store, (s) => s.selection);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  const engine = useFinState(store, (s) => s.engine);
  const guides = useMemo(
    () => (design ? sliceGuides(design, activeFoil, units, 'x', engine) : []),
    [design, activeFoil, units, engine],
  );
  const guideHandlers = useMemo(() => sliceGuideHandlers(store, 'x'), [store]);
  const handlers = useMemo(() => curveEditorHandlers(store), [store]);
  const taper = design?.taper;
  const root = taper?.knots[0]?.end.y ?? 0.8;
  const depth = useMemo(() => (design ? finReadouts(design).depth : 10), [design]);
  const view = useMemo(() => taperView(depth), [depth]);
  const minT = design ? finMinThickness(design) : 0;

  const layers = useMemo(
    () => (taper ? [{ id: 'taper', spline: taper, editable: true, color: TAPER }] : []),
    [taper],
  );

  const drawUnder = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      _vp: unknown,
      toScreen: (p: { x: number; y: number }) => { x: number; y: number },
    ) => {
      // Points are taper data: x the fraction of the depth, y the thickness.
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
      ctx.lineWidth = 1;
      line({ x: 0, y: 0 }, { x: 1, y: 0 }, GUIDE); // zero thickness, root to tip
      line({ x: 0, y: 0 }, { x: 0, y: root * 1.1 }, GUIDE); // the root
      ctx.setLineDash([5, 4]);
      line({ x: 0, y: minT }, { x: 1.02, y: minT }, LIMIT);
      ctx.setLineDash([]);
      ctx.font = FIN_CANVAS_FONT;
      // Labels are offset in pixels, so they read the same in a small pane.
      const label = (
        text: string,
        p: { x: number; y: number },
        dx: number,
        dy: number,
        align: CanvasTextAlign,
      ) => {
        const s = toScreen(p);
        ctx.textAlign = align;
        ctx.fillText(text, s.x + dx, s.y + dy);
      };
      ctx.fillStyle = FIN_CANVAS_LABEL;
      label('Base', { x: 0, y: 0 }, -6, 4, 'right');
      label('Tip', { x: 1, y: 0 }, -6, 4, 'right');
      label('thickness →', { x: 0, y: root * 0.55 }, 0, 16, 'center');
      ctx.fillStyle = LIMIT;
      label(`${fmtThick(minT, units)} min`, { x: 1.02, y: minT }, 0, -6, 'center');
      ctx.restore();
    },
    [units, root, minT],
  );

  const alongSweep = useMemo(() => (design ? thicknessAlongSweep(design) : 0), [design]);

  if (!design || !taper) return null;
  const editor = (
    <FinCurveEditor
      label="Thickness"
      layers={layers}
      selection={pickFromSelection(selection, ['taper'])}
      alsoSelected={alsoFromSelection(selection, ['taper'])}
      yScale={view}
      frameBounds={{ minX: -0.04, maxX: 1.06, minY: -0.12, maxY: root * 1.15 }}
      frameKey={`${design.position}-${frameKey}`}
      drawUnder={drawUnder}
      guides={guides}
      {...guideHandlers}
      {...handlers}
    />
  );
  return (
    <div className="relative h-full">
      {alongSweep > 0.05 && (
        <span
          className="pointer-events-none absolute right-2 top-1 z-10 max-w-[60%] text-right text-xs text-muted-foreground"
          data-testid="taper-along-sweep"
        >
          Swept-back fin: measured along the sweep
        </span>
      )}
      {editor}
    </div>
  );
});
