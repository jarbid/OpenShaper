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
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * One row in a dropdown menu. `checkbox` is also used for radio-style groups.
 *
 * `submenu` opens a flyout of further items. The flyout is nested *inside* the parent
 * panel rather than portalled, so `ContextMenu`'s outside-click check still sees it as
 * inside the menu. That has one consequence worth knowing: a panel that clips its
 * overflow will clip the flyout too, which is why submenus are used in `ContextMenu`
 * (no clipping) and not yet in the menubar `Menu`, whose panel scrolls.
 */
export type MenuItem =
  | {
      kind: 'action';
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      shortcut?: string;
      /**
       * Hover text. Mainly for saying WHY an item is disabled — a greyed-out
       * option with no explanation is a dead end for the user.
       */
      title?: string;
    }
  | { kind: 'checkbox'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'submenu'; label: string; items: MenuItem[]; disabled?: boolean }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

/** Shared row chrome, so submenu rows sit flush with action and checkbox rows. */
const ROW_CLASS =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 pointer-coarse:py-2.5';

/**
 * Grace period before a hovered-away flyout closes, in ms.
 *
 * Reaching a flyout means travelling diagonally off the row that opened it, and a
 * pointer does not follow a straight line — it dips below the row, or overshoots
 * past the panel's edge, before arriving. Closing the instant the pointer leaves
 * turns that into a race the user loses, worst of all when the flyout is flipped
 * to the LEFT and the natural rightward drift of the hand carries the pointer
 * away from the target.
 *
 * 300 ms is the usual figure for this (it is roughly what desktop menus use). Long
 * enough to absorb a wobbly diagonal, short enough that a deliberate move away
 * still feels like it closed immediately.
 */
const SUBMENU_CLOSE_DELAY_MS = 300;

/**
 * A row that opens a flyout of further items. Opens on hover, click or ArrowRight;
 * closes on ArrowLeft or Escape without dismissing the menu it sits in. Choosing an
 * item inside runs `onAfterAction`, closing the whole stack.
 *
 * Two things make the flyout reachable, and it needs both:
 *
 *  - The visual gap between row and panel is PADDING on a wrapper, not a margin on
 *    the panel. Pointer-leave semantics treat descendants as inside, so the flyout
 *    being a child of the hover region already covers the panel itself — but a
 *    margin would leave the gap belonging to neither, so crossing it would close
 *    the menu you are crossing toward.
 *  - A close delay ({@link SUBMENU_CLOSE_DELAY_MS}) covers everything the geometry
 *    cannot: overshoot past the panel, and the dip below the row on a diagonal.
 */
function SubmenuRow({
  label,
  items,
  disabled,
  onAfterAction,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  onAfterAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flip the flyout to the left when opening rightward would run off-screen.
  const [flip, setFlip] = useState(false);

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  /** Close now — for keyboard and selection, which are unambiguous. */
  const closeNow = () => {
    cancelClose();
    setOpen(false);
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  // The menu around this can unmount while a close is pending (an outside click,
  // or an item chosen in a sibling row).
  useEffect(() => cancelClose, []);

  useLayoutEffect(() => {
    if (!open) {
      setFlip(false);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    setFlip(el.getBoundingClientRect().right > window.innerWidth - 8);
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  return (
    <div
      className="relative"
      onPointerEnter={() => {
        cancelClose();
        if (!disabled) setOpen(true);
      }}
      onPointerLeave={scheduleClose}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          cancelClose();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            cancelClose();
            setOpen(true);
          }
        }}
        className={ROW_CLASS}
      >
        <span className="w-4 shrink-0" />
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </button>
      {open && (
        // Outer element owns the gap as padding, so it is hoverable; the inner one
        // is the panel you can actually see.
        <div className={cn('absolute top-0 z-10', flip ? 'right-full pr-1' : 'left-full pl-1')}>
          <div
            ref={panelRef}
            role="menu"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'Escape') return;
              // Close just the flyout — the menu around it stays open.
              e.preventDefault();
              e.stopPropagation();
              closeNow();
            }}
            className="min-w-48 rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
          >
            {renderMenuItems(items, onAfterAction)}
          </div>
        </div>
      )}
    </div>
  );
}

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
    if (item.kind === 'submenu')
      return (
        <SubmenuRow
          key={idx}
          label={item.label}
          items={item.items}
          disabled={item.disabled}
          onAfterAction={onAfterAction}
        />
      );
    const isCheckbox = item.kind === 'checkbox';
    return (
      <button
        key={idx}
        type="button"
        role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={isCheckbox ? item.checked : undefined}
        disabled={item.kind === 'action' && item.disabled}
        title={item.kind === 'action' ? item.title : undefined}
        onClick={() => {
          item.onSelect();
          if (item.kind === 'action') onAfterAction();
        }}
        className={ROW_CLASS}
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
