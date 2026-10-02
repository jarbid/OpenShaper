import { Input } from '@openshaper/ui';
import { useRef } from 'react';

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
  signed,
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
  /**
   * The value can legitimately be negative, so do not ask for a decimal keypad.
   *
   * `inputMode="decimal"` requests digits and a separator — and nothing else, which
   * on a phone means no minus key at all. Fin toe, cant and sweep commit whatever
   * float is typed (`FinPanel` patches them with no clamp), so a keypad that cannot
   * express the value is worse than a full keyboard that can.
   */
  signed?: boolean;
}) {
  // Only text the user actually changed is committed. Without this, leaving an
  // untouched field committed the *rounded* display value (an undo step and a moved
  // point for a focus and a blur), Enter committed twice (keydown, then the blur it
  // triggers), and Escape's blur committed the stale typed text it meant to discard.
  const dirty = useRef(false);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    onCommit();
  };
  return (
    <Input
      aria-label={ariaLabel}
      value={value}
      type={type}
      inputMode={signed ? 'text' : 'decimal'}
      enterKeyHint="done"
      step={step}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(event) => {
        dirty.current = true;
        onValueChange(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          dirty.current = false;
          onEscape?.();
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}
