import { Input } from '@openshaper/ui';

export function NumericInput({
  value,
  onValueChange,
  onCommit,
  onEscape,
  ariaLabel,
  className,
  step,
  type = 'text',
  placeholder,
  autoFocus,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onEscape?: () => void;
  ariaLabel?: string;
  className?: string;
  step?: number | string;
  type?: 'number' | 'text';
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <Input
      aria-label={ariaLabel}
      value={value}
      type={type}
      inputMode="decimal"
      step={step}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          onCommit();
          (event.target as HTMLInputElement).blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onEscape?.();
          (event.target as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
}
