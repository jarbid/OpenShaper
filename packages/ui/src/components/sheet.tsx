import { useCallback, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export type SheetSnap = 'peek' | 'half' | 'full';

const SNAP_ORDER: SheetSnap[] = ['peek', 'half', 'full'];
const PEEK_PX = 112; // ~h-28: just the peek header + a sliver of body
const TAP_SLOP = 6;

/** Pixel height of a snap point for the current viewport. */
function snapHeight(snap: SheetSnap): number {
  if (typeof window === 'undefined') return PEEK_PX;
  const h = window.innerHeight;
  switch (snap) {
    case 'peek':
      return PEEK_PX;
    case 'half':
      return Math.round(h * 0.5);
    case 'full':
      return Math.round(h * 0.9);
  }
}

export interface BottomSheetProps {
  /** Current snap point (controlled). */
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** Always-visible content in the drag header (e.g. headline specs). */
  peek?: ReactNode;
  /** Scrollable sheet body (the full panel list). */
  children: ReactNode;
  className?: string;
}

/**
 * A portalled bottom sheet with peek / half / full snap points, used on compact
 * (`< lg`) viewports to host the editor sidebar without covering the canvas.
 *
 * Drag the grab handle to resize; release snaps to the nearest point. A quick tap
 * on the handle cycles peek → half → full → peek. A dim backdrop appears only at
 * the `full` snap (so the canvas stays interactive at peek/half); tapping it
 * collapses back to `peek`.
 */
export function BottomSheet({ snap, onSnapChange, peek, children, className }: BottomSheetProps) {
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);

  const height = dragPx ?? snapHeight(snap);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startH: snapHeight(snap), moved: false };
      setDragPx(snapHeight(snap));
    },
    [snap],
  );

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.startY - e.clientY; // up = grow
    if (Math.abs(dy) > TAP_SLOP) d.moved = true;
    const max = snapHeight('full');
    setDragPx(Math.max(PEEK_PX, Math.min(d.startH + dy, max)));
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      if (!d) return;
      if (!d.moved) {
        // Quick tap: cycle to the next snap point.
        const next = SNAP_ORDER[(SNAP_ORDER.indexOf(snap) + 1) % SNAP_ORDER.length]!;
        setDragPx(null);
        onSnapChange(next);
        return;
      }
      // Snap to whichever point is closest to the released height.
      const h = dragPx ?? snapHeight(snap);
      let best: SheetSnap = 'peek';
      let bestD = Infinity;
      for (const s of SNAP_ORDER) {
        const dd = Math.abs(snapHeight(s) - h);
        if (dd < bestD) {
          bestD = dd;
          best = s;
        }
      }
      setDragPx(null);
      onSnapChange(best);
    },
    [dragPx, snap, onSnapChange],
  );

  return createPortal(
    <>
      {snap === 'full' && (
        <div
          className="fixed inset-0 z-30 bg-black/40"
          onPointerDown={() => onSnapChange('peek')}
          aria-hidden
        />
      )}
      <div
        role="dialog"
        aria-label="Board panels"
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-xl border-t border-border bg-card text-card-foreground shadow-[0_-8px_24px_rgba(0,0,0,0.4)]',
          dragPx === null && 'transition-[height] duration-200 ease-out',
          className,
        )}
        style={{ height }}
      >
        <div
          className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-muted-foreground/40" />
          {peek && <div className="px-4 pb-2 pt-2">{peek}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
