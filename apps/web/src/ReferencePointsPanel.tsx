/**
 * The reference-point table: measurements taken off a real board, typed or pasted in,
 * beside what the board on screen measures at the same spot.
 *
 * Outline and rocker rows are a position along the board and one value (the full
 * width, or the bottom/deck height). Section rows are grouped by the station they were
 * measured at; a station with no cross-section on it says so and offers to put one
 * there. Positions are shown from the tail or the nose, straight or over the curve (the
 * app's measurement setting); everything is stored as model x, so switching either only
 * changes what is shown.
 */
import {
  getLength,
  refPointBoardValue,
  REF_SECTION_TOLERANCE,
  type RefPoint,
} from '@openshaper/kernel';
import type { BoardState, RefPointDraft } from '@openshaper/store';
import { Button, Select, Textarea } from '@openshaper/ui';
import { X } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { NumericInput } from './components/numeric-input';
import {
  cmToUnitNumber,
  fmtLen,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from './format';
import type { Longitudinal } from './longitudinal';
import {
  defaultInterval,
  generateStations,
  parsePastedRows,
  stationToDisplay,
  stationToModel,
  type StationOrigin,
} from './ref-table';
import { useSyncedText } from './use-numeric-field';

type Tab = 'outline' | 'rocker' | 'section';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'outline', label: 'Outline' },
  { id: 'rocker', label: 'Rocker' },
  { id: 'section', label: 'Section' },
];

const shown = (cm: number, units: LengthUnit): string =>
  cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

/** One editable length: shows the unit's decimals, accepts fractions, commits on Enter/blur. */
function LengthCell({
  cm,
  units,
  ariaLabel,
  onCommit,
  onFocus,
}: {
  cm: number;
  units: LengthUnit;
  ariaLabel: string;
  onCommit: (cm: number) => void;
  onFocus?: () => void;
}) {
  const text = shown(cm, units);
  const [value, setValue] = useSyncedText(text, `${text}|${cm}`);
  return (
    <span onFocus={onFocus}>
      <NumericInput
        ariaLabel={ariaLabel}
        value={value}
        signed
        onValueChange={setValue}
        onCommit={() => {
          const parsed = parseTypedLen(value, units);
          if (parsed === null || !Number.isFinite(parsed)) setValue(text);
          else onCommit(parsed);
        }}
        onEscape={() => setValue(text)}
        className="h-7 w-full px-1.5 text-xs tabular-nums pointer-coarse:h-9"
      />
    </span>
  );
}

/** The cross-section index nearest `station` that may be moved (never the end markers). */
const nearestMovableSection = (positions: readonly number[], station: number): number | null => {
  let best: number | null = null;
  for (let i = 1; i < positions.length - 1; i++) {
    if (best === null || Math.abs(positions[i]! - station) < Math.abs(positions[best]! - station))
      best = i;
  }
  return best;
};

export function ReferencePointsPanel({
  store,
  units,
  longitudinal,
  activeSection,
}: {
  store: StoreApi<BoardState>;
  units: LengthUnit;
  longitudinal: Longitudinal;
  /** Index of the cross-section the section view shows; new section points go there. */
  activeSection: number;
}) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const points = useSyncExternalStore(store.subscribe, () => store.getState().refPoints);
  const selectedRef = useSyncExternalStore(store.subscribe, () => store.getState().selectedRef);
  const [tab, setTab] = useState<Tab>('outline');
  const [origin, setOrigin] = useState<StationOrigin>('tail');
  const [curve, setCurve] = useState<'bottom' | 'deck'>('bottom');
  const intervalShown = shown(defaultInterval(units), units);
  const [intervalText, setIntervalText] = useSyncedText(intervalShown, units.key);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!board) return null;

  const length = getLength(board);
  const suffix = unitSuffix(units);
  const toDisplay = (x: number) => stationToDisplay(x, origin, longitudinal, length);
  const toModel = (d: number) => stationToModel(d, origin, longitudinal, length);
  const state = () => store.getState();
  const select = (id: string) => state().selectRef(id);
  const section = board.crossSections[activeSection];
  const lengthwise = tab !== 'section';

  /** A new outline/rocker point at model x, valued from the board as it is now. */
  const draftAt = (x: number): RefPointDraft | null => {
    const probe: RefPoint =
      tab === 'outline'
        ? { id: '', plane: 'outline', x, y: 0 }
        : { id: '', plane: 'rocker', curve, x, y: 0 };
    const value = refPointBoardValue(board, probe);
    if (value === null) return null;
    const { id: _, ...draft } = { ...probe, y: value };
    return draft as RefPointDraft;
  };

  const addRow = () => {
    if (tab === 'section') {
      if (!section) return;
      state().addRefPoint({ plane: 'section', station: section.position, x: 0, y: 0 });
      return;
    }
    const plane = points.filter((p) => p.plane === tab);
    const step = parseTypedLen(intervalText, units) ?? defaultInterval(units);
    // One spacing past the furthest row; past the far end, halfway to it instead.
    const total = longitudinal.toDisplay(length);
    const furthest = plane.reduce((m, p) => Math.max(m, toDisplay(p.x)), 0);
    const next = furthest + step < total ? furthest + step : (furthest + total) / 2;
    const draft = draftAt(toModel(next));
    if (draft) state().addRefPoint(draft);
  };

  const generate = () => {
    const interval = parseTypedLen(intervalText, units);
    if (interval === null || interval <= 0) {
      setNotice('Enter a positive spacing.');
      return;
    }
    const drafts = generateStations(interval, origin, longitudinal, length)
      .map(draftAt)
      .filter((d): d is RefPointDraft => d !== null);
    state().addRefPoints(drafts, 'Generate reference points');
    setNotice(`${drafts.length} point${drafts.length === 1 ? '' : 's'} added.`);
  };

  const paste = () => {
    const { rows, bad } = parsePastedRows(pasteText ?? '', units);
    const drafts: RefPointDraft[] = rows.flatMap(([a, b]): RefPointDraft[] => {
      if (tab === 'outline') return [{ plane: 'outline', x: toModel(a), y: b / 2 }];
      if (tab === 'rocker') return [{ plane: 'rocker', curve, x: toModel(a), y: b }];
      return section ? [{ plane: 'section', station: section.position, x: a, y: b }] : [];
    });
    state().addRefPoints(drafts, 'Paste reference points');
    setNotice(
      `${drafts.length} point${drafts.length === 1 ? '' : 's'} added` +
        (bad.length ? `; line${bad.length === 1 ? '' : 's'} ${bad.join(', ')} skipped.` : '.'),
    );
    if (drafts.length) setPasteText(null);
  };

  const rowDelete = (p: RefPoint, n: number) => (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Delete reference point ${n}`}
      className="h-7 w-7 p-0"
      onClick={() => state().deleteRefPoint(p.id)}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );

  const rowClass = (p: RefPoint) =>
    `grid items-center gap-1 rounded px-0.5 ${p.id === selectedRef ? 'bg-muted' : ''}`;

  const lengthwiseRows = () => {
    const rows = points
      .filter((p) => p.plane === tab)
      .slice()
      .sort((a, b) => toDisplay(a.x) - toDisplay(b.x));
    if (rows.length === 0) return null;
    const valueName = tab === 'outline' ? 'Width' : 'Height';
    return (
      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_1fr_4.5rem_1.75rem] gap-1 text-[11px] text-muted-foreground">
          <span>
            From {origin}
            {longitudinal.mark}
          </span>
          <span>{valueName}</span>
          <span>Board</span>
          <span />
        </div>
        {rows.map((p, i) => {
          const board1 = refPointBoardValue(board, p);
          const scale = p.plane === 'outline' ? 2 : 1;
          const measured = p.plane === 'outline' ? Math.abs(p.y) * 2 : p.y;
          return (
            <div key={p.id} className={`${rowClass(p)} grid-cols-[1fr_1fr_4.5rem_1.75rem]`}>
              <LengthCell
                cm={toDisplay(p.x)}
                units={units}
                ariaLabel={`Position ${i + 1}`}
                onFocus={() => select(p.id)}
                onCommit={(d) => state().updateRefPoint(p.id, { x: toModel(d) })}
              />
              <LengthCell
                cm={measured}
                units={units}
                ariaLabel={`${valueName} ${i + 1}`}
                onFocus={() => select(p.id)}
                onCommit={(v) =>
                  state().updateRefPoint(p.id, {
                    // A width keeps the side the point was placed on.
                    y: p.plane === 'outline' ? (Math.sign(p.y) || 1) * (v / 2) : v,
                  })
                }
              />
              <span
                className="truncate text-[11px] tabular-nums text-muted-foreground"
                title={p.plane === 'rocker' ? `${p.curve} curve` : undefined}
              >
                {board1 === null ? '—' : fmtLen(board1 * scale, units)}
                {p.plane === 'rocker' && (
                  <span className="ml-0.5 opacity-70">{p.curve[0]!.toUpperCase()}</span>
                )}
              </span>
              {rowDelete(p, i + 1)}
            </div>
          );
        })}
      </div>
    );
  };

  const sectionRows = () => {
    const sectionPoints = points.filter(
      (p): p is Extract<RefPoint, { plane: 'section' }> => p.plane === 'section',
    );
    if (sectionPoints.length === 0) return null;
    const stations: number[] = [];
    for (const p of sectionPoints)
      if (!stations.some((s) => Math.abs(s - p.station) <= REF_SECTION_TOLERANCE))
        stations.push(p.station);
    stations.sort((a, b) => a - b);
    const positions = board.crossSections.map((cs) => cs.position);
    let n = 0;
    return (
      <div className="space-y-2">
        {stations.map((station) => {
          const onSection = positions.some((x) => Math.abs(x - station) <= REF_SECTION_TOLERANCE);
          const nearest = nearestMovableSection(positions, station);
          const inside = station > 0 && station < length;
          const rows = sectionPoints.filter(
            (p) => Math.abs(p.station - station) <= REF_SECTION_TOLERANCE,
          );
          return (
            <div key={station} className="space-y-1">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {fmtLen(longitudinal.toDisplay(station), units)}
                  {longitudinal.mark} from tail
                </span>
                {!onSection && <span className="text-amber-500">no section</span>}
              </div>
              {!onSection && (
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={nearest === null || !inside}
                    onClick={() => nearest !== null && state().moveCrossSection(nearest, station)}
                  >
                    Move nearest section here
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!inside}
                    onClick={() => state().addCrossSection(station)}
                  >
                    Add section here
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-[1fr_1fr_1.75rem] gap-1 text-[11px] text-muted-foreground">
                <span>Y (out)</span>
                <span>Z (up)</span>
                <span />
              </div>
              {rows.map((p) => {
                n += 1;
                const i = n;
                return (
                  <div key={p.id} className={`${rowClass(p)} grid-cols-[1fr_1fr_1.75rem]`}>
                    <LengthCell
                      cm={p.x}
                      units={units}
                      ariaLabel={`Section Y ${i}`}
                      onFocus={() => select(p.id)}
                      onCommit={(x) => state().updateRefPoint(p.id, { x })}
                    />
                    <LengthCell
                      cm={p.y}
                      units={units}
                      ariaLabel={`Section Z ${i}`}
                      onFocus={() => select(p.id)}
                      onCommit={(y) => state().updateRefPoint(p.id, { y })}
                    />
                    {rowDelete(p, i)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  const pasteHint =
    tab === 'outline'
      ? 'position, full width'
      : tab === 'rocker'
        ? `position, ${curve} height`
        : 'distance from stringer, height';

  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-1" role="tablist" aria-label="Reference point view">
        {TABS.map((t) => (
          <Button
            key={t.id}
            size="sm"
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? 'secondary' : 'ghost'}
            onClick={() => {
              setTab(t.id);
              setNotice(null);
            }}
          >
            {t.label}
            {points.some((p) => p.plane === t.id) &&
              ` ${points.filter((p) => p.plane === t.id).length}`}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {lengthwise && (
          <label className="flex items-center gap-1">
            From
            <Select
              aria-label="Measure positions from"
              value={origin}
              onChange={(e) => setOrigin(e.target.value as StationOrigin)}
              className="h-7 text-xs"
            >
              <option value="tail">Tail</option>
              <option value="nose">Nose</option>
            </Select>
          </label>
        )}
        {tab === 'rocker' && (
          <label className="flex items-center gap-1">
            New points on
            <Select
              aria-label="Curve for new rocker points"
              value={curve}
              onChange={(e) => setCurve(e.target.value as 'bottom' | 'deck')}
              className="h-7 text-xs"
            >
              <option value="bottom">Bottom</option>
              <option value="deck">Deck</option>
            </Select>
          </label>
        )}
        {tab === 'section' && (
          <span>
            New points go on the section at{' '}
            {section ? fmtLen(longitudinal.toDisplay(section.position), units) : '—'}
            {longitudinal.mark}.
          </span>
        )}
      </div>

      {lengthwise ? lengthwiseRows() : sectionRows()}

      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={addRow} disabled={tab === 'section' && !section}>
          Add point
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={pasteText !== null}
          onClick={() => setPasteText((t) => (t === null ? '' : null))}
        >
          Paste…
        </Button>
      </div>

      {lengthwise && (
        <div className="flex items-center gap-1 text-xs">
          <span className="text-muted-foreground">Every</span>
          <NumericInput
            ariaLabel={`Station spacing (${suffix})`}
            value={intervalText}
            onValueChange={setIntervalText}
            onCommit={() => {}}
            className="h-7 w-20 px-1.5 text-xs tabular-nums"
          />
          <span className="text-muted-foreground">{suffix}</span>
          <Button size="sm" variant="ghost" onClick={generate}>
            Generate stations
          </Button>
        </div>
      )}

      {pasteText !== null && (
        <div className="space-y-1">
          <Textarea
            aria-label="Rows to paste"
            placeholder={`One per line: ${pasteHint} (${suffix})`}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            className="text-xs"
          />
          <Button size="sm" onClick={paste} disabled={!pasteText.trim()}>
            Add rows
          </Button>
        </div>
      )}

      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
