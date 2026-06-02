/**
 * Shared presentational building blocks for the app shell: small atoms (labeled
 * rows, selects, toggles), the 3D appearance controls, and the canvas editor pane.
 * Extracted from App so the shell stays an orchestrator and these stay reusable.
 */
import {
  getDeckAtPos,
  getRockerAtPos,
  getThickness,
  getThicknessAtPos,
  getWidthAtPos,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { SplineEditor, type EditorOverlays, type SectionMarker } from '@openshaper/render2d';
import type {
  AnalysisMode,
  Board3DMode,
  LightingPreset,
  MaterialPreset,
} from '@openshaper/render3d';
import type { SplineTarget } from '@openshaper/store';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useMemo } from 'react';
import { fmtLen, type LengthUnit } from './format';
import { boardStore } from './store';

export type EditorKind = 'outline' | 'rocker' | 'crossSection';
export type View = 'quad' | EditorKind | '3d';

// --- small atoms -----------------------------------------------------------

const SELECT_CLASS = 'h-7 rounded border border-border bg-transparent px-1 text-xs';

/** A label/value row used throughout the spec + weight panels. */
export function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** A compact typed `<select>`. */
export function Sel<T extends string>({
  value,
  onChange,
  options,
  title,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  title: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      title={title}
      className={SELECT_CLASS}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A labeled checkbox row for an analysis overlay toggle. */
export function OverlayToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// --- 3D appearance controls ------------------------------------------------

const MODE_3D: { value: Board3DMode; label: string }[] = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'shaded-wire', label: '+Wire' },
  { value: 'wireframe', label: 'Wire' },
  { value: 'normals', label: 'Normals' },
];

const LIGHTING_3D: { value: LightingPreset; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: 'shaping-bay', label: 'Shaping bay' },
  { value: 'neutral', label: 'Neutral' },
];

const MATERIAL_3D: { value: MaterialPreset; label: string }[] = [
  { value: 'gloss', label: 'Glassed gloss' },
  { value: 'foam', label: 'Raw foam' },
  { value: 'matte', label: 'Matte' },
];

const ANALYSIS_3D: { value: AnalysisMode; label: string }[] = [
  { value: 'none', label: 'No analysis' },
  { value: 'zebra', label: 'Zebra' },
  { value: 'curvature', label: 'Curvature' },
  { value: 'slope', label: 'Slope' },
];

/** All 3D-view appearance + analysis settings, lifted so quad + full views share them. */
export interface View3DSettings {
  mode: Board3DMode;
  lighting: LightingPreset;
  material: MaterialPreset;
  color: string;
  analysis: AnalysisMode;
}

/**
 * 3D appearance + analysis controls. `compact` (quad view) shows just the render
 * mode + analysis; the full 3D view also exposes lighting, material, and color.
 */
export function ThreeDControls({
  settings,
  onChange,
  compact = false,
}: {
  settings: View3DSettings;
  onChange: (patch: Partial<View3DSettings>) => void;
  compact?: boolean;
}) {
  const set = onChange;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="flex gap-1">
        {MODE_3D.map((m) => (
          <Button
            key={m.value}
            size="sm"
            variant={settings.mode === m.value ? 'secondary' : 'ghost'}
            onClick={() => set({ mode: m.value })}
            title={`3D: ${m.label}`}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {!compact && (
        <>
          <Sel
            value={settings.lighting}
            onChange={(lighting) => set({ lighting })}
            options={LIGHTING_3D}
            title="Lighting"
          />
          <Sel
            value={settings.material}
            onChange={(material) => set({ material })}
            options={MATERIAL_3D}
            title="Material"
          />
          <input
            type="color"
            value={settings.color}
            onChange={(e) => set({ color: e.target.value })}
            title="Board color"
            className="h-7 w-8 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
        </>
      )}
      <Sel
        value={settings.analysis}
        onChange={(analysis) => set({ analysis })}
        options={ANALYSIS_3D}
        title="Surface analysis"
      />
    </div>
  );
}

// --- canvas editor pane ----------------------------------------------------

/**
 * View-aware "sliding info" readout (legacy sliding-info overlay): live
 * measurements at the hovered point, in the active units. Outline → width &
 * distance from the rail; rocker → rocker/thickness/%; cross-section → from-CL
 * & height.
 */
export function makeReadout(kind: EditorKind, units: LengthUnit) {
  return (world: Vec2): { label: string; value: string }[] => {
    const b = boardStore.getState().board;
    if (!b) return [];
    const L = (cm: number) => fmtLen(cm, units);
    if (kind === 'outline') {
      const halfW = getWidthAtPos(b, world.x) / 2;
      return [
        { label: 'Pos', value: L(world.x) },
        { label: 'Width', value: L(getWidthAtPos(b, world.x)) },
        { label: 'From rail', value: L(Math.max(0, halfW - Math.abs(world.y))) },
      ];
    }
    if (kind === 'rocker') {
      const thk = getThicknessAtPos(b, world.x);
      const center = getThickness(b) || 1;
      return [
        { label: 'Pos', value: L(world.x) },
        { label: 'Rocker', value: L(getRockerAtPos(b, world.x)) },
        { label: 'Deck', value: L(getDeckAtPos(b, world.x)) },
        { label: 'Thick', value: `${L(thk)} (${((thk / center) * 100).toFixed(0)}%)` },
      ];
    }
    return [
      { label: 'From CL', value: L(Math.abs(world.x)) },
      { label: 'Height', value: L(world.y) },
    ];
  };
}

/** Resolve the SplineEditor props for a single editor kind. */
function paneProps(kind: EditorKind, csIndex: number) {
  const targets: SplineTarget[] =
    kind === 'outline'
      ? [{ kind: 'outline' }]
      : kind === 'rocker'
        ? [{ kind: 'deck' }, { kind: 'bottom' }]
        : [{ kind: 'crossSection', index: csIndex }];
  return {
    targets,
    mirrorY: kind === 'outline',
    mirrorX: kind === 'crossSection',
    key: kind === 'crossSection' ? `cs-${csIndex}` : kind,
  };
}

export function EditorPane({
  title,
  kind,
  csIndex,
  units,
  sectionMarkers,
  onPickSection,
  overlays,
  ghostSplines,
  background,
  headerActions,
}: {
  title: string;
  kind: EditorKind;
  csIndex: number;
  units: LengthUnit;
  sectionMarkers?: SectionMarker[];
  onPickSection?: (index: number) => void;
  overlays?: EditorOverlays;
  ghostSplines?: Spline[];
  background?: React.ComponentProps<typeof SplineEditor>['background'];
  headerActions?: React.ReactNode;
}) {
  // Stable across re-renders so the editor's target set (and the SplineEditor
  // re-fit/draw effects keyed on it) only changes when the pane actually changes.
  const p = useMemo(() => paneProps(kind, csIndex), [kind, csIndex]);
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader className={headerActions ? 'gap-2' : undefined}>
        <PanelTitle>{title}</PanelTitle>
        {headerActions}
      </PanelHeader>
      <PanelBody className="min-h-0 flex-1 p-0">
        <SplineEditor
          key={p.key}
          store={boardStore}
          targets={p.targets}
          mirrorY={p.mirrorY}
          mirrorX={p.mirrorX}
          sectionMarkers={kind === 'outline' ? sectionMarkers : undefined}
          onPickSection={kind === 'outline' ? onPickSection : undefined}
          readout={makeReadout(kind, units)}
          overlays={overlays}
          ghostSplines={ghostSplines}
          background={kind === 'outline' ? background : undefined}
        />
      </PanelBody>
    </Panel>
  );
}
