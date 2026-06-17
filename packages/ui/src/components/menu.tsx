import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

/** One row in a dropdown menu. `checkbox` is also used for radio-style groups. */
export type MenuItem =
  | { kind: 'action'; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
  | { kind: 'checkbox'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

/**
 * Render a flat `MenuItem[]` as menu rows. Shared by the menubar `Menu` and the
 * `ContextMenu` so both look and behave identically. `onAfterAction` fires after an
 * `action` item is chosen (e.g. to close the menu); checkbox toggles keep it open.
 */
export function renderMenuItems(items: MenuItem[], onAfterAction: () => void): ReactNode {
  return items.map((item, idx) => {
    if (item.kind === 'separator')
      return <div key={idx} role="separator" className="my-1 h-px bg-border" />;
    if (item.kind === 'label')
      return (
        <div
          key={idx}
          role="presentation"
          className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {item.label}
        </div>
      );
    const isCheckbox = item.kind === 'checkbox';
    return (
      <button
        key={idx}
        type="button"
        role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={isCheckbox ? item.checked : undefined}
        disabled={item.kind === 'action' && item.disabled}
        onClick={() => {
          item.onSelect();
          if (item.kind === 'action') onAfterAction();
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 pointer-coarse:py-2.5"
      >
        <span className="flex w-4 shrink-0 justify-center">
          {isCheckbox && item.checked && <Check className="size-3.5" />}
        </span>
        <span className="flex-1">{item.label}</span>
        {item.kind === 'action' && item.shortcut && (
          <span className="text-xs text-muted-foreground">{item.shortcut}</span>
        )}
      </button>
    );
  });
}

interface MenuBarCtx {
  openId: string | null;
  open: (id: string | null) => void;
}
const MenuBarContext = createContext<MenuBarCtx | null>(null);

/** Application menubar: keeps at most one child `Menu` open; Escape / outside-click close. */
export function MenuBar({ className, children }: { className?: string; children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openId === null) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  return (
    <MenuBarContext.Provider value={{ openId, open: setOpenId }}>
      <div ref={ref} role="menubar" className={cn('flex items-center gap-0.5', className)}>
        {children}
      </div>
    </MenuBarContext.Provider>
  );
}

/** A single labeled dropdown in the menubar, rendered from a flat `items` list. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const ctx = useContext(MenuBarContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = ctx?.openId === id;
  // Horizontal nudge so a dropdown near the right edge stays fully on-screen (mobile).
  const [shiftX, setShiftX] = useState(0);

  // Move focus to the first enabled item when the menu opens (keyboard users).
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const overflow = r.right - (window.innerWidth - 8);
    if (overflow > 0) setShiftX(-overflow);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown' ? (i === -1 ? 0 : i + 1) : i === -1 ? btns.length - 1 : i - 1;
    btns[(next + btns.length) % btns.length]?.focus();
  };

  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => ctx?.open(open ? null : id)}
        onPointerEnter={() => ctx && ctx.openId !== null && ctx.open(id)}
        className={cn(
          'h-8 rounded-md px-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
          open && 'bg-accent text-accent-foreground',
        )}
      >
        {label}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          onKeyDown={onKeyDown}
          style={{ marginLeft: shiftX }}
          className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
        >
          {renderMenuItems(items, () => ctx?.open(null))}
        </div>
      )}
    </div>
  );
}
