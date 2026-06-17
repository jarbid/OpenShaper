import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** A single-line text/number input matching the design system. */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        // On touch, grow the field and use a 16px font so iOS doesn't auto-zoom on focus.
        'flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10 pointer-coarse:text-base',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
