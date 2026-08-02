import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export interface TooltipProps {
  /** What the control does, in a few words. Sentence case, no trailing period. */
  label: string;
  /**
   * Keyboard shortcut, rendered muted beside the label (e.g. `⌘Z`). Formatted by
   * the caller so platform differences stay in one place.
   */
  shortcut?: string;
  /** Side to prefer; flips automatically when it would leave the viewport. */
  side?: 'top' | 'bottom';
  /** The control to describe. Must forward ref and DOM props to a real element. */
  children: ReactElement;
}

/** Delay before showing. Long enough not to fire while sweeping across a toolbar. */
const OPEN_DELAY_MS = 400;
/** Gap between the trigger and the tooltip. */
const OFFSET = 8;
/** Keep-on-screen margin, matching ContextMenu. */
const MARGIN = 8;

/**
 * Text label for an icon-only control, portalled to `document.body`.
 *
 * Why this exists: icon-only buttons carry `aria-label`, so screen readers are
 * fine — it's sighted users who have to guess what a glyph does. Analytics bore
 * that out, with most editor dead clicks landing on controls that render no text.
 *
 * Behaviour worth knowing:
 *  - **Pointer only.** Suppressed for touch, where there is no hover and a
 *    tooltip would either never show or fight the tap.
 *  - **Focus shows it immediately**, with no delay, so keyboard users tabbing
 *    through a toolbar get the same information without waiting.
 *  - **Never traps or steals focus**, and is `aria-hidden`: the accessible name
 *    already comes from the trigger's own `aria-label`, so exposing this too
 *    would just read everything twice.
 *
 * The trigger keeps its own handlers — they're chained, not replaced.
 */
export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, []);

  useEffect(() => clearTimer, []);

  // Dismiss on anything that moves the trigger out from under the tooltip.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('wheel', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);

  // Measure after paint so the flip decision uses the real rendered size.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;

    const anchor = trigger.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();

    const fitsBelow = anchor.bottom + OFFSET + height <= window.innerHeight - MARGIN;
    const fitsAbove = anchor.top - OFFSET - height >= MARGIN;
    const below = side === 'bottom' ? fitsBelow || !fitsAbove : !(fitsAbove || !fitsBelow);

    const y = below ? anchor.bottom + OFFSET : anchor.top - OFFSET - height;
    const centred = anchor.left + anchor.width / 2 - width / 2;
    const x = Math.max(MARGIN, Math.min(centred, window.innerWidth - width - MARGIN));

    setPos({ x, y });
  }, [open, side, label, shortcut]);

  const show = (immediate: boolean) => {
    clearTimer();
    if (immediate) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };

  // Chain onto whatever the trigger already does rather than overwriting it.
  const chain =
    <E,>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) =>
    (e: E) => {
      theirs?.(e);
      ours(e);
    };

  const childProps = children.props as Record<string, unknown>;

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Preserve whatever ref the caller already attached.
      const theirs = (children as unknown as { ref?: unknown }).ref;
      if (typeof theirs === 'function') (theirs as (n: HTMLElement | null) => void)(node);
      else if (theirs && typeof theirs === 'object')
        (theirs as { current: HTMLElement | null }).current = node;
    },
    // Pointer type gates the whole thing: touch gets nothing.
    onPointerEnter: chain(
      childProps.onPointerEnter as ((e: React.PointerEvent) => void) | undefined,
      (e: React.PointerEvent) => {
        if (e.pointerType === 'touch') return;
        show(false);
      },
    ),
    onPointerLeave: chain(
      childProps.onPointerLeave as ((e: React.PointerEvent) => void) | undefined,
      hide,
    ),
    // A click means the user found what they wanted; the tooltip is now noise.
    onPointerDown: chain(
      childProps.onPointerDown as ((e: React.PointerEvent) => void) | undefined,
      hide,
    ),
    onFocus: chain(childProps.onFocus as ((e: React.FocusEvent) => void) | undefined, () =>
      show(true),
    ),
    onBlur: chain(childProps.onBlur as ((e: React.FocusEvent) => void) | undefined, hide),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="presentation"
            aria-hidden="true"
            className={cn(
              'pointer-events-none fixed z-[70] flex items-center gap-2 rounded-md border border-border',
              'bg-card px-2 py-1 text-xs text-card-foreground shadow-lg',
              // Rendered off-screen for the first paint so measurement can't flash.
              pos ? 'opacity-100' : 'opacity-0',
            )}
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
          >
            <span>{label}</span>
            {shortcut && <span className="text-muted-foreground">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
