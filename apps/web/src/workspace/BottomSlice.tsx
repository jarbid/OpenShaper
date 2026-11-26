// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom step's slice: the board's section at the chosen station, to true scale, and under it the relief the
 * board's contours raise the bottom by there, magnified, with one handle, the chosen contour's depth.
 *
 * - **The section** is the engine's, as built (its fine polyline, so a rail is smooth), with the station's
 *   bottom curve drawn on it. A contour is a few millimetres, so at this scale it is a pixel or two.
 * - **The relief strip** under it draws, across the bottom and from a baseline that is the bottom without the
 *   contours, what each contour raises it by at this station, with its height magnified so a few millimetres are
 *   readable. The magnification is written on the drawing ("height ×10"). It is the contour's own profile
 *   (`bottom-slice.ts`), before the mesh fades it along the rail.
 * - **The depth handle** stands where the chosen contour's relief is greatest. Dragging it up and down, or an
 *   arrow key on it, sets the contour's depth as the panel's dial does: one undo step for a drag or a held
 *   key, and the 3D board follows. It is off where this station has too little of the contour's depth to set it
 *   from, and the title says so.
 */
import { minusHalf, stationCurvesOf } from '@openshaper/store';
import { contourExtent } from '@openshaper/store/rails';
import { cn } from '@openshaper/ui';
import { memo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cmToUnitNumber, fmtLen, fmtSmallLen, type LengthUnit } from '../format';
import { railsStore } from '../store';
import { useElementSize } from '../use-element-size';
import { setBottomStatus } from './bottom-choice';
import { useBottomContours, useBottomStation } from './bottom-data';
import {
  RELIEF_SPAN,
  depthForRelief,
  handlePlace,
  reliefAcross,
  reliefAt,
  reliefAtPointer,
  reliefFactor,
} from './bottom-slice';
import { colourOfKind } from './contour-colour';
import { dialStep, heldNote } from './contour-panel';
import { flattenSpline } from './deck-slice';
import { closedPath, fitSlices, halfPath, toScreen, type SliceMeasure } from './rail-slice';
import { useCoalescedEdit } from './use-coalesced-edit';
import { useRailsProjection, useStationProbe } from './deck-data';

/** The size the slice is drawn at until it has been measured (no layout in tests and a prerender). */
const FALLBACK = { width: 360, height: 260 };

/** Room round the section, px. */
const MARGIN = { x: 24, top: 8, bottom: 6 } as const;
/** The relief strip's least and greatest height, px. */
/** A height no section is as tall as, to fit by the width alone. */
const TALL = 100_000;
const STRIP_MIN = 64;
const STRIP_MAX = 240;
/** Room under the strip's baseline, px. */
const STRIP_FOOT = 8;

const consume = (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
};

export const BottomSlice = memo(function BottomSlice({
  units,
  slice,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  slice: number;
}) {
  const station = useBottomStation(slice);
  const board = useRailsProjection();
  const probe = useStationProbe(station?.x ?? null);
  const { chosen, dials } = useBottomContours();
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box, FALLBACK);
  const edit = useCoalescedEdit();
  const drag = useRef<{ id: number; grab: number } | null>(null);

  if (!station || !board) return <NoSlice />;
  const { doc, index, x } = station;
  const plus = board.stationCurves[index];
  if (!plus || !(plus.w > 0 && plus.T > 0)) return <NoSlice />;
  const half = minusHalf(board);
  const minus = half && stationCurvesOf(half)?.[index];
  const other = minus ?? plus;

  // the section is as tall as its own shape asks at the scale the width allows, and the relief strip takes the rest
  const features = doc.features.filter((f) => f.enabled);
  const chosenFeature = chosen ? doc.features.find((f) => f.id === chosen.id) : undefined;
  const hasStrip = features.length > 0 || chosenFeature !== undefined;
  const measure = (c: typeof plus): SliceMeasure => ({
    halfWidth: c.w,
    thickness: c.T,
    apex: { y: c.w, z: c.T },
    zMin: Math.min(0, ...flattenSpline(c.bottom).filter((_, i) => i % 2 === 1)),
    zMax: c.T,
  });
  const measures = [measure(plus), measure(other)];
  const wide = fitSlices(measures, { width: size.width, height: TALL }, MARGIN);
  if (!wide) return <NoSlice />;
  const zSpan = Math.max(...measures.map((m) => m.zMax)) - Math.min(...measures.map((m) => m.zMin));
  const natural = Math.ceil(zSpan * wide.scale) + MARGIN.top + MARGIN.bottom;
  const height = hasStrip ? Math.max(size.height, natural + STRIP_MIN) : size.height;
  const strip = hasStrip ? Math.min(STRIP_MAX, height - natural) : 0;
  const frame = fitSlices(
    measures,
    { width: size.width, height: hasStrip ? natural : height },
    MARGIN,
  );
  if (!frame) return <NoSlice />;

  // the section behind: the engine's, from its fine polyline, until it has answered the store's
  const drawn = probe ? (probe.fine ?? probe) : null;
  const plusSection = board.crossSections[slice]?.spline;
  const minusSection = half?.crossSections[slice]?.spline ?? plusSection;
  const left = drawn ? drawn.plus : plusSection ? flattenSpline(plusSection) : null;
  const right = drawn
    ? (drawn.minus ?? drawn.plus)
    : minusSection
      ? flattenSpline(minusSection)
      : null;

  // the relief strip: a baseline that is the bottom without the contours, and a height magnified so a contour reads
  const baseline = natural + strip - STRIP_FOOT;
  const stripInner = Math.max(1, strip - STRIP_FOOT - 14);
  const factor = reliefFactor(frame.scale, stripInner, RELIEF_SPAN);
  const reliefPx = (cm: number) => cm * factor * frame.scale;
  const reliefPath = (fs: typeof features, w: number, side: 'left' | 'right', fill = false) => {
    const pts = reliefAcross(fs, x, w);
    const d = pts
      .map(([y, r], i) => {
        const p = toScreen(frame, y, 0, side);
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${(baseline - reliefPx(r)).toFixed(1)}`;
      })
      .join(' ');
    if (!fill) return d;
    const end = toScreen(frame, w, 0, side);
    const start = toScreen(frame, 0, 0, side);
    return `${d} L${end.x.toFixed(1)} ${baseline} L${start.x.toFixed(1)} ${baseline} Z`;
  };

  // the handle, on the plus side (the left of the section) where the chosen contour's relief is greatest
  const wPlus = plus.w;
  const place = chosenFeature ? handlePlace(chosenFeature, wPlus) : 0;
  const handleRelief = chosenFeature ? reliefAt(chosenFeature, x, place, wPlus) : 0;
  const spot = toScreen(frame, place, 0, 'left');
  const handleY = baseline - reliefPx(handleRelief);
  const settable =
    chosenFeature !== undefined && depthForRelief(chosenFeature, x, wPlus, 0.1) !== null;
  const chosenRun = chosenFeature ? contourExtent(chosenFeature) : null;
  const live = chosenFeature?.enabled === true && settable && dials !== null;
  const off =
    chosenFeature === undefined
      ? null
      : !chosenFeature.enabled
        ? 'This contour is switched off.'
        : !settable
          ? 'This station is at the end of the contour, or outside it: it has too little depth here to set from this handle. Choose a station along its run.'
          : null;

  const setDepth = (asked: number) => {
    if (!chosenFeature || !dials) return;
    railsStore.getState().setContourDepth(chosenFeature.id, asked);
    setBottomStatus(heldNote(asked, dials.depth, units) ?? '');
  };
  const pointerY = (e: { clientY: number }) =>
    e.clientY - (box.current?.getBoundingClientRect().top ?? 0);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!live || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, grab: handleY - pointerY(e) };
    edit.begin();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !chosenFeature) return;
    const wanted = reliefAtPointer(pointerY(e) + d.grab, baseline, factor, frame.scale);
    const depth = depthForRelief(chosenFeature, x, wPlus, wanted);
    if (depth !== null) setDepth(depth);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    edit.end();
  };
  // the handle moves the way the arrow points: up is deeper
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live || !dials) return;
    const big = e.shiftKey || e.key.startsWith('Page');
    const dir =
      e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp'
        ? 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown'
          ? -1
          : 0;
    if (dir !== 0) {
      consume(e);
      edit.begin();
      setDepth(dials.depth.value + dir * dialStep('depth', 'length', big));
    } else if (e.key === 'Home' || e.key === 'End') {
      consume(e);
      edit.begin();
      setDepth(e.key === 'Home' ? dials.depth.min : dials.depth.max);
    }
  };

  const top = toScreen(frame, 0, plus.T, 'right');
  const bottom = toScreen(frame, 0, 0, 'right');
  const colour = chosen ? colourOfKind(chosen.kind) : 'currentColor';
  const depthLabel = chosenFeature ? fmtSmallLen(dials?.depth.value ?? 0, units) : '';

  return (
    <div
      ref={box}
      data-testid="bottom-slice"
      className="relative h-full select-none overflow-hidden"
      style={{ minHeight: hasStrip ? natural + STRIP_MIN : 160 }}
    >
      <svg
        role="img"
        aria-label={`Section of the board at the chosen station, with its bottom curve${
          features.length > 0
            ? `, and under it the relief of ${features.length === 1 ? 'the contour' : 'the contours'} magnified ${factor} times`
            : ''
        }.`}
        width={size.width}
        height={hasStrip ? natural + strip : size.height}
        className="block text-foreground"
      >
        {left && right ? (
          <path
            d={closedPath(left, right, frame)}
            fill="currentColor"
            fillOpacity={0.08}
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeLinejoin="round"
          />
        ) : null}
        <path
          d={`M${top.x} ${top.y - 6} L${bottom.x} ${bottom.y + 6}`}
          stroke="currentColor"
          strokeOpacity={0.4}
          strokeDasharray="3 3"
        />
        {/* the bottom curve of this station, the shaper's own, on both sides of the stringer */}
        <g fill="none" className="stroke-primary" strokeLinecap="round" strokeWidth={2}>
          <path d={halfPath(flattenSpline(plus.bottom), frame, 'left')} />
          <path d={halfPath(flattenSpline(other.bottom), frame, 'right')} />
        </g>
        {strip > 0 ? (
          <g data-testid="relief-strip">
            <line
              x1={frame.cx - wPlus * frame.scale}
              x2={frame.cx + other.w * frame.scale}
              y1={baseline}
              y2={baseline}
              stroke="currentColor"
              strokeOpacity={0.5}
            />
            <text
              x={4}
              y={baseline - strip + STRIP_FOOT + 10}
              fontSize={10}
              className="fill-muted-foreground"
            >
              Contour relief, height ×{factor} (the section above is true scale)
            </text>
            {features.length > 0 ? (
              <g fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={1.25}>
                <path d={reliefPath(features, wPlus, 'left')} />
                <path d={reliefPath(features, other.w, 'right')} />
              </g>
            ) : null}
            {chosenFeature?.enabled ? (
              <g stroke={colour} strokeWidth={2} strokeLinejoin="round">
                <path
                  d={reliefPath([chosenFeature], wPlus, 'left', true)}
                  fill={colour}
                  fillOpacity={0.22}
                />
                <path
                  d={reliefPath([chosenFeature], other.w, 'right', true)}
                  fill={colour}
                  fillOpacity={0.22}
                />
              </g>
            ) : null}
            {chosenFeature && settable ? (
              <text
                x={spot.x}
                y={Math.max(baseline - strip + STRIP_FOOT + 24, handleY - 12)}
                textAnchor="middle"
                fontSize={11}
                className="fill-foreground"
              >
                {`Depth ${depthLabel}`}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
      {chosenFeature && chosenRun && !settable ? (
        <p
          data-testid="outside-run"
          className="pointer-events-none absolute inset-x-2 rounded bg-card/85 px-1 text-center text-xs text-muted-foreground"
          style={{ top: natural + 26 }}
        >
          {`${chosen!.name} runs ${fmtLen(chosenRun.from, units)} to ${fmtLen(chosenRun.to, units)}: choose a station along it.`}
        </p>
      ) : null}
      {chosenFeature ? (
        <div
          role="slider"
          tabIndex={live ? 0 : -1}
          aria-label="Depth"
          aria-orientation="vertical"
          aria-disabled={!live}
          aria-valuemin={cmToUnitNumber(dials?.depth.min ?? 0, units)}
          aria-valuemax={cmToUnitNumber(dials?.depth.max ?? 0, units)}
          aria-valuenow={cmToUnitNumber(dials?.depth.value ?? 0, units)}
          aria-valuetext={depthLabel}
          title={off ?? 'Drag up and down to set the depth'}
          data-testid="depth-handle"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
          onKeyUp={(e) => {
            if (/^(Arrow|Page|Home|End)/.test(e.key)) edit.end();
          }}
          onBlur={() => edit.end()}
          style={{ left: spot.x - 8, top: handleY - 8 }}
          className={cn(
            'absolute size-4 touch-none rounded-full border-2 outline-none',
            live
              ? 'cursor-ns-resize border-primary bg-background shadow-sm'
              : 'cursor-not-allowed border-muted-foreground/60 bg-muted',
            'focus-visible:ring-2 focus-visible:ring-ring',
            // the finger's 44 px: a 16 px handle with a 2 px border, and 16 px more each side of its padding box
            'before:absolute before:-inset-3 before:content-[""] pointer-coarse:before:-inset-[16px]',
          )}
        />
      ) : null}
      {features.length === 0 && !chosenFeature ? (
        <p className="pointer-events-none absolute inset-x-2 bottom-2 text-xs text-muted-foreground">
          No contour: the bottom is flat across. Add one in the panel.
        </p>
      ) : null}
    </div>
  );
});

/** What a place that has no section to draw says: the very tip of the nose or the tail has no width. */
function NoSlice() {
  return (
    <p className="p-2 text-xs text-muted-foreground">
      Nothing to draw here: the board has no width or no thickness at this station.
    </p>
  );
}
