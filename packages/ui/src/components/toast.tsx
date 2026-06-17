import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Non-blocking notification pill, fixed to the bottom centre of the viewport.
 * Purely presentational — the caller owns the show/dismiss state and timing.
 */
export const Toast = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(
        // z-50 keeps it above the mobile bottom sheet (z-40); on compact screens it sits
        // above the sheet's peek so it isn't hidden behind it.
        'fixed bottom-28 left-1/2 z-50 -translate-x-1/2 cursor-pointer rounded-md border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg lg:bottom-4',
        className,
      )}
      {...props}
    />
  ),
);
Toast.displayName = 'Toast';
