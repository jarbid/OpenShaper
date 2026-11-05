import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        // A toggle that is on: tinted, outlined, in the primary colour. Not the solid
        // primary, which is for the one action to press (owner review: a selected Left
        // and a Done button looked the same).
        selected:
          'border border-primary bg-primary/15 font-semibold text-primary hover:bg-primary/25',
      },
      // Coarse pointers (touch) get 44px in both axes — Apple's ergonomic floor, and
      // comfortably clear of the 24px WCAG 2.5.8 minimum — without enlarging the dense
      // mouse/keyboard UI. `min-w` rather than `w` so a wide button keeps its width
      // and only a narrow one (an icon, or a two-character label like "3D") grows.
      size: {
        default: 'h-9 px-4 py-2 pointer-coarse:h-11',
        sm: 'h-8 rounded-md px-3 text-xs pointer-coarse:h-11 pointer-coarse:min-w-11',
        lg: 'h-10 rounded-md px-6 pointer-coarse:h-11',
        icon: 'h-9 w-9 pointer-coarse:size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
