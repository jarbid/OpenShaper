// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deck panel: the deck of the chosen station in a shaper's words. It sits above the sidebar's own
 * sections while the Deck step is open.
 *
 * - **Its face**: the deck's shape by name (a menu of Flat and Domed; Custom is shown by name when the
 *   curve matches neither and is not a choice) and one dial, the crown: a number in the display unit, a slider,
 *   arrow-key steps, and a handle on the slice. The dial is off, with the reason written under it, for a Flat
 *   deck (it has none) and a Custom one (a crown would replace the curve the shaper drew).
 * - **More**: how far a shape reaches (every station, or the chosen one), and Edit curve, which shows the
 *   deck curve's own knots and handles in the cross-section editor.
 *
 * Choosing a shape replaces a drawn curve without asking: the undo is the way back, and the panel says so.
 * Every edit is a store action (`railsStore.setDeckShape`), so it is an undo step with a label, and a slider
 * drag or a held key is one step. The panel reads the rails board and the Deck step's choices itself; the
 * shell does not re-render it.
 */
import { bandAt, bandEdge, stationSplines } from '@openshaper/store/rails';
import {
  Button,
  Disclosure,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
} from '@openshaper/ui';
import { memo, useState } from 'react';
import { fmtLen, unitSuffix, type LengthUnit } from '../format';
import { readStored, writeStored } from '../persisted';
import { railsStore } from '../store';
import {
  setDeckEditCurve,
  setDeckScope,
  setDeckStatus,
  useDeckEditCurve,
  useDeckScope,
  useDeckStatus,
  type DeckScopeChoice,
} from './deck-choice';
import { useDeckStation } from './deck-data';
import {
  CROWN_STEPS,
  SHAPE_CHOICES,
  SHAPE_NOTES,
  crownFromPosition,
  crownNumber,
  crownOffReason,
  crownPosition,
  crownStep,
  heldNote,
  parseCrown,
  shapeLabel,
} from './deck-panel';
import { NumField } from './RailPanel';
import { useCoalescedEdit } from './use-coalesced-edit';

const MORE_KEY = 'bs.deckPanelMore';

const SCOPES: readonly { value: DeckScopeChoice; label: string }[] = [
  { value: 'all', label: 'All stations' },
  { value: 'station', label: 'This station' },
];

// --- the crown dial --------------------------------------------------------------------------------

interface CrownProps {
  units: LengthUnit;
  index: number;
  scope: DeckScopeChoice;
  /** The crown now (cm): the arc's for a Domed deck, the curve's own for the others. */
  crown: number;
  range: { readonly min: number; readonly max: number } | null;
  /** Why the dial is off, or null. */
  off: string | null;
}

function CrownDial({ units, index, scope, crown, range, off }: CrownProps) {
  const edit = useCoalescedEdit();
  const set = (asked: number) => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: asked }, { station: index, all: scope === 'all' });
    setDeckStatus(heldNote(asked, range, units) ?? '');
  };
  const reading = fmtLen(crown, units);

  return (
    <div className="flex flex-col gap-1" data-dial="crown">
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1 text-sm font-medium">Crown</span>
        {off === null ? (
          <NumField
            label="Crown number"
            shown={crownNumber(crown, units)}
            parse={(t) => parseCrown(t, units)}
            suffix={unitSuffix(units)}
            onStep={(dir, big) => set(crown + dir * crownStep(units, big))}
            onCommit={set}
          />
        ) : (
          <span className="inline-flex items-center gap-1" title={off}>
            <span className="flex h-8 w-20 items-center justify-end rounded-md border border-input bg-muted/40 px-2 text-xs tabular-nums text-muted-foreground">
              {crownNumber(crown, units)}
            </span>
            <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
          </span>
        )}
      </div>
      <input
        type="range"
        aria-label="Crown"
        aria-valuetext={reading}
        min={0}
        max={CROWN_STEPS}
        step={1}
        value={range ? crownPosition(crown, range) : 0}
        disabled={off !== null}
        title={off ?? undefined}
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
        onChange={(e) => range && set(crownFromPosition(Number(e.target.value), range))}
        className="h-5 w-full accent-[var(--primary)] pointer-coarse:h-11"
      />
      {range ? (
        <div className="flex justify-between text-[11px] text-muted-foreground" aria-hidden>
          <span>{fmtLen(range.min, units)}</span>
          <span>{fmtLen(range.max, units)}</span>
        </div>
      ) : null}
      {off !== null ? <p className="text-xs text-muted-foreground">{off}</p> : null}
    </div>
  );
}

// --- the scope and Edit curve ----------------------------------------------------------------------

/**
 * The Edit curve button: it shows the deck curve's own knots and handles in the drawing, and shows the
 * shape's one handle again when it is pressed again. A Custom curve is always shown with its points, so for
 * one the button is pressed and off.
 */
export function EditCurveButton({
  custom,
  className,
}: {
  /** The deck is Custom: its points are always shown. */
  custom: boolean;
  className?: string;
}) {
  const editCurve = useDeckEditCurve();
  const on = editCurve || custom;
  return (
    <Button
      size="sm"
      variant={on ? 'default' : 'outline'}
      aria-pressed={on}
      disabled={custom}
      title={
        custom
          ? 'A drawn curve is always shown with its points. Choose a shape to replace it.'
          : on
            ? 'Go back to the shape’s one handle'
            : 'Show the deck curve’s knots and handles in the drawing'
      }
      onClick={() => setDeckEditCurve(!editCurve)}
      className={className}
    >
      Edit curve
    </Button>
  );
}

function ScopeControl({ scope }: { scope: DeckScopeChoice }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">Apply to</legend>
      <div className="flex overflow-hidden rounded-md border border-input">
        {SCOPES.map((c) => (
          <label key={c.value} className="flex-1">
            <input
              type="radio"
              name="deck-scope"
              value={c.value}
              checked={scope === c.value}
              onChange={() => setDeckScope(c.value)}
              className="peer sr-only"
            />
            <span className="flex h-8 cursor-pointer items-center justify-center border-r border-input px-2 text-xs last:border-r-0 peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-inset hover:bg-accent peer-checked:hover:bg-primary pointer-coarse:h-11">
              {c.label}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {scope === 'all'
          ? 'A board’s deck is usually one shape from tail to nose, so a shape reaches every station. A crown typed here is this station’s; every other station falls the same share of its own thickness at the rail.'
          : 'Only the chosen station changes. The stations beside it keep their curves, and the deck blends between them.'}
      </p>
    </fieldset>
  );
}

// --- the panel -------------------------------------------------------------------------------------

export const DeckPanel = memo(function DeckPanel({
  units,
  slice,
  fluid = false,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station. */
  slice: number;
  /** Fill the width it is given (the bottom sheet) instead of the sidebar's own 20 rem. */
  fluid?: boolean;
}) {
  const station = useDeckStation(slice);
  const scope = useDeckScope();
  const status = useDeckStatus();
  const [more, setMore] = useState<boolean>(() => readStored(MORE_KEY, false, (v) => v === true));
  if (!station) return null;
  const { doc, index, reading, range } = station;

  const where = `Station ${index + 1} of ${doc.stations.length}`;
  const custom = reading?.shape === 'custom';

  const choose = (shape: 'flat' | 'domed') => {
    railsStore.getState().setDeckShape({ shape }, { station: index, all: scope === 'all' });
    const replaced = custom && railsStore.getState().doc !== doc;
    setDeckStatus(
      replaced
        ? `Replaced the drawn curve${scope === 'all' ? 's' : ''} with ${shapeLabel(shape)}. Undo brings ${scope === 'all' ? 'them' : 'it'} back.`
        : '',
    );
  };

  const entry = stationSplines(doc, 'plus')[index]!;
  const edge = bandEdge(entry.w, bandAt(doc, 'plus', doc.stations[index]!.x));
  const off = reading ? crownOffReason(reading.shape, range !== null) : null;

  return (
    <Panel
      role="region"
      aria-label="Deck panel"
      className={fluid ? 'w-full' : 'w-80 shrink-0'}
      data-testid="deck-panel"
    >
      <PanelHeader className="min-h-11 px-3 py-2">
        <PanelTitle className="flex items-center gap-1.5">
          Deck
          <span aria-hidden className="text-muted-foreground">
            ›
          </span>
          <span className="font-normal">{where}</span>
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="p-3">
        {reading === null ? (
          <p className="text-sm text-muted-foreground">
            This station has no width or no thickness, so there is no deck to shape here. Choose
            another station on the strip.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <span className="w-12">Shape</span>
                <Select
                  aria-label="Deck shape"
                  value={reading.shape}
                  onChange={(e) => choose(e.target.value as 'flat' | 'domed')}
                  className="min-w-0 flex-1"
                >
                  {SHAPE_CHOICES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  {custom ? (
                    <option value="custom" disabled>
                      Custom
                    </option>
                  ) : null}
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">
                {SHAPE_NOTES[reading.shape]}
                {reading.sidesDiffer ? ' The two sides differ.' : ''}
              </p>
            </div>
            <CrownDial
              units={units}
              index={index}
              scope={scope}
              crown={reading.crown}
              range={range}
              off={off}
            />
            <p className="text-xs text-muted-foreground">
              Measured where the rail starts to roll over the deck, {fmtLen(edge, units)} from the
              stringer.
            </p>
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
              <div className="flex flex-col gap-3">
                <ScopeControl scope={scope} />
                <div className="flex flex-col gap-1">
                  <EditCurveButton custom={custom} className="self-start" />
                  <p className="text-xs text-muted-foreground">
                    Draw the curve itself: its points and handles. Moving a point makes the deck
                    Custom, and the shape you chose is gone. Choosing a shape again replaces the
                    curve.
                  </p>
                </div>
              </div>
            </Disclosure>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
});
