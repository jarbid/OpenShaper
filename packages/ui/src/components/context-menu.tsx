import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderMenuItems, type MenuItem } from './menu';

export interface ContextMenuProps {
  /** Anchor position in viewport (client) pixels, e.g. a right-click point. */
  x: number;
  y: number;
  items: MenuItem[];
  /** Called when the menu should dismiss (item chosen, Escape, outside-click, scroll…). */
  onClose: () => void;
}

const MARGIN = 8;

/**
 * A floating context menu portalled to `document.body` and positioned at `(x, y)`.
 * Flips left/up when it would overflow the viewport so it stays fully on-screen.
 * Dismisses on Escape, outside pointerdown, wheel/scroll, resize, and window blur.
 * Presentational only — reuses the same row rendering as the menubar `Menu`.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // After layout, nudge the menu so it doesn't spill past the viewport edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxX = window.innerWidth - width - MARGIN;
    const maxY = window.innerHeight - height - MARGIN;
    setPos({ x: Math.max(MARGIN, Math.min(x, maxX)), y: Math.max(MARGIN, Math.min(y, maxY)) });
  }, [x, y, items]);

  // Focus the first enabled item so keyboard users land inside the menu.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[60] min-w-48 rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      {renderMenuItems(items, onClose)}
    </div>,
    document.body,
  );
}
