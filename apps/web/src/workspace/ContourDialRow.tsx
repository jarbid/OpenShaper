// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A number of the chosen contour as the Bottom panel shows it: its label, a field to type it in the display
 * unit (the arrow keys step it), a slider from the least to the most the board holds it to, and what each end
 * of the slider is. The value, the range and the words come from the store (`contourDials`); the row holds no
 * limit of its own, so a number stops where the board says and the slider's ends say where that is.
 *
 * A drag of the slider and a held key are one undo step (`useCoalescedEdit`); the slider's own keys do not
 * reach the editor's key handler.
 */
import type { ContourDial } from '@openshaper/store/rails';
import type { LengthUnit } from '../format';
import {
  SLIDER_STEPS,
  dialNumber,
  dialStep,
  dialSuffix,
  fromSliderPosition,
  parseDialNumber,
  rangeEnd,
  sliderPosition,
} from './contour-panel';
import { NumField } from './RailPanel';
import { useCoalescedEdit } from './use-coalesced-edit';

const SLIDER_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
];

export interface ContourDialRowProps {
  dial: ContourDial;
  units: LengthUnit;
  /** Set the dial to a value (cm, a fraction or a count). The store holds it to the range. */
  onSet: (value: number) => void;
  /** A slider as well as the field; the ends of an extent are dragged on the plan instead. */
  slider?: boolean;
}

export function ContourDialRow({ dial, units, onSet, slider = true }: ContourDialRowProps) {
  const edit = useCoalescedEdit();
  const { unit, key, min, max, value } = dial;
  const count = unit === 'count';
  const fixed = !(max > min);
  const shown = dialNumber(unit, value, units);
  const reading = `${shown} ${dialSuffix(unit, units)}`.trim();

  return (
    <div className="flex flex-col gap-1" data-dial={key}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1 text-sm font-medium" title={dial.note}>
          {dial.label}
        </span>
        <NumField
          label={`${dial.label} number`}
          shown={shown}
          parse={(t) => parseDialNumber(unit, t, units)}
          suffix={dialSuffix(unit, units)}
          onStep={(dir, big) => onSet(value + dir * dialStep(key, unit, big))}
          onCommit={onSet}
        />
      </div>
      {slider ? (
        <>
          <input
            type="range"
            aria-label={dial.label}
            aria-valuetext={reading}
            min={count ? min : 0}
            max={count ? max : SLIDER_STEPS}
            step={1}
            value={count ? Math.min(max, Math.max(min, value)) : sliderPosition(value, min, max)}
            disabled={fixed}
            title={fixed ? 'The board holds this number at one value here.' : dial.note}
            onPointerDown={() => edit.begin()}
            onPointerUp={() => edit.end()}
            onPointerCancel={() => edit.end()}
            onKeyDown={(e) => {
              if (SLIDER_KEYS.includes(e.key)) {
                // the slider's own keys: held, they are one step, and the editor's key handler has no claim on them
                e.stopPropagation();
                edit.begin();
              }
            }}
            onKeyUp={() => edit.end()}
            onBlur={() => edit.end()}
            onChange={(e) => {
              const n = Number(e.target.value);
              onSet(count ? n : fromSliderPosition(n, min, max));
            }}
            className="h-5 w-full accent-[var(--primary)] pointer-coarse:h-11"
          />
          <div className="flex justify-between text-[11px] text-muted-foreground" aria-hidden>
            <span>{rangeEnd(unit, min, units)}</span>
            <span>{rangeEnd(unit, max, units)}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
