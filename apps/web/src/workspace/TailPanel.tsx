// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tail panel: the board's tail in a shaper's words. It sits above the sidebar's own sections while the Tail
 * step is open.
 *
 * - **Its face**: the shape as a row of named choices with a thumbnail of each (a squash, a round, a pin, a diamond,
 *   a swallow, a fish; a Custom tail is shown by name when the outline matches none and is not a choice), then the two
 *   dials a shape has: the tail width and, for a swallow or a fish, the notch depth. A dial is a number in the display
 *   unit, a slider, arrow-key steps and a handle on the drawing; one that does not apply is off, with the reason written
 *   under it. Where the two sides' tails differ, a choice of Both, Left or Right says which an edit reaches.
 * - **More**: each corner's radius, from the tail, named by where it is ("tail corner, left", "notch crotch"). The corner
 *   chosen on the drawing, or by a tap on the board, is the one marked.
 *
 * Choosing a shape replaces a drawn tail without asking: the undo is the way back, and the panel says so. Every edit is
 * a store action (`railsStore.setTailShape`, `setCornerRadius`), so it is an undo step with a label, and a slider drag
 * or a held key is one step. The panel reads the rails board itself; the shell does not re-render it.
 */
import { isNotchedShape, type TailCorner, type TailShapeId } from '@openshaper/store/rails';
import { Disclosure, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { memo, useState } from 'react';
import { fmtLen, unitSuffix, type LengthUnit } from '../format';
import { readStored, writeStored } from '../persisted';
import { railsStore } from '../store';
import { NumField } from './RailPanel';
import {
  DIAL_STEPS,
  SHAPE_CHOICES,
  SHAPE_NOTES,
  THUMBNAILS,
  dialFromPosition,
  dialPosition,
  heldNote,
  lengthNumber,
  lengthStep,
  notchOffReason,
  parseLength,
  sentence,
  shapeLabel,
  widthOffReason,
  type DialRange,
} from './tail-panel';
import {
  sameCorner,
  setChosenCorner,
  setTailSide,
  setTailStatus,
  useChosenCorner,
  useTailSide,
  useTailStatus,
  type TailSideChoice,
} from './tail-choice';
import { useTail } from './tail-data';
import { useCoalescedEdit } from './use-coalesced-edit';

const MORE_KEY = 'bs.tailPanelMore';

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

// --- a dial -----------------------------------------------------------------------------------------

interface DialProps {
  /** The dial's name: "Tail width", "Notch depth", "Radius". */
  name: string;
  testId: string;
  units: LengthUnit;
  /** The value now (cm), or null where the tail has none. */
  value: number | null;
  range: DialRange | null;
  /** Why the dial is off, or null. */
  off: string | null;
  onSet: (asked: number) => void;
  /** A corner's row: no heading line, no ends of the range. */
  compact?: boolean;
}

/** A number, a slider and its ends: the dial a width, a depth and a radius all share. */
function LengthDial({ name, testId, units, value, range, off, onSet, compact = false }: DialProps) {
  const edit = useCoalescedEdit();
  const disabled = off !== null || value === null || range === null;
  const shown = value === null ? '–' : lengthNumber(value, units);
  const reading = value === null ? '' : fmtLen(value, units);
  const step = (dir: 1 | -1, big: boolean) => {
    if (value !== null) onSet(value + dir * lengthStep(units, big));
  };

  return (
    <div className="flex flex-col gap-1" data-dial={testId}>
      <div className="flex items-center justify-between gap-2">
        {compact ? null : <span className="flex-1 text-sm font-medium">{name}</span>}
        {disabled ? (
          <span className="inline-flex items-center gap-1" title={off ?? undefined}>
            <span className="flex h-8 w-20 items-center justify-end rounded-md border border-input bg-muted/40 px-2 text-xs tabular-nums text-muted-foreground">
              {shown}
            </span>
            <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
          </span>
        ) : (
          <NumField
            label={`${name} number`}
            shown={shown}
            parse={(t) => parseLength(t, units)}
            suffix={unitSuffix(units)}
            onStep={step}
            onCommit={onSet}
          />
        )}
      </div>
      <input
        type="range"
        aria-label={name}
        aria-valuetext={reading}
        min={0}
        max={DIAL_STEPS}
        step={1}
        value={value !== null && range ? dialPosition(value, range) : 0}
        disabled={disabled}
        title={off ?? undefined}
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
        onChange={(e) => range && onSet(dialFromPosition(Number(e.target.value), range))}
        className="h-5 w-full accent-[var(--primary)] pointer-coarse:h-11"
      />
      {range && !compact ? (
        <div className="flex justify-between text-[11px] text-muted-foreground" aria-hidden>
          <span>{fmtLen(range.min, units)}</span>
          <span>{fmtLen(range.max, units)}</span>
        </div>
      ) : null}
      {off !== null && !compact ? <p className="text-xs text-muted-foreground">{off}</p> : null}
    </div>
  );
}

// --- the shape picker and the side --------------------------------------------------------------------

function ShapePicker({
  shape,
  onChoose,
}: {
  shape: TailShapeId | 'custom';
  onChoose: (shape: TailShapeId) => void;
}) {
  return (
    <div role="group" aria-label="Tail shape" className="grid grid-cols-3 gap-1.5">
      {SHAPE_CHOICES.map((c) => {
        const on = shape === c.id;
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            title={SHAPE_NOTES[c.id]}
            data-testid={`tail-shape-${c.id}`}
            onClick={() => onChoose(c.id)}
            className={`flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11 ${
              on
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <svg
              viewBox="0 0 40 28"
              width="40"
              height="28"
              aria-hidden
              className="overflow-visible"
            >
              <line
                x1="2"
                y1="14"
                x2="38"
                y2="14"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeDasharray="2 2"
              />
              <path
                d={THUMBNAILS[c.id]}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            <span className="font-medium">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const SIDES: readonly { value: TailSideChoice; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'plus', label: 'Left' },
  { value: 'minus', label: 'Right' },
];

function SideControl({ side }: { side: TailSideChoice }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">Edit</legend>
      <div className="flex overflow-hidden rounded-md border border-input">
        {SIDES.map((c) => (
          <label key={c.value} className="flex-1">
            <input
              type="radio"
              name="tail-side"
              value={c.value}
              checked={side === c.value}
              onChange={() => setTailSide(c.value)}
              className="peer sr-only"
            />
            <span className="flex h-8 cursor-pointer items-center justify-center border-r border-input px-2 text-xs last:border-r-0 peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-inset hover:bg-accent peer-checked:hover:bg-primary pointer-coarse:h-11">
              {c.label}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        The two sides of this board’s tail differ. Both gives each side the same tail; Left or Right
        changes that side alone.
      </p>
    </fieldset>
  );
}

// --- the corners ------------------------------------------------------------------------------------

function CornerRow({
  corner,
  chosen,
  units,
}: {
  corner: TailCorner;
  chosen: boolean;
  units: LengthUnit;
}) {
  const set = (asked: number) => {
    railsStore
      .getState()
      .setCornerRadius(
        corner.side === 'tail' ? 'tail' : corner.index,
        asked,
        corner.side === 'tail' ? undefined : corner.side,
      );
    setTailStatus(heldNote('Radius', asked, corner.range, units) ?? '');
  };
  return (
    <li
      aria-current={chosen ? 'true' : undefined}
      data-testid={`tail-corner-${corner.side}-${corner.index}`}
      className={`flex flex-col gap-0.5 rounded-md border px-2 py-1.5 ${
        chosen ? 'border-primary bg-primary/10' : 'border-transparent'
      }`}
    >
      <button
        type="button"
        onClick={() => setChosenCorner({ side: corner.side, index: corner.index })}
        className="flex items-center justify-between gap-2 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
      >
        <span>{sentence(corner.label)}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {fmtLen(corner.radius, units)}
        </span>
      </button>
      <LengthDial
        name={`Radius of the ${corner.label}`}
        testId={`radius-${corner.side}-${corner.index}`}
        units={units}
        value={corner.radius}
        range={corner.range}
        off={null}
        onSet={set}
        compact
      />
    </li>
  );
}

// --- the panel --------------------------------------------------------------------------------------

export const TailPanel = memo(function TailPanel({
  units,
  fluid = false,
}: {
  units: LengthUnit;
  /** Fill the width it is given (the bottom sheet) instead of the sidebar's own 20 rem. */
  fluid?: boolean;
}) {
  const tail = useTail();
  const chosen = useChosenCorner();
  const sideChoice = useTailSide();
  const status = useTailStatus();
  const [more, setMore] = useState<boolean>(() => readStored(MORE_KEY, false, (v) => v === true));
  // a corner chosen on the drawing or by a tap on the board is to be seen: open the list for it, once
  const [seen, setSeen] = useState(chosen);
  if (!sameCorner(seen, chosen)) {
    setSeen(chosen);
    if (chosen !== null && !more) setMore(true);
  }
  if (!tail) return null;
  const { doc, reading, width, notch, corners } = tail;

  const shape = reading.shape;
  const custom = shape === 'custom';
  // a side is named only where the two differ: on any other board an edit reaches both
  const side = reading.sidesDiffer && sideChoice !== 'both' ? sideChoice : undefined;

  const choose = (next: TailShapeId) => {
    railsStore.getState().setTailShape({ shape: next }, side);
    const replaced = custom && railsStore.getState().doc !== doc;
    setTailStatus(
      replaced ? `Replaced the tail’s points with ${shapeLabel(next)}. Undo brings them back.` : '',
    );
  };
  const setWidth = (asked: number) => {
    if (custom) return;
    railsStore.getState().setTailShape({ shape, width: asked }, side);
    setTailStatus(heldNote('Width', asked, width, units) ?? '');
  };
  const setNotch = (asked: number) => {
    if (!isNotchedShape(shape)) return;
    railsStore.getState().setTailShape({ shape, notch: asked }, side);
    setTailStatus(heldNote('Notch depth', asked, notch, units) ?? '');
  };

  return (
    <Panel
      role="region"
      aria-label="Tail panel"
      className={fluid ? 'w-full' : 'w-80 shrink-0'}
      data-testid="tail-panel"
    >
      <PanelHeader className="min-h-11 px-3 py-2">
        <PanelTitle className="flex items-center gap-1.5">
          Tail
          <span aria-hidden className="text-muted-foreground">
            ›
          </span>
          <span className="font-normal" data-testid="tail-shape-name">
            {shapeLabel(shape)}
          </span>
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="p-3">
        <div className="flex flex-col gap-3">
          <ShapePicker shape={shape} onChoose={choose} />
          <p className="text-xs text-muted-foreground">{SHAPE_NOTES[shape]}</p>
          <LengthDial
            name="Tail width"
            testId="tail-width"
            units={units}
            value={reading.width}
            range={width}
            off={widthOffReason(shape)}
            onSet={setWidth}
          />
          <LengthDial
            name="Notch depth"
            testId="tail-notch"
            units={units}
            value={reading.notch}
            range={notch}
            off={notchOffReason(shape)}
            onSet={setNotch}
          />
          {reading.sidesDiffer ? <SideControl side={sideChoice} /> : null}
          {status ? (
            <p role="status" className="text-xs text-muted-foreground">
              {status}
            </p>
          ) : null}
          <Disclosure
            title="More"
            headingLevel={3}
            open={more}
            onOpenChange={(open) => {
              setMore(open);
              writeStored(MORE_KEY, open);
            }}
          >
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Each corner’s radius</p>
              {corners.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  This tail has no corner to round: its outline is smooth where it ends. Choose a
                  Squash, a Diamond, a Swallow or a Fish to give it some.
                </p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label="Corners of the tail">
                  {corners.map((c) => (
                    <CornerRow
                      key={`${c.side}:${c.index}`}
                      corner={c}
                      chosen={sameCorner(chosen, { side: c.side, index: c.index })}
                      units={units}
                    />
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                A board never ends in a point: the least radius of a tip is 5 mm. Drag a corner’s
                round handle on the drawing, or use its arrow keys, to change its radius.
              </p>
            </div>
          </Disclosure>
        </div>
      </PanelBody>
    </Panel>
  );
});
