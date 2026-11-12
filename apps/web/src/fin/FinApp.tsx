// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer (docs/design/fin-designer.md, steps 11–12): pick a starting fin,
 * edit its outline over the Futures tab, its foil section and its thickness taper,
 * set its side, cant, thickness and depth, nudge it on the tab, and read its numbers.
 * The fin autosaves, and Open / Save read and write `.fin.json` files (step 14); STEP
 * and STL export (step 15).
 *
 * Four views — profile, foil, thickness, 3D — share one large pane and three small
 * ones; a small pane's swap button brings its view into the large pane (round 1, R3).
 * The large pane's toolbar holds that view's controls. The 3D view's controls (side,
 * cant, nudge) go with it, under it when it is small, so the nudge sits by the view
 * that shows what it does.
 *
 * Lengths show in mm or inches, chosen in File settings (fin-settings.ts) and passed
 * to every component as a `units` prop (apps/web/CLAUDE.md).
 */
import {
  FIN_BASES,
  FIN_BASE_LABEL,
  FIN_MAX_CANT,
  FIN_MAX_TOE,
  FIN_MIN_SLICE_CANT,
  finTabOutline,
  futuresKind,
  finReadouts,
  validateFinDesign,
  type FinBase,
  type FinDesign,
  type FinHand,
  type FinLaminate,
  type FinTwist,
  type FinPosition,
} from '@openshaper/kernel';
import type { FinPreviewView } from '@openshaper/render3d';
import type { FinStart } from '@openshaper/store';
import { Button, Menu, MenuBar, Tooltip, type MenuItem } from '@openshaper/ui';
import { AlertTriangle, Maximize2, RotateCcw, RotateCw, Settings } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DegField, LenField } from '../components/fields';
import { CoreExportDialog } from './CoreExportDialog';
import {
  SECTION_DEFAULT,
  SectionOverlay,
  useSectionCuts,
  type SectionState,
} from './SectionAnalysis';
import { fmtArea, fmtLen, fmtThick, type LengthUnit } from '../format';
import { panelOutline, usePanelFit } from './use-panel-fit';
import { readStored, writeStored } from '../persisted';
import { FinSettingsDialog } from './FinSettingsDialog';
import {
  finLengthUnit,
  readFinSettings,
  withFinSettings,
  writeFinSettings,
  type FinSettings,
} from './fin-settings';
import { UPSTREAM_URL } from '../seo/site';
import { shortcutKeys } from '../shortcuts';
import { FinOutlinePane } from './FinOutlinePane';
import { FinSectionPane, FinSectionTools } from './FinSectionPane';
import { BuyMeACoffee } from './BuyMeACoffee';
import { FacingDialog, VECTOR_ACCEPT, readVectorFile } from './VectorImport';
import type { Ghost } from './ghost';
import { vectorFoil, vectorOutline, type VectorFacing, type VectorPath } from './vector-import';
import { FOIL_ANALYSIS_DEFAULT, type FoilAnalysis } from './foil-analysis';
import { FinTaperPane, MinThicknessField } from './FinTaperPane';
import { FitToPanel } from './panel-tools';
import { PointTools } from './PointTools';
import {
  defaultStems,
  FIN_EXT,
  finFiles,
  finsToWrite,
  readFinFile,
  type FinFormat,
} from './fin-file';
import { forgetSavedNames, SaveDialog } from './SaveDialog';
import { writeFiles } from '../save-files';
import { finStore } from './fin-store';
import {
  FIN_VIEW_TITLE,
  readViewOrder,
  swapIntoMain,
  writeViewOrder,
  type FinView,
  type FinViewOrder,
} from './fin-views';
import { useFinAutosave } from './use-fin-autosave';
import { acrossSign, NUDGE_FORE_CM, nudgeAcross, useFinShortcuts } from './use-fin-shortcuts';
import { useFinState } from './use-fin';
import { useSettledDesign } from './use-settled-design';

// three.js is the heavy part of the page: load it after the 2D editor is up.
const FinPreview3D = lazy(() =>
  import('@openshaper/render3d').then((m) => ({ default: m.FinPreview3D })),
);

function Preview({
  frameKey,
  view,
  section,
  onSection,
  onReset,
  units,
  minThickness,
}: {
  frameKey: string;
  view: FinPreviewView;
  /** The exports' minimum thickness (cm): the panel holds the fin as exported. */
  minThickness: number;
  section: SectionState;
  onSection: (next: SectionState) => void;
  onReset: () => void;
  units: LengthUnit;
}) {
  const design = useSettledDesign(finStore);
  const position = useFinState(finStore, (s) => s.design?.position);
  const hand = useFinState(finStore, (s) => s.design?.hand);
  const cuts = useSectionCuts(design, section);
  const fit = usePanelFit(finStore, minThickness);
  const panel = useMemo(() => (fit ? panelOutline(fit) : null), [fit]);
  return (
    <div className="relative h-full overflow-hidden" aria-label="3D preview">
      <Suspense fallback={null}>
        <FinPreview3D
          design={design}
          frameKey={`${position}-${hand}-${frameKey}`}
          view={view}
          panel={panel}
          // See-through only with a plane to see through to.
          sections={cuts?.planes?.length ? cuts.planes : null}
          zebra={section.on && section.zebra}
        />
      </Suspense>
      <SectionOverlay
        state={section}
        onChange={onSection}
        onReset={onReset}
        cuts={cuts}
        units={units}
      />
    </div>
  );
}

/** The starting fins, as the owner names them. */
const STARTS: { label: string; start: FinStart; hand?: FinHand }[] = [
  { label: 'Side, left', start: 'side', hand: 'left' },
  { label: 'Side, right', start: 'side', hand: 'right' },
  { label: 'Quad rear, left', start: 'quad-rear', hand: 'left' },
  { label: 'Quad rear, right', start: 'quad-rear', hand: 'right' },
  { label: 'Centre', start: 'centre' },
  { label: 'Single fin (US box)', start: 'single' },
  { label: 'Twin fin, left', start: 'twin', hand: 'left' },
  { label: 'Twin fin, right', start: 'twin', hand: 'right' },
  { label: 'Keel, left', start: 'keel', hand: 'left' },
  { label: 'Keel, right', start: 'keel', hand: 'right' },
  { label: 'Canard, left (FCS single)', start: 'canard', hand: 'left' },
  { label: 'Canard, right (FCS single)', start: 'canard', hand: 'right' },
];

const POSITION_LABEL: Record<FinPosition, string> = {
  side: 'Side fin',
  'quad-rear': 'Quad rear',
  centre: 'Centre fin',
};

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Readouts({ units }: { units: LengthUnit }) {
  const design = useFinState(finStore, (s) => s.design);
  const r = useMemo(() => (design ? finReadouts(design) : null), [design]);
  if (!r) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Fin measurements">
      <Readout label="Area" value={fmtArea(r.area, units)} />
      <Readout label="Depth" value={fmtLen(r.depth, units)} />
      <Readout label="Base length" value={fmtLen(r.rootChord, units)} />
      <Readout label="Rake" value={`${r.sweep.toFixed(1)}°`} />
      {design!.toe !== 0 && (
        <Readout
          label="Toe"
          value={`${design!.toe > 0 ? 'in' : 'out'} ${Math.abs(design!.toe).toFixed(2)}°`}
        />
      )}
      {/* Futures only: the limit is the grub screw at the box's front. */}
      {futuresKind(design!.base) && (
        <Readout
          label="Front overhang"
          // Behind the tab's front: no overhang, and how far clear (not a negative overhang).
          value={
            r.frontOverhang > 0
              ? fmtLen(r.frontOverhang, units)
              : `none (${fmtLen(-r.frontOverhang, units)} clear)`
          }
        />
      )}
    </dl>
  );
}

/**
 * Broken rules, read out as they happen: a hidden live region, as the status bar shows
 * them behind its chip (StatusChip).
 */
function Issues() {
  const design = useFinState(finStore, (s) => s.design);
  const issues = useMemo(() => (design ? validateFinDesign(design) : []), [design]);
  if (issues.length === 0) return null;
  return (
    <ul className="sr-only" role="status">
      {issues.map((i) => (
        <li key={i.code}>{i.message}</li>
      ))}
    </ul>
  );
}

function Nudge({
  id,
  label,
  dir,
  act,
}: {
  id: string;
  label: string;
  dir: string;
  act: () => boolean;
}) {
  return (
    <Tooltip label={label} shortcut={shortcutKeys(id)}>
      <Button variant="outline" size="icon" aria-label={label} onClick={act}>
        {dir}
      </Button>
    </Tooltip>
  );
}

/**
 * How a view's tools lay out: across the large pane's toolbar, or stacked under a small
 * pane's picture (the 3D view's), each group under its title.
 */
const ToolsLayout = createContext<'toolbar' | 'stacked'>('toolbar');

/**
 * A titled group of tools (owner review: the 3D controls ran on as one wrapped flow). In
 * the toolbar, groups are set apart by a rule; stacked, each has its title above it.
 */
function ToolGroup({ title, children }: { title: string; children: ReactNode }) {
  const layout = useContext(ToolsLayout);
  return layout === 'stacked' ? (
    <div role="group" aria-label={title} className="flex w-full flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>
    </div>
  ) : (
    <div
      role="group"
      aria-label={title}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l border-border pl-3 first:border-l-0 first:pl-0"
    >
      {children}
    </div>
  );
}

/**
 * Fore/aft and across nudges, in one row. They follow the view from above (nose up the
 * screen): up/down move the fin along the tab, left/right slide the blade across it.
 */
function NudgePad() {
  const s = finStore.getState;
  const hand = useFinState(finStore, (st) => st.design?.hand ?? null);
  // On a US box the blade slides along the head; a symmetric centre fin has no side to
  // slide to, so the arrows are fore and aft only.
  const usBox = useFinState(finStore, (st) => st.design?.base === 'us-box');
  const across = (side: 'left' | 'right') => (acrossSign(hand, side) > 0 ? 'outboard' : 'inboard');
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Position on the tab">
      <span className="mr-1 text-muted-foreground">Position</span>
      <Nudge
        id="fin-nudge-forward"
        label={usBox ? 'Slide the blade forward along the head' : 'Move the fin forward'}
        dir="↑"
        act={() => s().nudgeFore(NUDGE_FORE_CM)}
      />
      <Nudge
        id="fin-nudge-back"
        label={usBox ? 'Slide the blade back along the head' : 'Move the fin back'}
        dir="↓"
        act={() => s().nudgeFore(-NUDGE_FORE_CM)}
      />
      {!usBox && (
        <>
          <Nudge
            id="fin-nudge-left"
            label={`Slide the blade left (${across('left')})`}
            dir="←"
            act={() => nudgeAcross(s(), 'left')}
          />
          <Nudge
            id="fin-nudge-right"
            label={`Slide the blade right (${across('right')})`}
            dir="→"
            act={() => nudgeAcross(s(), 'right')}
          />
        </>
      )}
    </div>
  );
}

/** A number with a true minus sign, for ranges shown to users ("−20"). */
const minus = (n: number): string => (n < 0 ? `−${Math.abs(n)}` : String(n));

/** Toe steps (deg): a little toe makes a big difference. */
const TOE_STEP = 0.25;

/**
 * Toe correction: turn the blade on its tab, a quarter-degree a click or typed. Plus
 * toe in turns the leading edge toward the stringer; the view from above shows it
 * against the tab's axis. The field, then its turn buttons (owner review: the buttons
 * came before their label).
 */
function ToeTools({
  toe,
  onSet,
  label,
  noToe,
}: {
  toe: number;
  onSet: (deg: number) => void;
  label: string;
  /** Why this fin has no toe, greying the toe controls. */
  noToe?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Tooltip label={noToe ?? `Turn the blade on its tab, within ±${FIN_MAX_TOE}°`}>
        <div>
          <DegField label={label} value={toe} onCommit={onSet} disabled={!!noToe} />
        </div>
      </Tooltip>
      <Tooltip
        label={noToe ?? `Toe out ${TOE_STEP}°: turn the leading edge away from the stringer`}
      >
        <Button
          variant="outline"
          size="icon"
          aria-label="Toe out"
          disabled={!!noToe}
          onClick={() => onSet(toe - TOE_STEP)}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </Tooltip>
      <Tooltip label={noToe ?? `Toe in ${TOE_STEP}°: turn the leading edge toward the stringer`}>
        <Button
          variant="outline"
          size="icon"
          aria-label="Toe in"
          disabled={!!noToe}
          onClick={() => onSet(toe + TOE_STEP)}
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** Picks a cant line for the tools below; "Whole fin" is the fin's own placement. */
function CantLineSelect({ units }: { units: LengthUnit }) {
  const design = useFinState(finStore, (s) => s.design);
  const active = useFinState(finStore, (s) => s.activeCantLine);
  const lines = design?.cantLines ?? [];
  if (!design || lines.length === 0) return null;
  const depth = finReadouts(design).depth;
  return (
    <label className="flex items-center gap-2">
      <span className="text-muted-foreground">Cant and toe at</span>
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        value={active <= lines.length ? active : 0}
        aria-label="Cant and toe at"
        onChange={(e) => finStore.getState().setActiveCantLine(Number(e.target.value))}
      >
        <option value={0}>Whole fin</option>
        {lines.map((l, i) => (
          <option key={i} value={i + 1}>
            Cant line {fmtLen(l.height * depth, units)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A selected cant line's cant and toe: the blade eases to them going up from the line. */
function CantLineTools({ line, units }: { line: number; units: LengthUnit }) {
  const design = useFinState(finStore, (s) => s.design);
  const l = design?.cantLines?.[line - 1];
  if (!design || !l) return null;
  const set = (change: Partial<FinTwist>) => finStore.getState().setCantLine(line, change);
  const at = fmtLen(l.height * finReadouts(design).depth, units);
  return (
    <ToolGroup title={`Cant line ${at}`}>
      <Tooltip
        label={`Blade lean from this line up, ${minus(FIN_MIN_SLICE_CANT)}° to ${FIN_MAX_CANT}°`}
      >
        <div>
          <DegField label="Cant" value={l.cant} onCommit={(v) => set({ cant: v })} />
        </div>
      </Tooltip>
      <ToeTools toe={l.toe} onSet={(v) => set({ toe: v })} label="Toe" />
    </ToolGroup>
  );
}

/**
 * The whole fin's cant (side and quad-rear fins), in the 3D view's tools. Disabled on an
 * FCS tab, whose plug carries the cant, a Gbox, whose box does, and a US box.
 */
function CantField() {
  const position = useFinState(finStore, (s) => s.design?.position);
  const cant = useFinState(finStore, (s) => s.design?.cant ?? 0);
  const base = useFinState(finStore, (s) => s.design?.base);
  if (!position || !base || position === 'centre') return null;
  const fcs = !futuresKind(base);
  return (
    <Tooltip
      label={
        base === 'us-box'
          ? 'A fin in a US box has no cant'
          : base === 'gbox'
            ? 'Set by the Gbox'
            : fcs
              ? 'Set by the FCS plug (0°, 5° or 9°)'
              : `Blade lean out from the tab, 0° to ${FIN_MAX_CANT}°`
      }
    >
      <div>
        <DegField
          label={base === 'gbox' ? 'Cant (box)' : fcs && base !== 'us-box' ? 'Cant (plug)' : 'Cant'}
          value={cant}
          disabled={fcs}
          onCommit={(v) => finStore.getState().setCant(v)}
        />
      </div>
    </Tooltip>
  );
}

/**
 * The panel fit (File settings' panel): the 3D view from behind the fin, along the
 * panel, with the panel's outline round it; then its tilt, and Fit to panel.
 */
function PanelFitTools({
  view,
  onView,
  minThickness,
}: {
  view: FinPreviewView;
  onView: (v: FinPreviewView) => void;
  minThickness: number;
}) {
  const tilt = useFinState(finStore, (s) => (s.design?.panel ? (s.design.panel.tilt ?? 0) : null));
  const on = view === 'panel' && tilt !== null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Panel fit">
      <Tooltip
        label={
          tilt === null
            ? 'Set a panel thickness in File settings first'
            : 'Show the fin in its panel, from behind'
        }
      >
        <div>
          <Button
            size="sm"
            variant={on ? 'selected' : 'outline'}
            aria-pressed={on}
            disabled={tilt === null}
            onClick={() => onView(on ? 'side' : 'panel')}
          >
            Panel fit
          </Button>
        </div>
      </Tooltip>
      {on && (
        <>
          <Tooltip label="Tilt the panel to fit a canted blade (±45°)">
            <div className="w-32 text-sm">
              <DegField
                label="Tilt"
                value={tilt}
                onCommit={(v) => finStore.getState().setPanelTilt(v)}
              />
            </div>
          </Tooltip>
          <FitToPanel store={finStore} minThickness={minThickness} />
        </>
      )}
    </div>
  );
}

/**
 * The 3D view's tools, in groups (owner review): Placement (tab, side, cant, position),
 * Toe, View. With a control section selected, its own cant and toe in place of the whole
 * fin's, and Placement hidden: it is the whole fin's, not greyed out.
 */
function PlacementTools({
  view,
  onView,
  units,
  minThickness,
}: {
  view: FinPreviewView;
  onView: (v: FinPreviewView) => void;
  units: LengthUnit;
  minThickness: number;
}) {
  const position = useFinState(finStore, (s) => s.design?.position);
  const hand = useFinState(finStore, (s) => s.design?.hand);
  const toe = useFinState(finStore, (s) => s.design?.toe ?? 0);
  const base = useFinState(finStore, (s) => s.design?.base);
  // A cant line selected (here or in the profile): cant and toe set its change.
  const cantLine = useFinState(finStore, (s) =>
    s.activeCantLine <= (s.design?.cantLines?.length ?? 0) ? s.activeCantLine : 0,
  );
  if (!position || !base) return null;
  const s = finStore.getState;
  return (
    <>
      <CantLineSelect units={units} />
      {cantLine > 0 ? (
        <CantLineTools line={cantLine} units={units} />
      ) : (
        <>
          <ToolGroup title="Placement">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Tab</span>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={base}
                aria-label="Tab"
                onChange={(e) => s().setBase(e.target.value as FinBase)}
              >
                {FIN_BASES.map((b) => (
                  <option key={b} value={b}>
                    {FIN_BASE_LABEL[b]}
                  </option>
                ))}
              </select>
            </label>
            {hand && (
              <div className="flex items-center gap-1" role="group" aria-label="Side">
                {(['left', 'right'] as const).map((h) => (
                  <Button
                    key={h}
                    size="sm"
                    variant={hand === h ? 'selected' : 'outline'}
                    aria-pressed={hand === h}
                    onClick={() => s().setHand(h)}
                  >
                    {h === 'left' ? 'Left' : 'Right'}
                  </Button>
                ))}
              </div>
            )}
            <CantField />
            <NudgePad />
          </ToolGroup>
          <ToolGroup title="Toe">
            <ToeTools
              toe={toe}
              onSet={(v) => s().setToe(v)}
              label="Toe"
              noToe={
                position === 'centre'
                  ? 'A centre fin has no toe'
                  : base === 'us-box'
                    ? 'A fin in a US box has no toe'
                    : undefined
              }
            />
          </ToolGroup>
        </>
      )}
      <ToolGroup title="View">
        <Button
          size="sm"
          variant={view === 'above' ? 'selected' : 'outline'}
          aria-pressed={view === 'above'}
          onClick={() => onView(view === 'above' ? 'side' : 'above')}
        >
          View from above
        </Button>
        <PanelFitTools view={view} onView={onView} minThickness={minThickness} />
      </ToolGroup>
    </>
  );
}

/**
 * Where a new slice goes: halfway up the biggest gap between the root, the slices and
 * the tip, so repeated clicks spread them out.
 */
const widestGap = (heights: readonly number[]): number => {
  const hs = [0, ...heights, 1];
  let best = 0;
  for (let i = 1; i < hs.length - 1; i++)
    if (hs[i + 1]! - hs[i]! > hs[best + 1]! - hs[best]!) best = i;
  return (hs[best]! + hs[best + 1]!) / 2;
};

const nextSliceHeight = (d: FinDesign): number => widestGap(d.slices.map((sl) => sl.height));
const nextCantHeight = (d: FinDesign): number =>
  widestGap((d.cantLines ?? []).map((l) => l.height));

/** The profile view's controls. */
function OutlineTools({ units }: { units: LengthUnit }) {
  const design = useFinState(finStore, (s) => s.design);
  const depth = useMemo(() => (design ? finReadouts(design).depth : 0), [design]);
  if (!design) return null;
  return (
    <>
      <LenField
        label="Depth"
        valueCm={depth}
        units={units}
        onCommit={(cm) => finStore.getState().setDepth(cm)}
      />
      <PointTools store={finStore} />
      <Tooltip label="Add a control section: set the foil on a line across the fin">
        <Button
          variant="outline"
          size="sm"
          onClick={() => finStore.getState().addSlice(nextSliceHeight(design))}
        >
          Add control section
        </Button>
      </Tooltip>
      {design.slices.length > 0 && <RemoveSlice />}
      <Tooltip label="Add a cant line: change the cant and toe from a height up">
        <Button
          variant="outline"
          size="sm"
          onClick={() => finStore.getState().addCantLine(nextCantHeight(design))}
        >
          Add cant line
        </Button>
      </Tooltip>
      {(design.cantLines?.length ?? 0) > 0 && <RemoveCantLine />}
    </>
  );
}

/** Beside Add slice (owner feedback: it was only in the foil view). */
function RemoveSlice() {
  const foil = useFinState(finStore, (s) =>
    s.design && s.activeFoil <= s.design.slices.length ? s.activeFoil : 0,
  );
  return (
    <Tooltip label="Remove the selected control section (click its line to select it)">
      <Button
        variant="outline"
        size="sm"
        disabled={foil === 0}
        onClick={() => finStore.getState().removeSlice(foil)}
      >
        Remove control section
      </Button>
    </Tooltip>
  );
}

/** Beside Add cant line. */
function RemoveCantLine() {
  const line = useFinState(finStore, (s) =>
    s.activeCantLine <= (s.design?.cantLines?.length ?? 0) ? s.activeCantLine : 0,
  );
  return (
    <Tooltip label="Remove the selected cant line (click its line to select it)">
      <Button
        variant="outline"
        size="sm"
        disabled={line === 0}
        onClick={() => finStore.getState().removeCantLine(line)}
      >
        Remove cant line
      </Button>
    </Tooltip>
  );
}

/** The thickness view's controls. */
function TaperTools({ units }: { units: LengthUnit }) {
  const root = useFinState(finStore, (s) => s.design?.taper.knots[0]!.end.y);
  if (root === undefined) return null;
  return (
    <>
      <LenField
        label="Base thickness"
        valueCm={root}
        units={units}
        onCommit={(cm) => finStore.getState().setRootThickness(cm)}
      />
      <MinThicknessField store={finStore} units={units} />
      <PointTools store={finStore} />
    </>
  );
}

/**
 * The panel check (File settings): what panel the fin needs at its angle, and a warning
 * when that's more than the panel. A warning, not a broken rule: the fin can still be
 * exported, for a thicker panel or a different machine.
 */
const panelPose = (fit: NonNullable<ReturnType<typeof usePanelFit>>): string => {
  const pose = [
    fit.pose.angle ? `turned ${fit.pose.angle.toFixed(1)}°` : '',
    fit.pose.tilt ? `tilted ${fit.pose.tilt.toFixed(1)}°` : '',
  ].filter(Boolean);
  return pose.length ? ` ${pose.join(', ')}` : '';
};

/**
 * Warnings and problems as one chip at the right of the status bar, the list opening from
 * it (owner review: they ran on under the numbers in orange). Fine: a quiet line instead.
 */
function StatusChip({ units, minThickness }: { units: LengthUnit; minThickness: number }) {
  const design = useFinState(finStore, (s) => s.design);
  const issues = useMemo(() => (design ? validateFinDesign(design) : []), [design]);
  const fit = usePanelFit(finStore, minThickness);
  const [open, setOpen] = useState(false);
  const over = fit && !fit.fits ? fit : null;
  const count = issues.length + (over ? 1 : 0);
  if (count === 0) {
    return fit ? (
      <span className="text-xs text-muted-foreground">
        Fits the {fmtThick(fit.panel.thickness, units)} panel{panelPose(fit)}: needs{' '}
        {fmtThick(fit.width, units)}, tab included.
      </span>
    ) : null;
  }
  return (
    <div className="relative">
      {over && (
        <p className="sr-only" data-testid="panel-warning">
          Too thick for the {fmtThick(over.panel.thickness, units)} panel{panelPose(over)}: tab and
          blade need {fmtThick(over.width, units)}. Try Fit to panel, a thinner foil or less cant.
        </p>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold ${
          issues.length
            ? 'border-red-400 bg-red-400/10 text-red-300'
            : 'border-orange-500 bg-orange-500/10 text-orange-300'
        }`}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        {count} to fix
      </button>
      {open && (
        <div
          role="region"
          aria-label="Problems"
          className="absolute bottom-full right-0 z-30 mb-2 w-[26rem] max-w-[calc(100vw-2rem)] space-y-2 rounded-md border border-border bg-card p-3 text-sm shadow-lg"
        >
          {over && (
            <div className="flex items-start gap-2">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-orange-500" aria-hidden />
              <div className="flex-1">
                <p className="font-semibold">
                  Too thick for the {fmtThick(over.panel.thickness, units)} panel
                </p>
                <p className="text-muted-foreground">
                  Tab and blade need {fmtThick(over.width, units)}. Exports still work.
                </p>
              </div>
              <FitToPanel store={finStore} minThickness={minThickness} />
            </div>
          )}
          {issues.map((i) => (
            <div key={i.code} className="flex items-start gap-2">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-400" aria-hidden />
              <div>
                <p className="font-semibold">{i.message}</p>
                <p className="text-muted-foreground">Export is off until it is fixed.</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Status({ units, minThickness }: { units: LengthUnit; minThickness: number }) {
  const position = useFinState(finStore, (s) => s.design?.position);
  const base = useFinState(finStore, (s) => s.design?.base);
  const outline = useFinState(finStore, (s) => s.design?.outline);
  if (!position || !base) return null;
  const tab = finTabOutline(base, outline);
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2"
      style={{ gridArea: 'status' }}
    >
      <span className="border-r border-border pr-4 text-xs text-muted-foreground">
        {POSITION_LABEL[position]} on {FIN_BASE_LABEL[base]} ({fmtLen(tab.length, units)} ×{' '}
        {fmtLen(tab.height, units)})
      </span>
      <Readouts units={units} />
      <div className="ml-auto flex items-center gap-4">
        <StatusChip units={units} minThickness={minThickness} />
        {/* Credit where it's due: a fork of OpenShaper (GPL), at the bottom (owner review). */}
        <a
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          href={UPSTREAM_URL}
          target="_blank"
          rel="noreferrer"
        >
          A fork of OpenShaper
        </a>
      </div>
      <Issues />
    </div>
  );
}

/**
 * One view's pane. Large: its title and controls across the top. Small: its title and
 * a button that swaps it into the large pane; the 3D view keeps its controls, under it.
 */
function ViewPane({
  view,
  slot,
  onSwap,
  tools,
  children,
}: {
  view: FinView;
  /** 0 for the large pane, 1–3 for the small ones. */
  slot: number;
  onSwap: (slot: number) => void;
  tools: ReactNode;
  children: ReactNode;
}) {
  const large = slot === 0;
  const title = FIN_VIEW_TITLE[view];
  const keepTools = view === '3d';
  return (
    <section
      aria-label={title}
      data-slot={large ? 'main' : `small-${slot}`}
      style={{ gridArea: large ? 'main' : `s${slot}` }}
      className={`flex min-h-0 flex-col border-border ${large ? '' : 'border-t lg:border-l'}`}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-2 py-1 text-sm">
        {/* Large: a title, set apart from the controls after it (owner review: it read
            as the first field's label). */}
        <h2
          className={
            large
              ? 'border-r border-border pr-3 text-sm font-semibold text-foreground'
              : 'text-xs font-medium text-muted-foreground'
          }
        >
          {title}
        </h2>
        {large ? (
          <ToolsLayout.Provider value="toolbar">{tools}</ToolsLayout.Provider>
        ) : (
          <Tooltip label={`Show ${title} in the large pane`}>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7"
              aria-label={`Show ${title} in the large pane`}
              onClick={() => onSwap(slot)}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {!large && keepTools && (
        <div className="flex flex-col gap-2.5 border-t border-border px-2 py-2 text-sm">
          <ToolsLayout.Provider value="stacked">{tools}</ToolsLayout.Provider>
        </div>
      )}
    </section>
  );
}

function History() {
  const canUndo = useFinState(finStore, (s) => s.past.length > 0);
  const canRedo = useFinState(finStore, (s) => s.future.length > 0);
  return (
    <>
      <Tooltip label="Undo" shortcut={shortcutKeys('undo')}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canUndo}
          onClick={() => finStore.getState().undo()}
        >
          Undo
        </Button>
      </Tooltip>
      <Tooltip label="Redo" shortcut={shortcutKeys('redo')}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canRedo}
          onClick={() => finStore.getState().redo()}
        >
          Redo
        </Button>
      </Tooltip>
    </>
  );
}

/** The part of the fin a vector file replaces. */
type VectorPart = 'outline' | 'foil';

/**
 * Open and Save: `.fin.json` files. Opening replaces the fin and starts a fresh history,
 * and re-fits every view to it (`onOpened`), as a new fin does. Open's menu also imports
 * another fin's profile, or a vector drawing as the profile or the base foil
 * (vector-import.ts); an imported profile comes in at its own size, so the views re-fit
 * to it (`onImported`).
 */
function FileButtons({
  onSave,
  onOpened,
  onImported,
}: {
  onSave: () => void;
  onOpened: () => void;
  onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const vectorInput = useRef<HTMLInputElement>(null);
  const profileInput = useRef<HTMLInputElement>(null);
  // Which part the next vector file replaces, and the drawing waiting to be told its facing.
  const [importing, setImporting] = useState<VectorPart>('outline');
  const [pending, setPending] = useState<VectorPath[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async (file: File | undefined) => {
    if (!file) return;
    try {
      finStore.getState().load(await readFinFile(file));
      onOpened();
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  /** Another fin's profile onto this fin's tab; the rest of this fin stays. */
  const importProfile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const from = await readFinFile(file);
      const wrong = finStore.getState().importOutline(from.outline);
      if (wrong.length) {
        setProblem(`Profile not imported: ${wrong.join(' ')}`);
        return;
      }
      onImported();
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const openVector = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPending(await readVectorFile(file));
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const chooseVector = (part: VectorPart) => {
    setImporting(part);
    vectorInput.current?.click();
  };
  /** Put the drawing in; what's wrong with it if it can't go. */
  const place = (paths: VectorPath[], facing: VectorFacing): string | void => {
    const state = finStore.getState();
    try {
      const wrong =
        importing === 'outline'
          ? state.importOutline(vectorOutline(paths, facing))
          : state.importBaseFoil(vectorFoil(paths, facing, state.design?.position === 'centre'));
      if (wrong.length) return `Not imported: ${wrong.join(' ')}`;
      setPending(null);
      if (importing === 'outline') onImported();
    } catch (e) {
      return (e as Error).message;
    }
  };
  return (
    <>
      <MenuBar>
        <Menu
          label="Open…"
          panelClassName="min-w-72"
          items={[
            { kind: 'action', label: 'Open fin…', onSelect: () => input.current?.click() },
            {
              kind: 'action',
              label: 'Import profile from fin…',
              onSelect: () => profileInput.current?.click(),
            },
            {
              kind: 'action',
              label: 'Import vector outline (SVG, EPS)…',
              onSelect: () => chooseVector('outline'),
            },
            {
              kind: 'action',
              label: 'Import vector foil (SVG, EPS)…',
              onSelect: () => chooseVector('foil'),
            },
          ]}
        />
      </MenuBar>
      <input
        ref={vectorInput}
        type="file"
        accept={VECTOR_ACCEPT}
        className="hidden"
        aria-label="Open a vector file"
        onChange={(e) => {
          void openVector(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {pending && (
        <FacingDialog
          title={importing === 'outline' ? 'Import vector outline' : 'Import vector foil'}
          what={importing === 'outline' ? 'vector outline' : 'vector foil'}
          onCancel={() => setPending(null)}
          onChoose={(facing) => place(pending, facing)}
        />
      )}
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Open a fin file"
        onChange={(e) => {
          void open(e.target.files?.[0]);
          e.target.value = ''; // the same file can be opened again
        }}
      />
      <input
        ref={profileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Import a profile from a fin file"
        onChange={(e) => {
          void importProfile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Tooltip label="Save to a .fin.json file" shortcut={shortcutKeys('save')}>
        <Button variant="ghost" size="sm" onClick={onSave}>
          Save
        </Button>
      </Tooltip>
      {problem && (
        <span role="alert" className="text-xs text-destructive">
          {problem}
        </span>
      )}
    </>
  );
}

/** Remembered per device: whether Save and Export write a left and a right fin. */
const PAIR_KEY = 'bs.fin.pair';

/**
 * Export, the header's one primary action: a menu of STEP (CNC), STL (3D printing), the
 * core (each off while a rule is broken) and the profile as SVG, with the left-and-right option beside what it changes (owner review: the
 * header had eleven controls in five styles). The option changes Save too.
 */
function ExportMenu({
  pair,
  onPair,
  onExport,
  units,
  minThickness,
}: {
  pair: boolean;
  onPair: (on: boolean) => void;
  /** Open the save dialog for this export. */
  onExport: (request: SaveRequest) => void;
  units: LengthUnit;
  /** The exports' minimum thickness (cm, File settings). */
  minThickness: number;
}) {
  const design = useFinState(finStore, (s) => s.design);
  const issues = useMemo(() => (design ? validateFinDesign(design) : []), [design]);
  const [coreOpen, setCoreOpen] = useState(false);
  const blocked = issues.length > 0;
  const why = blocked ? 'Fix the problems shown in the status bar first' : undefined;
  const items: MenuItem[] = [
    {
      kind: 'action',
      label: 'STEP for CNC',
      disabled: blocked,
      title: why,
      onSelect: () => onExport({ format: 'step' }),
    },
    {
      kind: 'action',
      label: 'STL for 3D printing',
      disabled: blocked,
      title: why,
      onSelect: () => onExport({ format: 'stl' }),
    },
    {
      kind: 'action',
      label: 'Core to laminate over…',
      disabled: blocked,
      title: why,
      onSelect: () => setCoreOpen(true),
    },
    { kind: 'separator' },
    {
      kind: 'action',
      label: 'Profile as SVG',
      title: 'The profile drawn at full size, to import into another fin or a drawing program',
      onSelect: () => onExport({ format: 'svg' }),
    },
    ...(design?.hand
      ? ([
          { kind: 'separator' },
          {
            kind: 'checkbox',
            label: 'Left and right fin (two files)',
            checked: pair,
            onSelect: () => onPair(!pair),
          },
        ] as MenuItem[])
      : []),
  ];
  return (
    <>
      <MenuBar>
        <Menu
          label="Export ▾"
          items={items}
          triggerClassName="bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
          panelClassName="min-w-64"
        />
      </MenuBar>
      {coreOpen && (
        <CoreExportDialog
          units={units}
          pair={pair}
          minThickness={minThickness}
          onClose={() => setCoreOpen(false)}
          onExport={(format, laminate) => {
            setCoreOpen(false);
            onExport({ format, laminate });
          }}
        />
      )}
    </>
  );
}

/** What the save dialog is writing: the design (Save), or an export, maybe a core. */
interface SaveRequest {
  readonly format: FinFormat;
  readonly laminate?: FinLaminate;
}

const SAVE_TITLES: Record<FinFormat, string> = {
  fin: 'Save fin',
  step: 'Export STEP for CNC',
  stl: 'Export STL for 3D printing',
  svg: 'Export profile as SVG',
};

/**
 * Save and Export's dialog for the fin as it was when it opened: a name for each file
 * (a left and a right one with the pair option on), and where they go.
 */
function FinSaveDialog({
  request,
  pair,
  minThickness,
  onClose,
}: {
  request: SaveRequest;
  pair: boolean;
  minThickness: number;
  onClose: () => void;
}) {
  const [design] = useState(() => finStore.getState().design!);
  const { format, laminate } = request;
  const fins = finsToWrite(design, pair, format);
  const stems = defaultStems(design, pair, !!laminate, format);
  const items = fins.map((f, i) => ({
    label: fins.length > 1 ? (f.hand === 'left' ? 'Left fin' : 'Right fin') : 'File name',
    stem: stems[i]!,
  }));
  const exporting = format !== 'fin';
  return (
    <SaveDialog
      title={laminate ? `Export ${format.toUpperCase()} core` : SAVE_TITLES[format]}
      action={exporting ? 'Export' : 'Save'}
      busyLabel={exporting ? 'Exporting…' : 'Saving…'}
      items={items}
      ext={FIN_EXT[format]}
      note={
        laminate
          ? 'The core to laminate over, from the core settings you chose.'
          : format === 'svg'
            ? 'The profile at full size, front on the left. A left and a right fin share it.'
            : undefined
      }
      onSave={async (names, folder) =>
        writeFiles(await finFiles(design, format, names, pair, { laminate, minThickness }), folder)
      }
      onClose={onClose}
    />
  );
}

/** Opens File settings. */
function SettingsButton({
  settings,
  onChange,
}: {
  settings: FinSettings;
  onChange: (change: Partial<FinSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip label="File settings: units, grid, export minimum and core">
        <Button variant="ghost" size="sm" aria-label="File settings" onClick={() => setOpen(true)}>
          <Settings />
        </Button>
      </Tooltip>
      {open && (
        <FinSettingsDialog settings={settings} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function FinApp() {
  const [settings, setSettings] = useState<FinSettings>(readFinSettings);
  const changeSettings = useCallback((change: Partial<FinSettings>) => {
    setSettings((s) => {
      const next = withFinSettings(s, change);
      writeFinSettings(next);
      return next;
    });
  }, []);
  const units = useMemo(() => finLengthUnit(settings), [settings]);
  const [view3d, setView3d] = useState<FinPreviewView>('side');
  // The foil view's analysis: the other sections behind the foil (foil-analysis.ts).
  const [foilAnalysis, setFoilAnalysis] = useState<FoilAnalysis>(FOIL_ANALYSIS_DEFAULT);
  // A reference drawing behind the profile and the foil views, if one is showing (ghost.ts).
  const [outlineGhost, setOutlineGhost] = useState<Ghost | null>(null);
  const [foilGhost, setFoilGhost] = useState<Ghost | null>(null);
  // Section analysis in the 3D view; Reset re-frames the camera to its starting view.
  const [section, setSection] = useState<SectionState>(SECTION_DEFAULT);
  const [resets, setResets] = useState(0);
  const resetView = useCallback(() => {
    setView3d('side');
    setResets((n) => n + 1);
  }, []);
  const [pair, setPair] = useState(() => readStored(PAIR_KEY, false, (v) => v === true));
  const changePair = useCallback((on: boolean) => {
    setPair(on);
    writeStored(PAIR_KEY, on);
  }, []);
  // Save and Export open the save dialog: names, and where the files go.
  const [saving, setSaving] = useState<SaveRequest | null>(null);
  const save = useCallback(() => {
    if (finStore.getState().design) setSaving({ format: 'fin' });
  }, []);
  useFinShortcuts(finStore, { onSave: save });
  const ready = useFinAutosave(finStore);
  const [order, setOrder] = useState<FinViewOrder>(readViewOrder);
  const swap = useCallback((slot: number) => {
    setOrder((o) => {
      const next = swapIntoMain(o, slot);
      writeViewOrder(next);
      return next;
    });
  }, []);
  const slotOf = (view: FinView) => order.indexOf(view);
  // A new fin re-fits every view, even one with the same position and side as the last
  // (the twin fin and keel are side fins, like the default).
  const [starts, setStarts] = useState(0);
  // A different fin is offered its own file names again.
  const restart = () => {
    forgetSavedNames();
    setStarts((n) => n + 1);
  };
  // Re-fit a view's canvas when it moves between the large pane and a small one.
  const sizeKey = (view: FinView) => `${order[0] === view ? 'large' : 'small'}-${starts}`;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold">OpenFinShaper</h1>
        {/* File, then Edit: groups set apart by a rule (owner review). */}
        <div
          role="group"
          aria-label="File"
          className="flex items-center gap-1 border-l border-border pl-3"
        >
          <MenuBar>
            <Menu
              label="New fin"
              panelClassName="min-w-64"
              items={STARTS.map((st) => ({
                kind: 'action' as const,
                label: st.label,
                onSelect: () => {
                  finStore.getState().newFin(st.start, st.hand);
                  restart();
                },
              }))}
            />
          </MenuBar>
          <FileButtons
            onSave={save}
            onOpened={restart}
            onImported={() => setStarts((n) => n + 1)}
          />
        </div>
        <div
          role="group"
          aria-label="Edit"
          className="flex items-center gap-1 border-l border-border pl-3"
        >
          <History />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BuyMeACoffee />
          <ExportMenu
            pair={pair}
            onPair={changePair}
            onExport={setSaving}
            units={units}
            minThickness={settings.exportMin}
          />
          <SettingsButton settings={settings} onChange={changeSettings} />
          <a
            className="px-2 text-sm text-muted-foreground underline-offset-4 hover:underline"
            href="/docs/fin-designer"
          >
            Help
          </a>
        </div>
      </header>
      {/* Which small slot holds the 3D view: its row is taller, the model and its tools
          both needing room (owner review: the model was 80 px wide). */}
      <main aria-busy={!ready} className="fin-grid min-h-0 flex-1" data-3d-slot={slotOf('3d')}>
        <ViewPane
          view="outline"
          slot={slotOf('outline')}
          onSwap={swap}
          tools={<OutlineTools units={units} />}
        >
          <FinOutlinePane
            store={finStore}
            units={units}
            frameKey={sizeKey('outline')}
            gridStep={settings.grid ?? undefined}
            ghost={outlineGhost}
            onGhost={setOutlineGhost}
          />
        </ViewPane>
        <ViewPane
          view="foil"
          slot={slotOf('foil')}
          onSwap={swap}
          tools={
            <FinSectionTools store={finStore} units={units} minThickness={settings.exportMin} />
          }
        >
          <FinSectionPane
            store={finStore}
            units={units}
            frameKey={sizeKey('foil')}
            minThickness={settings.exportMin}
            analysis={foilAnalysis}
            onAnalysis={setFoilAnalysis}
            ghost={foilGhost}
            onGhost={setFoilGhost}
          />
        </ViewPane>
        <ViewPane
          view="taper"
          slot={slotOf('taper')}
          onSwap={swap}
          tools={<TaperTools units={units} />}
        >
          <FinTaperPane store={finStore} units={units} frameKey={sizeKey('taper')} />
        </ViewPane>
        <ViewPane
          view="3d"
          slot={slotOf('3d')}
          onSwap={swap}
          tools={
            <PlacementTools
              view={view3d}
              onView={setView3d}
              units={units}
              minThickness={settings.exportMin}
            />
          }
        >
          <Preview
            frameKey={`${sizeKey('3d')}-${resets}`}
            view={view3d}
            minThickness={settings.exportMin}
            section={section}
            onSection={setSection}
            onReset={resetView}
            units={units}
          />
        </ViewPane>
        <Status units={units} minThickness={settings.exportMin} />
      </main>
      {saving && (
        <FinSaveDialog
          request={saving}
          pair={pair}
          minThickness={settings.exportMin}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  );
}
