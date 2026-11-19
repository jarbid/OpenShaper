// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A button that opens a menu: the shell of the 3D view's Look and Show.
 *
 * The menubar's `Menu` and the `ContextMenu` of `@openshaper/ui` do not give these two what they
 * need: the menubar's needs a `MenuBar` around it, neither has radio rows (`menuitemradio`), a row
 * that is listed but cannot be chosen (it stays focusable, with the reason on it), a heading that
 * groups rows for a screen reader, or arrow keys. This borrows their look (the same panel and row
 * classes) and adds those.
 *
 * - The panel is portalled to `document.body` and placed under the button, so a short pane that
 *   clips what overflows cannot cut it; it scrolls when the window is shorter than it is.
 * - Arrow Up and Down, Home and End move between the rows; Enter and Space choose; Escape and a
 *   press outside close it and give focus back to the button (unless the press took it somewhere
 *   else); Tab closes it and carries on from the button, as it would without the menu.
 * - A key handled in the menu does not go on to the window: Escape must not also clear the patch
 *   a tap chose, an arrow must not nudge the selected control point, and a letter or a digit must
 *   not choose a design step. A key with Ctrl, Alt or Cmd held is the app's own and goes on.
 * - Rows have the 44 px floor under a coarse pointer, and a visible focus ring.
 */
import { Button, cn } from '@openshaper/ui';
import { Check, ChevronDown } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { AnalysisBlock } from './view3d-settings';

const MARGIN = 8;
const GAP = 4;
const ROW_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** What the rows can ask of the menu around them. */
const MenuContext = createContext<{ close: () => void }>({ close: () => undefined });

/** The rows of a panel, in the order they are drawn. */
const rowsOf = (panel: HTMLElement | null): HTMLElement[] =>
  panel ? Array.from(panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];

interface Place {
  left: number;
  top: number;
  maxHeight: number;
}

export interface MenuButtonProps {
  /** The menu's name, for a screen reader. */
  label: string;
  /** What the button says: its name and, where it has one, the choice it holds. */
  trigger: ReactNode;
  /** The button's accessible name, when its visible words do not read as one (a name and a value). */
  triggerLabel?: string;
  /**
   * One sentence for the button's tooltip. It is the native `title`, not the design system's `Tooltip`:
   * that one shows when the button takes focus, and focus returns to the button when the menu closes, so
   * it would pop up under every choice made with the pointer.
   */
  tip?: string;
  /**
   * Where focus goes when the menu opens: the first row (the default), or the chosen one, for a menu that
   * is one choice among several, so the person sees where they are.
   */
  initialFocus?: 'first' | 'chosen';
  /**
   * Which edge of the button the menu lines up with: its left (the default), or its right, for a button
   * at the right of a pane, so the menu opens over the pane and not past its edge.
   */
  align?: 'start' | 'end';
  /** Attributes the tests and the scripts find the button by. */
  data?: Readonly<Record<`data-${string}`, string>>;
  /** The rows: `MenuGroup`, `MenuItemRow` and `MenuSeparator`. */
  children: ReactNode;
}

export function MenuButton({
  label,
  trigger,
  triggerLabel,
  tip,
  initialFocus = 'first',
  align = 'start',
  data,
  children,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Which row takes focus when the menu opens: the first or the chosen one, or the last (Arrow Up on the button). */
  const entry = useRef<'first' | 'chosen' | 'last'>(initialFocus);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  }, []);
  const context = useRef({ close: () => close(true) });

  // Under the button, kept inside the window, before the first paint so it is never seen in the wrong place.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;
    const at = trigger.getBoundingClientRect();
    const top = at.bottom + GAP;
    const width = panel.offsetWidth;
    const edge = align === 'end' ? at.right - width : at.left;
    setPlace({
      left: Math.max(MARGIN, Math.min(edge, window.innerWidth - width - MARGIN)),
      top,
      maxHeight: Math.max(160, window.innerHeight - top - MARGIN),
    });
  }, [open, align]);

  // Focus goes into the menu: to the chosen row, so the person sees where they are, or the first.
  useEffect(() => {
    if (!open) return;
    const rows = rowsOf(panelRef.current);
    const live = rows.filter((r) => r.getAttribute('aria-disabled') !== 'true');
    const chosen = live.find((r) => r.getAttribute('aria-checked') === 'true');
    const target =
      entry.current === 'last'
        ? rows.at(-1)
        : ((entry.current === 'chosen' ? chosen : undefined) ?? live[0] ?? rows[0]);
    target?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
      // The press may have gone to something that takes focus, and that is where it should stay. If
      // it went to nothing, focus was in the panel that has just gone: the button gets it back.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) triggerRef.current?.focus();
      }, 0);
    };
    const onResize = () => close(false);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = rowsOf(panelRef.current);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => rows[(i + rows.length) % rows.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at === -1 ? rows.length - 1 : at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        // Focus goes to the button first and the key's own move starts from there.
        close(true);
        return;
      default:
        // Enter and Space choose the row (their default action); no other key reaches the editor.
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    e.stopPropagation();
    entry.current = e.key === 'ArrowUp' ? 'last' : initialFocus;
    setOpen(true);
  };

  const button = (
    <Button
      ref={triggerRef}
      type="button"
      size="sm"
      variant={open ? 'secondary' : 'outline'}
      className="[&_svg]:size-3.5"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={triggerLabel}
      title={tip}
      onClick={() => {
        entry.current = initialFocus;
        if (open) close(true);
        else setOpen(true);
      }}
      onKeyDown={onTriggerKeyDown}
      {...data}
    >
      {trigger}
      <ChevronDown aria-hidden="true" className="text-muted-foreground" />
    </Button>
  );

  return (
    <>
      {button}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="menu"
            aria-label={label}
            onKeyDown={onPanelKeyDown}
            className="fixed z-[60] min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-card p-1 text-sm text-card-foreground shadow-lg"
            style={{
              left: place?.left ?? -9999,
              top: place?.top ?? -9999,
              maxHeight: place?.maxHeight,
            }}
          >
            <MenuContext.Provider value={context.current}>{children}</MenuContext.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A heading and the rows under it, as one group for a screen reader. `sub` is a group inside a
 * group (the light, within Realistic): a lighter heading. `note` is a line under the heading that
 * says something about every row of the group.
 */
export function MenuGroup({
  label,
  sub = false,
  note,
  children,
}: {
  label: string;
  sub?: boolean;
  note?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div
        id={id}
        role="presentation"
        className={cn(
          'px-2 pb-1 pt-1.5 text-xs text-muted-foreground',
          sub ? 'font-medium' : 'font-semibold uppercase tracking-wide',
        )}
      >
        {label}
      </div>
      {note && (
        <div role="presentation" className="px-2 pb-1 text-xs text-muted-foreground">
          {note}
        </div>
      )}
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

export interface MenuItemRowProps {
  /** `menuitemradio` for one choice among several, `menuitemcheckbox` for a switch, `menuitem` for an action. */
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  /** Whether a radio is the one chosen, or a checkbox is on. */
  checked?: boolean;
  /**
   * Why the row cannot be chosen now. It stays listed and focusable (a screen reader finds it
   * and its reason), says the short reason beside its name, and has the whole reason as its tooltip.
   */
  blocked?: AnalysisBlock | null;
  /** Say the short reason beside the name (the default). Off where the group's note says it once. */
  shortReason?: boolean;
  /** The row's tooltip, where it is not blocked. */
  hint?: string;
  /** Something drawn before the name: a swatch. */
  leading?: ReactNode;
  /** Leave the menu open after the row is chosen: for switches and settings that are tried one after another. */
  keepOpen?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

export function MenuItemRow({
  role,
  checked,
  blocked,
  shortReason = true,
  hint,
  leading,
  keepOpen = false,
  onSelect,
  children,
}: MenuItemRowProps) {
  const menu = useContext(MenuContext);
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitem' ? undefined : !!checked}
      aria-disabled={blocked ? true : undefined}
      title={blocked ? blocked.reason : hint}
      tabIndex={-1}
      onClick={() => {
        if (blocked) return;
        onSelect();
        if (!keepOpen) menu.close();
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent',
        'pointer-coarse:min-h-11',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked &&
          (role === 'menuitemradio' ? (
            <span aria-hidden="true" className="size-2 rounded-full bg-current" />
          ) : (
            <Check aria-hidden="true" className="size-3.5" />
          ))}
      </span>
      {leading}
      <span className="flex-1">
        {children}
        {blocked && shortReason && (
          <>
            {' '}
            <span className="text-muted-foreground">({blocked.short})</span>
          </>
        )}
      </span>
    </button>
  );
}
