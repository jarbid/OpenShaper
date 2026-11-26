// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom seen from below: the board's plan with each contour drawn on it, and under it the stations.
 *
 * - **The board** is the outline, the tail on the left and the nose on the right, with the plus side below
 *   the stringer (the camera is under the board; see `contour-plan.ts`). A ruler along the top is the rail
 *   map's and the station strip's, in the display unit.
 * - **Each contour is a band along the board** where it acts across the bottom: its hollow (a concave), the
 *   whole bottom (a vee), a line for each channel. The band is shaded by the depth along the run, so its law
 *   along the board is what is seen. A contour switched off is outlined and not shaded.
 * - **Choosing**: a tap on a band chooses that contour, the narrowest where bands lie over one another; a tap
 *   on the bare board chooses the station nearest it, and the stations' ticks along the foot choose one too.
 * - **The chosen contour** has a handle on each end and one in the middle: dragging an end changes where it
 *   starts or ends, dragging the middle (or the band itself) slides it, and the number being set is shown in
 *   the display unit while the pointer is down. The store holds the run to the board, a least span long.
 *   Each handle is a slider for the keyboard: the arrow keys move it a centimetre, ten with Shift, Home and End
 *   take it to its least and greatest.
 *
 * The drag is one undo step (`useCoalescedEdit`) and every move is computed by the store from where the drag
 * began (`railsStore.setContourExtent`, `moveContour`), so the run is a function of the pointer.
 */
import type { BottomFeature } from '@openshaper/board2';
import { minusHalf } from '@openshaper/store';
import { contourBands, contourExtent, halfWidthFn, sliceOfStation } from '@openshaper/store/rails';
import { cn } from '@openshaper/ui';
import {
  memo,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { cmToUnitNumber, fmtLen, type LengthUnit } from '../format';
import { boardLengthOf } from '../rail-zones';
import { railsStore } from '../store';
import { useElementSize } from '../use-element-size';
import { setBottomStatus, setChosenContour } from './bottom-choice';
import { useBottomContours, useBottomStation } from './bottom-data';
import { colourOfKind } from './contour-colour';
import { ContourLaw } from './ContourLaw';
import {
  PLAN_RULER,
  bandPaths,
  channelLines,
  depthStops,
  fitPlan,
  grabbedExtent,
  outlinePath,
  planNudge,
  planX,
  planXAt,
  planY,
  type HalfWidths,
  type PlanGrab,
} from './contour-plan';
import { heldNote } from './contour-panel';
import { flattenSpline } from './deck-slice';
import { useRailsDoc, useRailsProjection, useStationMarks } from './deck-data';
import { MAP_PAD, rulerTicks, xToPx } from './rail-map';
import { nearestStation, stationLabel } from './station-strip';
import { useCoalescedEdit } from './use-coalesced-edit';

/** The size the plan is drawn at until it has been measured (no layout in tests and a prerender). */
const FALLBACK = { width: 560, height: 200 };

const consume = (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
};

export const ContourPlan = memo(function ContourPlan({
  units,
  slice,
  onStation,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  slice: number;
  /** Choose a station by its classic slice index. */
  onStation: (slice: number) => void;
}) {
  const doc = useRailsDoc();
  const board = useRailsProjection();
  const station = useBottomStation(slice);
  const marks = useStationMarks(doc);
  const { contours, chosen, dials } = useBottomContours();
  const gradient = useId();
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box, FALLBACK);
  const edit = useCoalescedEdit();
  /** What the pointer holds, and where the run and the pointer were when it took hold. */
  const drag = useRef<{
    id: number;
    grab: PlanGrab;
    start: { from: number; to: number; at: number };
  } | null>(null);
  const [holding, setHolding] = useState<PlanGrab | null>(null);
  const keyEdit = useRef(false);

  // the outlines, flattened once for each board that is drawn
  const outlines = useMemo(() => {
    if (!board) return null;
    const plus = flattenSpline(board.outline, 16);
    const minus = flattenSpline((minusHalf(board) ?? board).outline, 16);
    let half = 0;
    for (const run of [plus, minus])
      for (let i = 1; i < run.length; i += 2) half = Math.max(half, run[i]!);
    return { plus, minus, half };
  }, [board]);

  if (!doc || !outlines) return null;
  const length = boardLengthOf(doc);
  const fit = fitPlan(size.width, length, outlines.half);
  const half = {
    plus: halfWidthFn(doc.outline),
    minus: halfWidthFn(doc.outline, 'minus'),
  };
  const chosenIndex = station ? station.index : null;
  const chosenFeature = chosen ? doc.features.find((f) => f.id === chosen.id) : undefined;
  const chosenRun = chosenFeature ? contourExtent(chosenFeature) : null;

  const left = (el: Element | null) => el?.getBoundingClientRect().left ?? 0;
  const xOf = (clientX: number) => planXAt(fit, clientX - left(box.current));

  // --- dragging the chosen contour's ends and middle
  const grabAt = (grab: PlanGrab) => (e: PointerEvent<Element>) => {
    if (!chosenFeature || !chosenRun || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = {
      id: e.pointerId,
      grab,
      start: { ...chosenRun, at: xOf(e.clientX) },
    };
    setHolding(grab);
    edit.begin();
  };
  const move = (e: PointerEvent<Element>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !chosenFeature || !dials) return;
    const asked = grabbedExtent(d.grab, xOf(e.clientX), d.start);
    const s = railsStore.getState();
    if (d.grab === 'move') s.moveContour(chosenFeature.id, asked.from!);
    else s.setContourExtent(chosenFeature.id, asked.from, asked.to);
    const dial = d.grab === 'to' ? dials.to : dials.from;
    const value = d.grab === 'to' ? asked.to! : asked.from!;
    setBottomStatus(heldNote(value, dial, units) ?? '');
  };
  const release = (e: PointerEvent<Element>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setHolding(null);
    edit.end();
  };
  const bind = (grab: PlanGrab) => ({
    onPointerDown: grabAt(grab),
    onPointerMove: move,
    onPointerUp: release,
    onPointerCancel: release,
  });

  // --- the keys on a handle: a centimetre along the board, ten with Shift, and the least and greatest
  const keysOf = (grab: PlanGrab) => ({
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!chosenFeature || !chosenRun || !dials) return;
      const dir =
        e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
            ? -1
            : 0;
      const end = e.key === 'Home' || e.key === 'End';
      if (dir === 0 && !end) return;
      consume(e);
      if (!keyEdit.current) {
        keyEdit.current = true;
        edit.begin();
      }
      const s = railsStore.getState();
      const step = dir * planNudge(e.shiftKey);
      if (grab === 'move') {
        const to =
          e.key === 'Home' ? dials.from.min : dials.to.max - (chosenRun.to - chosenRun.from);
        s.moveContour(chosenFeature.id, end ? to : chosenRun.from + step);
      } else {
        const at = grab === 'from' ? chosenRun.from : chosenRun.to;
        const dial = grab === 'from' ? dials.from : dials.to;
        const value = end ? (e.key === 'Home' ? dial.min : dial.max) : at + step;
        if (grab === 'from') s.setContourExtent(chosenFeature.id, value, undefined);
        else s.setContourExtent(chosenFeature.id, undefined, value);
        setBottomStatus(heldNote(value, dial, units) ?? '');
      }
    },
    onKeyUp: () => {
      keyEdit.current = false;
      edit.end();
    },
    onBlur: () => {
      keyEdit.current = false;
      edit.end();
    },
  });

  // --- choosing a station
  const stationAt = (clientX: number) => {
    const nearest = nearestStation(marks, xOf(clientX));
    if (nearest !== null) onStation(sliceOfStation(nearest));
  };
  const onLaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (chosenIndex === null) return;
    const last = marks.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? Math.min(last, chosenIndex + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? Math.max(0, chosenIndex - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    consume(e);
    onStation(sliceOfStation(next));
    e.currentTarget.querySelector<HTMLElement>(`[data-tick="${next}"]`)?.focus();
  };

  const ticks = rulerTicks(fit.frame, units);
  const featureOf = (id: string) => doc.features.find((q) => q.id === id)!;
  const order = [...contours].sort(
    (a, b) => spanAt(featureOf(b.id), half) - spanAt(featureOf(a.id), half),
  );
  const stationX = station ? station.x : null;
  const holdingLabel =
    holding && chosenRun
      ? holding === 'move'
        ? `${fmtLen(chosenRun.from, units)} to ${fmtLen(chosenRun.to, units)}`
        : holding === 'from'
          ? `From ${fmtLen(chosenRun.from, units)}`
          : `To ${fmtLen(chosenRun.to, units)}`
      : null;

  const handle = (
    grab: PlanGrab,
    at: number,
    label: string,
    value: number,
    min: number,
    max: number,
  ) => (
    <div
      key={grab}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={cmToUnitNumber(min, units)}
      aria-valuemax={cmToUnitNumber(max, units)}
      aria-valuenow={cmToUnitNumber(value, units)}
      aria-valuetext={fmtLen(value, units)}
      title={`${label}: drag, or use the arrow keys`}
      data-testid={`plan-${grab}`}
      {...bind(grab)}
      {...keysOf(grab)}
      style={{ left: planX(fit, at) - 8, top: fit.cy - 8 }}
      className={cn(
        'absolute z-[4] touch-none border-2 border-primary bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        grab === 'move'
          ? 'size-4 rotate-45 cursor-grab rounded-sm'
          : 'size-4 cursor-ew-resize rounded-full',
        // the finger's 44 px: a 16 px handle with a 2 px border, and 16 px more each side of its padding box
        'before:absolute before:-inset-3 before:content-[""] pointer-coarse:before:-inset-[16px]',
      )}
    />
  );

  return (
    <section aria-label="The bottom seen from below" className="flex flex-col gap-1">
      <div ref={box} className="relative select-none" data-testid="contour-plan">
        <svg
          width={size.width}
          height={fit.height}
          role="img"
          aria-label={`The bottom of the board seen from below, tail on the left, with ${contours.length === 0 ? 'no contour' : contours.length === 1 ? 'one contour' : `${contours.length} contours`} drawn on it. The plus side is the lower one.`}
          className="block text-foreground"
        >
          <defs>
            {contours.map((c) => {
              const f = doc.features.find((q) => q.id === c.id)!;
              return (
                <linearGradient key={c.id} id={`${gradient}${c.id}`} x1="0" x2="1" y1="0" y2="0">
                  {depthStops(f).map((s) => (
                    <stop
                      key={s.offset}
                      offset={s.offset}
                      stopColor={colourOfKind(c.kind)}
                      stopOpacity={s.opacity}
                    />
                  ))}
                </linearGradient>
              );
            })}
          </defs>
          {/* the ruler: the rail map's, in the display unit */}
          <g className="text-muted-foreground" aria-hidden>
            <line
              x1={MAP_PAD}
              x2={size.width - MAP_PAD}
              y1={PLAN_RULER - 1}
              y2={PLAN_RULER - 1}
              stroke="currentColor"
              strokeOpacity={0.5}
            />
            {ticks.map((t) => {
              const x = xToPx(t.x, fit.frame);
              const anchor =
                x < MAP_PAD + 22 ? 'start' : x > size.width - MAP_PAD - 22 ? 'end' : 'middle';
              return (
                <g key={t.x}>
                  <line
                    x1={x}
                    x2={x}
                    y1={PLAN_RULER - 6}
                    y2={PLAN_RULER - 1}
                    stroke="currentColor"
                    strokeOpacity={0.6}
                  />
                  <text
                    x={x}
                    y={PLAN_RULER - 9}
                    fontSize={10}
                    textAnchor={anchor}
                    fill="currentColor"
                  >
                    {t.label}
                  </text>
                </g>
              );
            })}
          </g>
          {/* the board; a tap on it chooses the station nearest */}
          <path
            d={outlinePath(fit, outlines.plus, outlines.minus)}
            fill="currentColor"
            fillOpacity={0.07}
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeLinejoin="round"
            data-testid="plan-board"
            onPointerUp={(e) => stationAt(e.clientX)}
          >
            <title>The bottom of the board. Tap to choose the station nearest.</title>
          </path>
          <line
            x1={planX(fit, 0)}
            x2={planX(fit, length)}
            y1={fit.cy}
            y2={fit.cy}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeDasharray="3 3"
          />
          {/* the stations: a faint line across the board at each, and a bold one at the chosen */}
          {marks.map((m, i) => (
            <line
              key={i}
              x1={planX(fit, m.x)}
              x2={planX(fit, m.x)}
              y1={planY(fit, -outlines.half)}
              y2={planY(fit, outlines.half)}
              stroke={i === chosenIndex ? 'var(--primary)' : 'currentColor'}
              strokeOpacity={i === chosenIndex ? 0.9 : 0.18}
              strokeWidth={i === chosenIndex ? 1.5 : 1}
              strokeDasharray={i === chosenIndex ? undefined : '2 3'}
              pointerEvents="none"
            />
          ))}
          {/* the contours, the widest first so a narrow one lies on top and takes the tap */}
          {order.map((c) => {
            const f = doc.features.find((q) => q.id === c.id)!;
            const isChosen = chosen?.id === c.id;
            const colour = colourOfKind(c.kind);
            const bands = bandPaths(fit, f, half);
            const lines = channelLines(fit, f, half);
            const choose = isChosen ? grabAt('move') : () => setChosenContour(c.id);
            return (
              <g
                key={c.id}
                data-contour-band={c.id}
                aria-label={`${c.name}, ${fmtLen(c.from, units)} to ${fmtLen(c.to, units)}`}
                opacity={c.enabled ? 1 : 0.55}
              >
                {bands.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill={c.enabled ? `url(#${gradient}${c.id})` : 'none'}
                    stroke={colour}
                    strokeWidth={isChosen ? 2 : 1}
                    strokeDasharray={c.enabled ? undefined : '4 3'}
                    strokeOpacity={isChosen ? 1 : 0.7}
                    className={isChosen ? 'cursor-grab' : 'cursor-pointer'}
                    onPointerDown={choose}
                    onPointerMove={isChosen ? move : undefined}
                    onPointerUp={isChosen ? release : undefined}
                    onPointerCancel={isChosen ? release : undefined}
                  >
                    <title>{`${c.name}. ${isChosen ? 'Drag to slide it along the board.' : 'Tap to choose it.'}`}</title>
                  </path>
                ))}
                {lines.map((l, i) => (
                  <path
                    key={`l${i}`}
                    d={l.d}
                    fill="none"
                    stroke={colour}
                    strokeWidth={l.width}
                    strokeOpacity={c.enabled ? 0.85 : 0.4}
                    strokeLinecap="round"
                    className={isChosen ? 'cursor-grab' : 'cursor-pointer'}
                    onPointerDown={choose}
                    onPointerMove={isChosen ? move : undefined}
                    onPointerUp={isChosen ? release : undefined}
                    onPointerCancel={isChosen ? release : undefined}
                  />
                ))}
              </g>
            );
          })}
          {stationX !== null ? (
            <text
              x={planX(fit, stationX)}
              y={fit.height - 2}
              fontSize={10}
              textAnchor="middle"
              fill="var(--primary)"
              pointerEvents="none"
            >
              {chosenIndex !== null ? `Station ${chosenIndex + 1}` : ''}
            </text>
          ) : null}
          {/* the ends of the chosen run: a line across the board where it starts and where it ends */}
          {chosenRun
            ? [chosenRun.from, chosenRun.to].map((x, i) => (
                <line
                  key={i}
                  x1={planX(fit, x)}
                  x2={planX(fit, x)}
                  y1={planY(fit, -outlines.half)}
                  y2={planY(fit, outlines.half)}
                  stroke={colourOfKind(chosen!.kind)}
                  strokeWidth={1.5}
                  strokeOpacity={0.9}
                  pointerEvents="none"
                />
              ))
            : null}
          {holdingLabel && chosenRun ? (
            <text
              x={planX(
                fit,
                holding === 'to'
                  ? chosenRun.to
                  : holding === 'from'
                    ? chosenRun.from
                    : (chosenRun.from + chosenRun.to) / 2,
              )}
              y={PLAN_RULER + 20}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              className="fill-foreground stroke-card"
              strokeWidth={3}
              style={{ paintOrder: 'stroke' }}
              data-testid="plan-number"
              pointerEvents="none"
            >
              {holdingLabel}
            </text>
          ) : null}
        </svg>
        {chosenRun && dials && chosen ? (
          <>
            {handle(
              'from',
              chosenRun.from,
              `Start of ${chosen.name}`,
              chosenRun.from,
              dials.from.min,
              dials.from.max,
            )}
            {handle(
              'move',
              (chosenRun.from + chosenRun.to) / 2,
              `Position of ${chosen.name}`,
              chosenRun.from,
              dials.from.min,
              dials.to.max - (chosenRun.to - chosenRun.from),
            )}
            {handle(
              'to',
              chosenRun.to,
              `End of ${chosen.name}`,
              chosenRun.to,
              dials.to.min,
              dials.to.max,
            )}
          </>
        ) : null}
        {/* the chosen contour's depth along the board, its keys to drag */}
        {chosenFeature && dials && chosen ? (
          <ContourLaw
            fit={fit}
            feature={chosenFeature}
            name={chosen.name}
            depthMax={dials.depth.max}
            units={units}
            colour={colourOfKind(chosen.kind)}
            xAt={xOf}
          />
        ) : null}
        {/* the stations along the foot: one tab stop, the arrow keys move the choice */}
        <div
          role="toolbar"
          aria-label="Stations along the board"
          aria-orientation="horizontal"
          data-testid="plan-stations"
          onKeyDown={onLaneKey}
          className="relative h-7 pointer-coarse:h-14"
        >
          {marks.map((m, i) => {
            const isChosen = chosenIndex === i;
            const name = stationLabel(i, marks.length, m.x, units);
            return (
              <button
                key={i}
                type="button"
                data-tick={i}
                aria-pressed={isChosen}
                aria-label={name}
                title={`${name}. Click to choose it.`}
                tabIndex={isChosen || (chosenIndex === null && i === 0) ? 0 : -1}
                onClick={() => onStation(sliceOfStation(i))}
                style={{ left: planX(fit, m.x) - 11 }}
                className="absolute inset-y-0 flex w-[22px] cursor-pointer flex-col items-center justify-start rounded-sm outline-none before:absolute before:-inset-x-3 before:inset-y-0 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:before:-inset-x-4"
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 block rounded-full',
                    isChosen ? 'h-4 w-1 bg-primary' : 'h-3 w-0.5 bg-foreground/60',
                  )}
                />
                <span
                  aria-hidden
                  className={cn(
                    'text-[10px] leading-none',
                    isChosen ? 'font-semibold text-primary' : 'text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                {/* a station the chosen contour runs over, where the slice can show it: marked in its colour */}
                {chosenRun && chosen && m.x > chosenRun.from && m.x < chosenRun.to ? (
                  <span
                    aria-hidden
                    data-in-run
                    className="mt-0.5 block h-0.5 w-3.5 rounded-full"
                    style={{ background: colourOfKind(chosen.kind) }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
});

/** How wide a contour is across the bottom at the middle of its run, cm: the order it is drawn in, the widest first. */
function spanAt(f: BottomFeature, half: HalfWidths): number {
  const { from, to } = contourExtent(f);
  const bands = contourBands(f, half.plus((from + to) / 2));
  return Math.max(...bands.map((b) => b.to)) - Math.min(...bands.map((b) => b.from));
}
