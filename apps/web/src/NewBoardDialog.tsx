// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The New board gallery (File > New board…): choose a kind of board, then its length, width and thickness,
 * and the board opens at that size.
 *
 * A grid of cards is a radio group: the arrow keys move through it and choose as they go, Space and Enter
 * choose, and Enter also takes the cursor on to the first size field. The three size fields are in the
 * app's units, start at the size the kind is drawn at and are held to the kind's ranges when they are
 * committed (Enter, leaving the field, an arrow key), never refused. Enter in a field creates the board;
 * Escape closes the dialog.
 *
 * The dialog is a lazy chunk, and everything it needs to make the board (the template, the conversion in
 * the worker, the scaling) is loaded only when a board is created. The app is handed the finished board
 * and opens it as a template is opened.
 */
import type { RailsBoard } from '@openshaper/board2';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle, cn } from '@openshaper/ui';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { captureError } from './analytics';
import {
  BOARD_TYPES,
  DIMENSIONS,
  holdSize,
  holdToRange,
  type BoardSize,
  type BoardType,
  type Dimension,
  type Range,
} from './board-types';
import { Modal } from './components/modal';
import {
  cmToUnitNumber,
  fmtDimsHeadline,
  fmtLen,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from './format';
import { makeBoardOfType } from './new-board';
import { useSyncedText } from './use-numeric-field';

/** What each dimension is called and, to a shaper, what it measures. */
const LABELS: Readonly<Record<Dimension, string>> = {
  length: 'Length',
  width: 'Width',
  thickness: 'Thickness',
};

/**
 * One press of an arrow key on a size field, in the shown unit (millimetres, centimetres or inches): about
 * a hundredth of the dimension, in round numbers of that unit. Shift makes it ten times as much.
 */
const NUDGE: Readonly<Record<Dimension, Readonly<Record<'mm' | 'cm' | 'in', number>>>> = {
  length: { mm: 10, cm: 1, in: 1 },
  width: { mm: 5, cm: 0.5, in: 0.125 },
  thickness: { mm: 1, cm: 0.1, in: 0.0625 },
};

const BIG_NUDGE = 10;

/** The thumbnails are drawn to one scale, so a longboard is seen to be longer than a shortboard. */
const LONGEST = Math.max(...BOARD_TYPES.map((t) => t.drawn.length));
const WIDEST = Math.max(...BOARD_TYPES.map((t) => t.drawn.width));
/** The margin round a thumbnail's boards, in cm. */
const MARGIN = 6;

/** A kind's plan outline: its plus half and the same mirrored, filled, with no line along the stringer. */
function PlanThumbnail({ plan }: { plan: string }) {
  const height = WIDEST + 2 * MARGIN;
  return (
    <svg
      viewBox={`${-MARGIN} ${-height / 2} ${LONGEST + 2 * MARGIN} ${height}`}
      preserveAspectRatio="xMinYMid meet"
      aria-hidden="true"
      focusable="false"
      className="h-10 w-full"
    >
      <g className="fill-foreground/10 stroke-foreground" strokeWidth={1.5} strokeLinejoin="round">
        <path d={plan} vectorEffect="non-scaling-stroke" />
        <path d={plan} transform="scale(1 -1)" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

interface KindCardProps {
  type: BoardType;
  units: LengthUnit;
  checked: boolean;
  /** The one card the Tab key reaches: the chosen one, or the first when none is. */
  tabbable: boolean;
  /** A board is being made: the cards stay where they are, and choosing does nothing. */
  busy: boolean;
  onChoose: (type: BoardType, thenSize: boolean) => void;
  onMove: (type: BoardType, to: 'next' | 'previous' | 'first' | 'last') => void;
}

function KindCard({ type, units, checked, tabbable, busy, onChoose, onMove }: KindCardProps) {
  const id = useId();
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 'next'
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? 'previous'
          : e.key === 'Home'
            ? 'first'
            : e.key === 'End'
              ? 'last'
              : null;
    if (to !== null) {
      e.preventDefault();
      onMove(type, to);
    } else if (e.key === 'Enter') {
      // choose, and go on to the size: a button's own Enter would only click it
      e.preventDefault();
      onChoose(type, true);
    }
  };
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={busy || undefined}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-about ${id}-size`}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onChoose(type, false)}
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-card p-3 text-left text-card-foreground transition-colors',
        'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-disabled:cursor-wait aria-disabled:opacity-70 pointer-coarse:min-h-11',
        checked ? 'border-primary ring-2 ring-primary' : 'border-border',
      )}
    >
      <PlanThumbnail plan={type.plan} />
      <span id={`${id}-name`} className="text-sm font-semibold">
        {type.name}
      </span>
      <span id={`${id}-about`} className="text-xs leading-snug text-muted-foreground">
        {type.description}
      </span>
      <span id={`${id}-size`} className="mt-auto text-xs tabular-nums text-muted-foreground">
        Drawn at{' '}
        <span className="text-foreground">
          {fmtDimsHeadline(type.drawn.length, type.drawn.width, type.drawn.thickness, units)}
        </span>
      </span>
    </button>
  );
}

interface SizeFieldProps {
  dimension: Dimension;
  /** The value held now, in cm. */
  value: number;
  range: Range;
  units: LengthUnit;
  /** A board is being made: the field keeps its focus and its text, and cannot be changed. */
  busy: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
  /** A value was committed: held to the range already. */
  onChange: (cm: number) => void;
  /** Enter was pressed: the value now held, committed. */
  onEnter: (cm: number) => void;
}

/**
 * A length the shaper can type in the app's units, or feet and inches as `6'2"` in any of them. What is typed
 * stays until it is committed (Enter, leaving the field); a number past an end of the range becomes the end
 * and the field shows it; text that is no number puts the value back. The up and down arrow keys step it.
 */
function SizeField({
  dimension,
  value,
  range,
  units,
  busy,
  inputRef,
  onChange,
  onEnter,
}: SizeFieldProps) {
  const id = useId();
  const decimals = unitDecimals(units);
  const shown = cmToUnitNumber(value, units).toFixed(decimals);
  // the nonce re-shows the number after a commit that left it as it was: a typed value past the end of the range
  const [nonce, setNonce] = useState(0);
  const [text, setText] = useSyncedText(shown, `${value}|${units.key}|${nonce}`);
  const dirty = useRef(false);

  /** What the field holds: its typed text taken as a length, held to the range (or the value when it is no number). */
  const typed = (): number => {
    const parsed = parseTypedLen(text, units);
    return parsed === null || !Number.isFinite(parsed) ? value : holdToRange(parsed, range);
  };
  const commit = (): number => {
    if (!dirty.current) return value;
    dirty.current = false;
    const next = typed();
    if (next !== value) onChange(next);
    setNonce((n) => n + 1);
    return next;
  };
  const step = (dir: 1 | -1, big: boolean) => {
    const base = dirty.current ? typed() : value;
    const unitStep = NUDGE[dimension][unitSuffix(units) as 'mm' | 'cm' | 'in'];
    const cm = (dir * unitStep * (big ? BIG_NUDGE : 1)) / cmToUnitNumber(1, units);
    dirty.current = false;
    onChange(holdToRange(base + cm, range));
    setNonce((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {LABELS[dimension]}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          ref={inputRef}
          value={text}
          readOnly={busy}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          aria-describedby={`${id}-range`}
          onChange={(e) => {
            dirty.current = true;
            setText(e.target.value);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            // a board is being made: nothing here changes it
            if (busy) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter(commit());
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
            }
          }}
          className="text-right tabular-nums pointer-coarse:h-11"
        />
        <span aria-hidden="true" className="w-6 text-xs text-muted-foreground">
          {unitSuffix(units)}
        </span>
      </div>
      <p id={`${id}-range`} className="text-xs text-muted-foreground">
        {fmtLen(range.least, units)} to {fmtLen(range.greatest, units)}
      </p>
    </div>
  );
}

export interface NewBoardDialogProps {
  /** The editor's length unit: every length shown and typed is in it. */
  units: LengthUnit;
  /** The board is made: the app opens it as the document, and closes the dialog. */
  onOpen: (board: RailsBoard, name: string) => void;
  onClose: () => void;
}

function NewBoardDialog({ units, onOpen, onClose }: NewBoardDialogProps) {
  const [chosen, setChosen] = useState<BoardType | null>(null);
  const [size, setSize] = useState<BoardSize | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizeFocus, setSizeFocus] = useState(0);
  const kinds = useRef<HTMLDivElement>(null);
  const lengthField = useRef<HTMLInputElement | null>(null);
  const setLengthField = useCallback((el: HTMLInputElement | null) => {
    lengthField.current = el;
  }, []);
  /** The attempt that may still open its board: closing the dialog, or another attempt, drops the rest. */
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  // The first card takes the focus once the modal has noted which control opened the dialog (a child's effect
  // runs before its parent's), so closing returns the focus there; `autoFocus` would have taken it first.
  useEffect(() => {
    kinds.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
  }, []);
  // after the size fields have been rendered for a kind that was just chosen
  useEffect(() => {
    if (sizeFocus > 0) lengthField.current?.focus();
  }, [sizeFocus]);

  const choose = (type: BoardType, thenSize: boolean) => {
    if (busy) return;
    if (chosen?.name !== type.name) {
      setChosen(type);
      setSize(type.drawn);
      setError(null);
    }
    if (thenSize) setSizeFocus((n) => n + 1);
  };
  const move = (from: BoardType, to: 'next' | 'previous' | 'first' | 'last') => {
    const at = BOARD_TYPES.indexOf(from);
    const n = BOARD_TYPES.length;
    const next =
      to === 'first' ? 0 : to === 'last' ? n - 1 : (at + (to === 'next' ? 1 : n - 1)) % n;
    choose(BOARD_TYPES[next]!, false);
    kinds.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  const create = async (now: BoardSize) => {
    if (chosen === null || busy) return;
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    try {
      const board = await makeBoardOfType(chosen, holdSize(chosen, now));
      if (mine === attempt.current) onOpen(board, chosen.name);
    } catch (err) {
      if (mine !== attempt.current) return;
      console.error('Failed to make a board of a type', err);
      captureError('template_load', err);
      setError(`Could not make the ${chosen.name}: ${err instanceof Error ? err.message : err}`);
      setBusy(false);
    }
  };

  const setDimension = (d: Dimension, cm: number) =>
    setSize((s) => (s === null ? s : { ...s, [d]: cm }));

  return (
    <Modal
      name="new-board"
      label="New board"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      <Panel
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader>
          <PanelTitle>New board</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" aria-label="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="min-h-0 flex-1 space-y-4 overflow-y-auto text-sm">
          <section aria-labelledby="new-board-kind" className="space-y-2">
            <h3
              id="new-board-kind"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Kind of board
            </h3>
            <div
              ref={kinds}
              role="radiogroup"
              aria-labelledby="new-board-kind"
              className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
              {BOARD_TYPES.map((type, i) => (
                <KindCard
                  key={type.name}
                  type={type}
                  units={units}
                  checked={chosen?.name === type.name}
                  tabbable={chosen === null ? i === 0 : chosen.name === type.name}
                  busy={busy}
                  onChoose={choose}
                  onMove={move}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="new-board-size" className="space-y-2">
            <h3
              id="new-board-size"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Size
            </h3>
            {chosen === null || size === null ? (
              <p className="min-h-[5rem] text-muted-foreground">
                Choose a kind of board, then set its length, width and thickness.
              </p>
            ) : (
              <div role="group" aria-label={`Size of the ${chosen.name}`} className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-3">
                  {DIMENSIONS.map((d) => (
                    <SizeField
                      key={d}
                      dimension={d}
                      value={size[d]}
                      range={chosen.ranges[d]}
                      units={units}
                      busy={busy}
                      inputRef={d === 'length' ? setLengthField : undefined}
                      onChange={(cm) => setDimension(d, cm)}
                      onEnter={(cm) => void create({ ...size, [d]: cm })}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Thickness is measured at the middle of the board.
                </p>
              </div>
            )}
          </section>
        </PanelBody>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          {busy && (
            <p role="status" className="mr-auto text-muted-foreground">
              Making the board…
            </p>
          )}
          {error !== null && (
            <p role="alert" className="mr-auto text-destructive">
              {error}
            </p>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={chosen === null || size === null}
            aria-busy={busy}
            onClick={() => size !== null && void create(size)}
            className="aria-busy:opacity-70"
          >
            Create board
          </Button>
        </div>
      </Panel>
    </Modal>
  );
}

export default memo(NewBoardDialog);
