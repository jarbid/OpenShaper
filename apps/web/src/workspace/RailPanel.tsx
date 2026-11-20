// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail panel: the zone of the rail that is chosen, in a shaper's words. It sits above the
 * sidebar's own sections while the Rails step is open.
 *
 * - **A zone**: its rail by name (a menu of the built-in rails, then my rails, then Custom), whether
 *   the edits reach both sides or the left or right alone, three dials (Apex, Tuck, Edge) each a slider
 *   with a number, the zone's slice, and More (band, hardness, tuck shape, the deck-side edge, and where
 *   the zone starts and ends, by number). Save as my rail, Tidy rails and Delete zone are at the foot.
 * - **A blend**: the two zones it runs between, each with an Edit button, and its length. A blend has
 *   nothing of its own: it is where two zones end and begin.
 * - **Nothing chosen**: how to choose, and the board's zones.
 *
 * Every edit is a store action (`railsStore`), so it is an undo step with a label, and a slider drag or
 * a held key is one step. The panel reads the rails board and the shared choice itself; the shell does not
 * re-render it.
 */
import {
  BUILT_IN_RAILS,
  RAIL_LIMITS,
  applyDials,
  apexLabel,
  type RailNumber,
  type RailRecipe,
  type RailSide,
} from '@openshaper/store/rails';
import { railZoneColor } from '@openshaper/render3d/patches';
import {
  Button,
  Disclosure,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  cn,
} from '@openshaper/ui';
import { memo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  cmToUnitNumber,
  fineLengthStep,
  fmtLen,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from '../format';
import {
  cleanName,
  removeRail,
  renameRail,
  saveRail,
  setMyRails,
  useMyRails,
  type SavedRail,
} from '../my-rails';
import { chooseRail } from '../patch-look';
import { readStored, writeStored } from '../persisted';
import {
  setRailSides,
  useRailChoice,
  useRailPlace,
  useRailSides,
  type EditSides,
} from '../rail-choice';
import {
  isLinked,
  useBoardLength,
  useBoardRails,
  zonesOfSide,
  type Rails,
  type Side,
  type SideZones,
} from '../rail-zones';
import { sideWord } from '../patch-text';
import { railsStore } from '../store';
import { removeChosenZone, setRailStatus, tidyBoard, useRailStatus } from './rail-actions';
import {
  DIALS,
  DIAL_STEPS,
  apexShown,
  beyondDial,
  dialPosition,
  dialValue,
  parseApex,
  railTitle,
  titleText,
  type DialSpec,
} from './rail-panel';
import { ZoneSlice } from './RailSlice';
import { useCoalescedEdit } from './use-coalesced-edit';
import { useWorkspaceStep } from './use-step';
import { useSyncedText } from '../use-numeric-field';

const MORE_KEY = 'bs.railPanelMore';

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const sideName = (side: Side): string => capital(sideWord(side));

/** Keep a key the panel uses from also reaching the editor's own key handler. */
const consume = (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
};

// --- a number field --------------------------------------------------------------------------------

export interface NumFieldProps {
  /** The field's accessible name. */
  label: string;
  /** The number as the field shows it. */
  shown: string;
  /** Typed text as a number in the field's own terms, or null when it is not one. */
  parse: (text: string) => number | null;
  onCommit: (value: number) => void;
  /** A step by the arrow keys: `dir` is -1 or 1, `big` with Shift. */
  onStep?: (dir: -1 | 1, big: boolean) => void;
  suffix?: string;
  className?: string;
}

/**
 * A number the shaper can type. What is typed is kept until it is committed (Enter or leaving the
 * field), so the box can be empty or half typed; Escape puts the number back; the up and down arrow keys
 * step it, one undo step for a held key.
 */
export function NumField({
  label,
  shown,
  parse,
  onCommit,
  onStep,
  suffix,
  className,
}: NumFieldProps) {
  const [nonce, setNonce] = useState(0);
  const [text, setText] = useSyncedText(shown, `${shown}|${nonce}`);
  const dirty = useRef(false);
  const edit = useCoalescedEdit();

  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const value = parse(text);
    if (value === null) setText(shown);
    else onCommit(value);
    // the store may have held the number to a range: show what it is now, even if that is what it was
    setNonce((n) => n + 1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      consume(e);
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      consume(e);
      dirty.current = false;
      setText(shown);
      e.currentTarget.blur();
    } else if (onStep && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      consume(e);
      dirty.current = false;
      edit.begin();
      onStep(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    }
  };
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Input
        aria-label={label}
        inputMode="decimal"
        enterKeyHint="done"
        value={text}
        onChange={(e) => {
          dirty.current = true;
          setText(e.target.value);
        }}
        onBlur={() => {
          commit();
          edit.end();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') edit.end();
        }}
        className="h-8 w-20 px-2 text-right text-xs tabular-nums"
      />
      {suffix ? <span className="w-6 text-xs text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

// --- the dials -------------------------------------------------------------------------------------

interface ZoneEdit {
  /** The zone's index on its side, and the sides an edit reaches. */
  index: number;
  sides: RailSide;
  rail: RailRecipe;
  units: LengthUnit;
}

const setNumber = (z: ZoneEdit, name: RailNumber, value: number) =>
  railsStore.getState().setZoneNumber(z.sides, z.index, name, value);

/** The dial's rail number held to the dial's range, as a rail with it set would hold it. */
const heldBy = (spec: DialSpec, rail: RailRecipe, value: number): number =>
  applyDials(rail, { [spec.id]: value })[spec.number];

function DialRow({ spec, z }: { spec: DialSpec; z: ZoneEdit }) {
  const { rail, units } = z;
  const value = rail[spec.number];
  const edit = useCoalescedEdit();
  const set = (v: number) => setNumber(z, spec.number, heldBy(spec, rail, v));

  const reading =
    spec.id === 'apex'
      ? apexLabel(value)
      : spec.id === 'tuck'
        ? fmtLen(value, units)
        : `${Math.round(value * 10) / 10}°`;
  const field =
    spec.id === 'apex'
      ? {
          label: 'Apex number',
          shown: apexShown(value),
          parse: parseApex,
          suffix: '%',
          step: (dir: -1 | 1, big: boolean) => set(value + dir * (big ? 0.05 : 0.01)),
        }
      : spec.id === 'tuck'
        ? {
            label: 'Tuck number',
            shown: cmToUnitNumber(value, units).toFixed(unitDecimals(units)),
            parse: (t: string) => parseTypedLen(t, units),
            suffix: unitSuffix(units),
            step: (dir: -1 | 1, big: boolean) =>
              set(
                value + (dir * fineLengthStep(units) * (big ? 10 : 1)) / cmToUnitNumber(1, units),
              ),
          }
        : {
            label: 'Edge number',
            shown: String(Math.round(value * 10) / 10),
            parse: (t: string) => {
              const n = Number.parseFloat(t);
              return Number.isFinite(n) ? n : null;
            },
            suffix: '°',
            step: (dir: -1 | 1, big: boolean) => set(value + dir * (big ? 5 : 1)),
          };
  const beyond = beyondDial(value, spec.range);

  return (
    <div className="flex flex-col gap-1" data-dial={spec.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{spec.label}</span>
        <span className="flex-1 text-xs text-muted-foreground">{reading}</span>
        <NumField
          label={field.label}
          shown={field.shown}
          parse={field.parse}
          suffix={field.suffix}
          onStep={field.step}
          onCommit={set}
        />
      </div>
      <input
        type="range"
        aria-label={spec.label}
        aria-valuetext={reading}
        min={0}
        max={DIAL_STEPS}
        step={1}
        value={dialPosition(value, spec.range)}
        onPointerDown={() => edit.begin()}
        onPointerUp={() => edit.end()}
        onPointerCancel={() => edit.end()}
        onKeyDown={(e) => {
          if (
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'PageUp',
              'PageDown',
              'Home',
              'End',
            ].includes(e.key)
          ) {
            // the slider's own keys: held, they are one step, and the editor's key handler has no claim on them
            e.stopPropagation();
            edit.begin();
          }
        }}
        onKeyUp={() => edit.end()}
        onBlur={() => edit.end()}
        onChange={(e) => set(dialValue(Number(e.target.value), spec.range))}
        className="h-5 w-full accent-[var(--primary)] pointer-coarse:h-11"
      />
      <div className="flex justify-between text-[11px] text-muted-foreground" aria-hidden>
        <span>{spec.ends[0]}</span>
        <span>{spec.ends[1]}</span>
      </div>
      {beyond ? (
        <p className="text-[11px] italic text-muted-foreground">
          Past the end of the dial. The number is kept until the dial is moved.
        </p>
      ) : null}
    </div>
  );
}

// --- saving and renaming a rail of my own -----------------------------------------------------------

function NameForm({
  label,
  initial,
  submit,
  cancel,
}: {
  label: string;
  initial: string;
  /** Returns the reason it cannot be done, or null when it was. */
  submit: (name: string) => string | null;
  cancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const problem = submit(name);
    if (problem) setError(problem);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1" aria-label={label}>
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          aria-label="Name for the rail"
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              consume(e);
              cancel();
            }
          }}
          className="h-8 flex-1 text-sm"
        />
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// --- the sides -------------------------------------------------------------------------------------

const SIDE_CHOICES: readonly { value: EditSides; label: string }[] = [
  { value: 'both', label: 'Both sides' },
  { value: 'plus', label: 'Left' },
  { value: 'minus', label: 'Right' },
];

/** Make the panel edit `value`: a side alone unlocks it first, Both locks two identical sides again. */
function chooseSides(rails: Rails, value: EditSides): void {
  const store = railsStore.getState();
  if (value === 'both') {
    // two sides that are the same are one board's rail again; two that differ wait for a word from the shaper
    if (rails.minus !== undefined && isLinked(rails)) store.linkRailSides('plus');
  } else if (rails.minus === undefined) {
    store.unlockRailSide();
  }
  setRailSides(value);
}

function SidesControl({ rails, sides }: { rails: Rails; sides: EditSides }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">Sides</legend>
      <div className="flex overflow-hidden rounded-md border border-input">
        {SIDE_CHOICES.map((c) => (
          <label key={c.value} className="flex-1">
            <input
              type="radio"
              name="rail-sides"
              value={c.value}
              checked={sides === c.value}
              onChange={() => chooseSides(rails, c.value)}
              className="peer sr-only"
            />
            <span className="flex h-8 cursor-pointer items-center justify-center border-r border-input px-2 text-xs last:border-r-0 peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-inset hover:bg-accent peer-checked:hover:bg-primary pointer-coarse:h-11">
              {c.label}
            </span>
          </label>
        ))}
      </div>
      {sides === 'both' && !isLinked(rails) ? (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <span>The two sides have different rails. Edits reach the same zone on both.</span>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => railsStore.getState().linkRailSides('plus')}
            >
              Make both sides like Left
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => railsStore.getState().linkRailSides('minus')}
            >
              Make both sides like Right
            </Button>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

// --- the rail's name -------------------------------------------------------------------------------

function RailMenu({ z, mine }: { z: ZoneEdit; mine: readonly SavedRail[] }) {
  const title = railTitle(z.rail, mine);
  const [form, setForm] = useState<'rename' | null>(null);
  const current =
    title.kind === 'custom'
      ? 'custom'
      : title.kind === 'mine'
        ? `m:${title.name}`
        : `b:${BUILT_IN_RAILS.find((b) => b.name === title.name)?.id ?? ''}`;
  const builtIn =
    title.kind === 'built-in' ? BUILT_IN_RAILS.find((b) => b.name === title.name) : undefined;

  const onChange = (value: string) => {
    const [kind, id] = [value.slice(0, 1), value.slice(2)];
    const chosen =
      kind === 'b'
        ? BUILT_IN_RAILS.find((b) => b.id === id)?.rail
        : mine.find((m) => m.name === id)?.rail;
    if (chosen) railsStore.getState().setZoneRail(z.sides, z.index, chosen);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium">
        <span className="w-12">Rail</span>
        <Select
          aria-label="Rail"
          value={current}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1"
        >
          <optgroup label="Built-in rails">
            {BUILT_IN_RAILS.map((b) => (
              <option key={b.id} value={`b:${b.id}`} title={b.summary}>
                {b.name}
              </option>
            ))}
          </optgroup>
          {mine.length > 0 ? (
            <optgroup label="My rails">
              {mine.map((m) => (
                <option key={m.name} value={`m:${m.name}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {title.kind === 'custom' ? (
            <option value="custom" disabled>
              {titleText(title)}
            </option>
          ) : null}
        </Select>
      </label>
      <p className="text-xs text-muted-foreground">
        {builtIn
          ? builtIn.summary
          : title.kind === 'mine'
            ? `One of your own rails.`
            : `These numbers match no named rail.${title.like ? ` The closest is ${title.like}.` : ''}`}
      </p>
      {title.kind === 'mine' ? (
        form === 'rename' ? (
          <NameForm
            label="Rename the rail"
            initial={title.name}
            cancel={() => setForm(null)}
            submit={(name) => {
              const done = renameRail(mine, title.name, name);
              if (!done.ok) return done.error;
              setMyRails(done.list);
              setForm(null);
              return null;
            }}
          />
        ) : (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setForm('rename')}>
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMyRails(removeRail(mine, title.name))}
            >
              Remove from my rails
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

// --- More ------------------------------------------------------------------------------------------

interface MoreRow {
  id: string;
  label: string;
  field: Omit<NumFieldProps, 'label'>;
}

function MoreRows({
  z,
  from,
  to,
  length,
}: {
  z: ZoneEdit;
  from: number;
  to: number;
  length: number;
}) {
  const { rail, units } = z;
  const ratio = (name: 'hardness' | 'tuckShape') => ({
    shown: String(Math.round(rail[name] * 100) / 100),
    parse: (t: string) => {
      const n = Number.parseFloat(t);
      return Number.isFinite(n) ? n : null;
    },
    onCommit: (v: number) => setNumber(z, name, v),
    onStep: (dir: -1 | 1, big: boolean) =>
      setNumber(z, name, rail[name] + dir * (big ? 0.1 : 0.01)),
  });
  const lengthField = (value: number, commit: (cm: number) => void) => ({
    shown: cmToUnitNumber(value, units).toFixed(unitDecimals(units)),
    parse: (t: string) => parseTypedLen(t, units),
    suffix: unitSuffix(units),
    onCommit: commit,
    onStep: (dir: -1 | 1, big: boolean) =>
      commit(value + (dir * fineLengthStep(units) * (big ? 10 : 1)) / cmToUnitNumber(1, units)),
  });
  const moveEnd = (end: 'from' | 'to') => (cm: number) =>
    railsStore.getState().moveZoneEnd(z.sides, z.index, end, Math.min(length, Math.max(0, cm)));
  const rows: MoreRow[] = [
    {
      id: 'band',
      label: 'Band width',
      field: lengthField(rail.band, (cm) => setNumber(z, 'band', cm)),
    },
    { id: 'hardness', label: 'Hardness', field: ratio('hardness') },
    { id: 'tuckShape', label: 'Tuck shape', field: ratio('tuckShape') },
    {
      id: 'deckEdge',
      label: 'Deck-side edge',
      field: {
        shown: String(Math.round(rail.deckEdge * 10) / 10),
        parse: (t) => (Number.isFinite(Number.parseFloat(t)) ? Number.parseFloat(t) : null),
        suffix: '°',
        onCommit: (v) => setNumber(z, 'deckEdge', v),
        onStep: (dir, big) => setNumber(z, 'deckEdge', rail.deckEdge + dir * (big ? 5 : 1)),
      },
    },
    { id: 'start', label: 'Starts at', field: lengthField(from, moveEnd('from')) },
    { id: 'end', label: 'Ends at', field: lengthField(to, moveEnd('to')) },
  ];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-sm">{r.label}</span>
          <NumField label={r.label} {...r.field} />
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">
        Band is {fmtLen(RAIL_LIMITS.band[0], units)} to {fmtLen(RAIL_LIMITS.band[1], units)};
        hardness and tuck shape are 0.05 to 0.95; the deck-side edge is 0 to 89°.
      </p>
    </div>
  );
}

// --- the cards -------------------------------------------------------------------------------------

function Swatch({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-sm border border-border"
      style={{ background: railZoneColor(index) }}
    />
  );
}

/** Where a zone is, in words: "from 20 mm to 60 mm" or "at 100 mm". */
const placesOf = (from: number, to: number, units: LengthUnit): string =>
  from === to ? `at ${fmtLen(from, units)}` : `${fmtLen(from, units)} to ${fmtLen(to, units)}`;

function NothingChosen({
  rails,
  lanes,
  mine,
  units,
  place,
}: {
  rails: Rails;
  lanes: readonly Side[];
  mine: readonly SavedRail[];
  units: LengthUnit;
  place: number | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Tap a rail zone on the board or the strip to choose it. Tap + to add one.
      </p>
      {lanes.map((side) => {
        const { zones } = zonesOfSide(rails, side);
        return (
          <div key={side} className="flex flex-col gap-1">
            {lanes.length > 1 ? (
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {sideName(side)}
              </h3>
            ) : null}
            <ul
              className="flex flex-col gap-0.5"
              aria-label={lanes.length > 1 ? `${sideName(side)} zones` : 'Zones'}
            >
              {zones.map((zone, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() =>
                      chooseRail({ side, zone: i }, place ?? (zone.from + zone.to) / 2)
                    }
                    className="flex min-h-8 w-full items-center gap-2 rounded px-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                  >
                    <Swatch index={i} />
                    <span className="min-w-0 flex-1 truncate">
                      Zone {i + 1}: {railTitle(zone.rail, mine).name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {placesOf(zone.from, zone.to, units)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function BlendCard({
  side,
  zones,
  blend,
  mine,
  units,
}: {
  side: Side;
  zones: SideZones;
  blend: number;
  mine: readonly SavedRail[];
  units: LengthUnit;
}) {
  const b = zones.blends[blend]!;
  const ends = [
    { index: b.before, at: zones.zones[b.before]!.to, role: 'Before' },
    { index: b.after, at: zones.zones[b.after]!.from, role: 'After' },
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        A blend runs from where one zone ends to where the next begins. To change it, move those
        ends on the strip, or choose either zone here.
      </p>
      <ul className="flex flex-col gap-1">
        {ends.map((e) => {
          const zone = zones.zones[e.index]!;
          return (
            <li key={e.role} className="flex items-center gap-2 text-sm">
              <Swatch index={e.index} />
              <span className="min-w-0 flex-1 truncate">
                {e.role}: zone {e.index + 1}, {railTitle(zone.rail, mine).name}
              </span>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Edit zone ${e.index + 1}`}
                onClick={() => chooseRail({ side, zone: e.index }, e.at)}
              >
                Edit
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-muted-foreground">
        Length {fmtLen(b.to - b.from, units)}, from {fmtLen(b.from, units)} to {fmtLen(b.to, units)}
        .
      </p>
    </div>
  );
}

function ZoneCard({
  rails,
  side,
  index,
  sides,
  mine,
  units,
  length,
}: {
  rails: Rails;
  side: Side;
  index: number;
  sides: EditSides;
  mine: readonly SavedRail[];
  units: LengthUnit;
  length: number;
}) {
  const zones = zonesOfSide(rails, side);
  const zone = zones.zones[index]!;
  const z: ZoneEdit = { index, sides, rail: zone.rail, units };
  const [more, setMore] = useState<boolean>(() => readStored(MORE_KEY, false, (v) => v === true));
  const [form, setForm] = useState<'save' | null>(null);
  const status = useRailStatus();

  return (
    <div className="flex flex-col gap-3">
      <RailMenu z={z} mine={mine} />
      <SidesControl rails={rails} sides={sides} />
      <div className="flex flex-col gap-3" role="group" aria-label="Dials">
        {DIALS.map((spec) => (
          <DialRow key={spec.id} spec={spec} z={z} />
        ))}
      </div>
      <ZoneSlice from={zone.from} to={zone.to} units={units} />
      <Disclosure
        title="More"
        headingLevel={3}
        open={more}
        onOpenChange={(open) => {
          setMore(open);
          writeStored(MORE_KEY, open);
        }}
      >
        <MoreRows z={z} from={zone.from} to={zone.to} length={length} />
      </Disclosure>
      {form === 'save' ? (
        <NameForm
          label="Save as my rail"
          initial=""
          cancel={() => setForm(null)}
          submit={(name) => {
            const done = saveRail(mine, name, zone.rail);
            if (!done.ok) return done.error;
            setMyRails(done.list);
            setForm(null);
            setRailStatus(`Saved as “${cleanName(name)}”. It is in the Rail menu on every board.`);
            return null;
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setForm('save')}>
          Save as my rail
        </Button>
        <Button size="sm" variant="outline" onClick={() => void tidyBoard()}>
          Tidy rails
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={zones.zones.length < 2}
          onClick={() => removeChosenZone(sides)}
        >
          Delete zone
        </Button>
      </div>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
    </div>
  );
}

// --- the panel -------------------------------------------------------------------------------------

export const RailPanel = memo(function RailPanel({
  units,
  fluid = false,
}: {
  units: LengthUnit;
  /** Fill the width it is given (the bottom sheet) instead of the sidebar's own 20 rem. */
  fluid?: boolean;
}) {
  const rails = useBoardRails();
  const length = useBoardLength();
  const choice = useRailChoice();
  const place = useRailPlace();
  const sides = useRailSides();
  const mine = useMyRails();
  if (!rails) return null;

  const twoLanes = !isLinked(rails) || sides !== 'both';
  const lanes: Side[] = twoLanes ? ['plus', 'minus'] : ['plus'];
  const zones = choice ? zonesOfSide(rails, choice.side) : null;
  const zone = choice?.zone !== undefined ? zones?.zones[choice.zone] : undefined;
  const blend = choice?.blend !== undefined ? zones?.blends[choice.blend] : undefined;

  const where =
    choice && zone
      ? `Zone ${choice.zone! + 1}${twoLanes ? ` (${sideName(choice.side)})` : ''}`
      : choice && blend
        ? `Blend ${choice.blend! + 1}`
        : null;

  return (
    <Panel
      role="region"
      aria-label="Rail panel"
      className={fluid ? 'w-full' : 'w-80 shrink-0'}
      data-testid="rail-panel"
    >
      <PanelHeader className="min-h-11 px-3 py-2">
        <PanelTitle className="flex items-center gap-1.5">
          Rails
          {where ? (
            <>
              <span aria-hidden className="text-muted-foreground">
                ›
              </span>
              <span className="font-normal">{where}</span>
            </>
          ) : null}
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="p-3">
        {choice && zones && zone ? (
          <ZoneCard
            rails={rails}
            side={choice.side}
            index={choice.zone!}
            sides={sides}
            mine={mine}
            units={units}
            length={length}
          />
        ) : choice && zones && blend ? (
          <BlendCard
            side={choice.side}
            zones={zones}
            blend={choice.blend!}
            mine={mine}
            units={units}
          />
        ) : (
          <NothingChosen rails={rails} lanes={lanes} mine={mine} units={units} place={place} />
        )}
      </PanelBody>
    </Panel>
  );
});

/** The panel while the Rails step is the one open, and nothing otherwise. */
export const RailPanelSlot = memo(function RailPanelSlot({
  units,
  fluid,
}: {
  units: LengthUnit;
  fluid?: boolean;
}) {
  const [step] = useWorkspaceStep();
  return step === 'rails' ? <RailPanel units={units} fluid={fluid} /> : null;
});
