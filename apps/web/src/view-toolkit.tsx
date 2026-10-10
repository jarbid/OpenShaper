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
import {
  MEASURE_COLORS,
  SplineEditor,
  type EditorOverlays,
  type SectionMarker,
} from '@openshaper/render2d';
import type { SplineTarget } from '@openshaper/store';
import {
  Button,
  Checkbox,
  cn,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
} from '@openshaper/ui';
import { useMemo } from 'react';
import { fmtLen, LENGTH_UNITS, type LengthUnit } from './format';
import type { Longitudinal, MeasurementAxis } from './longitudinal';
import { SelectedPointEditor } from './ControlPointInspector';
import { boardStore } from './store';
import type { EditorSettings } from './settings';
import { useIsCoarsePointer } from './useMediaQuery';
import {
  ANALYSIS_3D,
  LIGHTING_3D,
  MATERIAL_3D,
  MODE_3D,
  QUALITY_3D,
  type View3DSettings,
} from './view3d-settings';

export type EditorKind = 'outline' | 'rocker' | 'crossSection';
/** What a single pane can show — one of the 2D editors or the 3D surface. */
export type SplitPaneKind = EditorKind | '3d';
export type View = 'quad' | 'split' | EditorKind | '3d';

/** The panes a split half can be pointed at, in picker order. */
export const SPLIT_PANE_KINDS: readonly SplitPaneKind[] = [
  'outline',
  'rocker',
  'crossSection',
  '3d',
];

/** Short pane names, for the split pickers. */
export const PANE_LABELS: Record<SplitPaneKind, string> = {
  outline: 'Outline',
  rocker: 'Rocker',
  crossSection: 'Cross-section',
  '3d': '3D',
};

/** The layout tier, as the two media-query answers that gate a view. */
export interface ViewTier {
  isPhone: boolean;
  isDesktop: boolean;
}

/**
 * Whether a view is offered at the current layout tier.
 *
 * Quad stacks its four panes into a scrolling column below `lg`. On a phone that
 * is ~1200px of scroll inside a ~740px viewport, and because every canvas sets
 * `touch-action: none` the column can only be scrolled from the gaps between
 * panes and the pane headers — so most of it is unreachable by the gesture a
 * phone user would naturally try. Phones get the single views instead.
 *
 * Split halves the viewport height between two full-width panes, so it needs a
 * height budget the compact tiers do not have: below `lg` each half would be
 * shorter than the fixed pane height the stacked quad column already settled on,
 * with a pane header eating into it twice. It is a desktop layout, and the tab
 * and its number key are both withheld everywhere else.
 */
export const isViewAvailable = (view: View, { isPhone, isDesktop }: ViewTier): boolean => {
  if (view === 'quad') return !isPhone;
  if (view === 'split') return isDesktop;
  return true;
};

/** Where a tier lands when the view it would otherwise restore is unavailable. */
export const FALLBACK_VIEW: View = 'outline';

// Re-export 3D settings so existing importers from view-toolkit keep working
export { faceSizeFor } from './view3d-settings';
export type { MeshQuality, View3DSettings } from './view3d-settings';

/**
 * A stable header shared by every 2D and 3D editor pane.
 *
 * `PanelHeader`'s `px-4` becomes `px-2` on a coarse pointer. 16px of gutter is
 * cheap on a desktop and expensive on a phone: the cross-section cluster needs
 * every pixel of a 360px row once its controls are at the touch floor, and the
 * pane title beside it is already truncating to nothing at that width.
 */
export function ViewPaneHeader({ className, ...props }: React.ComponentProps<typeof PanelHeader>) {
  return <PanelHeader className={cn('min-h-14 pointer-coarse:px-2', className)} {...props} />;
}

/** Hover hint for the pane titles that toggle between Quad and a single view. */
export const VIEW_TOGGLE_HINT = 'Double-click to switch between this view and Quad';

/**
 * A pane title that doubles as the Quad <-> single-view toggle.
 *
 * Double-click is a mouse-only shorthand — the tab strip and the number keys in
 * `shortcuts.ts` remain the discoverable route, and a tier that does not offer the
 * target view simply ignores it. So the heading only advertises itself when a
 * handler is actually wired: a pointer cursor, the hint above, and `select-none`,
 * without which a double-click leaves the title text highlighted behind the view
 * it just switched to.
 */
export function ViewToggleTitle({
  className,
  onDoubleClick,
  children,
}: {
  className?: string;
  onDoubleClick?: React.MouseEventHandler<HTMLHeadingElement>;
  children: React.ReactNode;
}) {
  return (
    <PanelTitle
      className={cn(onDoubleClick && 'cursor-pointer select-none', className)}
      title={onDoubleClick ? VIEW_TOGGLE_HINT : undefined}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </PanelTitle>
  );
}

/**
 * The pane picker that stands in for a split half's title.
 *
 * Split view is two panes and two choices, so the choice lives where the pane
 * name would otherwise be: the heading *is* the control, and there is no second
 * place to look for it. It replaces `ViewToggleTitle` rather than joining the
 * header actions, because those are the fallback slot of `SelectedPointEditor`
 * and vanish the moment a control point is selected — which is exactly when
 * someone is most likely to want the other half of the board on screen.
 */
export function SplitPaneSelect({
  slot,
  value,
  onChange,
}: {
  slot: 'Top' | 'Bottom';
  value: SplitPaneKind;
  onChange: (kind: SplitPaneKind) => void;
}) {
  const label = `${slot} pane view`;
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value as SplitPaneKind)}
      title={label}
      aria-label={label}
      // Sized and weighted like the `PanelTitle` it stands in for, so the header
      // still reads as a row of pane names rather than a row of form controls.
      className="mr-auto h-8 w-auto shrink-0 border-transparent bg-transparent px-1 text-sm font-medium shadow-none hover:border-input"
    >
      {SPLIT_PANE_KINDS.map((k) => (
        <option key={k} value={k}>
          {PANE_LABELS[k]}
        </option>
      ))}
    </Select>
  );
}

// --- small atoms -----------------------------------------------------------

/** A label/value row used throughout the spec + weight panels. */
export function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/**
 * The display-unit picker.
 *
 * Lives in the toolbar on wide layouts and in the bottom sheet on the phone tier,
 * where the toolbar row has no room for it — at 360px the four view tabs plus this
 * plus the panels button come to ~411px, and because this is `shrink-0` the tab
 * strip absorbed the overflow and pushed a whole view off-screen. One component
 * either way, so a phone does not silently get a smaller control.
 */
export function UnitSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="Display units"
      aria-label="Display units"
      // The raised-panel palette rather than the primitive's `bg-background`: this
      // one sits on the toolbar, where the page colour would make it disappear.
      className={cn(
        'shrink-0 bg-card text-card-foreground [&>option]:bg-card [&>option]:text-card-foreground',
        className,
      )}
    >
      {LENGTH_UNITS.map((u) => (
        <option key={u.key} value={u.key}>
          {u.label}
        </option>
      ))}
    </Select>
  );
}

export function MeasurementAxisSelect({
  value,
  onChange,
}: {
  value: MeasurementAxis;
  onChange: (axis: MeasurementAxis) => void;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value as MeasurementAxis)}
      title="Longitudinal measurement axis"
      aria-label="Longitudinal measurement axis"
      className="shrink-0 bg-card text-card-foreground [&>option]:bg-card [&>option]:text-card-foreground"
    >
      <option value="x-axis">x-axis</option>
      <option value="o-curve">o/curve</option>
    </Select>
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
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      title={title}
      // Denser than the default with a mouse; the coarse-pointer size survives the
      // merge, so a fingertip still gets the full 44px.
      className="h-7 px-1 text-xs"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
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
  // The floor lives on the label, not the box: a native checkbox cannot be grown
  // with padding, and a 44px one would look broken. The whole row is clickable, so
  // that is the target worth measuring.
  return (
    <label className="flex cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// --- 3D appearance controls ------------------------------------------------

/**
 * 3D appearance + analysis controls. `compact` (quad view) shows render mode,
 * lighting, the section toggle, analysis, and mesh quality; the full 3D view also
 * exposes material and board color.
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
      {/* Lighting is useful in the quad mini-pane too, so it stays out of `!compact`. */}
      <Sel
        value={settings.lighting}
        onChange={(lighting) => set({ lighting })}
        options={LIGHTING_3D}
        title="Lighting"
      />
      <Button
        size="sm"
        variant={settings.showStringer ? 'secondary' : 'ghost'}
        onClick={() => set({ showStringer: !settings.showStringer })}
        title="Draw the stringer line down the centre of the board"
      >
        Stringer
      </Button>
      <Button
        size="sm"
        variant={settings.showSections ? 'secondary' : 'ghost'}
        onClick={() => set({ showSections: !settings.showSections })}
        title="Draw a ring at every cross-section (the active one in cyan)"
      >
        Sections
      </Button>
      {!compact && (
        <>
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
      <Sel
        value={settings.meshQuality}
        onChange={(meshQuality) => set({ meshQuality })}
        options={QUALITY_3D}
        title="Mesh quality"
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
export function makeReadout(kind: EditorKind, units: LengthUnit, longitudinal: Longitudinal) {
  return (world: Vec2): { label: string; value: string; color?: string }[] => {
    const b = boardStore.getState().board;
    if (!b) return [];
    const L = (cm: number) => fmtLen(cm, units);
    const pos = (x: number) => ({
      label: 'Pos' + longitudinal.mark,
      value: L(longitudinal.toDisplay(x)),
      color: cyan,
    });
    // The scrub probe is the cyan vertical line at the cursor's board-x; its readouts
    // (position + the span it measures) are coloured to match it.
    const cyan = MEASURE_COLORS.fromCl;
    if (kind === 'outline') {
      const halfW = getWidthAtPos(b, world.x) / 2;
      return [
        pos(world.x),
        { label: 'Width', value: L(getWidthAtPos(b, world.x)), color: cyan },
        { label: 'From rail', value: L(Math.max(0, halfW - Math.abs(world.y))) },
      ];
    }
    if (kind === 'rocker') {
      const thk = getThicknessAtPos(b, world.x);
      const center = getThickness(b) || 1;
      return [
        pos(world.x),
        { label: 'Rocker', value: L(getRockerAtPos(b, world.x)) },
        { label: 'Deck', value: L(getDeckAtPos(b, world.x)) },
        { label: 'Thick', value: `${L(thk)} (${((thk / center) * 100).toFixed(0)}%)`, color: cyan },
      ];
    }
    // Colour-coded to match the measurement-cursor probes (legacy "sliding info"):
    // From CL ↔ vertical probe, Height ↔ horizontal probe.
    return [
      { label: 'From CL', value: L(Math.abs(world.x)), color: MEASURE_COLORS.fromCl },
      { label: 'Height', value: L(world.y), color: MEASURE_COLORS.height },
    ];
  };
}

/** Resolve the SplineEditor props for a single editor kind. */
function paneProps(kind: EditorKind, csIndex: number, settings?: EditorSettings) {
  const targets: SplineTarget[] =
    kind === 'outline'
      ? [{ kind: 'outline' }]
      : kind === 'rocker'
        ? [{ kind: 'deck' }, { kind: 'bottom' }]
        : [{ kind: 'crossSection', index: csIndex }];
  // Resolve per-pane curve colors from settings when provided, falling back to
  // the hardcoded theme defaults so callers that pass nothing are unchanged.
  let colors: string[] | undefined;
  if (kind === 'rocker') {
    colors = [settings?.deckColor ?? '#22D3EE', settings?.bottomColor ?? '#F472B6'];
  } else if (kind === 'outline') {
    colors = [settings?.outlineColor ?? '#22D3EE'];
  } else {
    // crossSection
    colors = [settings?.crossSectionColor ?? '#2DD4BF'];
  }
  return {
    targets,
    colors,
    mirrorY: kind === 'outline',
    mirrorX: kind === 'crossSection',
    key: kind === 'crossSection' ? `cs-${csIndex}` : kind,
  };
}

export function EditorPane({
  title,
  titleControl,
  kind,
  csIndex,
  units,
  longitudinal,
  sectionMarkers,
  onPickSection,
  focusedSection,
  onFocusSection,
  onMoveSection,
  onDeleteSection,
  onAddSectionAt,
  onScrub,
  overlays,
  onTunniChange,
  ghostSplines,
  background,
  traceInteractive,
  onTraceTransform,
  calibration,
  onCalibrationClick,
  viewCommand,
  initialView,
  onViewChange,
  headerActions,
  onTitleDoubleClick,
  settings,
}: {
  title: string;
  /** Replaces the pane heading — the split layout puts its pane picker here. */
  titleControl?: React.ReactNode;
  kind: EditorKind;
  csIndex: number;
  units: LengthUnit;
  /** Converts board-length positions for the marker labels and the cursor readout. */
  longitudinal: Longitudinal;
  sectionMarkers?: SectionMarker[];
  onPickSection?: (index: number) => void;
  focusedSection?: number | null;
  onFocusSection?: (index: number | null) => void;
  onMoveSection?: (index: number, position: number) => void;
  onDeleteSection?: (index: number) => void;
  onAddSectionAt?: (x: number) => void;
  onScrub?: (x: number | null) => void;
  overlays?: EditorOverlays;
  onTunniChange?: (enabled: boolean) => void;
  ghostSplines?: Spline[];
  background?: React.ComponentProps<typeof SplineEditor>['background'];
  traceInteractive?: React.ComponentProps<typeof SplineEditor>['traceInteractive'];
  onTraceTransform?: React.ComponentProps<typeof SplineEditor>['onTraceTransform'];
  calibration?: React.ComponentProps<typeof SplineEditor>['calibration'];
  onCalibrationClick?: React.ComponentProps<typeof SplineEditor>['onCalibrationClick'];
  viewCommand?: React.ComponentProps<typeof SplineEditor>['viewCommand'];
  initialView?: React.ComponentProps<typeof SplineEditor>['initialView'];
  onViewChange?: React.ComponentProps<typeof SplineEditor>['onViewChange'];
  headerActions?: React.ReactNode;
  onTitleDoubleClick?: React.MouseEventHandler<HTMLHeadingElement>;
  /** Optional visual settings (colors, sizes). When absent the draw defaults apply. */
  settings?: EditorSettings;
}) {
  // Stable across re-renders so the editor's target set (and the SplineEditor
  // re-fit/draw effects keyed on it) only changes when the pane actually changes.
  const p = useMemo(() => paneProps(kind, csIndex, settings), [kind, csIndex, settings]);
  // Only the length-wise views have anything to gain from turning the board — a
  // cross-section is already the shape of the pane it sits in. Gated on the pointer
  // rather than on width so a narrow desktop window does not suddenly rotate under
  // a mouse; whether the turn actually helps is then decided per pane inside
  // `SplineEditor`, which is what keeps it from ever making a pane worse.
  const allowTurn = useIsCoarsePointer() && kind !== 'crossSection';
  return (
    // `h-full` is load-bearing: in the quad layouts the pane is a grid item and
    // stretches on its own, but a maximized pane's parent is a plain block, so
    // without it the Panel shrinks to its content and leaves the rest of the
    // screen empty — two thirds of it on a phone. The 3D pane has always passed
    // its own `h-full` for the same reason.
    <Panel className="flex h-full min-h-0 flex-col">
      {/*
        The header must keep a constant height. It used to wrap, and on a narrow
        (phone) pane selecting a control point pushed the position editor onto a
        second row — which shrank the canvas mid-drag and yanked the viewport out
        from under the finger. One row always: the title truncates and the editor
        scrolls sideways rather than either of them adding a row.
      */}
      <ViewPaneHeader className="gap-2">
        {titleControl ?? (
          <ViewToggleTitle className="mr-auto min-w-0 truncate" onDoubleClick={onTitleDoubleClick}>
            {title}
          </ViewToggleTitle>
        )}
        <SelectedPointEditor
          store={boardStore}
          units={units}
          targets={p.targets}
          fallback={
            headerActions && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>
          }
        />
      </ViewPaneHeader>
      <PanelBody className="min-h-0 flex-1 p-0">
        <SplineEditor
          key={p.key}
          store={boardStore}
          targets={p.targets}
          colors={p.colors}
          mirrorY={p.mirrorY}
          mirrorX={p.mirrorX}
          sectionMarkers={kind !== 'crossSection' ? sectionMarkers : undefined}
          onPickSection={kind !== 'crossSection' ? onPickSection : undefined}
          focusedSection={focusedSection}
          onFocusSection={onFocusSection}
          onMoveSection={kind !== 'crossSection' ? onMoveSection : undefined}
          onDeleteSection={kind !== 'crossSection' ? onDeleteSection : undefined}
          formatSectionPosition={(cm) =>
            fmtLen(longitudinal.toDisplay(cm), units) + longitudinal.mark
          }
          onAddSectionAt={kind !== 'crossSection' ? onAddSectionAt : undefined}
          onScrub={kind !== 'crossSection' ? onScrub : undefined}
          allowTurn={allowTurn}
          readout={makeReadout(kind, units, longitudinal)}
          measureCursor={kind === 'crossSection'}
          overlays={overlays}
          onTunniChange={onTunniChange}
          ghostSplines={ghostSplines}
          background={background}
          traceInteractive={traceInteractive}
          onTraceTransform={onTraceTransform}
          calibration={calibration}
          onCalibrationClick={onCalibrationClick}
          ghostColor={settings?.ghostColor}
          gridColor={settings?.gridColor}
          controlPointSize={settings?.controlPointSize}
          curveThickness={settings?.curveThickness}
          viewCommand={viewCommand}
          initialView={initialView}
          onViewChange={onViewChange}
        />
      </PanelBody>
    </Panel>
  );
}
