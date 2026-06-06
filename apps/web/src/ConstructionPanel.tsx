import {
  buildHwsTemplates,
  DEFAULT_HWS_PARAMS,
  type HwsParams,
  sheetToSvg,
  type TemplateSheet,
} from '@openshaper/export';
import type { BezierBoard } from '@openshaper/kernel';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadTemplateSheet, type TemplateFormat } from './file-io';
import {
  cmToUnitNumber,
  exportUnitFor,
  fmtDimsHeadline,
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
  units,
  specs,
  onClose,
}: {
  board: BezierBoard;
  units: LengthUnit;
  specs: PanelSpecs | null;
  onClose: () => void;
}) {
  const [p, setP] = useState<HwsParams>(DEFAULT_HWS_PARAMS);
  const set = <K extends keyof HwsParams>(key: K, value: HwsParams[K]): void =>
    setP((prev) => ({ ...prev, [key]: value }));

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
    return { ...built, meta: { ...built.meta, note } };
  }, [board, p, note]);

  // --- Preview navigation: part stepper + zoom/pan ---
  const partCount = sheet.parts.length;
  // 'all' = full sheet; otherwise a single part index.
  const [view, setView] = useState<'all' | number>('all');
  const effectiveView: 'all' | number = typeof view === 'number' && view < partCount ? view : 'all';

  const viewSheet = useMemo<TemplateSheet>(
    () => (effectiveView === 'all' ? sheet : { ...sheet, parts: [sheet.parts[effectiveView]!] }),
    [sheet, effectiveView],
  );
  const svg = useMemo(
    () => sheetToSvg(viewSheet, { strokeWidthMm: 0.4, unit: exportUnit }),
    [viewSheet, exportUnit],
  );

  // Stepper indices: 0 = "All parts", 1..N = individual parts.
  const stepCount = partCount + 1;
  const stepIndex = effectiveView === 'all' ? 0 : effectiveView + 1;
  const stepLabel =
    effectiveView === 'all' ? 'All parts' : (sheet.parts[effectiveView]?.label ?? 'Part');
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
              <NumField
                label="Rail inset"
                units={units}
                value={p.railInset}
                onChange={(v) => set('railInset', v)}
              />
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
              <Toggle
                label="Lightening holes"
                checked={p.lighteningHoles}
                onChange={(v) => set('lighteningHoles', v)}
              />
              {p.lighteningHoles && (
                <NumField
                  label="Web margin"
                  units={units}
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
                units={units}
                value={p.kerf}
                onChange={(v) => set('kerf', v)}
              />
              <NumField
                label="Skin overhang"
                units={units}
                value={p.skinOverhang}
                onChange={(v) => set('skinOverhang', v)}
              />
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {partCount} part{partCount === 1 ? '' : 's'} · red = cut, blue = mark · {suf}
              </span>
              <div className="flex gap-2">
                {(['dxf', 'svg', 'pdf'] as TemplateFormat[]).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    onClick={() => downloadTemplateSheet(sheet, f, exportUnit)}
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
