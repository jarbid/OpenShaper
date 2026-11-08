// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File settings (owner request): units, the profile view's grid, the panel the fin is
 * cut from, the exports' minimum thickness and the core export's laminate, in one place
 * instead of scattered across the header. Every change applies at once; the panel is
 * saved with the fin, the rest is remembered in this browser.
 */
import { FIN_EXPORT_MIN_THICKNESS, FIN_PANEL_THICKNESS } from '@openshaper/kernel';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useState, type ReactNode } from 'react';
import { Modal } from '../components/modal';
import { NumericInput } from '../components/numeric-input';
import {
  cmToUnitNumber,
  fmtThick,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from '../format';
import { useSyncedText } from '../use-numeric-field';
import { finStore } from './fin-store';
import { useFinState } from './use-fin';
import {
  LAMINATE_MAX,
  LAMINATE_MIN,
  LAMINATE_SIDES,
  readCoreSettings,
  writeCoreSettings,
  type CoreSettings,
} from './CoreExportDialog';
import {
  GRID_OPTIONS,
  INCH_FRACTIONS,
  finLengthUnit,
  type FinSettings,
  type FinUnit,
  type InchFraction,
} from './fin-settings';

/** A length typed in the current unit, clamped to `min`–`max` (cm) on commit. */
function ClampedLength({
  label,
  valueCm,
  min,
  max,
  units,
  extraDecimals = 0,
  onCommit,
}: {
  label: string;
  valueCm: number;
  min: number;
  max: number;
  units: LengthUnit;
  extraDecimals?: number;
  onCommit: (cm: number) => void;
}) {
  const shown = cmToUnitNumber(valueCm, units).toFixed(unitDecimals(units) + extraDecimals);
  const [text, setText] = useSyncedText(shown);
  const commit = () => {
    const cm = parseTypedLen(text, units);
    if (cm === null) setText(shown);
    else onCommit(Math.min(max, Math.max(min, cm)));
  };
  return (
    <label className="flex items-center gap-2">
      <span className="flex-1">{label}</span>
      <NumericInput
        value={text}
        onValueChange={setText}
        onCommit={commit}
        onEscape={() => setText(shown)}
        ariaLabel={label}
        className="w-20 tabular-nums"
      />
      <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
    </label>
  );
}

/**
 * The panel's thickness, saved with the fin. Empty means none: no panel check. Common
 * G10 panels are 1/4", 5/16", 3/8" and 1/2".
 */
function PanelThickness({ units }: { units: LengthUnit }) {
  const thickness = useFinState(finStore, (s) => s.design?.panel?.thickness ?? null);
  const shown =
    thickness === null ? '' : cmToUnitNumber(thickness, units).toFixed(unitDecimals(units) + 1);
  const [text, setText] = useSyncedText(shown);
  const commit = () => {
    if (text.trim() === '') {
      finStore.getState().setPanelThickness(null);
      return;
    }
    const cm = parseTypedLen(text, units);
    if (cm === null) setText(shown);
    else if (!finStore.getState().setPanelThickness(cm)) setText(shown);
  };
  const { min, max } = FIN_PANEL_THICKNESS;
  return (
    <>
      <label className="flex items-center gap-2">
        <span className="flex-1">Panel thickness</span>
        <NumericInput
          value={text}
          onValueChange={setText}
          onCommit={commit}
          onEscape={() => setText(shown)}
          ariaLabel="Panel thickness"
          placeholder="none"
          className="w-20 tabular-nums"
        />
        <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
      </label>
      <p className="text-xs text-muted-foreground">
        The panel this fin is machined from ({fmtThick(min, units)}–{fmtThick(max, units)}; empty
        for none). The tab and blade must both fit in it: Panel fit in the 3D view shows how. Saved
        with this fin.
      </p>
    </>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <fieldset className="space-y-2">
    <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {title}
    </legend>
    {children}
  </fieldset>
);

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-sm';

export function FinSettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: FinSettings;
  onChange: (change: Partial<FinSettings>) => void;
  onClose: () => void;
}) {
  const units = finLengthUnit(settings);
  const [core, setCore] = useState<CoreSettings>(readCoreSettings);
  const changeCore = (change: Partial<CoreSettings>) => {
    const next = { ...core, ...change };
    setCore(next);
    writeCoreSettings(next);
  };
  const { min, max } = FIN_EXPORT_MIN_THICKNESS;
  const grids = GRID_OPTIONS[settings.unit];
  const gridIndex = grids.findIndex(
    (o) => settings.grid !== null && Math.abs(o.cm - settings.grid) < 1e-9,
  );

  return (
    <Modal
      name="fin-settings"
      label="File settings"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      {/* Clicks inside the panel aren't backdrop clicks. */}
      <Panel className="flex w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>File settings</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-5 text-sm">
          <p className="text-xs text-muted-foreground">
            Changes apply straight away. The panel is saved with the fin; the rest is remembered in
            this browser.
          </p>
          <Section title="Units">
            {/* Label left, choices in the right-hand column with the fields (owner review). */}
            <div className="flex items-center gap-4" role="radiogroup" aria-label="Units">
              <span className="flex-1">Lengths in</span>
              {(['mm', 'in'] as const satisfies readonly FinUnit[]).map((u) => (
                <label key={u} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="fin-units"
                    checked={settings.unit === u}
                    onChange={() => onChange({ unit: u })}
                  />
                  {u === 'mm' ? 'Millimetres' : 'Inches'}
                </label>
              ))}
            </div>
            {settings.unit === 'in' && (
              <label className="flex items-center gap-2">
                <span className="flex-1">Show lengths to the nearest</span>
                <select
                  className={selectClass}
                  aria-label="Inch fraction"
                  value={settings.fraction}
                  onChange={(e) => onChange({ fraction: Number(e.target.value) as InchFraction })}
                >
                  {INCH_FRACTIONS.map((f) => (
                    <option key={f} value={f}>
                      1/{f}&quot;
                    </option>
                  ))}
                </select>
              </label>
            )}
            {settings.unit === 'in' && (
              <p className="text-xs text-muted-foreground">
                Fields show decimal inches; you can type fractions such as 3/8 or 1 1/4.
              </p>
            )}
          </Section>

          <Section title="Grid">
            <label className="flex items-center gap-2">
              <span className="flex-1">Profile view grid</span>
              <select
                className={selectClass}
                aria-label="Grid size"
                value={gridIndex}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  onChange({ grid: i < 0 ? null : grids[i]!.cm });
                }}
              >
                <option value={-1}>Auto (follows zoom)</option>
                {grids.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </Section>

          <Section title="Panel">
            <PanelThickness units={units} />
          </Section>

          <Section title="Export">
            <ClampedLength
              label="Export minimum thickness"
              valueCm={settings.exportMin}
              min={min}
              max={max}
              units={units}
              onCommit={(cm) => onChange({ exportMin: cm })}
            />
            <p className="text-xs text-muted-foreground">
              STEP, STL and core exports thicken the edges and tip to at least this (
              {fmtThick(min, units)}–{fmtThick(max, units)}). The design isn&apos;t changed.
            </p>
          </Section>

          <Section title="Export core">
            <ClampedLength
              label="Laminate thickness, per face"
              valueCm={core.thickness}
              min={LAMINATE_MIN}
              max={LAMINATE_MAX}
              units={units}
              extraDecimals={1}
              onCommit={(cm) => changeCore({ thickness: cm })}
            />
            <div className="flex items-center gap-4" role="radiogroup" aria-label="Laminate on">
              <span className="flex-1">Laminate on</span>
              {LAMINATE_SIDES.map((o) => (
                <label key={o.value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="settings-laminate-sides"
                    checked={core.sides === o.value}
                    onChange={() => changeCore({ sides: o.value })}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={core.tab}
                onChange={(e) => changeCore({ tab: e.target.checked })}
              />
              Include the tab
            </label>
            <p className="text-xs text-muted-foreground">
              The Export core dialog starts from these, and remembers what you export with.
            </p>
          </Section>

          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </Modal>
  );
}
