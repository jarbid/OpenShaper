// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Two panes one above the other with a divider between them that can be dragged or moved by keys:
 * the workspace's board over its drawing. (The repo has no other splitter.)
 *
 * The divider is a window splitter: `role="separator"`, focusable, `aria-valuenow` the top pane's
 * share in percent. Up and Down (and Left and Right) move it 2 %, Home and End go to the limits
 * of 25 % and 75 %. The arrows are consumed: the point editor nudges the selected point on any
 * arrow nobody else has used.
 *
 * The position lives here, in this component's state, so a drag re-renders this component and
 * nothing above it; `top` and `bottom` are the same elements they were, and React leaves them
 * alone. It is written to storage when a drag ends or a key is pressed, not on every move.
 */
import { cn } from '@openshaper/ui';
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  clampSplit,
  readSplit,
  splitAfterKey,
  splitAtPointer,
  splitPercent,
  SPLIT_MAX,
  SPLIT_MIN,
  writeSplit,
} from './split';

/** The divider's height in px (`h-3`), which the pointer maths takes out of the column. */
const HANDLE = 12;

/** A share as a grid track size, without the digits floating point adds to a difference. */
const rowSize = (share: number) => `minmax(0, ${Number(share.toFixed(4))}fr)`;

export function SplitPane({
  top,
  bottom,
  className,
  label = 'Resize the board and the drawing',
}: {
  top: ReactNode;
  bottom: ReactNode;
  className?: string;
  /** The divider's accessible name. */
  label?: string;
}) {
  const [fraction, setFraction] = useState(readSplit);
  const [dragging, setDragging] = useState(false);
  const column = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  // What the end of a drag stores: the state of the last move, which a handler cannot read.
  const latest = useRef(fraction);

  const move = (next: number) => {
    latest.current = next;
    setFraction(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = e.pointerId;
    setDragging(true);
    e.currentTarget.focus();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = column.current?.getBoundingClientRect();
    if (drag.current !== e.pointerId || !box) return;
    move(splitAtPointer(e.clientY, box.top, box.height, HANDLE));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    writeSplit(latest.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = splitAfterKey(e.key, fraction);
    if (next === null) return;
    e.preventDefault();
    move(next);
    writeSplit(next);
  };

  return (
    <div
      ref={column}
      className={cn('grid', dragging && 'cursor-row-resize select-none', className)}
      style={{ gridTemplateRows: `${rowSize(fraction)} ${HANDLE}px ${rowSize(1 - fraction)}` }}
    >
      <div className="min-h-0 min-w-0">{top}</div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuemin={splitPercent(SPLIT_MIN)}
        aria-valuemax={splitPercent(SPLIT_MAX)}
        aria-valuenow={splitPercent(clampSplit(fraction))}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        className={cn(
          'group relative flex h-3 cursor-row-resize touch-none select-none items-center justify-center rounded-md outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          // a finger's 44 px: the strip is 12 px, the area that takes a touch grows around it
          'pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-4 pointer-coarse:before:content-[""]',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-1 w-12 rounded-full bg-border transition-colors',
            'group-hover:bg-muted-foreground/50 group-focus-visible:bg-ring',
            dragging && 'bg-primary group-hover:bg-primary',
          )}
        />
      </div>
      <div className="min-h-0 min-w-0">{bottom}</div>
    </div>
  );
}
