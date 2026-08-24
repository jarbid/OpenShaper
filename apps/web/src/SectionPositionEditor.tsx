import { Input } from '@openshaper/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cmToUnitNumber, parseLen, unitSuffix, type LengthUnit } from './format';

export function SectionPositionEditor({
  valueCm,
  units,
  onCommit,
  onDismiss,
}: {
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
  /** Optional Escape handler. Omitted where the editor is always on screen. */
  onDismiss?: () => void;
}) {
  const shown = cmToUnitNumber(valueCm, units).toFixed(2);
  const [text, setText] = useState(shown);
  const textRef = useRef(shown);
  const dirty = useRef(false);
  const stepAmount = units.key === 'mm' ? 10 : units.key === 'cm' ? 1 : 0.5;
  const stepLabel = stepAmount + ' ' + unitSuffix(units);

  const updateText = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  useEffect(() => {
    updateText(shown);
    dirty.current = false;
  }, [shown]);

  const commit = () => {
    if (!dirty.current) return;
    const position = parseLen(textRef.current, units);
    dirty.current = false;
    if (Number.isFinite(position)) onCommit(position);
    else updateText(shown);
  };

  const step = (direction: -1 | 1) => {
    const typedCm = parseLen(textRef.current, units);
    const baseCm = Number.isFinite(typedCm) ? typedCm : valueCm;
    const next = (cmToUnitNumber(baseCm, units) + direction * stepAmount).toFixed(2);
    updateText(next);
    dirty.current = false;
    onCommit(parseLen(next, units));
  };

  return (
    <div
      data-testid="section-position-editor"
      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      title="Length position of this cross-section"
    >
      <div className="flex shrink-0 items-stretch">
        <Input
          aria-label="Selected slice position"
          value={text}
          inputMode="decimal"
          onChange={(event) => {
            dirty.current = true;
            updateText(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
              event.currentTarget.blur();
            } else if (event.key === 'Escape' && onDismiss) {
              event.preventDefault();
              onDismiss();
            }
          }}
          className="h-7 w-20 rounded-r-none px-2 text-xs tabular-nums pointer-coarse:h-9"
        />
        <div className="flex h-7 w-5 flex-col overflow-hidden rounded-r-md border border-l-0 border-input bg-background pointer-coarse:h-9">
          <button
            type="button"
            aria-label="Increase slice position"
            title={'Increase by ' + stepLabel}
            className="flex min-h-0 flex-1 items-center justify-center border-b border-input hover:bg-accent hover:text-accent-foreground"
            onClick={() => step(1)}
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            aria-label="Decrease slice position"
            title={'Decrease by ' + stepLabel}
            className="flex min-h-0 flex-1 items-center justify-center hover:bg-accent hover:text-accent-foreground"
            onClick={() => step(-1)}
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      </div>
      <span>{unitSuffix(units)}</span>
    </div>
  );
}
