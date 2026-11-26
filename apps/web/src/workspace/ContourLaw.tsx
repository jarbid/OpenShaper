// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A contour's law along the board: its depth against where along the board, under the plan and to the same
 * scale along the board, with a handle on each key of the curve between the two ends. Dragging a handle sideways
 * moves the key along the board (held between its neighbours) and up and down sets how deep the contour is
 * there; the arrow keys do the same a step at a time (left and right a centimetre, up and down a fifth of a
 * millimetre, ten times that with Shift). The two ends are the contour's extent and are dragged on the plan.
 *
 * Each move is `railsStore.setContourKey` computed from where the drag began, so a key is a function of the pointer,
 * and a drag or a held key is one undo step. The lane shows depth up to a centimetre, or the most the board holds
 * under the contour if that is less; the keys' numbers are under More in the panel.
 */
import type { BottomFeature } from '@openshaper/board2';
import { contourKeys } from '@openshaper/store/rails';
import { cn } from '@openshaper/ui';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cmToUnitNumber, fmtLen, fmtSmallLen, type LengthUnit } from '../format';
import { railsStore } from '../store';
import { useRailsDoc } from './deck-data';
import {
  LAW_HEIGHT,
  lawDepthAt,
  lawMax,
  lawPaths,
  lawY,
  planX,
  planNudge,
  type PlanFit,
} from './contour-plan';
import { dialStep } from './contour-panel';
import { MAP_PAD } from './rail-map';
import { useCoalescedEdit } from './use-coalesced-edit';

const consume = (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
};

export function ContourLaw({
  fit,
  feature,
  name,
  depthMax,
  units,
  colour,
  xAt,
}: {
  fit: PlanFit;
  feature: BottomFeature;
  /** The contour's name as the panel gives it ("Single concave", "Vee 2"). */
  name: string;
  /** The most depth the board lets this contour have (cm). */
  depthMax: number;
  units: LengthUnit;
  colour: string;
  /** The place along the board (cm from the tail) at a pointer's x. */
  xAt: (clientX: number) => number;
}) {
  const doc = useRailsDoc();
  const wrap = useRef<HTMLDivElement>(null);
  const edit = useCoalescedEdit();
  const drag = useRef<{ id: number; index: number } | null>(null);
  if (!doc) return null;

  const max = lawMax(depthMax);
  const keys = contourKeys(doc, feature.id);
  const { line, area } = lawPaths(fit, feature, max);
  const top = () => wrap.current?.getBoundingClientRect().top ?? 0;
  const set = (index: number, patch: { s?: number; value?: number }) =>
    railsStore.getState().setContourKey(feature.id, index, patch);

  const onDown = (index: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, index };
    edit.begin();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    set(d.index, { s: xAt(e.clientX), value: lawDepthAt(e.clientY - top(), max) });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    edit.end();
  };
  const onKey = (index: number, s: number, value: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    const along = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const deeper = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (along === 0 && deeper === 0) return;
    consume(e);
    edit.begin();
    if (along !== 0) set(index, { s: s + along * planNudge(e.shiftKey) });
    else set(index, { value: value + deeper * dialStep('depth', 'length', e.shiftKey) });
  };

  return (
    <div
      ref={wrap}
      className="relative"
      style={{ height: LAW_HEIGHT }}
      data-testid="contour-law"
      role="group"
      aria-label={`${name}: depth along the board`}
    >
      <svg
        width={fit.frame.width}
        height={LAW_HEIGHT}
        className="block text-foreground"
        aria-hidden
      >
        <line
          x1={MAP_PAD}
          x2={fit.frame.width - MAP_PAD}
          y1={lawY(0, max)}
          y2={lawY(0, max)}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
        <path d={area} fill={colour} fillOpacity={0.2} />
        <path d={line} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" />
        <text x={4} y={11} fontSize={10} className="fill-muted-foreground">
          Depth along the board, up to {fmtSmallLen(max, units)}
        </text>
      </svg>
      {keys.map((k) => (
        <div
          key={k.index}
          role="slider"
          tabIndex={0}
          aria-label={`Key ${k.index} of the law`}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={cmToUnitNumber(k.valueMax, units)}
          aria-valuenow={cmToUnitNumber(k.value, units)}
          aria-valuetext={`${fmtSmallLen(k.value, units)} deep at ${fmtLen(k.s, units)} from the tail`}
          title="Drag sideways to move it along the board and up or down to set how deep"
          data-testid={`law-key-${k.index}`}
          onPointerDown={onDown(k.index)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey(k.index, k.s, k.value)}
          onKeyUp={() => edit.end()}
          onBlur={() => edit.end()}
          style={{ left: planX(fit, k.s) - 7, top: lawY(k.value, max) - 7, borderColor: colour }}
          className={cn(
            'absolute z-[4] size-3.5 rotate-45 touch-none cursor-move rounded-sm border-2 bg-background shadow-sm outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring',
            // the finger's 44 px: a 14 px handle with a 2 px border, and 17 px more each side of its padding box
            'before:absolute before:-inset-3.5 before:content-[""] pointer-coarse:before:-inset-[17px]',
          )}
        />
      ))}
    </div>
  );
}
