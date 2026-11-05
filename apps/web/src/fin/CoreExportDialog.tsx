// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Export the fin's core, for a fin that is printed and then has laminate (usually
 * unidirectional carbon) vacuum-bagged onto its faces for stiffness at the base. The
 * blade is pulled in by the laminate on the chosen faces, never under the export's
 * minimum thickness (FinLaminate in kernel blade.ts), so with the laminate on it is the design.
 * The tab is unchanged unless the laminate wraps it too, over the base where the fin
 * leaves the box: then its laminated faces are thinned the same, so it still fits.
 */
import type { FinLaminate } from '@openshaper/kernel';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useState } from 'react';
import { Modal } from '../components/modal';
import { NumericInput } from '../components/numeric-input';
import {
  cmToUnitNumber,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from '../format';
import { readStored, writeStored } from '../persisted';

/** Which faces the laminate goes on. */
export type LaminateSides = 'outside' | 'inside' | 'both';

export interface CoreSettings {
  /** Laminate per face (cm). */
  readonly thickness: number;
  readonly sides: LaminateSides;
  /** The laminate wraps the tab too: thin its laminated faces. */
  readonly tab: boolean;
}

/** One ply of 200 gsm unidirectional carbon is about 0.20–0.25 mm. */
export const DEFAULT_CORE: CoreSettings = { thickness: 0.02, sides: 'both', tab: false };

/** What the field accepts (cm): 0.05 mm up to 2 mm a face. */
export const LAMINATE_MIN = 0.005;
export const LAMINATE_MAX = 0.2;

export const LAMINATE_SIDES: { value: LaminateSides; label: string }[] = [
  { value: 'outside', label: 'Outside' },
  { value: 'inside', label: 'Inside' },
  { value: 'both', label: 'Both' },
];

export const laminateFor = ({ thickness, sides, tab }: CoreSettings): FinLaminate => ({
  outside: sides === 'inside' ? 0 : thickness,
  inside: sides === 'outside' ? 0 : thickness,
  tab,
});

const CORE_KEY = 'bs.fin.core';

/** Stored settings, or the defaults; settings saved before `tab` existed don't wrap it. */
const readSettings = (v: unknown): CoreSettings => {
  const s = v as Partial<CoreSettings> | null;
  const valid =
    !!s &&
    typeof s.thickness === 'number' &&
    s.thickness >= LAMINATE_MIN &&
    s.thickness <= LAMINATE_MAX &&
    LAMINATE_SIDES.some((o) => o.value === s.sides);
  return valid ? { thickness: s.thickness!, sides: s.sides!, tab: s.tab === true } : DEFAULT_CORE;
};

/** The core settings last used (or set in File settings), or the defaults. */
export const readCoreSettings = (): CoreSettings =>
  readStored(CORE_KEY, DEFAULT_CORE, readSettings);
export const writeCoreSettings = (s: CoreSettings): void => {
  writeStored(CORE_KEY, s);
};

export function CoreExportDialog({
  units,
  pair,
  minThickness,
  onExport,
  onClose,
}: {
  units: LengthUnit;
  /** R & L is on: each export writes a left and a right core. */
  pair: boolean;
  /** The exports' minimum thickness (cm): the core never goes under it. */
  minThickness: number;
  onExport: (format: 'step' | 'stl', laminate: FinLaminate) => void;
  onClose: () => void;
}) {
  const [initial] = useState(readCoreSettings);
  // A ply is a fraction of a millimetre: show one more decimal than other lengths.
  const show = (cm: number) => cmToUnitNumber(cm, units).toFixed(unitDecimals(units) + 1);
  const withUnit = (cm: number) => `${show(cm)} ${unitSuffix(units)}`;
  const [text, setText] = useState(() => show(initial.thickness));
  const [sides, setSides] = useState<LaminateSides>(initial.sides);
  const [tab, setTab] = useState(initial.tab);
  const typed = parseTypedLen(text, units);
  const ok = typed !== null && typed >= LAMINATE_MIN - 1e-9 && typed <= LAMINATE_MAX + 1e-9;

  const run = (format: 'step' | 'stl') => {
    if (!ok) return;
    const settings: CoreSettings = { thickness: typed, sides, tab };
    writeCoreSettings(settings);
    onExport(format, laminateFor(settings));
  };

  return (
    <Modal
      name="fin-core-export"
      label="Export core"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      {/* Clicks inside the panel aren't backdrop clicks. */}
      <Panel className="flex w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>Export core</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            A thinner blade to laminate over: with the laminate on, it matches your design. Never
            under the export minimum, {withUnit(minThickness)}.
          </p>
          <label className="flex items-center gap-2">
            <span className="flex-1">Laminate thickness, per face</span>
            <NumericInput
              value={text}
              onValueChange={setText}
              onCommit={() => {
                if (ok) setText(show(typed));
              }}
              ariaLabel="Laminate thickness"
              className="w-20 tabular-nums"
              autoFocus
            />
            <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
          </label>
          <p className="text-xs text-muted-foreground">
            {ok
              ? `One ply of 200 gsm unidirectional carbon is about ${show(0.02)}–${withUnit(0.025)}. For more plies, add them up.`
              : `Enter a thickness from ${show(LAMINATE_MIN)} to ${withUnit(LAMINATE_MAX)}.`}
          </p>
          <fieldset className="flex items-center gap-4">
            <legend className="mb-2">Laminate on</legend>
            {LAMINATE_SIDES.map((o) => (
              <label key={o.value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="laminate-sides"
                  value={o.value}
                  checked={sides === o.value}
                  onChange={() => setSides(o.value)}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={tab} onChange={(e) => setTab(e.target.checked)} />
              Include the tab
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              {tab
                ? 'The tab is thinned too, so wrapped it still fits the box. Best with a flat inside face.'
                : 'The tab stays its standard width.'}
            </p>
          </div>
          {pair && (
            <p className="text-xs text-muted-foreground">
              Left + right is on: each export writes a left and a right core.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" disabled={!ok} onClick={() => run('stl')}>
              Export STL core
            </Button>
            <Button variant="outline" size="sm" disabled={!ok} onClick={() => run('step')}>
              Export STEP core
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </Modal>
  );
}
