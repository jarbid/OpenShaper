import { ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface DisclosureProps {
  /** Section name. Kept short — it is the thing being scanned when everything is shut. */
  title: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * A digest of the section's contents, right-aligned in the header and readable
   * while collapsed — the dims headline for Specs, the total for Weight.
   *
   * This is what makes a shut accordion worth reading rather than merely tidy: a
   * header that only says "Weight estimate" forces a click to learn anything, so
   * a sidebar of shut headers would answer no questions at all.
   */
  summary?: ReactNode;
  /**
   * Marks a section holding state the board would not have by default — a trace
   * image loaded, a ghost board attached. Collapsed, that state is otherwise
   * invisible, and "why is there a grey curve on my outline" has no answer you can
   * see.
   */
  marked?: boolean;
  /**
   * Heading level for the header, 2 by default.
   *
   * A disclosure nested inside another (the spec readout's bands inside its section)
   * has to be an `h3`, or the document outline flattens and every band reads as a
   * sibling of the tool that contains it.
   */
  headingLevel?: 2 | 3;
  /**
   * A small control beside the header — the editor's `?` docs link. Rendered next
   * to the toggle button, not inside it, so it stays its own focus stop and is never
   * a control nested in a button.
   */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A titled section that collapses to its header.
 *
 * The editor sidebar is a column of these. `Panel` remains the plain surface; this
 * composes it rather than replacing it, so a panel that should never collapse (the
 * view panes) keeps using `Panel` directly.
 *
 * The body is **unmounted** while closed, not hidden. Several sidebar sections hold
 * `useSyncExternalStore` subscriptions to the board store, and a hidden subtree keeps
 * subscribing and re-rendering on every drag of a control point — which is exactly the
 * work the project's "UI never blocks" rule exists to avoid. The cost is that transient
 * local state inside a section does not survive a collapse; nothing in the sidebar keeps
 * anything there worth more than the re-render budget.
 */
export function Disclosure({
  title,
  open,
  onOpenChange,
  summary,
  marked = false,
  headingLevel = 2,
  action,
  children,
  className,
}: DisclosureProps) {
  const bodyId = useId();
  const summaryId = `${bodyId}-summary`;
  const showSummary = summary != null && !open;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const header = (
    <Heading className={action ? 'min-w-0 flex-1' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        // The section's name must not drift as the board changes. Left to the
        // button's own text content it would: the summary lives inside the button,
        // so "Weight estimate" became "Weight estimate2.44 kg (5.4 lb)" — a name no
        // test could query and a screen reader announced as one run-on word. The
        // summary is still announced, as the description that follows the name.
        aria-label={typeof title === 'string' ? title : undefined}
        aria-describedby={showSummary ? summaryId : undefined}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/40',
          // The header is the only thing on screen when the section is shut, so its
          // corners must follow the card's; rounding the bottom too would cut into
          // the body's top border when it is open.
          open && 'rounded-b-none',
          'min-h-9 pointer-coarse:min-h-11',
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {title}
        </span>
        {marked && (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-primary"
            title="This section is holding settings"
          />
        )}
        {showSummary && (
          <span id={summaryId} className="min-w-0 shrink truncate text-xs text-muted-foreground">
            {summary}
          </span>
        )}
      </button>
    </Heading>
  );
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
    >
      {action ? (
        <div className="flex items-center">
          {header}
          <div className="shrink-0 pr-1">{action}</div>
        </div>
      ) : (
        header
      )}
      {open && (
        <div id={bodyId} className="border-t border-border px-3 py-2">
          {children}
        </div>
      )}
    </div>
  );
}
