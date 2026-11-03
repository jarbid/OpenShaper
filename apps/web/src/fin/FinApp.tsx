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
  twistAt,
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
import { Button, Tooltip } from '@openshaper/ui';
import { Maximize2, RotateCcw, RotateCw, Settings } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
import { GITHUB_URL } from '../seo/site';
import { shortcutKeys } from '../shortcuts';
import { FinOutlinePane } from './FinOutlinePane';
import { FinSectionPane, FinSectionTools } from './FinSectionPane';
import { FinTaperPane } from './FinTaperPane';
import { FitToPanel } from './panel-tools';
import { PointTools } from './PointTools';
import { downloadFin, exportFin, readFinFile } from './fin-file';
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
          sections={cuts?.planes ?? null}
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
  { label: 'Canard, left (FCS single tab)', start: 'canard', hand: 'left' },
  { label: 'Canard, right (FCS single tab)', start: 'canard', hand: 'right' },
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
      <Readout label="Base (root chord)" value={fmtLen(r.rootChord, units)} />
      <Readout label="Sweep" value={`${r.sweep.toFixed(1)}°`} />
      {design!.toe !== 0 && (
        <Readout
          label="Toe"
          value={`${design!.toe > 0 ? 'in' : 'out'} ${Math.abs(design!.toe).toFixed(2)}°`}
        />
      )}
      {/* Futures only: the limit is the grub screw at the box's front. */}
      {futuresKind(design!.base) && (
        <Readout label="Front overhang" value={fmtLen(r.frontOverhang, units)} />
      )}
    </dl>
  );
}

function Issues() {
  const design = useFinState(finStore, (s) => s.design);
  const issues = useMemo(() => (design ? validateFinDesign(design) : []), [design]);
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-md border border-destructive/60 p-2 text-sm" role="status">
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
 * Fore/aft and across nudges, in one row. They follow the view from above (nose up the
 * screen): up/down move the fin along the tab, left/right slide the blade across it.
 */
function NudgePad({ disabled = false }: { disabled?: boolean }) {
  const s = finStore.getState;
  const hand = useFinState(finStore, (st) => st.design?.hand ?? null);
  // On a US box the blade slides along the head; a symmetric centre fin has no side to
  // slide to, so the arrows are fore and aft only.
  const usBox = useFinState(finStore, (st) => st.design?.base === 'us-box');
  const across = (side: 'left' | 'right') => (acrossSign(hand, side) > 0 ? 'outboard' : 'inboard');
  return (
    <div
      className={`flex items-center gap-1 ${disabled ? 'pointer-events-none opacity-40' : ''}`}
      role="group"
      aria-label="Position on the tab"
      aria-disabled={disabled}
    >
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

/** Toe steps (deg): a little toe makes a big difference. */
const TOE_STEP = 0.25;

/**
 * Toe correction: turn the blade on its tab, a quarter-degree a click or typed. Plus
 * toe in turns the leading edge toward the stringer; the view from above shows it
 * against the tab's axis.
 */
function ToeTools({
  toe,
  onSet,
  label,
  view,
  onView,
  noToe,
}: {
  toe: number;
  onSet: (deg: number) => void;
  label: string;
  view: FinPreviewView;
  onView: (v: FinPreviewView) => void;
  /** Why this fin has no toe, greying the toe controls (the view switch still works). */
  noToe?: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Toe">
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
      {noToe ? (
        <Tooltip label={noToe}>
          <div>
            <DegField label={label} value={toe} onCommit={onSet} disabled />
          </div>
        </Tooltip>
      ) : (
        <DegField label={label} value={toe} onCommit={onSet} />
      )}
      <Button
        size="sm"
        variant={view === 'above' ? 'default' : 'outline'}
        aria-pressed={view === 'above'}
        onClick={() => onView(view === 'above' ? 'side' : 'above')}
      >
        From above
      </Button>
    </div>
  );
}

/**
 * Which part the 3D view's cant and toe set: the whole fin (Root) or a slice's change
 * above it. Shares the selection with the foil view's tabs.
 */
function SliceSelect({ units }: { units: LengthUnit }) {
  const design = useFinState(finStore, (s) => s.design);
  const activeFoil = useFinState(finStore, (s) => s.activeFoil);
  if (!design || design.slices.length === 0) return null;
  const depth = finReadouts(design).depth;
  return (
    <label className="flex items-center gap-2">
      <span className="text-muted-foreground">Slice (twist)</span>
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        value={activeFoil > 0 ? activeFoil : 0}
        aria-label="Slice (twist)"
        onChange={(e) => finStore.getState().setActiveFoil(Number(e.target.value))}
      >
        <option value={0}>Root (whole fin)</option>
        {design.slices.map((sl, i) => (
          <option key={i} value={i + 1}>
            {fmtLen(sl.height * depth, units)}
            {sl.twist ? ' · cant / toe' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A selected slice's cant and toe: the blade eases to them from the root (or the slice
 * below) over the whole span up to the slice, and keeps them above it.
 */
function SliceTwistTools({
  foil,
  view,
  onView,
}: {
  foil: number;
  view: FinPreviewView;
  onView: (v: FinPreviewView) => void;
}) {
  const design = useFinState(finStore, (s) => s.design);
  if (!design) return null;
  const sl = design.slices[foil - 1];
  if (!sl) return null;
  // A slice without a change shows what the blade has there now.
  const now = sl.twist ?? twistAt(design, sl.height);
  const set = (change: Partial<FinTwist> | null) => finStore.getState().setSliceTwist(foil, change);
  return (
    <>
      <DegField
        label={`Cant at slice (${FIN_MIN_SLICE_CANT}–${FIN_MAX_CANT}°)`}
        value={now.cant}
        onCommit={(v) => set({ cant: v })}
      />
      <ToeTools
        toe={now.toe}
        onSet={(v) => set({ toe: v })}
        label="Toe at slice"
        view={view}
        onView={onView}
      />
      {sl.twist && (
        <Button size="sm" variant="outline" onClick={() => set(null)}>
          No change here
        </Button>
      )}
    </>
  );
}

/**
 * The whole fin's cant (side and quad-rear fins), in the 3D view's tools. Disabled on an
 * FCS tab, whose plug carries the cant, and a US box.
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
          : fcs
            ? 'Set by the FCS plug (0°, 5° or 9°)'
            : 'Blade lean out from the tab'
      }
    >
      <div>
        <DegField
          label={base === 'us-box' ? 'Cant' : fcs ? 'Cant (plug)' : `Cant (0–${FIN_MAX_CANT}°)`}
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
            : 'The whole fin from behind, along the panel it is cut from, with the panel round it: green when it fits, orange when not'
        }
      >
        <div>
          <Button
            size="sm"
            variant={on ? 'default' : 'outline'}
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
          <Tooltip label="The panel leaning from upright, toward the fin's outside face (±45°): a canted blade on an upright tab fits a thinner panel leaning between them. The fin itself doesn't change, nor its exports">
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
  // A slice selected (here or in the foil view): cant and toe set its change instead.
  const slice = useFinState(finStore, (s) =>
    s.design && s.activeFoil > 0 && s.activeFoil <= s.design.slices.length ? s.activeFoil : 0,
  );
  if (!position || !base) return null;
  const s = finStore.getState;
  return (
    <>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Base</span>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={base}
          aria-label="Base"
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
              variant={hand === h ? 'default' : 'outline'}
              aria-pressed={hand === h}
              onClick={() => s().setHand(h)}
            >
              {h === 'left' ? 'Left' : 'Right'}
            </Button>
          ))}
        </div>
      )}
      <SliceSelect units={units} />
      {slice > 0 ? (
        <>
          <NudgePad disabled />
          <SliceTwistTools foil={slice} view={view} onView={onView} />
        </>
      ) : (
        <>
          <CantField />
          <NudgePad />
          <ToeTools
            toe={toe}
            onSet={(v) => s().setToe(v)}
            label={`Toe (±${FIN_MAX_TOE}°)`}
            view={view}
            onView={onView}
            noToe={
              position === 'centre'
                ? 'A centre fin has no toe'
                : base === 'us-box'
                  ? 'A fin in a US box has no toe'
                  : undefined
            }
          />
        </>
      )}
      <PanelFitTools view={view} onView={onView} minThickness={minThickness} />
    </>
  );
}

/**
 * Where a new slice goes: halfway up the biggest gap between the root, the slices and
 * the tip, so repeated clicks spread them out.
 */
const nextSliceHeight = (d: FinDesign): number => {
  const hs = [0, ...d.slices.map((sl) => sl.height), 1];
  let best = 0;
  for (let i = 1; i < hs.length - 1; i++)
    if (hs[i + 1]! - hs[i]! > hs[best + 1]! - hs[best]!) best = i;
  return (hs[best]! + hs[best + 1]!) / 2;
};

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
      <Tooltip label="Add a foil slice: drag its line to place it, then shape its foil, or give the blade above it a twist (its own cant and toe) in the 3D view">
        <Button
          variant="outline"
          size="sm"
          onClick={() => finStore.getState().addSlice(nextSliceHeight(design))}
        >
          Add slice (twist)
        </Button>
      </Tooltip>
      {design.slices.length > 0 && <RemoveSlice />}
    </>
  );
}

/** Beside Add slice (owner feedback: it was only in the foil view). */
function RemoveSlice() {
  const foil = useFinState(finStore, (s) =>
    s.design && s.activeFoil <= s.design.slices.length ? s.activeFoil : 0,
  );
  return (
    <Tooltip label="Remove the selected slice (click its line to select it)">
      <Button
        variant="outline"
        size="sm"
        disabled={foil === 0}
        onClick={() => finStore.getState().removeSlice(foil)}
      >
        Remove slice
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
        label="Root thickness"
        valueCm={root}
        units={units}
        onCommit={(cm) => finStore.getState().setRootThickness(cm)}
      />
      <PointTools store={finStore} />
    </>
  );
}

/** Readouts and broken rules, always in view. */
/**
 * The panel check (File settings): what panel the fin needs at its angle, and a warning
 * when that's more than the panel. A warning, not a broken rule: the fin can still be
 * exported, for a thicker panel or a different machine.
 */
function PanelStatus({ units, minThickness }: { units: LengthUnit; minThickness: number }) {
  const fit = usePanelFit(finStore, minThickness);
  if (!fit) return null;
  const pose = [
    fit.pose.angle ? `turned ${fit.pose.angle.toFixed(1)}°` : '',
    fit.pose.tilt ? `tilted ${fit.pose.tilt.toFixed(1)}°` : '',
  ].filter(Boolean);
  const angle = pose.length ? ` ${pose.join(', ')}` : '';
  return fit.fits ? (
    <p className="text-xs text-muted-foreground">
      Fits the {fmtThick(fit.panel.thickness, units)} panel{angle}: needs{' '}
      {fmtThick(fit.width, units)}, base included.
    </p>
  ) : (
    <p className="text-xs text-orange-400" data-testid="panel-warning">
      Too thick for the {fmtThick(fit.panel.thickness, units)} panel{angle}: base and blade need{' '}
      {fmtThick(fit.width, units)}. Try Fit to panel (in the 3D view&apos;s Panel fit), a thinner
      foil or less cant.
    </p>
  );
}

function Status({ units, minThickness }: { units: LengthUnit; minThickness: number }) {
  const position = useFinState(finStore, (s) => s.design?.position);
  const base = useFinState(finStore, (s) => s.design?.base);
  const outline = useFinState(finStore, (s) => s.design?.outline);
  if (!position || !base) return null;
  const tab = finTabOutline(base, outline);
  return (
    <div className="space-y-2 border-t border-border px-3 py-2" style={{ gridArea: 'status' }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-xs text-muted-foreground">
          {POSITION_LABEL[position]} on {FIN_BASE_LABEL[base]} ({fmtLen(tab.length, units)} ×{' '}
          {fmtLen(tab.height, units)})
        </span>
        <Readouts units={units} />
      </div>
      <PanelStatus units={units} minThickness={minThickness} />
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
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {large ? (
          tools
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-2 py-1.5 text-sm">
          {tools}
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

/**
 * Open and Save: `.fin.json` files. Opening replaces the fin and starts a fresh history,
 * and re-fits every view to it (`onOpened`), as a new fin does.
 */
function FileButtons({ onSave, onOpened }: { onSave: () => void; onOpened: () => void }) {
  const input = useRef<HTMLInputElement>(null);
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
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
        Open…
      </Button>
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

/** Export for manufacture: STEP for CNC, STL for printing. Off while a rule is broken. */
/** Remembered per device: whether Save and Export write a left and a right fin. */
const PAIR_KEY = 'bs.fin.pair';

/**
 * The R & L option beside Save and Export: when ticked, each writes the fin and its
 * mirror for the other side, two files. Only for fins that have a side.
 */
function PairOption({ pair, onChange }: { pair: boolean; onChange: (on: boolean) => void }) {
  const hand = useFinState(finStore, (s) => s.design?.hand);
  if (!hand) return null;
  return (
    <Tooltip label="Save and export a left and a right fin: two files each time">
      <label className="flex items-center gap-1.5 px-1 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={pair}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>R &amp; L</span>
      </label>
    </Tooltip>
  );
}

function ExportButtons({
  pair,
  units,
  minThickness,
}: {
  pair: boolean;
  units: LengthUnit;
  /** The exports' minimum thickness (cm, File settings). */
  minThickness: number;
}) {
  const design = useFinState(finStore, (s) => s.design);
  const issues = useMemo(() => (design ? validateFinDesign(design) : []), [design]);
  const [busy, setBusy] = useState<'step' | 'stl' | 'core' | null>(null);
  const [coreOpen, setCoreOpen] = useState(false);
  const run = (format: 'step' | 'stl', laminate?: FinLaminate) => {
    const d = finStore.getState().design;
    if (!d || busy) return;
    setBusy(laminate ? 'core' : format);
    // Let "Exporting…" paint before the work starts.
    window.setTimeout(() => {
      void exportFin(d, format, pair, laminate, minThickness).finally(() => setBusy(null));
    }, 0);
  };
  const blocked = issues.length > 0;
  const why = blocked ? 'Fix the issues listed under the measurements first' : undefined;
  return (
    <>
      <Tooltip label={why ?? 'Export a STEP file for CNC (mm)'}>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || busy !== null}
          onClick={() => run('step')}
        >
          {busy === 'step' ? 'Exporting…' : 'Export STEP'}
        </Button>
      </Tooltip>
      <Tooltip label={why ?? 'Export an STL file for 3D printing (mm)'}>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || busy !== null}
          onClick={() => run('stl')}
        >
          {busy === 'stl' ? 'Exporting…' : 'Export STL'}
        </Button>
      </Tooltip>
      <Tooltip
        label={why ?? 'Export a thinner core to bag laminate onto, such as unidirectional carbon'}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || busy !== null}
          onClick={() => setCoreOpen(true)}
        >
          {busy === 'core' ? 'Exporting…' : 'Export core…'}
        </Button>
      </Tooltip>
      {coreOpen && (
        <CoreExportDialog
          units={units}
          pair={pair}
          minThickness={minThickness}
          onClose={() => setCoreOpen(false)}
          onExport={(format, laminate) => {
            setCoreOpen(false);
            run(format, laminate);
          }}
        />
      )}
    </>
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
  // ⌘S saves through a stable callback, so it reads the option from a ref.
  const pairRef = useRef(pair);
  useEffect(() => {
    pairRef.current = pair;
  }, [pair]);
  const save = useCallback(() => {
    const d = finStore.getState().design;
    if (d) void downloadFin(d, pairRef.current);
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
  // Re-fit a view's canvas when it moves between the large pane and a small one.
  const sizeKey = (view: FinView) => `${order[0] === view ? 'large' : 'small'}-${starts}`;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold">OpenFinShaper</h1>
        {/* Credit where it's due: the fin designer is part of OpenShaper (GPL). */}
        <a
          className="mr-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          part of OpenShaper
        </a>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">New fin</span>
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value=""
            aria-label="Start a new fin"
            onChange={(e) => {
              const start = STARTS[Number(e.target.value)];
              if (!start) return;
              finStore.getState().newFin(start.start, start.hand);
              setStarts((n) => n + 1);
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
            {STARTS.map((st, i) => (
              <option key={st.label} value={i}>
                {st.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <FileButtons onSave={save} onOpened={() => setStarts((n) => n + 1)} />
          <PairOption pair={pair} onChange={changePair} />
          <ExportButtons pair={pair} units={units} minThickness={settings.exportMin} />
          <History />
          <SettingsButton settings={settings} onChange={changeSettings} />
          <a
            className="px-2 text-sm text-muted-foreground underline-offset-4 hover:underline"
            href="/docs/fin-designer"
          >
            Help / Feedback
          </a>
        </div>
      </header>
      <main aria-busy={!ready} className="fin-grid min-h-0 flex-1">
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
    </div>
  );
}
