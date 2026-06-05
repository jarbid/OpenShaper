import {
  buildHwsTemplates,
  DEFAULT_HWS_PARAMS,
  type HwsParams,
  sheetToSvg,
} from '@openshaper/export';
import type { BezierBoard } from '@openshaper/kernel';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useMemo, useState } from 'react';
import { downloadTemplateSheet, type TemplateFormat } from './file-io';

/**
 * Parametric panel for the Hollow-Wood-Surfboard (HWS) internal-frame templates.
 * Flow: Templates menu → this panel → export. A live SVG preview is produced by the
 * same writer used for the SVG download, so what you see is what you cut. Lengths
 * in the kernel are centimetres; "mm" fields convert on the boundary.
 */
export function ConstructionPanel({ board, onClose }: { board: BezierBoard; onClose: () => void }) {
  const [p, setP] = useState<HwsParams>(DEFAULT_HWS_PARAMS);
  const set = <K extends keyof HwsParams>(key: K, value: HwsParams[K]): void =>
    setP((prev) => ({ ...prev, [key]: value }));

  const sheet = useMemo(() => buildHwsTemplates(board, p), [board, p]);
  const svg = useMemo(() => sheetToSvg(sheet, { strokeWidthMm: 0.4 }), [sheet]);
  const partCount = sheet.parts.length;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-5xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Hollow Wood Frame — construction templates</PanelTitle>
          <Button size="sm" variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>
        <PanelBody className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[20rem_1fr]">
          {/* --- Parameter form --- */}
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1 text-sm">
            <Group title="Material">
              <NumField
                label="Frame thickness"
                mm
                value={p.materialThickness}
                onChange={(v) => set('materialThickness', v)}
              />
              <NumField
                label="Skin thickness"
                mm
                value={p.skinThickness}
                onChange={(v) => set('skinThickness', v)}
              />
            </Group>

            <Group title="Ribs">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Placement</span>
                <select
                  className="h-8 rounded border border-border bg-background px-2"
                  value={p.ribMode}
                  onChange={(e) => set('ribMode', e.target.value as HwsParams['ribMode'])}
                >
                  <option value="crossSections">From cross-sections</option>
                  <option value="spacing">By spacing</option>
                  <option value="evenCount">Even count</option>
                </select>
              </label>
              {p.ribMode === 'spacing' && (
                <NumField
                  label="Rib spacing"
                  cm
                  value={p.ribSpacing}
                  onChange={(v) => set('ribSpacing', v)}
                />
              )}
              {p.ribMode === 'evenCount' && (
                <NumField
                  label="Rib count"
                  value={p.ribCount}
                  step={1}
                  min={1}
                  onChange={(v) => set('ribCount', Math.round(v))}
                />
              )}
              <NumField
                label="End margin"
                cm
                value={p.endMargin}
                onChange={(v) => set('endMargin', v)}
              />
              <NumField
                label="Rail inset"
                mm
                value={p.railInset}
                onChange={(v) => set('railInset', v)}
              />
            </Group>

            <Group title="Joinery">
              <NumField
                label="Slot fit (clearance)"
                mm
                value={p.slotFit}
                onChange={(v) => set('slotFit', v)}
              />
              <NumField
                label="Half-lap fraction"
                value={p.halfLapFraction}
                step={0.05}
                min={0.1}
                onChange={(v) => set('halfLapFraction', v)}
              />
            </Group>

            <Group title="Lightening">
              <Toggle
                label="Lightening holes"
                checked={p.lighteningHoles}
                onChange={(v) => set('lighteningHoles', v)}
              />
              {p.lighteningHoles && (
                <NumField
                  label="Web margin"
                  cm
                  value={p.webMargin}
                  onChange={(v) => set('webMargin', v)}
                />
              )}
            </Group>

            <Group title="Parts">
              <Toggle
                label="Stringer"
                checked={p.includeStringer}
                onChange={(v) => set('includeStringer', v)}
              />
              <Toggle
                label="Ribs"
                checked={p.includeRibs}
                onChange={(v) => set('includeRibs', v)}
              />
              <Toggle
                label="Deck skin"
                checked={p.includeDeckSkin}
                onChange={(v) => set('includeDeckSkin', v)}
              />
              <Toggle
                label="Bottom skin"
                checked={p.includeBottomSkin}
                onChange={(v) => set('includeBottomSkin', v)}
              />
            </Group>

            <Group title="Cutting">
              <NumField
                label="Kerf (tool dia.)"
                mm
                value={p.kerf}
                onChange={(v) => set('kerf', v)}
              />
              <NumField
                label="Skin overhang"
                cm
                value={p.skinOverhang}
                onChange={(v) => set('skinOverhang', v)}
              />
            </Group>
          </div>

          {/* --- Preview + export --- */}
          <div className="flex min-h-0 flex-col gap-3">
            <div
              className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {partCount} part{partCount === 1 ? '' : 's'} · red = cut, blue = mark
              </span>
              <div className="flex gap-2">
                {(['dxf', 'svg', 'pdf'] as TemplateFormat[]).map((f) => (
                  <Button key={f} size="sm" onClick={() => downloadTemplateSheet(sheet, f)}>
                    {f.toUpperCase()}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

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

/**
 * A labelled numeric field. By default the value is treated as centimetres; pass
 * `mm` to display/edit in millimetres (×10) or `cm` for an explicit cm suffix.
 */
function NumField({
  label,
  value,
  onChange,
  mm = false,
  cm = false,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (cmValue: number) => void;
  mm?: boolean;
  cm?: boolean;
  step?: number;
  min?: number;
}) {
  const display = mm ? Math.round(value * 1000) / 100 : Math.round(value * 1000) / 1000;
  const suffix = mm ? 'mm' : cm ? 'cm' : '';
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          className="h-8 w-20 text-right"
          value={Number.isFinite(display) ? display : ''}
          step={step ?? (mm ? 0.1 : 0.5)}
          min={min}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) return;
            onChange(mm ? v / 10 : v);
          }}
        />
        <span className="w-5 text-xs text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
