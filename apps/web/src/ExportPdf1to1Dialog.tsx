/**
 * 1:1 PDF export dialog: pick which geometry to include, slice the full-size board
 * across a chosen paper size (with overlap/cut marks + tile labels for assembly), and
 * package as a combined PDF or one PDF per part. Length fields follow the editor's
 * `units` selector (CLAUDE.md rule — never hardcode mm/cm/in). Modeled on the
 * SettingsDialog backdrop + Panel pattern, with Escape-to-close.
 */
import { PAPER_SIZES, type Orientation } from '@openshaper/export';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useState } from 'react';
import { cmToUnitNumber, parseLen, unitDecimals, unitSuffix, type LengthUnit } from './format';
import { DEFAULT_PDF1TO1, type Pdf1to1Settings } from './pdf-export-settings';

// ---- tiny form atoms -------------------------------------------------------

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function CheckRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
      />
    </label>
  );
}

/** A length field shown/edited in the editor's unit, reporting back internal centimetres. */
function LenField({
  label,
  cm,
  units,
  onChange,
  disabled,
}: {
  label: string;
  cm: number;
  units: LengthUnit;
  onChange: (cm: number) => void;
  disabled?: boolean;
}) {
  const decimals = unitDecimals(units);
  const display = Math.round(cmToUnitNumber(cm, units) * 10 ** decimals) / 10 ** decimals;
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={display}
          disabled={disabled}
          step={units.key === 'in' ? 0.0625 : units.key === 'mm' ? 0.5 : 0.1}
          onChange={(e) => {
            if (e.target.value === '') return;
            const next = parseLen(e.target.value, units);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="h-8 w-20 rounded border border-border bg-background px-2 text-right text-sm"
        />
        <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
      </span>
    </label>
  );
}

function IntField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(e) => {
          const n = Math.round(parseFloat(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="h-8 w-20 rounded border border-border bg-background px-2 text-right text-sm"
      />
    </label>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded border border-border bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---- main component --------------------------------------------------------

export interface ExportPdf1to1DialogProps {
  units: LengthUnit;
  /** Current persisted settings, used to pre-populate the form. */
  settings: Pdf1to1Settings;
  /** Called with the chosen settings to persist + run the export. */
  onExport: (settings: Pdf1to1Settings) => void;
  onClose: () => void;
}

export function ExportPdf1to1Dialog({
  units,
  settings,
  onExport,
  onClose,
}: ExportPdf1to1DialogProps) {
  const [draft, setDraft] = useState<Pdf1to1Settings>({ ...settings });

  const set = <K extends keyof Pdf1to1Settings>(key: K, value: Pdf1to1Settings[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  // Escape-to-close (the existing modals don't wire this; we improve on them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const resetToDefaults = () => setDraft({ ...DEFAULT_PDF1TO1 });
  const exportNow = () => {
    onExport(draft);
    onClose();
  };

  const paperOptions = [
    ...PAPER_SIZES.map((p) => ({ value: p.id, label: p.label })),
    { value: 'custom', label: 'Custom…' },
  ];
  const orientationOptions: { value: Orientation; label: string }[] = [
    { value: 'auto', label: 'Auto (fit)' },
    { value: 'portrait', label: 'Portrait' },
    { value: 'landscape', label: 'Landscape' },
  ];

  const noSlice = !draft.slice;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Export 1:1 PDF</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="space-y-5 overflow-y-auto text-sm">
          {/* --- Geometry --- */}
          <Group title="Geometry included">
            <CheckRow
              label="Outline (plan)"
              value={draft.outline}
              onChange={(v) => set('outline', v)}
            />
            <CheckRow
              label="Fins (on outline)"
              value={draft.fins}
              onChange={(v) => set('fins', v)}
              disabled={!draft.outline}
            />
            <CheckRow
              label="Rocker / profile"
              value={draft.rocker}
              onChange={(v) => set('rocker', v)}
            />
            <CheckRow
              label="Cross-sections"
              value={draft.crossSections}
              onChange={(v) => set('crossSections', v)}
            />
            <IntField
              label="Cross-section count"
              value={draft.crossSectionCount}
              min={1}
              max={40}
              onChange={(v) => set('crossSectionCount', v)}
            />
            <CheckRow
              label="Calibration ruler"
              value={draft.calibration}
              onChange={(v) => set('calibration', v)}
            />
          </Group>

          {/* --- Output --- */}
          <Group title="Output">
            <SelectRow
              label="Packaging"
              value={draft.packaging}
              options={[
                { value: 'combined', label: 'Combined PDF' },
                { value: 'per-part', label: 'One PDF per part' },
              ]}
              onChange={(v) => set('packaging', v as Pdf1to1Settings['packaging'])}
            />
          </Group>

          {/* --- Slicing --- */}
          <Group title="Paper slicing">
            <CheckRow
              label="Slice into printable pages"
              value={draft.slice}
              onChange={(v) => set('slice', v)}
            />
            <SelectRow
              label="Paper size"
              value={draft.paperId}
              options={paperOptions}
              disabled={noSlice}
              onChange={(v) => set('paperId', v)}
            />
            {draft.paperId === 'custom' && (
              <>
                <LenField
                  label="Custom width"
                  cm={draft.customWidthCm}
                  units={units}
                  disabled={noSlice}
                  onChange={(cm) => set('customWidthCm', cm)}
                />
                <LenField
                  label="Custom height"
                  cm={draft.customHeightCm}
                  units={units}
                  disabled={noSlice}
                  onChange={(cm) => set('customHeightCm', cm)}
                />
              </>
            )}
            <SelectRow
              label="Orientation"
              value={draft.orientation}
              options={orientationOptions}
              disabled={noSlice}
              onChange={(v) => set('orientation', v as Orientation)}
            />
          </Group>

          {/* --- Marks --- */}
          <Group title="Assembly marks">
            <LenField
              label="Overlap (glue strip)"
              cm={draft.overlapCm}
              units={units}
              disabled={noSlice}
              onChange={(cm) => set('overlapCm', cm)}
            />
            <CheckRow
              label="Cut marks"
              value={draft.cutMarks}
              onChange={(v) => set('cutMarks', v)}
              disabled={noSlice}
            />
            <CheckRow
              label="Tile labels & join IDs"
              value={draft.labels}
              onChange={(v) => set('labels', v)}
              disabled={noSlice}
            />
          </Group>
        </PanelBody>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={resetToDefaults}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={exportNow}>
              Export
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
