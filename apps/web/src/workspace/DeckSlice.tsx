// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Deck step's slice: the board's section at the chosen station, to true scale, with the deck curve
 * drawn on it and one handle, the crown, on the curve where the rail starts to roll over it.
 *
 * Dragging the handle up and down sets the crown (the fall of the deck from the stringer's height down to the
 * handle), as the panel's dial does: one undo step for a drag, a held key or a slider, and the 3D board follows.
 * The handle is the same dial, so a Flat deck shows it off (a flat deck has no crown) and a Custom one, which is
 * shown with its own points in the cross-section editor, has none. What is behind the curve is the engine's
 * section as it is built, or the station's curves until the engine has answered; it lags a drag by a
 * frame, and the deck curve does not.
 */
import { minusHalf, stationCurvesOf } from '@openshaper/store';
import { bandAt, bandEdge } from '@openshaper/store/rails';
import { cn } from '@openshaper/ui';
import { memo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cmToUnitNumber, fmtLen, type LengthUnit } from '../format';
import { railsStore } from '../store';
import { useElementSize } from '../use-element-size';
import { setDeckStatus, useDeckScope } from './deck-choice';
import { useDeckStation, useRailsProjection, useStationProbe } from './deck-data';
import { crownOffReason, crownStep, heldNote } from './deck-panel';
import {
  crownAtPointer,
  crownMark,
  deckPaths,
  fitStation,
  flattenSpline,
  grabOf,
} from './deck-slice';
import { closedPath, toScreen } from './rail-slice';
import { useCoalescedEdit } from './use-coalesced-edit';

/** The size the slice is drawn at until it has been measured (no layout in tests and a prerender). */
const FALLBACK = { width: 640, height: 220 };

/** Stop a key the handle uses from also reaching the editor's own key handler. */
const consume = (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
};

export const DeckSlice = memo(function DeckSlice({
  units,
  slice,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  slice: number;
}) {
  const station = useDeckStation(slice);
  const board = useRailsProjection();
  const probe = useStationProbe(station ? (station.doc.stations[station.index]?.x ?? null) : null);
  const scope = useDeckScope();
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box, FALLBACK);
  const edit = useCoalescedEdit();
  /** The pointer holding the handle, and how far below the pointer the handle stood. */
  const drag = useRef<{ id: number; grab: number } | null>(null);

  if (!station || !board) return <NoDeck />;
  const { doc, index, reading, range } = station;
  const plus = board.stationCurves[index];
  const half = minusHalf(board);
  const minus = half && stationCurvesOf(half)?.[index];
  if (!plus || !reading || !(plus.w > 0 && plus.T > 0)) return <NoDeck />;

  const widths = [plus.w, minus?.w ?? plus.w];
  const frame = fitStation(
    widths,
    plus.T,
    Math.min(0, ...flattenSpline(plus.bottom).filter((_, i) => i % 2 === 1)),
    size,
  );
  if (!frame) return <NoDeck />;

  const x = doc.stations[index]!.x;
  const plusBand = bandAt(doc, 'plus', x);
  const mark = crownMark(frame, plus.deck, plus.w, plus.T, plusBand, 'left');
  const other = minus ?? plus;
  const decks = [
    deckPaths(plus.deck, bandEdge(plus.w, plusBand), frame, 'left'),
    deckPaths(
      other.deck,
      bandEdge(other.w, bandAt(doc, minus ? 'minus' : 'plus', x)),
      frame,
      'right',
    ),
  ];
  // The section behind the curve: the engine's own, from its fine polyline (the store's has 64 points, and a
  // rail's bend is two or three of them, which draws as a polygon); until the engine has answered, the store's.
  const drawn = probe ? (probe.fine ?? probe) : null;
  const plusSection = board.crossSections[slice]?.spline;
  const minusSection = half?.crossSections[slice]?.spline ?? plusSection;
  const left = drawn ? drawn.plus : plusSection ? flattenSpline(plusSection) : null;
  const right = drawn
    ? (drawn.minus ?? drawn.plus)
    : minusSection
      ? flattenSpline(minusSection)
      : null;
  const top = toScreen(frame, 0, plus.T, 'right');
  const bottom = toScreen(frame, 0, 0, 'right');

  const live = reading.shape === 'domed' && range !== null;
  const off = crownOffReason(reading.shape, range !== null);
  // the crown as the panel reads it, from the dome the curve is (the curve drawn is that dome exactly)
  const crown = reading.crown;

  const setCrown = (next: number) => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: next }, { station: index, all: scope === 'all' });
  };
  /** After an edit, say so when the station held the crown at the most it can. */
  const sayHeld = (asked: number) => {
    const note = heldNote(asked, range, units);
    setDeckStatus(note ?? '');
  };

  // --- the pointer
  const heightOf = (e: { clientY: number }) =>
    e.clientY - (box.current?.getBoundingClientRect().top ?? 0);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!live || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, grab: grabOf(mark.handle.y, heightOf(e)) };
    edit.begin();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const asked = crownAtPointer(frame, plus.T, heightOf(e), d.grab);
    setCrown(asked);
    sayHeld(asked);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    edit.end();
  };

  // --- the keys: the handle moves the way the arrow points, so Down is more crown
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live) return;
    const big = e.shiftKey;
    const dir =
      e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp'
          ? -1
          : 0;
    if (dir !== 0) {
      consume(e);
      edit.begin();
      const asked = crown + dir * crownStep(units, big || e.key.startsWith('Page'));
      setCrown(asked);
      sayHeld(asked);
    } else if (e.key === 'Home' || e.key === 'End') {
      consume(e);
      edit.begin();
      setCrown(e.key === 'Home' ? range!.min : range!.max);
    }
  };

  const label = `Crown ${fmtLen(crown, units)}`;
  const stringer = `M${top.x} ${top.y - 8} L${bottom.x} ${bottom.y + 8}`;

  return (
    <div
      ref={box}
      data-testid="deck-slice"
      className="relative h-full min-h-24 select-none overflow-hidden"
    >
      <svg
        role="img"
        aria-label={`Section of the board at the chosen station, with the deck ${
          reading.shape === 'custom' ? 'drawn by hand' : reading.shape
        }. ${label}.`}
        width={size.width}
        height={size.height}
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
        <path d={stringer} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="3 3" />
        {/* the deck curve on both sides: solid to the band edge, where the rail takes over, dashed from there to the wall */}
        {decks.map((d, i) => (
          <g key={i} fill="none" className="stroke-primary" strokeLinecap="round">
            <path d={d.visible} strokeWidth={2.25} />
            <path d={d.hidden} strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="3 3" />
          </g>
        ))}
        {/* the crown: the stringer's height carried over to the band edge, and the fall to the handle */}
        <g fill="none" stroke="currentColor" strokeOpacity={0.55} className="text-muted-foreground">
          <line x1={top.x} x2={mark.top.x} y1={top.y} y2={top.y} strokeDasharray="3 3" />
          <line x1={mark.top.x} x2={mark.top.x} y1={mark.top.y} y2={mark.handle.y} />
          <line x1={mark.top.x - 4} x2={mark.top.x + 4} y1={mark.top.y} y2={mark.top.y} />
          <line x1={mark.top.x - 4} x2={mark.top.x + 4} y1={mark.handle.y} y2={mark.handle.y} />
        </g>
        <text
          x={mark.top.x}
          y={mark.top.y - 8}
          textAnchor="middle"
          fontSize={11}
          className="fill-foreground"
        >
          {label}
        </text>
      </svg>
      <div
        role="slider"
        tabIndex={live ? 0 : -1}
        aria-label="Crown"
        aria-orientation="vertical"
        aria-disabled={!live}
        aria-valuemin={range ? cmToUnitNumber(range.min, units) : 0}
        aria-valuemax={range ? cmToUnitNumber(range.max, units) : 0}
        aria-valuenow={cmToUnitNumber(crown, units)}
        aria-valuetext={fmtLen(crown, units)}
        title={off ?? 'Drag up and down to set the crown'}
        data-testid="crown-handle"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onKeyUp={(e) => {
          if (/^(Arrow|Page|Home|End)/.test(e.key)) edit.end();
        }}
        onBlur={() => edit.end()}
        style={{ left: mark.handle.x - 8, top: mark.handle.y - 8 }}
        className={cn(
          'absolute size-4 touch-none rounded-full border-2 outline-none',
          live
            ? 'cursor-ns-resize border-primary bg-background shadow-sm'
            : 'cursor-not-allowed border-muted-foreground/60 bg-muted',
          'focus-visible:ring-2 focus-visible:ring-ring',
          // the finger's 44 px, around a 16 px handle
          'before:absolute before:-inset-3 before:content-[""] pointer-coarse:before:-inset-[14px]',
        )}
      />
    </div>
  );
});

/** What a place that has no deck to draw says: the very tip of the nose or the tail has no width. */
function NoDeck() {
  return (
    <p className="p-2 text-xs text-muted-foreground">
      Nothing to draw here: the board has no width or no thickness at this station.
    </p>
  );
}
