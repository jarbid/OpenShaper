import {
  buildHwsTemplates,
  cuttingList,
  DEFAULT_HWS_PARAMS,
  type HwsParams,
  layoutNestedSheet,
  nestedSheetViews,
  nestParts,
  railOffset,
  sheetToSvg,
  type TemplateSheet,
  totalPieces,
} from '@openshaper/export';
import type { BezierBoard } from '@openshaper/kernel';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadTemplateSheet, slugifyName, type TemplateFormat } from './file-io';
import {
  HWS_SETTINGS_VERSION,
  type HwsOutputSettings,
  loadHwsSettings,
  saveHwsSettings,
} from './hws-settings';
import {
  cmToUnitNumber,
  exportUnitFor,
  fmtDimsHeadline,
  fmtLen,
  type LengthUnit,
  parseLen,
  unitDecimals,
  unitSuffix,
} from './format';

/** The board dimensions used to compose the export note (internal cm). */
export interface PanelSpecs {
  length: number;
  maxWidth: number;
  thickness: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Parametric panel for the Hollow-Wood-Surfboard (HWS) internal-frame templates.
 * Flow: Templates menu → this panel → export. A live SVG preview is produced by the
 * same writer used for the SVG download, so what you see is what you cut. Lengths
 * in the kernel are centimetres; fields display in the editor's selected unit and
 * convert on the boundary, and the exports inherit that unit too.
 */
export function ConstructionPanel({
  board,
  boardName,
  units,
  specs,
  onClose,
}: {
  board: BezierBoard;
  /** Board model name (meta.model) — used for the download filenames. */
  boardName?: string;
  units: LengthUnit;
  specs: PanelSpecs | null;
  onClose: () => void;
}) {
  const [p, setP] = useState<HwsParams>(() => loadHwsSettings().params);
  const set = <K extends keyof HwsParams>(key: K, value: HwsParams[K]): void =>
    setP((prev) => ({ ...prev, [key]: value }));
  const [output, setOutput] = useState<HwsOutputSettings>(() => loadHwsSettings().output);
  const setOut = <K extends keyof HwsOutputSettings>(key: K, value: HwsOutputSettings[K]): void =>
    setOutput((prev) => ({ ...prev, [key]: value }));

  // Persist params + output choices on every change.
  useEffect(() => {
    saveHwsSettings({ version: HWS_SETTINGS_VERSION, params: p, output });
  }, [p, output]);

  const exportUnit = exportUnitFor(units);
  const suf = unitSuffix(units);
  const fmtLenField = (cm: number): string =>
    cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

  // Board-info + units note printed on every export and shown in the preview.
  const note = useMemo(() => {
    const dims = specs ? fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units) : '';
    return (
      `OpenShaper HWS${dims ? ` · ${dims}` : ''}` +
      ` · frame ${fmtLenField(p.materialThickness)} / skin ${fmtLenField(p.skinThickness)} ${suf}` +
      ` · units: ${suf}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs, units, p.materialThickness, p.skinThickness]);

  const sheet = useMemo<TemplateSheet>(() => {
    const built = buildHwsTemplates(board, p);
    const pieces = totalPieces(cuttingList(built));
    return { ...built, meta: { ...built.meta, note: `${note} · ${pieces} pieces` } };
  }, [board, p, note]);
  const cutList = useMemo(() => cuttingList(sheet), [sheet]);

  // Optional material-sheet nesting (affects the DXF/SVG layout + preview only).
  const nest = useMemo(
    () =>
      output.nest
        ? nestParts(sheet.parts, {
            widthCm: output.nestWidthCm,
            heightCm: output.nestHeightCm,
            allowRotate: output.nestAllowRotate,
          })
        : null,
    [sheet, output.nest, output.nestWidthCm, output.nestHeightCm, output.nestAllowRotate],
  );
  const nestedLayout = useMemo(() => (nest ? layoutNestedSheet(sheet, nest) : null), [sheet, nest]);
  const sheetViews = useMemo(() => (nest ? nestedSheetViews(sheet, nest) : null), [sheet, nest]);

  // --- Preview navigation: part/sheet stepper + zoom/pan ---
  const partCount = sheet.parts.length;
  // 'all' = full layout; otherwise a single part (or, when nesting, sheet) index.
  const [view, setView] = useState<'all' | number>('all');
  const viewMax = sheetViews ? sheetViews.length : partCount;
  const effectiveView: 'all' | number = typeof view === 'number' && view < viewMax ? view : 'all';

  const viewSheet = useMemo<TemplateSheet>(() => {
    if (sheetViews) return effectiveView === 'all' ? nestedLayout! : sheetViews[effectiveView]!;
    return effectiveView === 'all' ? sheet : { ...sheet, parts: [sheet.parts[effectiveView]!] };
  }, [sheet, sheetViews, nestedLayout, effectiveView]);
  const svg = useMemo(
    () => sheetToSvg(viewSheet, { strokeWidthMm: 0.4, unit: exportUnit }),
    [viewSheet, exportUnit],
  );

  // Stepper indices: 0 = "All parts"/"All sheets", 1..N = individual parts/sheets.
  const stepCount = viewMax + 1;
  const stepIndex = effectiveView === 'all' ? 0 : effectiveView + 1;
  // Part name plus — for ribs — its board station, in the editor's display unit.
  const partLabel = (part: { label: string; station?: number } | undefined): string => {
    if (!part) return 'Part';
    return part.station != null ? `${part.label} @ ${fmtLen(part.station, units)}` : part.label;
  };
  const stepLabel = sheetViews
    ? effectiveView === 'all'
      ? 'All sheets'
      : `Sheet ${effectiveView + 1}/${sheetViews.length}`
    : effectiveView === 'all'
      ? 'All parts'
      : partLabel(sheet.parts[effectiveView]);
  const gotoStep = (i: number): void => {
    const wrapped = ((i % stepCount) + stepCount) % stepCount;
    setView(wrapped === 0 ? 'all' : wrapped - 1);
  };

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const fit = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  // Reset the view transform whenever the previewed part changes.
  useEffect(fit, [effectiveView]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Wheel-zoom toward the cursor. Bound non-passively so preventDefault sticks.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const next = clamp(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.25, 20);
        const ratio = next / z;
        setPan((pn) => ({ x: cx - (cx - pn.x) * ratio, y: cy - (cy - pn.y) * ratio }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent): void => {
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-5xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Hollow Wood Frame — construction templates</PanelTitle>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setP(DEFAULT_HWS_PARAMS)}>
              Reset to defaults
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </PanelHeader>
        <PanelBody className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[20rem_1fr]">
          {/* --- Parameter form --- */}
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1 text-sm">
            <Group title="Material">
              <NumField
                label="Frame thickness"
                units={units}
                value={p.materialThickness}
                onChange={(v) => set('materialThickness', v)}
              />
              <NumField
                label="Skin thickness"
                units={units}
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
                  units={units}
                  value={p.ribSpacing}
                  onChange={(v) => set('ribSpacing', v)}
                />
              )}
              {p.ribMode === 'evenCount' && (
                <NumField
                  label="Rib count"
                  unitless
                  value={p.ribCount}
                  step={1}
                  min={1}
                  onChange={(v) => set('ribCount', Math.round(v))}
                />
              )}
              <NumField
                label="End margin"
                units={units}
                value={p.endMargin}
                onChange={(v) => set('endMargin', v)}
              />
            </Group>

            <Group title="Rail band">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Lamination</span>
                <select
                  className="h-8 rounded border border-border bg-background px-2"
                  value={p.railLamination}
                  onChange={(e) =>
                    set('railLamination', e.target.value as HwsParams['railLamination'])
                  }
                >
                  <option value="vertical">Vertical strips</option>
                  <option value="horizontal">Horizontal layers</option>
                </select>
              </label>
              {p.railLamination === 'vertical' ? (
                <>
                  {/* Vertical strips build the band inward: offset = stock × count. */}
                  <NumField
                    label="Laminations"
                    unitless
                    value={p.railLaminations}
                    step={1}
                    min={0}
                    onChange={(v) => set('railLaminations', Math.max(0, Math.round(v)))}
                  />
                  <NumField
                    label="Strip thickness"
                    units={units}
                    value={p.railStripThickness}
                    onChange={(v) => set('railStripThickness', v)}
                  />
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>Rail/outline offset</span>
                    <span>{railOffset(p) > 0 ? fmtLen(railOffset(p), units) : '—'}</span>
                  </div>
                </>
              ) : (
                <>
                  {/* Horizontal layers stack UP the rail: plan width is set directly. */}
                  <NumField
                    label="Band width"
                    units={units}
                    value={p.railBandWidth}
                    min={0}
                    onChange={(v) => set('railBandWidth', Math.max(0, v))}
                  />
                  <NumField
                    label="Layer thickness"
                    units={units}
                    value={p.railStripThickness}
                    onChange={(v) => set('railStripThickness', v)}
                  />
                </>
              )}
              {railOffset(p) > 0 && (
                <>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Rib joint</span>
                    <select
                      className="h-8 rounded border border-border bg-background px-2"
                      value={p.railJoint}
                      onChange={(e) => set('railJoint', e.target.value as HwsParams['railJoint'])}
                    >
                      <option value="butt">Butt + reference lines</option>
                      <option value="tabSlot">Tab + slot</option>
                    </select>
                  </label>
                  <NumField
                    label="Tail trim"
                    units={units}
                    value={p.railTailTrim}
                    onChange={(v) => set('railTailTrim', v)}
                  />
                  <NumField
                    label="Nose trim"
                    units={units}
                    value={p.railNoseTrim}
                    onChange={(v) => set('railNoseTrim', v)}
                  />
                  {p.railLamination === 'vertical' && (
                    <Toggle
                      label="Flatten (follow rocker)"
                      checked={p.railFlatten}
                      onChange={(v) => set('railFlatten', v)}
                    />
                  )}
                </>
              )}
            </Group>

            <Group title="Joinery">
              <NumField
                label="Slot fit (clearance)"
                units={units}
                value={p.slotFit}
                onChange={(v) => set('slotFit', v)}
              />
              <NumField
                label="Half-lap fraction"
                unitless
                value={p.halfLapFraction}
                step={0.05}
                min={0.1}
                onChange={(v) => set('halfLapFraction', v)}
              />
            </Group>

            <Group title="Lightening">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Style</span>
                <select
                  className="h-8 rounded border border-border bg-background px-2"
                  value={p.lighteningStyle}
                  onChange={(e) =>
                    set('lighteningStyle', e.target.value as HwsParams['lighteningStyle'])
                  }
                >
                  <option value="none">None (solid)</option>
                  <option value="truss">Truss web</option>
                  <option value="pocket">Pocket (filleted)</option>
                  <option value="circles">Circular holes</option>
                </select>
              </label>
              {p.lighteningStyle !== 'none' && (
                <NumField
                  label="Web margin (rim)"
                  units={units}
                  value={p.webMargin}
                  onChange={(v) => set('webMargin', v)}
                />
              )}
              {p.lighteningStyle === 'truss' && (
                <>
                  <NumField
                    label="Web thickness"
                    units={units}
                    value={p.webThickness}
                    onChange={(v) => set('webThickness', v)}
                  />
                  <NumField
                    label="Bay spacing"
                    units={units}
                    value={p.trussSpacing}
                    onChange={(v) => set('trussSpacing', v)}
                  />
                  <NumField
                    label="Diagonal lean (°)"
                    unitless
                    value={p.trussAngle}
                    step={5}
                    min={0}
                    onChange={(v) => set('trussAngle', clamp(v, 0, 60))}
                  />
                  <NumField
                    label="Corner radius"
                    units={units}
                    value={p.pocketCornerRadius}
                    onChange={(v) => set('pocketCornerRadius', v)}
                  />
                </>
              )}
              {p.lighteningStyle === 'pocket' && (
                <NumField
                  label="Corner radius"
                  units={units}
                  value={p.pocketCornerRadius}
                  onChange={(v) => set('pocketCornerRadius', v)}
                />
              )}
              {p.lighteningStyle === 'circles' && (
                <>
                  <NumField
                    label="Hole diameter"
                    units={units}
                    value={p.holeDiameter}
                    onChange={(v) => set('holeDiameter', v)}
                  />
                  <NumField
                    label="Hole spacing"
                    units={units}
                    value={p.holeSpacing}
                    onChange={(v) => set('holeSpacing', v)}
                  />
                </>
              )}
              {p.lighteningStyle !== 'none' && (
                <Toggle
                  label="Also lighten stringer"
                  checked={p.lightenStringer}
                  onChange={(v) => set('lightenStringer', v)}
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
              {railOffset(p) > 0 && (
                <Toggle
                  label="Rail template"
                  checked={p.includeRailTemplate}
                  onChange={(v) => set('includeRailTemplate', v)}
                />
              )}
            </Group>

            <Group title="Skins">
              <NumField
                label="Skin overhang"
                units={units}
                value={p.skinOverhang}
                onChange={(v) => set('skinOverhang', v)}
              />
            </Group>

            <Group title="Layout (DXF / SVG)">
              <Toggle
                label="Nest to material sheets"
                checked={output.nest}
                onChange={(v) => setOut('nest', v)}
              />
              {output.nest && (
                <>
                  <NumField
                    label="Sheet width"
                    units={units}
                    value={output.nestWidthCm}
                    onChange={(v) => setOut('nestWidthCm', Math.max(1, v))}
                  />
                  <NumField
                    label="Sheet height"
                    units={units}
                    value={output.nestHeightCm}
                    onChange={(v) => setOut('nestHeightCm', Math.max(1, v))}
                  />
                  <Toggle
                    label="Allow 90° rotation"
                    checked={output.nestAllowRotate}
                    onChange={(v) => setOut('nestAllowRotate', v)}
                  />
                </>
              )}
            </Group>
          </div>

          {/* --- Preview + export --- */}
          <div className="flex min-h-0 flex-col gap-3">
            {/* Navigation toolbar */}
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => gotoStep(stepIndex - 1)}>
                  ‹
                </Button>
                <span className="min-w-28 text-center text-muted-foreground">
                  {stepLabel} ({stepIndex + 1}/{stepCount})
                </span>
                <Button size="sm" variant="ghost" onClick={() => gotoStep(stepIndex + 1)}>
                  ›
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setZoom((z) => clamp(z / 1.25, 0.25, 20))}
                >
                  −
                </Button>
                <span className="w-10 text-center text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setZoom((z) => clamp(z * 1.25, 0.25, 20))}
                >
                  +
                </Button>
                <Button size="sm" variant="ghost" onClick={fit}>
                  Fit
                </Button>
              </div>
            </div>

            {nest && nest.unplaced.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                ⚠ {nest.unplaced.length} part{nest.unplaced.length === 1 ? '' : 's'} exceed
                {nest.unplaced.length === 1 ? 's' : ''} the material sheet — placed beside the
                sheets in the export
              </div>
            )}

            {(sheet.warnings?.length ?? 0) > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {sheet.warnings!.length <= 3 ? (
                  <ul className="space-y-0.5">
                    {sheet.warnings!.map((w, i) => (
                      <li key={i}>⚠ {w.message}</li>
                    ))}
                  </ul>
                ) : (
                  <details>
                    <summary className="cursor-pointer">
                      ⚠ {sheet.warnings!.length} build warnings
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {sheet.warnings!.map((w, i) => (
                        <li key={i}>{w.message}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <div
              ref={viewportRef}
              className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded border border-border bg-white active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <div
                className="absolute inset-0 p-2 [&_svg]:h-full [&_svg]:w-full"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: '0 0',
                }}
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
            {/* Cutting list: template sizes + copies to cut, in the display unit. */}
            {cutList.length > 0 && (
              <div className="max-h-36 overflow-y-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Part</th>
                      <th className="px-2 py-1 text-right font-medium">Size</th>
                      <th className="px-2 py-1 text-right font-medium">Cut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cutList.map((item) => (
                      <tr key={item.partId} className="border-t border-border/50">
                        <td className="px-2 py-0.5">{item.label}</td>
                        <td className="px-2 py-0.5 text-right text-muted-foreground">
                          {fmtLen(item.widthCm, units)} × {fmtLen(item.heightCm, units)}
                        </td>
                        <td className="px-2 py-0.5 text-right">{item.count}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {partCount} part{partCount === 1 ? '' : 's'} · {totalPieces(cutList)} pieces
                {nest ? ` · ${nest.sheets} sheet${nest.sheets === 1 ? '' : 's'}` : ''} · red = cut,
                blue = mark · {suf}
              </span>
              <div className="flex gap-2">
                {(['dxf', 'svg', 'pdf'] as TemplateFormat[]).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    onClick={() =>
                      downloadTemplateSheet(
                        // DXF/SVG take the nested layout when enabled; PDF stays per part.
                        f !== 'pdf' && nestedLayout ? nestedLayout : sheet,
                        f,
                        exportUnit,
                        `${slugifyName(boardName)}-hws-frame`,
                      )
                    }
                  >
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
 * A labelled numeric field. Length fields display/edit in the editor's `units`
 * (converting to/from internal centimetres); pass `unitless` for dimensionless
 * values (ratios, counts).
 */
function NumField({
  label,
  value,
  onChange,
  units,
  unitless = false,
  step,
  min,
}: {
  label: string;
  value: number;
  /** Receives the value back in internal centimetres (or raw, if `unitless`). */
  onChange: (cmValue: number) => void;
  units?: LengthUnit;
  unitless?: boolean;
  step?: number;
  min?: number;
}) {
  const isLen = !unitless && !!units;
  const display = isLen ? cmToUnitNumber(value, units!) : Math.round(value * 1000) / 1000;
  const suffix = isLen ? unitSuffix(units!) : '';
  const decimals = isLen ? unitDecimals(units!) : 3;
  const rounded = Number.isFinite(display)
    ? Math.round(display * 10 ** decimals) / 10 ** decimals
    : '';
  const defaultStep = isLen ? (suffix === 'mm' ? 0.5 : suffix === 'in' ? 0.0625 : 0.1) : 0.1;
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          className="h-8 w-20 text-right"
          value={rounded}
          step={step ?? defaultStep}
          min={min}
          onChange={(e) => {
            if (e.target.value === '') return;
            const next = isLen ? parseLen(e.target.value, units!) : parseFloat(e.target.value);
            if (!Number.isFinite(next)) return;
            onChange(next);
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
