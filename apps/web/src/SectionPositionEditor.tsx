import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NumericInput } from './components/numeric-input';
import {
  cmToUnitNumber,
  lengthEditStep,
  parseLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from './format';

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
  // The unit's own precision (3 places in inches), but never under 2: a station
  // sits at any position, and 1 place in mm would hide where it really is.
  const decimals = Math.max(2, unitDecimals(units));
  const shown = cmToUnitNumber(valueCm, units).toFixed(decimals);
  const [text, setText] = useState(shown);
  const textRef = useRef(shown);
  const dirty = useRef(false);
  const stepAmount = lengthEditStep(units);
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
    const next = (cmToUnitNumber(baseCm, units) + direction * stepAmount).toFixed(decimals);
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
        <NumericInput
          ariaLabel="Selected slice position"
          value={text}
          onValueChange={(next) => {
            dirty.current = true;
            updateText(next);
          }}
          onCommit={commit}
          onEscape={() => onDismiss?.()}
          className="h-7 w-20 rounded-r-none px-2 text-xs tabular-nums pointer-coarse:h-12"
        />
        {/*
          Two stacked steppers cannot both reach the 44px ergonomic floor: that
          would be an 88px column in a pane header with 40px of content space. 48px
          splits into two 24px halves, which is the WCAG 2.5.8 minimum, and the
          field beside them is the 44px path to the same value for anyone who
          misses. 50px rather than 48 because the 1px divider comes out of the
          split, which would otherwise leave the lower half at 23. At 36px wide
          rather than 20px they are also no longer the narrowest target in the
          editor.
        */}
        <div className="flex h-7 w-5 flex-col overflow-hidden rounded-r-md border border-l-0 border-input bg-background pointer-coarse:h-[3.125rem] pointer-coarse:w-9">
          <button
            type="button"
            aria-label="Increase slice position"
            title={'Increase by ' + stepLabel}
            className="flex min-h-0 flex-1 items-center justify-center border-b border-input hover:bg-accent hover:text-accent-foreground"
            onClick={() => step(1)}
          >
            <ChevronUp className="size-3 pointer-coarse:size-4" />
          </button>
          <button
            type="button"
            aria-label="Decrease slice position"
            title={'Decrease by ' + stepLabel}
            className="flex min-h-0 flex-1 items-center justify-center hover:bg-accent hover:text-accent-foreground"
            onClick={() => step(-1)}
          >
            <ChevronDown className="size-3 pointer-coarse:size-4" />
          </button>
        </div>
      </div>
      <span>{unitSuffix(units)}</span>
    </div>
  );
}
