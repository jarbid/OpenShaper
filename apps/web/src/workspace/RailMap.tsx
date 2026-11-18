// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail map: the board's rail laid out straight, tail to nose, to scale, in the display unit.
 *
 * Each zone is a block in its colour on the 3D board, named for its rail; each blend is a gradient
 * between its neighbours' colours; a zone of no length is a tick. With the sides one list there is one
 * lane; when they differ, or one side is being edited, two (Left over Right). A click chooses a zone or
 * a blend and puts the cursor there; the ruler moves the cursor alone; a handle at a zone's end drags
 * it, one undo step; pointing at a lane offers a "+" that adds a zone.
 *
 * What is chosen, and where the cursor is, is `rail-choice.ts`, shared with the board and the panel.
 * The strip reads the rails board itself, so an edit re-renders the map and not the shell, and each
 * lane is memoised on its zones, its choice and the width.
 *
 * ## Keyboard and assistive technology
 *
 * The strip is a toolbar of buttons, one per zone and blend, in board order, with one tab stop (the
 * chosen one). Arrow keys move the choice along a lane (Left and Right) or to the other lane (Up and
 * Down), Home and End go to its ends, Delete removes the chosen zone. A zone's ends are sliders: arrow
 * keys nudge one by 0.5 cm, with Shift by 5 cm. The ruler is the place's slider: arrows move it, Enter
 * adds a zone there. Keys the map uses do not reach the editor's own key handler.
 */
import { railName } from '@openshaper/store/rails';
import { ChevronRight, Plus, Broom } from 'lucide-react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from 'react';
import { cmToUnitNumber, fmtLen, type LengthUnit } from '../format';
import { chooseRail } from '../patch-look';
import { useRailChoice, useRailPlace, useRailSides, setRailPlace } from '../rail-choice';
import { sideWord } from '../patch-text';
import {
  useBoardLength,
  useBoardRails,
  zonesOfSide,
  type Side,
  type SideZones,
} from '../rail-zones';
import { railZoneColor } from '@openshaper/render3d/patches';
import { railsStore } from '../store';
import { useElementSize } from '../use-element-size';
import { cn } from '@openshaper/ui';
import { useMyRails, type SavedRail } from '../my-rails';
import {
  addZoneAt,
  addZoneAtCursor,
  editSidesOf,
  laneEditSide,
  removeChosenZone,
  showsTwoLanes,
  tidyBoard,
} from './rail-actions';
import {
  MAP_PAD,
  NUDGE,
  NUDGE_BIG,
  canAddAt,
  clickPlace,
  dragTarget,
  fitLabel,
  gradientCss,
  grabOffsetOf,
  isDrag,
  laneHandles,
  laneLayout,
  nudged,
  pxToX,
  readableOn,
  rulerTicks,
  xToPx,
  type Frame,
  type HandleSpot,
} from './rail-map';

/** Height of the ruler, px. */
const RULER_HEIGHT = 26;

/** A block's accessible name. */
const spanText = (from: number, to: number, units: LengthUnit): string =>
  from === to ? `at ${fmtLen(from, units)}` : `from ${fmtLen(from, units)} to ${fmtLen(to, units)}`;

// --- one lane --------------------------------------------------------------------------------------

interface LaneProps {
  side: Side;
  /** "Left" or "Right" when the map has two lanes, else null. */
  label: string | null;
  twoLanes: boolean;
  zones: SideZones;
  frame: Frame;
  units: LengthUnit;
  mine: readonly SavedRail[];
  chosenZone: number | null;
  chosenBlend: number | null;
  /** This lane holds the strip's tab stop when nothing is chosen. */
  firstLane: boolean;
  stripRef: RefObject<HTMLDivElement | null>;
  frameRef: MutableRefObject<Frame>;
}

const Lane = memo(function Lane({
  side,
  label,
  twoLanes,
  zones,
  frame,
  units,
  mine,
  chosenZone,
  chosenBlend,
  firstLane,
  stripRef,
  frameRef,
}: LaneProps) {
  const lane = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{
    id: number;
    zone: number;
    end: 'from' | 'to';
    grab: number;
    left: number;
    origin: { x: number; y: number };
    started: boolean;
  } | null>(null);
  const keyEdit = useRef(false);
  // a drag still open when the lane goes (the step changed under the pointer) is ended, not left open
  useEffect(
    () => () => {
      if (drag.current || keyEdit.current) {
        drag.current = null;
        keyEdit.current = false;
        const s = railsStore.getState();
        if (s.editing) s.endEdit();
      }
    },
    [],
  );

  const layout = useMemo(() => laneLayout(zones, frame), [zones, frame]);
  const handles = useMemo(() => laneHandles(zones, frame, chosenZone), [zones, frame, chosenZone]);
  const names = useMemo(() => zones.zones.map((z) => railName(z.rail, mine)), [zones, mine]);
  const edit = laneEditSide(twoLanes, side);
  const prefix = label ? `${label} ` : '';

  /** The strip's left edge, which a pixel across the strip is measured from. */
  const stripLeft = () => stripRef.current?.getBoundingClientRect().left ?? 0;

  const choose = (selection: { zone: number } | { blend: number }, place: number) =>
    chooseRail({ side, ...selection }, place);

  const onZoneClick = (zone: number) => (e: MouseEvent<HTMLButtonElement>) => {
    const z = zones.zones[zone]!;
    const px = e.detail === 0 ? null : e.clientX - stripLeft();
    choose({ zone }, clickPlace(z.from, z.to, px, frameRef.current));
  };
  const onBlendClick = (blend: number) => (e: MouseEvent<HTMLButtonElement>) => {
    const b = zones.blends[blend]!;
    const px = e.detail === 0 ? null : e.clientX - stripLeft();
    choose({ blend }, clickPlace(b.from, b.to, px, frameRef.current));
  };

  // --- the "+" under the pointer
  const onLaneMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || drag.current) return;
    const left = lane.current?.getBoundingClientRect().left ?? 0;
    const px = e.clientX - left;
    setHover(canAddAt(zones, frameRef.current, px) ? px : null);
  };
  const addHere = () => {
    if (hover === null) return;
    const x = pxToX(hover, frameRef.current);
    addZoneAt(x, side, laneEditSide(twoLanes, side));
    setHover(null);
  };

  // --- dragging a zone's end
  const begin = () => {
    const s = railsStore.getState();
    if (!s.editing) s.beginEdit();
  };
  const finish = () => {
    const s = railsStore.getState();
    if (s.editing) s.endEdit();
  };
  const onHandleDown = (h: HandleSpot) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    // preventing the default stops the browser giving the handle focus: it is taken here, so the arrow keys nudge it next
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const left = stripLeft();
    drag.current = {
      id: e.pointerId,
      zone: h.zone,
      end: h.end,
      grab: grabOffsetOf(h.placePx, e.clientX, left),
      left,
      origin: { x: e.clientX, y: e.clientY },
      started: false,
    };
    const z = zones.zones[h.zone]!;
    choose({ zone: h.zone }, z.from);
    begin();
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.started && !isDrag(d.origin, { x: e.clientX, y: e.clientY })) return;
    d.started = true;
    const x = dragTarget(e.clientX, d.left, d.grab, frameRef.current);
    railsStore.getState().moveZoneEnd(edit, d.zone, d.end, x);
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    finish();
  };
  const onHandleKey = (h: HandleSpot) => (e: KeyboardEvent<HTMLDivElement>) => {
    const z = zones.zones[h.zone]!;
    const at = h.end === 'from' ? z.from : z.to;
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0; // prettier-ignore
    if (dir === 0) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        consume(e);
        removeChosenZone(edit);
      }
      return;
    }
    consume(e);
    keyEdit.current = true;
    begin();
    railsStore
      .getState()
      .moveZoneEnd(edit, h.zone, h.end, nudged(at, dir, e.shiftKey, frameRef.current.length));
  };
  const onHandleKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!keyEdit.current || !e.key.startsWith('Arrow')) return;
    keyEdit.current = false;
    finish();
  };
  const onHandleBlur = () => {
    if (!keyEdit.current) return;
    keyEdit.current = false;
    finish();
  };

  const stopFor = (kind: 'zone' | 'blend', index: number): number => {
    const chosen = kind === 'zone' ? chosenZone === index : chosenBlend === index;
    const none = chosenZone === null && chosenBlend === null;
    return chosen || (none && firstLane && kind === 'zone' && index === 0) ? 0 : -1;
  };

  const blocks: React.ReactNode[] = [];
  zones.zones.forEach((z, i) => {
    const b = layout.zones[i]!;
    const color = railZoneColor(i);
    const chosen = chosenZone === i;
    blocks.push(
      <button
        key={`z${i}`}
        type="button"
        data-stop
        data-lane={side}
        data-kind="zone"
        data-index={i}
        aria-pressed={chosen}
        aria-label={`${prefix}Zone ${i + 1}: ${names[i]}, ${spanText(z.from, z.to, units)}`}
        title={`${names[i]} ${spanText(z.from, z.to, units)}`}
        tabIndex={stopFor('zone', i)}
        onClick={onZoneClick(i)}
        style={{
          left: b.left,
          width: b.width,
          background: color,
          color: readableOn(color),
        }}
        className={cn(
          'absolute inset-y-1 z-[2] flex items-center justify-center overflow-hidden px-1 text-[11px] font-medium leading-none outline-none',
          b.tick ? 'rounded-sm' : 'rounded-md',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          chosen && 'z-[3] ring-2 ring-foreground ring-offset-1 ring-offset-background',
        )}
      >
        {b.tick ? null : fitLabel(names[i]!, b.width)}
      </button>,
    );
    const blend = zones.blends[i];
    const g = layout.blends[i];
    if (blend && g) {
      const isChosen = chosenBlend === i;
      blocks.push(
        <button
          key={`b${i}`}
          type="button"
          data-stop
          data-lane={side}
          data-kind="blend"
          data-index={i}
          aria-pressed={isChosen}
          aria-label={`${prefix}Blend ${i + 1}: zone ${i + 1} to zone ${i + 2}, ${spanText(blend.from, blend.to, units)}`}
          title={`Blend between zone ${i + 1} and zone ${i + 2}`}
          tabIndex={stopFor('blend', i)}
          onClick={onBlendClick(i)}
          style={{
            left: g.left,
            width: Math.max(g.width, 3),
            background: gradientCss(railZoneColor(blend.before), railZoneColor(blend.after)),
          }}
          className={cn(
            'absolute inset-y-3 z-[1] rounded-sm outline-none pointer-coarse:inset-y-1',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            isChosen && 'z-[3] ring-2 ring-foreground ring-offset-1 ring-offset-background',
          )}
        />,
      );
    }
  });

  const lead = layout.lead;
  const trail = layout.trail;
  const holdClass = 'absolute inset-y-3 z-0 rounded-sm opacity-40';

  return (
    <div
      ref={lane}
      role="group"
      aria-label={label ? `${label} rail` : 'Rail'}
      data-lane={side}
      // 44 px for a mouse; a finger's block is 48 inside 56 (a zone's block is the lane less 4 px each way)
      className="relative h-11 pointer-coarse:h-14"
      onPointerMove={onLaneMove}
      onPointerLeave={() => setHover(null)}
    >
      {label && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0.5 top-1/2 z-[4] -translate-y-1/2 rotate-180 text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground [writing-mode:vertical-rl]"
        >
          {label}
        </span>
      )}
      {lead && (
        <div
          aria-hidden
          data-hold="lead"
          style={{ left: lead.left, width: lead.width, background: railZoneColor(lead.zone) }}
          className={holdClass}
          onClick={(e) => {
            const z = zones.zones[lead.zone]!;
            choose({ zone: lead.zone }, clickPlace(z.from, z.to, e.clientX - stripLeft(), frame));
          }}
        />
      )}
      {trail && (
        <div
          aria-hidden
          data-hold="trail"
          style={{ left: trail.left, width: trail.width, background: railZoneColor(trail.zone) }}
          className={holdClass}
          onClick={(e) => {
            const z = zones.zones[trail.zone]!;
            choose({ zone: trail.zone }, clickPlace(z.from, z.to, e.clientX - stripLeft(), frame));
          }}
        />
      )}
      {blocks}
      {handles.map((h) => {
        const z = zones.zones[h.zone]!;
        const at = h.end === 'from' ? z.from : z.to;
        const chosen = chosenZone === h.zone;
        const what = h.stretch
          ? `Draw out zone ${h.zone + 1}`
          : `${h.end === 'from' ? 'Start' : 'End'} of zone ${h.zone + 1}`;
        return (
          <div
            // the same element before and after a tick is drawn out: the grip becomes the zone's end handle, and
            // the drag that is holding it must not lose it
            key={`${h.zone}${h.end}`}
            role="slider"
            data-handle={`${h.zone}:${h.end}`}
            aria-label={`${prefix}${what}`}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={cmToUnitNumber(frame.length, units)}
            aria-valuenow={cmToUnitNumber(at, units)}
            aria-valuetext={fmtLen(at, units)}
            tabIndex={chosen ? 0 : -1}
            onPointerDown={onHandleDown(h)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={onHandleKey(h)}
            onKeyUp={onHandleKeyUp}
            onBlur={onHandleBlur}
            style={{ left: h.px - 6 }}
            className={cn(
              'absolute top-1/2 flex h-8 w-3 -translate-y-1/2 cursor-ew-resize touch-none select-none items-center justify-center rounded-sm border bg-background text-foreground shadow-sm outline-none',
              // the draw-out grip of the chosen tick is above its neighbours' handles, which can stand under it
              h.stretch ? 'z-[6]' : 'z-[5]',
              chosen ? 'border-foreground' : 'border-foreground/50',
              'focus-visible:ring-2 focus-visible:ring-ring',
              // the finger's 44 px, around a 12 px handle
              'before:absolute before:-inset-x-1 before:-inset-y-1 before:content-[""] pointer-coarse:before:-inset-x-4 pointer-coarse:before:-inset-y-3',
            )}
          >
            {h.stretch ? (
              <ChevronRight aria-hidden className="size-3" />
            ) : (
              <span aria-hidden className="h-4 w-px bg-current opacity-60" />
            )}
          </div>
        );
      })}
      {hover !== null && (
        <button
          type="button"
          aria-label={`${prefix}Add a zone here`}
          title="Add a zone here"
          tabIndex={-1}
          onClick={addHere}
          style={{ left: hover - 12 }}
          className="absolute -bottom-3 z-[6] grid size-6 place-items-center rounded-full border border-foreground/40 bg-background text-foreground opacity-70 shadow-sm outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        >
          <Plus aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
});

/** Stop a key the map uses from also reaching the editor's own key handler (a point selected in another step). */
function consume(e: { preventDefault(): void; stopPropagation(): void }) {
  e.preventDefault();
  e.stopPropagation();
}

// --- the map ---------------------------------------------------------------------------------------

export const RailMap = memo(function RailMap({ units }: { units: LengthUnit }) {
  const rails = useBoardRails();
  const length = useBoardLength();
  const mine = useMyRails();
  const choice = useRailChoice();
  const place = useRailPlace();
  const sides = useRailSides();
  const strip = useRef<HTMLDivElement>(null);
  /** The pointer scrubbing the ruler, if one is. */
  const scrub = useRef<number | null>(null);
  const { width } = useElementSize(strip, { width: 640, height: 0 });
  const frame = useMemo<Frame>(() => ({ width, length }), [width, length]);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const ticks = useMemo(() => rulerTicks(frame, units), [frame, units]);
  if (!rails || length <= 0) return null;

  const twoLanes = showsTwoLanes(rails, sides);
  const lanes: { side: Side; label: string | null }[] = twoLanes
    ? [
        { side: 'plus', label: capital(sideWord('plus')) },
        { side: 'minus', label: capital(sideWord('minus')) },
      ]
    : [{ side: 'plus', label: null }];
  const at = place ?? length / 2;
  const cursor = xToPx(at, frame);

  // --- the ruler: the place's slider
  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const left = strip.current?.getBoundingClientRect().left ?? 0;
    setRailPlace(pxToX(e.clientX - left, frameRef.current));
  };
  const onRulerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    scrub.current = e.pointerId;
    moveTo(e);
  };
  const onRulerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (scrub.current === e.pointerId) moveTo(e);
  };
  const onRulerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (scrub.current !== e.pointerId) return;
    scrub.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onRulerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? NUDGE_BIG : NUDGE;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      consume(e);
      setRailPlace(Math.max(0, at - big));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      consume(e);
      setRailPlace(Math.min(length, at + big));
    } else if (e.key === 'Home') {
      consume(e);
      setRailPlace(0);
    } else if (e.key === 'End') {
      consume(e);
      setRailPlace(length);
    } else if (e.key === 'Enter') {
      consume(e);
      addZoneAtCursor();
    }
  };

  // --- the toolbar: arrows move the choice
  const onStripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-stop]');
    if (!el || !strip.current) return;
    const stops = Array.from(strip.current.querySelectorAll<HTMLElement>('[data-stop]'));
    const lane = el.dataset.lane;
    const inLane = stops.filter((s) => s.dataset.lane === lane);
    const i = inLane.indexOf(el);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowRight') next = inLane[Math.min(inLane.length - 1, i + 1)];
    else if (e.key === 'ArrowLeft') next = inLane[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = inLane[0];
    else if (e.key === 'End') next = inLane[inLane.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const other = stops.filter((s) => s.dataset.lane !== lane);
      // the other lane's stop nearest this one's left edge
      const at0 = el.getBoundingClientRect().left;
      next = other.sort(
        (a, b) =>
          Math.abs(a.getBoundingClientRect().left - at0) -
          Math.abs(b.getBoundingClientRect().left - at0),
      )[0];
      if (next && (e.key === 'ArrowDown') !== (lane === 'plus')) next = undefined;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      consume(e);
      if (el.dataset.kind === 'zone') removeChosenZone(editSidesOf(sides));
      return;
    } else return;
    consume(e);
    if (next && next !== el) {
      next.focus();
      next.click();
    }
  };

  return (
    <section aria-label="Rail map" className="flex flex-col gap-1">
      <div
        ref={strip}
        role="toolbar"
        aria-label="Rail zones and blends"
        aria-orientation="horizontal"
        data-testid="rail-map"
        onKeyDown={onStripKey}
        className="relative select-none pb-2"
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label="Place along the board"
          aria-valuemin={0}
          aria-valuemax={cmToUnitNumber(length, units)}
          aria-valuenow={cmToUnitNumber(at, units)}
          aria-valuetext={fmtLen(at, units)}
          data-testid="rail-ruler"
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
          onKeyDown={onRulerKey}
          className="relative h-[26px] cursor-ew-resize touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
        >
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
              const anchor =
                x < MAP_PAD + 22 ? 'start' : x > width - MAP_PAD - 22 ? 'end' : 'middle';
              return (
                <g key={t.x}>
                  <line
                    x1={x}
                    x2={x}
                    y1={RULER_HEIGHT - 7}
                    y2={RULER_HEIGHT - 1}
                    stroke="currentColor"
                    strokeOpacity={0.6}
                  />
                  <text
                    x={x}
                    y={RULER_HEIGHT - 11}
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
        </div>
        {lanes.map((l, i) => {
          const zones = zonesOfSide(rails, l.side);
          const here =
            choice && (twoLanes ? choice.side === l.side : l.side === 'plus') ? choice : null;
          return (
            <Lane
              key={l.side}
              side={l.side}
              label={l.label}
              twoLanes={twoLanes}
              zones={zones}
              frame={frame}
              units={units}
              mine={mine}
              chosenZone={here?.zone ?? null}
              chosenBlend={here?.blend ?? null}
              firstLane={i === 0}
              stripRef={strip}
              frameRef={frameRef}
            />
          );
        })}
        <div
          aria-hidden
          data-testid="rail-cursor"
          style={{ left: cursor }}
          className="pointer-events-none absolute bottom-2 top-0 z-[7] w-px bg-foreground"
        >
          <span className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-foreground" />
        </div>
      </div>
    </section>
  );
});

const BAR_BUTTON =
  'inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11';

/**
 * What the map's header offers: Add zone (at the cursor, which is how a touch screen, with nothing to point
 * with, adds one) and Tidy rails. What the last of them said is `useRailStatus`, shown by the header.
 */
export const RailMapActions = memo(function RailMapActions() {
  const rails = useBoardRails();
  if (!rails) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button type="button" onClick={() => void addZoneAtCursor()} className={BAR_BUTTON}>
        <Plus aria-hidden className="size-3.5" />
        Add zone
      </button>
      <button
        type="button"
        onClick={() => void tidyBoard()}
        title="Join neighbouring zones whose rails differ by less than 1 mm of band or tuck, a tenth of a degree of edge or a tenth of a ratio"
        className={BAR_BUTTON}
      >
        <Broom aria-hidden className="size-3.5" />
        Tidy rails
      </button>
    </div>
  );
});

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
