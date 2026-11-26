// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom panel: the board's contours in a shaper's words. It sits above the sidebar's own sections while
 * the Bottom step is open.
 *
 * - **Its face**: the contours as a short list (name, depth, where it runs, an on/off switch, Remove),
 *   Add contour (the four kinds), and for the chosen contour its **Depth** dial, the one other dial its kind
 *   has (a concave's Width, the channels' Count) and where it runs as two numbers, From and To, both measured
 *   from the tail. A board with no contour says so and offers the same Add. Every number can be typed in the
 *   display unit, nudged with the arrow keys or slid, and Depth and the ends of the run are dragged on the
 *   drawing too.
 * - **More**: the chosen contour's other numbers, each with its slider; its law along the board (the keys of
 *   its depth curve between the two ends: where along the board and how deep, with Add key and Remove); and
 *   Edit curve, which shows the bottom curve of the chosen station, knots and handles, in the drawing.
 *
 * A contour's kind is not a choice to change: remove it and add another. Every edit is a store action
 * (`railsStore.addContour`, `setContourDepth`, …), so it is an undo step with a label, a slider drag or a
 * held key is one step, and the number is held to what the board allows and says so. The panel reads the
 * rails board and the Bottom step's choices itself; the shell does not re-render it.
 */
import {
  CONTOUR_KINDS,
  canAddContour,
  contourKeys,
  stationOfSlice,
  type ContourDial,
  type ContourKind,
} from '@openshaper/store/rails';
import {
  Button,
  Checkbox,
  Disclosure,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
} from '@openshaper/ui';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { fmtLen, type LengthUnit } from '../format';
import { readStored, writeStored } from '../persisted';
import { railsStore } from '../store';
import {
  setBottomEditCurve,
  setBottomStatus,
  setChosenContour,
  useBottomEditCurve,
  useBottomStatus,
} from './bottom-choice';
import { useBottomContours } from './bottom-data';
import { colourOfKind } from './contour-colour';
import {
  AT_THE_MOST,
  NO_CONTOURS,
  depthText,
  dialNumber,
  dialStep,
  dialSuffix,
  heldNote,
  parseDialNumber,
  runText,
} from './contour-panel';
import { ContourDialRow } from './ContourDialRow';
import { NumField } from './RailPanel';

const MORE_KEY = 'bs.bottomPanelMore';

// --- Edit curve ------------------------------------------------------------------------------------

/**
 * The Edit curve button: it shows the chosen station's bottom curve, its knots and handles, in the drawing in
 * place of the slice and the plan, and shows them again when it is pressed again.
 */
export function BottomEditCurveButton({ className }: { className?: string }) {
  const on = useBottomEditCurve();
  return (
    <Button
      size="sm"
      variant={on ? 'default' : 'outline'}
      aria-pressed={on}
      title={
        on
          ? 'Go back to the slice and the plan from below'
          : 'Show the bottom curve’s knots and handles in the drawing'
      }
      onClick={() => setBottomEditCurve(!on)}
      className={className}
    >
      Edit curve
    </Button>
  );
}

// --- the law along the board ----------------------------------------------------------------------

function LawKeys({
  id,
  doc,
  units,
}: {
  id: string;
  doc: NonNullable<ReturnType<typeof useBottomContours>['doc']>;
  units: LengthUnit;
}) {
  const keys = contourKeys(doc, id);
  const store = () => railsStore.getState();
  return (
    <div className="flex flex-col gap-1.5" data-testid="law-keys">
      <p className="text-sm font-medium">Law along the board</p>
      <p className="text-xs text-muted-foreground">
        The depth between the two ends is a curve through these keys: where along the board,
        measured from the tail, and how deep there. They are dragged under the plan too: sideways
        along the board, up and down for how deep.
      </p>
      {keys.map((k) => (
        <div key={k.index} className="flex items-center gap-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Key {k.index}</span>
          <NumField
            label={`Key ${k.index} position`}
            shown={dialNumber('length', k.s, units)}
            parse={(t) => parseDialNumber('length', t, units)}
            suffix={dialSuffix('length', units)}
            onStep={(dir, big) =>
              store().setContourKey(id, k.index, { s: k.s + dir * dialStep('from', 'length', big) })
            }
            onCommit={(s) => store().setContourKey(id, k.index, { s })}
            className="min-w-0"
          />
          <NumField
            label={`Key ${k.index} depth`}
            shown={dialNumber('length', k.value, units)}
            parse={(t) => parseDialNumber('length', t, units)}
            suffix={dialSuffix('length', units)}
            onStep={(dir, big) =>
              store().setContourKey(id, k.index, {
                value: k.value + dir * dialStep('depth', 'length', big),
              })
            }
            onCommit={(value) => store().setContourKey(id, k.index, { value })}
            className="min-w-0"
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove key ${k.index}`}
            title={
              k.removable
                ? 'Remove this key'
                : 'A curve keeps its two ends and one key between them.'
            }
            disabled={!k.removable}
            onClick={() => store().removeFeatureKey(id, k.index)}
            className="px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="self-start pointer-coarse:min-h-11"
        onClick={() => store().addFeatureKey(id)}
      >
        Add key
      </Button>
    </div>
  );
}

// --- the panel -------------------------------------------------------------------------------------

export const BottomPanel = memo(function BottomPanel({
  units,
  slice,
  fluid = false,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station: Edit curve is for the bottom curve there. */
  slice: number;
  /** Fill the width it is given (the bottom sheet) instead of the sidebar's own 20 rem. */
  fluid?: boolean;
}) {
  const { doc, contours, chosen, dials } = useBottomContours();
  const status = useBottomStatus();
  const [more, setMore] = useState<boolean>(() => readStored(MORE_KEY, false, (v) => v === true));
  if (!doc) return null;

  const store = () => railsStore.getState();
  const room = canAddContour(doc);
  const station = stationOfSlice(slice, doc.stations.length);

  const add = (kind: ContourKind) => {
    const id = store().addContour(kind);
    if (id === null) return;
    setChosenContour(id);
    setBottomStatus('');
  };
  const remove = (id: string) => {
    const i = contours.findIndex((c) => c.id === id);
    const name = contours[i]?.name ?? 'The contour';
    store().removeFeature(id);
    const next = contours[i + 1] ?? contours[i - 1];
    setChosenContour(next?.id ?? null);
    setBottomStatus(`Removed ${name}. Undo brings it back.`);
  };
  const setDial = (dial: ContourDial, asked: number) => {
    if (!chosen) return;
    const s = store();
    if (dial.key === 'depth') s.setContourDepth(chosen.id, asked);
    else if (dial.key === 'from') s.setContourExtent(chosen.id, asked, undefined);
    else if (dial.key === 'to') s.setContourExtent(chosen.id, undefined, asked);
    else s.setContourParams(chosen.id, { [dial.key]: asked });
    setBottomStatus(heldNote(asked, dial, units) ?? '');
  };

  return (
    <Panel
      role="region"
      aria-label="Bottom panel"
      className={fluid ? 'w-full' : 'w-80 shrink-0'}
      data-testid="bottom-panel"
    >
      <PanelHeader className="min-h-11 px-3 py-2">
        <PanelTitle className="flex items-center gap-1.5">
          Bottom
          {chosen ? (
            <>
              <span aria-hidden className="text-muted-foreground">
                ›
              </span>
              <span className="font-normal">{chosen.name}</span>
            </>
          ) : null}
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="p-3">
        <div className="flex flex-col gap-3">
          {/* the contours the board has */}
          <section aria-label="Contours" className="flex flex-col gap-1.5">
            {contours.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="no-contours">
                {NO_CONTOURS}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="contour-list">
                {contours.map((c) => {
                  const isChosen = chosen?.id === c.id;
                  return (
                    <li
                      key={c.id}
                      className={`flex items-stretch gap-1 rounded-md border ${isChosen ? 'border-primary bg-accent/40' : 'border-border'} ${c.enabled ? '' : 'opacity-60'}`}
                    >
                      <button
                        type="button"
                        aria-pressed={isChosen}
                        data-contour={c.id}
                        title={`Choose ${c.name}`}
                        onClick={() => setChosenContour(c.id)}
                        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <span
                            aria-hidden
                            className="inline-block size-2.5 rounded-full"
                            style={{ background: colourOfKind(c.kind) }}
                          />
                          {c.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {depthText(c.depth, units)} deep · {runText(c.from, c.to, units)}
                        </span>
                      </button>
                      <label className="flex shrink-0 items-center px-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center">
                        <Checkbox
                          checked={c.enabled}
                          aria-label={`${c.name} on`}
                          title={c.enabled ? 'Switch off: it stays, and is not built' : 'Switch on'}
                          onChange={(e) => store().setFeatureEnabled(c.id, e.target.checked)}
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${c.name}`}
                        title={`Remove ${c.name}`}
                        onClick={() => remove(c.id)}
                        className="h-auto px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div role="group" aria-label="Add a contour" className="grid grid-cols-2 gap-1">
              {CONTOUR_KINDS.map((k) => (
                <Button
                  key={k.kind}
                  size="sm"
                  variant="outline"
                  title={room ? `Add ${k.name.toLowerCase()}: ${k.note}` : AT_THE_MOST}
                  disabled={!room}
                  onClick={() => add(k.kind)}
                  className="justify-start gap-1 pointer-coarse:min-h-11"
                >
                  <Plus aria-hidden className="size-3.5" />
                  {k.name}
                </Button>
              ))}
            </div>
            {room ? null : <p className="text-xs text-muted-foreground">{AT_THE_MOST}</p>}
          </section>

          {/* the chosen contour */}
          {chosen && dials ? (
            <section
              aria-label={`${chosen.name} numbers`}
              className="flex flex-col gap-3"
              data-testid="chosen-contour"
            >
              <p className="text-xs text-muted-foreground">
                {dials.info.note}
                {chosen.enabled ? '' : ' It is switched off: it is kept, and not built.'}
              </p>
              <ContourDialRow
                dial={dials.depth}
                units={units}
                onSet={(v) => setDial(dials.depth, v)}
              />
              <p className="-mt-1 text-xs text-muted-foreground">{dials.info.depth.note}</p>
              {dials.second ? (
                <ContourDialRow
                  dial={dials.second}
                  units={units}
                  onSet={(v) => setDial(dials.second!, v)}
                />
              ) : null}
              <div className="flex flex-col gap-1">
                <div className="grid grid-cols-2 gap-x-3">
                  <ContourDialRow
                    dial={dials.from}
                    units={units}
                    slider={false}
                    onSet={(v) => setDial(dials.from, v)}
                  />
                  <ContourDialRow
                    dial={dials.to}
                    units={units}
                    slider={false}
                    onSet={(v) => setDial(dials.to, v)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Along the board, measured from the tail. It runs{' '}
                  {fmtLen(chosen.to - chosen.from, units)}
                  {chosen.from <= dials.from.min + 0.05 ? ' and out of the tail' : ''}. Drag its
                  ends on the plan from below.
                </p>
              </div>
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
                  {dials.more.map((d) => (
                    <div key={d.key} className="flex flex-col gap-0.5">
                      <ContourDialRow dial={d} units={units} onSet={(v) => setDial(d, v)} />
                      <p className="text-xs text-muted-foreground">{d.note}</p>
                    </div>
                  ))}
                  <LawKeys id={chosen.id} doc={doc} units={units} />
                  <div className="flex flex-col gap-1">
                    <BottomEditCurveButton className="self-start pointer-coarse:min-h-11" />
                    <p className="text-xs text-muted-foreground">
                      Draw the bottom curve of{' '}
                      {station === null ? 'the chosen station' : `station ${station + 1}`}: its
                      knots and handles, across the board’s width. It is your curve: a contour
                      raises the bottom by its own depth over it and never replaces it.
                    </p>
                  </div>
                </div>
              </Disclosure>
            </section>
          ) : (
            <Disclosure
              title="More"
              headingLevel={3}
              open={more}
              onOpenChange={(open) => {
                setMore(open);
                writeStored(MORE_KEY, open);
              }}
            >
              <div className="flex flex-col gap-1">
                <BottomEditCurveButton className="self-start pointer-coarse:min-h-11" />
                <p className="text-xs text-muted-foreground">
                  Draw the bottom curve of{' '}
                  {station === null ? 'the chosen station' : `station ${station + 1}`}: its knots
                  and handles, across the board’s width.
                </p>
              </div>
            </Disclosure>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
});
