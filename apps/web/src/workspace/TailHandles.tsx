// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Tail step's handles, laid over the outline editor: a round handle on each corner of the tail, which sets that
 * corner's radius, and a handle on the tail's width, which sets the width where the shape has one.
 *
 * - **A radius handle** stands out from its corner on the line to the centre of the arc that rounds it, tethered to the
 *   corner (`tail-handles.ts` places it, a little off that line where another handle would be under it). A press chooses
 *   the corner; a drag changes the radius, one undo step for the gesture, with the radius written beside it in the display
 *   unit; the arrow keys step it (a millimetre, ten with Shift or Page Up and Down), Home and End take it to the least and
 *   the most. It is a slider to a screen reader and a keyboard, with its name in its tooltip, and 44 px to a fingertip.
 * - **A width handle** stands where the width is measured (the corner on a squash, a diamond, a swallow and a fish) and
 *   drags across the board; the width is written on the line between the two sides, in the display unit.
 *
 * The notch depth has no handle of its own: the notch bottom is a point of the outline, and the editor under this
 * moves it (the store takes that for the depth). The outline's own points and handles are the editor's, and stay as
 * they were.
 */
import type { EditorFrame } from '@openshaper/render2d';
import { tailWidthRange } from '@openshaper/store/rails';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtLen, type LengthUnit } from '../format';
import { railsStore } from '../store';
import { useIsCoarsePointer } from '../useMediaQuery';
import {
  COARSE_HANDLES,
  FINE_HANDLES,
  cornerImages,
  distanceAlong,
  draggedRadius,
  placeRadiusHandles,
  widthHandleName,
  widthImages,
  widthSpot,
  type CornerImage,
  type WidthImage,
} from './tail-handles';
import { sameCorner, setChosenCorner, useChosenCorner } from './tail-choice';
import { lengthStep, sentence } from './tail-panel';
import { useTail, type TailView } from './tail-data';
import { useCoalescedEdit } from './use-coalesced-edit';

type Place = (e: { clientX: number; clientY: number }) => readonly [number, number];

/** What a handle's keys do to a number: the step the key asks for (in cm), or null for a key that is none of its. */
function keyStep(e: KeyboardEvent, units: LengthUnit): number | 'least' | 'most' | null {
  const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown';
  const step = lengthStep(units, big);
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowRight':
    case 'PageUp':
      return step;
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'PageDown':
      return -step;
    case 'Home':
      return 'least';
    case 'End':
      return 'most';
    default:
      return null;
  }
}

// --- the round handle of a corner ---------------------------------------------------------------------

function RadiusHandle({
  image,
  at,
  units,
  chosen,
  place,
}: {
  image: CornerImage;
  /** Where it stands on the pane: `placeRadiusHandles` says, so that no two handles overlap. */
  at: { x: number; y: number };
  units: LengthUnit;
  chosen: boolean;
  place: Place;
}) {
  const { corner } = image;
  const edit = useCoalescedEdit();
  const grab = useRef<{ radius: number; distance: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const set = (asked: number) =>
    railsStore
      .getState()
      .setCornerRadius(
        corner.side === 'tail' ? 'tail' : corner.index,
        asked,
        corner.side === 'tail' ? undefined : corner.side,
      );
  const choose = () => setChosenCorner({ side: corner.side, index: corner.index });

  const name = sentence(corner.label);
  const text = `${name}: radius ${fmtLen(corner.radius, units)}`;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { radius: corner.radius, distance: distanceAlong(image, place(e)) };
    edit.begin();
    setDragging(true);
    choose();
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (!g) return;
    set(draggedRadius(g.radius, g.distance, distanceAlong(image, place(e)), corner.turn));
  };
  const release = () => {
    grab.current = null;
    setDragging(false);
    edit.end();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = keyStep(e, units);
    if (step === null) return;
    // the handle's own keys: held, they are one step, and the editor's key handler has no claim on them
    e.preventDefault();
    e.stopPropagation();
    edit.begin();
    set(
      step === 'least'
        ? corner.range.min
        : step === 'most'
          ? corner.range.max
          : corner.radius + step,
    );
  };

  return (
    <>
      <button
        type="button"
        role="slider"
        aria-label={`${name} radius`}
        aria-valuemin={corner.range.min}
        aria-valuemax={corner.range.max}
        aria-valuenow={corner.radius}
        aria-valuetext={fmtLen(corner.radius, units)}
        aria-current={chosen ? 'true' : undefined}
        title={text}
        data-testid={`tail-radius-handle-${image.key}`}
        data-chosen={chosen ? 'true' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
        onKeyUp={() => edit.end()}
        onFocus={() => {
          setFocused(true);
          choose();
        }}
        onBlur={() => {
          setFocused(false);
          edit.end();
        }}
        style={{ left: at.x, top: at.y, touchAction: 'none' }}
        className="group pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <span
          aria-hidden
          className={`block rounded-full border-2 border-primary shadow-sm transition-[width,height] group-focus-visible:ring-2 group-focus-visible:ring-ring ${
            chosen ? 'h-4 w-4 bg-primary' : 'h-3 w-3 bg-background'
          }`}
        />
      </button>
      {dragging || focused ? (
        <span
          aria-hidden
          data-testid={dragging ? 'tail-radius-readout' : undefined}
          style={{ left: at.x + 12, top: at.y - 22 }}
          className="pointer-events-none absolute whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[11px] text-popover-foreground shadow ring-1 ring-border"
        >
          {dragging ? `Radius ${fmtLen(corner.radius, units)}` : text}
        </span>
      ) : null}
    </>
  );
}

// --- the handle of the width --------------------------------------------------------------------------

function WidthHandle({
  image,
  tail,
  frame,
  units,
  place,
}: {
  image: WidthImage;
  tail: TailView;
  frame: EditorFrame;
  units: LengthUnit;
  place: Place;
}) {
  const edit = useCoalescedEdit();
  const grab = useRef<{ width: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const range = tailWidthRange(tail.doc, image.shape, image.side);
  const set = (asked: number) =>
    railsStore.getState().setTailShape({ shape: image.shape, width: asked }, image.side);
  // the handle stands outside the board, in line with where the width is measured: the outline's own point is there
  const { at } = widthSpot(image, frame.toPane);
  const name = widthHandleName(image.shape);
  const text = `${name}: ${fmtLen(image.width, units)}`;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { width: image.width, y: place(e)[1] };
    edit.begin();
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (g) set(g.width + 2 * image.sign * (place(e)[1] - g.y));
  };
  const release = () => {
    grab.current = null;
    setDragging(false);
    edit.end();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = keyStep(e, units);
    if (step === null) return;
    e.preventDefault();
    e.stopPropagation();
    edit.begin();
    set(step === 'least' ? range.min : step === 'most' ? range.max : image.width + step);
  };

  return (
    <>
      <button
        type="button"
        role="slider"
        aria-label={name}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={image.width}
        aria-valuetext={fmtLen(image.width, units)}
        title={text}
        data-testid={`tail-width-handle-${image.key}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
        onKeyUp={() => edit.end()}
        onBlur={() => edit.end()}
        style={{ left: at.x, top: at.y, touchAction: 'none' }}
        className="group pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize items-center justify-center outline-none pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <span
          aria-hidden
          className="block h-3 w-3 rotate-45 border-2 border-primary bg-background shadow-sm group-focus-visible:ring-2 group-focus-visible:ring-ring"
        />
      </button>
      {dragging ? (
        <span
          aria-hidden
          style={{ left: at.x + 14, top: at.y - 10 }}
          className="pointer-events-none absolute whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[11px] text-popover-foreground shadow ring-1 ring-border"
        >
          {`Width ${fmtLen(image.width, units)}`}
        </span>
      ) : null}
    </>
  );
}

// --- the layer ----------------------------------------------------------------------------------------

/** The handles of the tail, given where the board lies on the pane now. */
export function TailHandles({ frame, units }: { frame: EditorFrame; units: LengthUnit }) {
  const tail = useTail();
  const chosen = useChosenCorner();
  // a fingertip's 44 px squares and a mouse's 24 px ones are laid out apart: the handles of a small tail are close
  const layout = useIsCoarsePointer() ? COARSE_HANDLES : FINE_HANDLES;
  const layer = useRef<HTMLDivElement>(null);
  if (!tail) return null;

  // a pointer's place in board cm: the layer is the pane, so the pane's own mapping reads it
  const place: Place = (e) => {
    const box = layer.current?.getBoundingClientRect();
    const w = frame.fromPane({ x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
    return [w.x, w.y];
  };
  const mirror = tail.doc.outline.minus === undefined;
  const corners = cornerImages(tail.corners, mirror);
  const widths = widthImages(tail.doc);
  const spots = widths.map((w) => widthSpot(w, frame.toPane));
  const stands = placeRadiusHandles(
    corners,
    frame.toPane,
    frame.scale,
    layout,
    spots.map((s) => s.at),
    { width: frame.width, height: frame.height },
  );
  const ends =
    widths.length === 2 ? widths.map((w) => frame.toPane({ x: w.point[0], y: w.point[1] })) : [];
  const mid =
    ends.length === 2
      ? { x: (ends[0]!.x + ends[1]!.x) / 2, y: (ends[0]!.y + ends[1]!.y) / 2 }
      : null;

  return (
    <div ref={layer} className="pointer-events-none absolute inset-0" data-testid="tail-handles">
      <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        {corners.map((c) => {
          const from = frame.toPane({ x: c.vertex[0], y: c.vertex[1] });
          const to = stands.get(c.key) ?? from;
          return (
            <line
              key={c.key}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--primary)"
              strokeOpacity={
                sameCorner(chosen, { side: c.corner.side, index: c.corner.index }) ? 0.9 : 0.45
              }
              strokeWidth={1}
            />
          );
        })}
        {widths.map((w, i) => (
          <line
            key={`tether-${w.key}`}
            x1={spots[i]!.measured.x}
            y1={spots[i]!.measured.y}
            x2={spots[i]!.at.x}
            y2={spots[i]!.at.y}
            stroke="var(--primary)"
            strokeOpacity={0.45}
            strokeWidth={1}
          />
        ))}
        {ends.length === 2 ? (
          <line
            x1={ends[0]!.x}
            y1={ends[0]!.y}
            x2={ends[1]!.x}
            y2={ends[1]!.y}
            stroke="var(--primary)"
            strokeOpacity={0.5}
            strokeDasharray="4 3"
          />
        ) : null}
      </svg>
      {mid !== null ? (
        <span
          aria-hidden
          data-testid="tail-width-label"
          style={{ left: mid.x - 8, top: mid.y, transform: 'translate(-100%, -50%)' }}
          className="pointer-events-none absolute whitespace-nowrap rounded bg-background/80 px-1 text-[11px] text-foreground"
        >
          {fmtLen(widths[0]!.width, units)}
        </span>
      ) : null}
      {widths.map((w) => (
        <WidthHandle key={w.key} image={w} tail={tail} frame={frame} units={units} place={place} />
      ))}
      {corners.map((c) => (
        <RadiusHandle
          key={c.key}
          image={c}
          at={stands.get(c.key) ?? frame.toPane({ x: c.vertex[0], y: c.vertex[1] })}
          units={units}
          chosen={sameCorner(chosen, { side: c.corner.side, index: c.corner.index })}
          place={place}
        />
      ))}
    </div>
  );
}
