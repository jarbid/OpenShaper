import { cn } from '@openshaper/ui';
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The editor's modal dialog: a dimmed full-screen overlay that is the dialog.
 *
 * One place for what every dialog owes keyboard and screen-reader users:
 * `role="dialog"` + `aria-modal` with a name, Escape to dismiss, Tab kept inside,
 * and focus handed back to whatever opened it. `data-modal` is what the global
 * shortcut handler checks to stay quiet behind a dialog.
 *
 * The overlay itself carries the role rather than a wrapper, so the dialogs keep
 * their exact layout: the panel inside is the only thing on it.
 */
export function Modal({
  name,
  label,
  onClose,
  onEscape = onClose,
  closeOnBackdrop = true,
  className,
  children,
}: {
  /** Stable id for `data-modal` (and the shortcut handler's palette exception). */
  name: string;
  /** Accessible name, normally the dialog's title. */
  label: string;
  /** Backdrop click (when allowed). */
  onClose: () => void;
  /** Escape. Defaults to `onClose`. */
  onEscape?: () => void;
  /** A prompt that must be answered sets this false: the backdrop does nothing. */
  closeOnBackdrop?: boolean;
  /** Overlay layout (how the panel is placed). */
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read inside the listener, so a parent passing a fresh arrow each render does
  // not re-bind it (or lose the focus-restore below).
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    // A field marked autoFocus has already taken focus; otherwise move it into the
    // dialog itself, so Tab starts from its first control.
    if (!root.contains(document.activeElement)) root.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A control that handles Escape itself (the palette's input) marks it handled.
        if (e.defaultPrevented) return;
        e.preventDefault();
        escape.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-modal={name}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cn('fixed inset-0 z-50 bg-black/60 outline-none', className)}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      {children}
    </div>
  );
}
