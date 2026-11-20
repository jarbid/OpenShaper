// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station strip: the board's stations laid out tail to nose, to scale, in the display unit, a tick for
 * each. The chosen station's tick is marked, and the drawing beside the strip is the section there.
 *
 * It holds no board and reads no store: it is given the stations, which is chosen and what to do, so
 * the Deck step and the Bottom step draw it the same way. A click or a tap on a tick chooses it; a drag
 * moves it, held between its neighbours by whoever moves it; pointing at the strip (a mouse) offers a "+"
 * that adds a station there; the Add and Remove buttons add one after the chosen station and remove the
 * chosen one, which is how a keyboard or a touch screen does both.
 *
 * ## Keyboard and assistive technology
 *
 * The ticks are a toolbar of buttons, one per station in board order, with one tab stop (the chosen one).
 * The arrow keys, Home and End move the choice; Enter and Space choose; Delete removes the chosen
 * station; Shift with an arrow moves it half a centimetre (five with Ctrl or Cmd too). Keys the strip
 * uses do not reach the editor's own key handler.
 */
import { cn } from '@openshaper/ui';
import { Plus, Trash2 } from 'lucide-react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { fmtLen, type LengthUnit } from '../format';
import { useElementSize } from '../use-element-size';
import {
  MAP_PAD,
  dragTarget,
  grabOffsetOf,
  isDrag,
  pxToX,
  rulerTicks,
  xToPx,
  type Frame,
} from './rail-map';
import {
  canAddAt,
  choiceAfterKey,
  movedByKey,
  nearestStation,
  numbersFit,
  placeAfter,
  stationLabel,
  tickPositions,
  type StationMark,
} from './station-strip';

export interface StationStripProps {
  /** The stations in board order, tail to nose. */
  stations: readonly StationMark[];
  /** The chosen station's index, or null. */
  chosen: number | null;
  /** The board's length, cm. */
  length: number;
  units: LengthUnit;
  /** The fewest stations a board keeps: Remove stops there. */
  minStations: number;
  /** Choose a station. */
  onChoose: (index: number) => void;
  /** Move a station to a place (cm from the tail). Called for every move of a drag or a key; the caller holds it between the neighbours. */
  onMove: (index: number, x: number) => void;
  /** Add a station at a place (cm from the tail). */
  onAdd: (x: number) => void;
  /** Remove a station. */
  onRemove: (index: number) => void;
  /** A drag, or a key held down, that moves stations begins and ends, so the moves are one undo step. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  /** What the last action said ("There is no room for a station here."), shown beside the readout. */
  status?: string;
  /** The strip's own label, for the page when there is more than one. */
  label?: string;
}

/** Height of the ruler, px. */
const RULER_HEIGHT = 16;

const BAR_BUTTON =
  'inline-flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11';

/** Stop a key the strip uses from also reaching the editor's own key handler. */
function consume(e: { preventDefault(): void; stopPropagation(): void }) {
  e.preventDefault();
  e.stopPropagation();
}

export const StationStrip = memo(function StationStrip({
  stations,
  chosen,
  length,
  units,
  minStations,
  onChoose,
  onMove,
  onAdd,
  onRemove,
  onGestureStart,
  onGestureEnd,
  status,
  label = 'Stations',
}: StationStripProps) {
  const strip = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(strip, { width: 640, height: 0 });
  const frame = useMemo<Frame>(() => ({ width, length }), [width, length]);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{
    id: number;
    index: number;
    grab: number;
    left: number;
    origin: { x: number; y: number };
    started: boolean;
  } | null>(null);
  const keyEdit = useRef(false);

  // a gesture still open when the strip goes (the step changed under the pointer) is closed, not left open
  const end = useRef(onGestureEnd);
  end.current = onGestureEnd;
  useEffect(
    () => () => {
      if (drag.current?.started || keyEdit.current) end.current?.();
      drag.current = null;
      keyEdit.current = false;
    },
    [],
  );

  const at = useMemo(() => tickPositions(stations, frame), [stations, frame]);
  const ticks = useMemo(() => rulerTicks(frame, units), [frame, units]);
  const numbered = useMemo(() => numbersFit(stations, frame), [stations, frame]);
  const count = stations.length;
  const here = chosen === null ? undefined : stations[chosen];
  const after = placeAfter(stations, chosen, length);
  const canRemove = chosen !== null && count > minStations;

  /** The lane's left edge, which a pixel across the strip is measured from. */
  const laneLeft = () => lane.current?.getBoundingClientRect().left ?? 0;

  // --- the "+" under the pointer
  const onLaneMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || drag.current) return;
    const px = e.clientX - laneLeft();
    setHover(canAddAt(stations, frameRef.current, px) ? px : null);
  };
  const addHere = () => {
    if (hover === null) return;
    onAdd(pxToX(hover, frameRef.current));
    setHover(null);
  };
  /** A click on the bare lane chooses the nearest station: a tap on a thin tick needs no aim. */
  const onLaneClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const nearest = nearestStation(stations, pxToX(e.clientX - laneLeft(), frameRef.current));
    if (nearest !== null) onChoose(nearest);
  };

  // --- dragging a tick
  const onTickDown = (index: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // keep the browser from giving the tick focus by its own rules and from starting a text selection
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const left = laneLeft();
    drag.current = {
      id: e.pointerId,
      index,
      grab: grabOffsetOf(xToPx(stations[index]!.x, frameRef.current), e.clientX, left),
      left,
      origin: { x: e.clientX, y: e.clientY },
      started: false,
    };
    onChoose(index);
  };
  const onTickMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.started) {
      if (!isDrag(d.origin, { x: e.clientX, y: e.clientY })) return;
      d.started = true;
      onGestureStart?.();
    }
    onMove(d.index, dragTarget(e.clientX, d.left, d.grab, frameRef.current));
  };
  const onTickUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d.started) onGestureEnd?.();
  };

  // --- the keys
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('[data-tick]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      consume(e);
      if (canRemove) onRemove(chosen!);
      return;
    }
    if (e.shiftKey && here !== undefined && chosen !== null) {
      const x = movedByKey(here.x, e.key, e.ctrlKey || e.metaKey, length);
      if (x === null) return;
      consume(e);
      if (!keyEdit.current) {
        keyEdit.current = true;
        onGestureStart?.();
      }
      onMove(chosen, x);
      return;
    }
    const next = choiceAfterKey(e.key, chosen, count);
    if (next === null) return;
    consume(e);
    if (next !== chosen) {
      onChoose(next);
      lane.current?.querySelector<HTMLElement>(`[data-tick="${next}"]`)?.focus();
    }
  };
  const closeKeyEdit = () => {
    if (!keyEdit.current) return;
    keyEdit.current = false;
    onGestureEnd?.();
  };

  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {here ? (
            <>
              <span className="font-medium text-foreground">
                Station {chosen! + 1} of {count}
              </span>
              , {fmtLen(here.x, units)} from the tail.
            </>
          ) : (
            'No station is chosen.'
          )}{' '}
          <span role="status" aria-live="polite">
            {status}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={BAR_BUTTON}
            disabled={after === null}
            title={
              after === null
                ? 'There is no room after this station.'
                : `Add a station ${fmtLen(after, units)} from the tail, after this one`
            }
            onClick={() => after !== null && onAdd(after)}
          >
            <Plus aria-hidden className="size-3.5" />
            Add station
          </button>
          <button
            type="button"
            className={BAR_BUTTON}
            disabled={!canRemove}
            title={
              canRemove
                ? 'Remove this station'
                : count <= minStations
                  ? `A board keeps at least ${minStations} stations.`
                  : 'Choose a station to remove.'
            }
            onClick={() => canRemove && onRemove(chosen!)}
          >
            <Trash2 aria-hidden className="size-3.5" />
            Remove station
          </button>
        </div>
      </div>
      <div ref={strip} data-testid="station-strip" className="relative select-none">
        <svg
          width={width}
          height={RULER_HEIGHT}
          aria-hidden
          className="block text-muted-foreground"
        >
          <line
            x1={MAP_PAD}
            x2={width - MAP_PAD}
            y1={RULER_HEIGHT - 1}
            y2={RULER_HEIGHT - 1}
            stroke="currentColor"
            strokeOpacity={0.5}
          />
          {ticks.map((t) => {
            const x = xToPx(t.x, frame);
            const anchor = x < MAP_PAD + 22 ? 'start' : x > width - MAP_PAD - 22 ? 'end' : 'middle';
            return (
              <g key={t.x}>
                <line
                  x1={x}
                  x2={x}
                  y1={RULER_HEIGHT - 6}
                  y2={RULER_HEIGHT - 1}
                  stroke="currentColor"
                  strokeOpacity={0.6}
                />
                <text
                  x={x}
                  y={RULER_HEIGHT - 9}
                  fontSize={10}
                  textAnchor={anchor}
                  fill="currentColor"
                >
                  {t.label}
                </text>
              </g>
            );
          })}
        </svg>
        <div
          ref={lane}
          role="toolbar"
          aria-label={`${label} along the board`}
          aria-orientation="horizontal"
          data-testid="station-lane"
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key.startsWith('Arrow') || e.key === 'Shift') closeKeyEdit();
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) closeKeyEdit();
          }}
          onPointerMove={onLaneMove}
          onPointerLeave={() => setHover(null)}
          onClick={onLaneClick}
          // 40 px for a mouse; the finger's 56
          className="relative h-10 cursor-pointer pointer-coarse:h-14"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border"
            style={{ left: MAP_PAD, width: Math.max(0, width - 2 * MAP_PAD) }}
          />
          {stations.map((s, i) => {
            const isChosen = chosen === i;
            const name = stationLabel(i, count, s.x, units);
            return (
              <button
                key={i}
                type="button"
                data-tick={i}
                aria-pressed={isChosen}
                aria-label={name}
                title={`${name}. Click to choose it, drag to move it.`}
                tabIndex={isChosen || (chosen === null && i === 0) ? 0 : -1}
                onClick={() => onChoose(i)}
                onPointerDown={onTickDown(i)}
                onPointerMove={onTickMove}
                onPointerUp={onTickUp}
                onPointerCancel={onTickUp}
                style={{ left: at[i]! - 11 }}
                className={cn(
                  'absolute inset-y-0 z-[2] flex w-[22px] cursor-ew-resize touch-none flex-col items-center justify-center gap-0.5 rounded-sm outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  // the finger's 44 px, around a 22 px tick
                  'before:absolute before:-inset-x-3 before:inset-y-0 before:content-[""] pointer-coarse:before:-inset-x-4',
                  isChosen ? 'z-[3]' : '',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'block rounded-full',
                    isChosen ? 'h-8 w-1 bg-primary' : 'h-5 w-0.5 bg-foreground/60',
                  )}
                />
                {numbered || isChosen ? (
                  <span
                    aria-hidden
                    className={cn(
                      'text-[10px] leading-none',
                      isChosen ? 'font-semibold text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                ) : null}
              </button>
            );
          })}
          {hover !== null && (
            <button
              type="button"
              aria-label="Add a station here"
              title="Add a station here"
              tabIndex={-1}
              onClick={addHere}
              style={{ left: hover - 12 }}
              className="absolute -bottom-3 z-[6] grid size-6 place-items-center rounded-full border border-foreground/40 bg-background text-foreground opacity-70 shadow-sm outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
            >
              <Plus aria-hidden className="size-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
});
