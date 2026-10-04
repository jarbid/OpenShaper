import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/** A surface container (card-like) used for editor panels and sidebars. */
export const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  ),
);
Panel.displayName = 'Panel';

export const PanelHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between border-b border-border px-4 py-2',
        className,
      )}
      {...props}
    />
  ),
);
PanelHeader.displayName = 'PanelHeader';

export const PanelTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('text-sm font-semibold tracking-tight', className)} {...props} />
  ),
);
PanelTitle.displayName = 'PanelTitle';

export const PanelBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-4', className)} {...props} />,
);
PanelBody.displayName = 'PanelBody';
