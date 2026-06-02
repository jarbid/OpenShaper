/**
 * Buy Me a Coffee integration — native and on-brand, no third-party scripts.
 *
 * OpenShaper is free and open-source; this is a voluntary tip jar, never a
 * paywall. The link is driven by SUPPORT_URL (see support.ts); when no handle is
 * set these components render nothing, so the marketing build stays clean.
 */
import { buttonVariants, cn } from '@openshaper/ui';
import type { ReactNode } from 'react';
import { GITHUB_URL } from '../seo/site';
import { SUPPORT_URL } from '../support';

/** Thin line-art coffee mug with steam — echoes the CAD construction-line motif. */
export function CoffeeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* steam */}
      <path d="M8.5 2.5c-.8 1-.1 1.8 0 2.6M12 2.5c-.8 1-.1 1.8 0 2.6" opacity="0.7" />
      {/* cup */}
      <path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z" />
      {/* handle */}
      <path d="M16 9.5h2.5a2.5 2.5 0 0 1 0 5H16" />
      {/* saucer */}
      <path d="M3 21h14" opacity="0.7" />
    </svg>
  );
}

/** Inline "buy me a coffee" button, styled with the design system. */
export function CoffeeButton({
  className,
  size = 'lg',
  children = 'Buy me a coffee',
}: {
  className?: string;
  size?: 'sm' | 'default' | 'lg';
  children?: ReactNode;
}) {
  if (!SUPPORT_URL) return null;
  return (
    <a
      href={SUPPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ size }), className)}
    >
      <CoffeeIcon className="size-4" />
      {children}
    </a>
  );
}

/**
 * "Support the project" callout — a warm, optional ask that reinforces the
 * free/open ethos rather than gating anything. Used at the close of the About
 * story. Renders nothing when no donation handle is configured.
 */
export function SupportCallout() {
  if (!SUPPORT_URL) return null;
  return (
    <aside className="reveal crop-frame relative mt-12 overflow-hidden rounded-2xl border border-border bg-card/70 p-7 backdrop-blur-sm sm:p-9">
      {/* faint steam-glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full"
        style={{
          background:
            'radial-gradient(closest-side, color-mix(in oklch, var(--primary) 22%, transparent), transparent)',
        }}
      />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-primary">
          <CoffeeIcon className="size-6" />
        </span>
        <div>
          <p className="fig-label">Optional · keeps the bay lit</p>
          <h2 className="font-display mt-2 text-2xl sm:text-3xl">Like it? Buy me a coffee.</h2>
          <p className="mt-3 max-w-xl text-muted-foreground">
            OpenShaper is free and always will be — no accounts, no paywall, every feature open.
            It&apos;s built and maintained by one person, in between surfs. If it&apos;s saved you
            time or helped you shape something, a coffee keeps the project moving. Completely
            optional, genuinely appreciated.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <CoffeeButton className="shadow-sm" />
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
            >
              ★ Star on GitHub
            </a>
          </div>
        </div>
      </div>
    </aside>
  );
}
