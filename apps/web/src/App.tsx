import { stepExportSupport } from '@openshaper/export';
import type { BoardDoc } from '@openshaper/board2';
import {
  decodeShareFile,
  parseBrd,
  readBoardJson,
  readBoardText,
  writeBoardJson,
  type BoardFile,
} from '@openshaper/io';
import {
  loftCrossSection,
  getLength,
  resolveFins,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';
import { reflectSpline, type EditorOverlays, type SimilarityParams } from '@openshaper/render2d';
import type { AnalysisStatus, Board3DViewProps, ExternalSurface } from '@openshaper/render3d';
import { minusHalf, selectSpecs } from '@openshaper/store';
import { projectDoc } from '@openshaper/store/sections';
import {
  BottomSheet,
  Button,
  buttonVariants,
  cn,
  Menu,
  MenuBar,
  Panel,
  PanelBody,
  Toast,
  ToolbarSeparator,
  type MenuItem,
  type SheetSnap,
} from '@openshaper/ui';
import { Menu as MenuIcon, Share2, SlidersHorizontal } from 'lucide-react';
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  decideImport,
  downloadBoard,
  downloadBoardText,
  downloadBrd,
  downloadPdf1to1,
  downloadRailBands,
  downloadStep,
  exportBoard,
  openBoardFile,
  SectionsFileError,
  sourceExtension,
  type BoardMeta,
  type ExportFormat,
  toBoardMeta,
} from './file-io';
import { captureError, track } from './analytics';
import {
  installSessionSummary,
  markExport,
  markImport,
  markSave,
  markTemplate,
  markView,
} from './session-metrics';
import { ImportWarningsDialog } from './ImportWarningsDialog';
import type { ImportWarning } from '@openshaper/io';
import { ExportPdf1to1Dialog } from './ExportPdf1to1Dialog';
import { ExportStepDialog } from './ExportStepDialog';
import { ExportRailBandsDialog } from './ExportRailBandsDialog';
import { loadPdf1to1, savePdf1to1, type Pdf1to1Settings } from './pdf-export-settings';
import { loadStep, saveStep, type StepSettings } from './step-export-settings';
import { loadRailBands, saveRailBands, type RailBandsSettings } from './rail-bands-settings';
import { clearRecentBoards, getRecentBoards, recordRecentBoard } from './recent-boards';
import {
  DEFAULT_LENGTH_UNIT,
  fmtDimsHeadline,
  fmtVol,
  LENGTH_UNITS,
  lengthUnitByKey,
  parseLen,
  type LengthUnit,
} from './format';
import { AnalysisLegend } from './AnalysisLegend';
import { openHtmlInNewTab, specSheetHtmlFor } from './spec-sheet-open';
import { loadSession, saveSession } from './session-store';
import { DEFAULT_SPLIT, loadViewState, saveViewState, type SplitPanes } from './view-state';
import { Brandmark } from './components/marks';
import { CommandPalette, commandsFromMenus } from './CommandPalette';
import { commandHelp } from './help-text';
import { HelpTooltip, ShowTipsProvider } from './help-tips';
import { ConstructionPanel } from './ConstructionPanel';
import { SettingsDialog } from './SettingsDialog';
import { ShareDialog } from './ShareDialog';
import { NurbsOpenPrompt } from './NurbsOpenPrompt';
import { SharedBoardPrompt } from './SharedBoardPrompt';
import { clearSharedPayload, peekSharedPayload } from './share-bootstrap';
import { shareLinkMessage } from './share-url';
import { loadSettings, saveSettings, type EditorSettings } from './settings';
import { NurbsBoundary } from './nurbs-boundary';
import { useEngineParam } from './nurbs-flag';
import { useReleaseNurbsWhenOff } from './nurbs-session';
import { CrossSectionControls } from './CrossSectionControls';
import { LandscapeHint } from './LandscapeHint';
import { CoffeeIcon } from './components/Support';
import { Sidebar, type OverlayToggles, type ResizeFields } from './Sidebar';
import {
  applyViewChange,
  DEFAULT_SIDEBAR_STATE,
  revealSection,
  type SidebarState,
} from './sidebar-sections';
import sampleBrd from './sample-board.brd?raw';
import { depthSeries } from './bottom-features';
import { activeStore, boardStore, sectionStore } from './store';
import { probeAt, probeSpline, setWantedProbes, useProbes } from './nurbs-probes';
import { metaOfDoc, sectionsName, sectionsText, sectionsTextNow } from './section-files';
import {
  attachSectionDoc,
  currentSections,
  holdSectionsText,
  openSectionDoc,
  prepareSectionDoc,
  useSectionEngine,
} from './use-section-engine';
import { localizeLengths, refusalHint } from './nurbs-text';
import { SUPPORT_URL } from './support';
import { BOARD_TEMPLATES, NURBS_TEMPLATES } from './templates';
import { clampSectionIndex, nearestMidpointSection } from './section-index';
import { VIEW_KEYS } from './shortcuts';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { useSettledBoard } from './use-settled-board';
import { isShortViewport, useIsDesktop, useIsPhone, useIsShortViewport } from './useMediaQuery';
import { specsFromMesh } from './nurbs-specs';
import { useMeshSpecs } from './use-mesh-specs';
import { useSpecsWorker } from './use-specs-worker';
import { useTrace, type TraceView } from './use-trace';
import {
  EditorPane,
  faceSizeFor,
  FALLBACK_VIEW,
  isViewAvailable,
  MeasurementAxisSelect,
  SplitPaneSelect,
  ThreeDControls,
  UnitSelect,
  ViewPaneHeader,
  ViewToggleTitle,
  type EditorKind,
  type SplitPaneKind,
  type View,
  type View3DSettings,
} from './view-toolkit';
import { longitudinalFor, type MeasurementAxis } from './longitudinal';
import {
  DEFAULT_VIEW_3D,
  effectiveAnalysis,
  exactAnalysisUnavailable,
  ghostDeviationUnavailable,
} from './view3d-settings';
import { estimateWeight, FOAM_TYPES, GLASS_SCHEDULES } from './weights';
import { readRaw, writeRaw } from './persisted';

// three.js / fiber / drei are the bulk of the bundle and are only needed once a 3D
// pane is shown, so load Board3DView as its own chunk. The 2D editor becomes
// interactive without waiting on the 3D stack, and 2D-only views never fetch it.
const Board3DView = lazy(() =>
  import('@openshaper/render3d').then((m) => ({ default: m.Board3DView })),
);

// The experimental NURBS viewer: its own chunk, fetched only with the engine flag on
// (and it starts its own worker, which carries board2 and geom).
const NurbsLayer = lazy(() => import('./nurbs-layer'));

const ANALYSIS_IDLE: AnalysisStatus = { state: 'off' };

/**
 * Board3DView behind a Suspense boundary, so the lazy 3D chunk can stream in, with
 * the computed analysis modes' legend over it (the view reports where an analysis
 * stands; the legend's lengths are formatted here, in the display unit).
 *
 * Memoized: the 3D view subscribes to the board store itself and every prop here is a
 * primitive, a ref-backed value or a stable callback (`units` is one of the constant
 * `LENGTH_UNITS`, `ghost` changes only when a ghost is opened or cleared), so an
 * AppShell render (a 2D drag move, a hover scrub) need not re-reconcile the three.js
 * scene.
 */
const ThreeDPane = memo(function ThreeDPane({
  units,
  nurbsEngine,
  ...props
}: Board3DViewProps & { units: LengthUnit; nurbsEngine: boolean }) {
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>(ANALYSIS_IDLE);
  // The NURBS surface for the board on screen, from the (lazy) NURBS layer; always
  // null with the engine flag off.
  const [surface, setSurface] = useState<ExternalSurface | null>(null);
  const dropSurface = useCallback(() => setSurface(null), []);
  return (
    <div className="relative h-full w-full">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading 3D…
          </div>
        }
      >
        <Board3DView
          {...props}
          surface={nurbsEngine ? surface : null}
          onAnalysisStatus={setAnalysisStatus}
        />
      </Suspense>
      {nurbsEngine && (
        // A chunk that will not load (offline, or removed by a deploy) must not take the
        // editor down with it: the boundary falls back to the classic view.
        <NurbsBoundary onFail={dropSurface}>
          <Suspense fallback={null}>
            <NurbsLayer
              store={props.store}
              analysis={props.analysis ?? 'none'}
              units={units}
              onSurface={setSurface}
            />
          </Suspense>
        </NurbsBoundary>
      )}
      {/* Only an exact mode reports anything but 'off'; switching away clears it. */}
      {props.analysis && props.analysis !== 'none' && (
        <AnalysisLegend status={analysisStatus} units={units} />
      )}
    </div>
  );
});

/** A NURBS document on its way to being the open board (see `openSections` in AppShell). */
interface SectionsOpen {
  doc: BoardDoc;
  /** The name it takes in the recent list. */
  recentName: string;
  /** Called once it is open (a template or a recent board also clears the ghost). */
  onOpened?: () => void;
}

/** The notice after an import that was repaired: what changed, or nothing to say. */
const importedNotice = (info: readonly ImportWarning[]) =>
  info.length > 0
    ? { title: 'Imported with changes:', messages: info.map((w) => w.message) }
    : null;

function AppShell() {
  const board = useSyncExternalStore(activeStore.subscribe, () => activeStore.getState().board);
  // Subscribe to history depth so the undo/redo buttons re-render with the right
  // enabled state, read live from the store rather than a render-time snapshot.
  const canUndo =
    useSyncExternalStore(activeStore.subscribe, () => activeStore.getState().past.length) > 0;
  const canRedo =
    useSyncExternalStore(activeStore.subscribe, () => activeStore.getState().future.length) > 0;

  // Silent session restore: rehydrate the autosaved working board (and ghost)
  // from IndexedDB; fall back to the bundled sample when nothing usable is
  // stored. Hydration is async so it never blocks first paint; autosave stays
  // off (`hydrated`) until the decision lands, so a slow load can't be
  // clobbered by an autosave of the empty/sample state.
  const hydrated = useRef(false);
  /**
   * A decoded shared board waiting on the "replace your work?" question. It is
   * held here, never in boardStore, until the user says yes — which is what
   * makes *Keep current* a true no-op and lets autosave keep running
   * underneath without blurring the two choices.
   */
  const [pendingShare, setPendingShare] = useState<BoardFile | null>(null);
  // The engine setting, for the one effect below that closes over the first render.
  const nurbsOnRef = useRef(false);
  /** A session NURBS document is held while the engine is off: offer to turn it on. */
  const [heldPrompt, setHeldPrompt] = useState(false);

  /** The bundled sample, when there is no session (or it cannot be restored). */
  const loadSample = () => {
    try {
      const { board } = parseBrd(sampleBrd);
      hydrated.current = true;
      boardStore.getState().load(board);
    } catch (e) {
      console.error('Failed to load sample board', e);
      // A bundled asset we ship failing to parse — the editor opens empty.
      captureError('sample_board', e);
    }
  };

  useEffect(() => {
    if (boardStore.getState().board) {
      hydrated.current = true;
      return;
    }
    let cancelled = false;

    /**
     * Restore the autosaved workspace; fall back to the bundled sample. A NURBS document in the session
     * is restored with the engine on (revived first, so the classic store and the section store change
     * together and nothing is edited in between). With the engine off its text is held and written back
     * unchanged, and turning the engine on revives it.
     */
    const restoreOrSample = async (
      session: Awaited<ReturnType<typeof loadSession>>,
    ): Promise<boolean> => {
      if (session) {
        try {
          const { board: sBoard, metadata } = readBoardJson(session.boardJson);
          let sGhost: BezierBoard | null = null;
          if (session.ghostJson) {
            try {
              sGhost = readBoardJson(session.ghostJson).board;
            } catch {
              // A broken ghost snapshot must not block restoring the board.
            }
          }
          let sections: BoardDoc | null = null;
          if (session.sectionsJson && nurbsOnRef.current) {
            try {
              const r = await prepareSectionDoc(JSON.parse(session.sectionsJson) as unknown);
              if (r.ok) sections = r.doc;
            } catch {
              // A document that will not read: held below, and tried again by the engine.
            }
            if (cancelled) return false;
          }
          hydrated.current = true;
          boardStore.getState().load(sBoard);
          if (sections) {
            attachSectionDoc(sections);
            setMeta(metaOfDoc(sections.meta));
          } else {
            // Never drop a saved NURBS document: hold it when it is not revived here (engine off, or a
            // chunk that would not load); the engine revives it, or says why it could not.
            if (session.sectionsJson) {
              holdSectionsText(session.sectionsJson);
              if (!nurbsOnRef.current) setHeldPrompt(true);
            }
            setMeta(toBoardMeta(metadata));
          }
          if (sGhost) setGhost(sGhost);
          return true;
        } catch (e) {
          console.error('Failed to restore session', e);
          // The visitor's own work failing to come back. The JSON is ours, so
          // a parse failure here is our bug, not a bad file.
          captureError('session_restore', e);
        }
      }
      loadSample();
      return false;
    };

    void (async () => {
      // Startup precedence (docs/design/share-link.md §2.3): decode the link
      // first, but touch nothing until the session read has resolved, so the
      // "is there work to lose?" question is answered before it is asked.
      const payload = peekSharedPayload();
      const session = await loadSession();
      if (cancelled) return;

      let shared: BoardFile | null = null;
      if (payload) {
        try {
          shared = await decodeShareFile(payload);
        } catch (e) {
          // A bad link is a bad input, not our bug — so a message, not a
          // captureError, and never the payload or the parser's own words.
          clearSharedPayload();
          showToast(shareLinkMessage(e));
        }
        if (cancelled) return;
      }

      // A valid link into an empty browser opens straight away: there is
      // nothing to replace, so there is nothing to ask about.
      if (shared && !session) {
        void adoptRef.current(shared);
        return;
      }

      const hadSession = await restoreOrSample(session);
      if (cancelled) return;
      if (shared && hadSession) setPendingShare(shared);
      else if (shared) void adoptRef.current(shared);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Overlay toggles are declared early so the dist flag can be forwarded to the
  // specs worker (the worker re-runs the distribution only when the flag is on).
  const [overlayToggles, setOverlayToggles] = useState<OverlayToggles>({
    grid: false,
    comb: false,
    com: false,
    dist: false,
    tunni: false,
    apex: false,
  });
  // Flip one overlay and report it. These four are entirely unmeasured
  // otherwise — the curvature comb and volume distribution in particular are
  // expensive to maintain, so knowing whether anyone turns them on is the
  // difference between investing in them and retiring them.
  // One path for the View menu and the sidebar checkboxes. Stable, so the memo'd
  // Sidebar can take it as a prop.
  const setOverlay = useCallback((key: keyof OverlayToggles, enabled: boolean) => {
    // Reported outside the updater: StrictMode double-invokes updaters in dev,
    // which would double-count the event.
    track('overlay_toggled', { overlay: key, enabled });
    setOverlayToggles((s) => ({ ...s, [key]: enabled }));
  }, []);
  const toggleOverlay = (key: keyof OverlayToggles) => setOverlay(key, !overlayToggles[key]);
  const setTunniOverlay = useCallback((on: boolean) => setOverlay('tunni', on), [setOverlay]);

  // Specs (and the distribution overlay) read the settled board so they don't
  // re-integrate on every drag move — see useSettledBoard. The integrals run in
  // the specs worker; previous values hold during recompute (no flicker).
  const settledBoard = useSettledBoard();
  const workerResult = useSpecsWorker(settledBoard, {
    wantDistribution: overlayToggles.dist,
    distributionIntervals: 40,
    wantApex: overlayToggles.apex,
  });
  // Volume-distribution overlay: computed off-thread when the overlay is enabled.
  // When disabled the worker skips the sampling, saving ~41 getCrossSectionAreaAt
  // calls per settled-board change.
  const volumeDist = workerResult?.distribution;
  // Rail apex height for the rocker view: traced off-thread too, from the settled board,
  // so like the distribution it catches up when a drag is released.
  const apexHeight = workerResult?.apex;

  // View-state restore: active tab, per-pane 2D framing, 3D camera pose —
  // read once at boot (synchronous localStorage), then live changes are
  // debounce-persisted. Each pane's stored framing is "pending" until that
  // pane first mounts and applies it; afterwards remounts auto-fit as usual.
  // The camera instead tracks the latest pose so 3D remounts keep continuity.
  const bootViewState = useRef(loadViewState());
  const liveViewState = useRef(bootViewState.current);
  const pendingViews2d = useRef({ ...bootViewState.current.views2d });
  // `pickedView` is what the user chose (and what gets persisted); `view` is what
  // this tier can actually show. Deriving rather than correcting the state means a
  // phone renders Outline over a stored `quad` without destroying that preference —
  // widen the window and quad comes straight back.
  const [pickedView, setPickedView] = useState<View>(bootViewState.current.view);
  // Sidebar shape (rail folded, which sections are open, which the user owns). Lives
  // beside `pickedView` because the two are coupled: changing view re-opens the
  // sections that view implies, for every section the user has not taken over.
  const [sidebar, setSidebar] = useState<SidebarState>(
    () => bootViewState.current.sidebar ?? DEFAULT_SIDEBAR_STATE,
  );
  const viewSaveTimer = useRef<number | undefined>(undefined);
  const scheduleViewSave = useCallback(() => {
    window.clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = window.setTimeout(() => saveViewState(liveViewState.current), 500);
  }, []);
  useEffect(() => {
    liveViewState.current = { ...liveViewState.current, view: pickedView };
    scheduleViewSave();
  }, [pickedView, scheduleViewSave]);
  // Which pane each half of the split layout shows. Persisted alongside the
  // active view, so a pairing set up once survives a reload and a trip through
  // the other views.
  const [split, setSplit] = useState<SplitPanes>(bootViewState.current.split ?? DEFAULT_SPLIT);
  useEffect(() => {
    liveViewState.current = { ...liveViewState.current, split };
    scheduleViewSave();
  }, [split, scheduleViewSave]);
  /**
   * Point one half at a pane. Picking the pane the *other* half already shows
   * swaps the two rather than doubling it up: two copies of the outline is never
   * what the pick meant, and swapping is the one reading that keeps both choices.
   */
  const setSplitPane = useCallback(
    (slot: 'top' | 'bottom', kind: SplitPaneKind) =>
      setSplit((s) => {
        if (kind === (slot === 'top' ? s.bottom : s.top)) return { top: s.bottom, bottom: s.top };
        return slot === 'top' ? { ...s, top: kind } : { ...s, bottom: kind };
      }),
    [],
  );
  useEffect(() => {
    liveViewState.current = { ...liveViewState.current, sidebar };
    scheduleViewSave();
  }, [sidebar, scheduleViewSave]);
  /** Per-pane framing report: consume the pending restore, persist the live value. */
  const reportPaneView = (kind: EditorKind) => (v: { cx: number; cy: number; scale: number }) => {
    delete pendingViews2d.current[kind];
    liveViewState.current.views2d[kind] = v;
    scheduleViewSave();
  };
  const onCameraChange = useCallback(
    (pose: { position: [number, number, number]; target: [number, number, number] }) => {
      liveViewState.current.camera3d = pose;
      scheduleViewSave();
    },
    [scheduleViewSave],
  );
  // Editor layout tier: at `lg`+ the sidebar sits beside the viewport; below it the
  // sidebar moves into a draggable bottom sheet and the quad view stacks vertically.
  // Narrower (or shorter) still is the phone tier, which drops quad entirely.
  const isDesktop = useIsDesktop();
  const isPhone = useIsPhone();
  const isShort = useIsShortViewport();
  const tier = { isPhone, isDesktop };
  const view = isViewAvailable(pickedView, tier) ? pickedView : FALLBACK_VIEW;
  const views = VIEW_KEYS.filter((v) => isViewAvailable(v.view, tier));

  // Switching view re-opens the sections that view is for and shuts the ones it is
  // not — but only for sections the user has never toggled themselves (`touched`).
  // Keyed on the *derived* view, so a phone falling back off `quad` gets the sections
  // for what it is actually showing — and in Split, on the two panes actually on
  // screen rather than on the layout, so re-pointing a half re-opens its tools.
  // `applyViewChange` returns the same object when nothing moves, so the first
  // render does not re-persist what it just restored.
  const sidebarViews: View | readonly View[] = view === 'split' ? [split.top, split.bottom] : view;
  useEffect(() => {
    setSidebar((s) => applyViewChange(s, sidebarViews));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, split.top, split.bottom]);

  // Which editors get used is invisible to autocapture — the panes are
  // canvases. Recorded once per session per view (markView dedupes) so the
  // question "is 3D a core tool or a curiosity" becomes answerable without a
  // per-click stream.
  // The one gate on changing view: the tab strip and the number keys both route
  // through it, so a view this tier does not offer cannot be reached by either.
  const selectView = useCallback(
    (v: View) => {
      if (!isViewAvailable(v, { isPhone, isDesktop })) return;
      setPickedView(v);
      markView(v);
    },
    [isPhone, isDesktop],
  );

  // A short viewport (a phone held landscape) starts with the sheet out of the
  // way: its 112px peek is more than a quarter of the screen there, and the
  // point of turning the phone is to see the board.
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>(() =>
    isShortViewport() ? 'closed' : 'peek',
  );
  // The same holds when the phone is turned after load: a sheet left at peek goes
  // out of the way. A sheet opened further was asked for, so it stays. Synced
  // during render (not in an effect) so the rotated layout never paints with it.
  const [sheetWasShort, setSheetWasShort] = useState(isShort);
  if (isShort !== sheetWasShort) {
    setSheetWasShort(isShort);
    if (isShort && sheetSnap === 'peek') setSheetSnap('closed');
  }
  // The sheet is fixed over the viewport bottom whenever it is mounted, so the
  // view area must reserve its peek height — and reclaim it when it is closed.
  const sheetOpen = !isDesktop && sheetSnap !== 'closed';
  // "Showing panels" means more than the peek readout — at `peek` the button's
  // job is still to reveal them, so it opens rather than closes.
  const panelsShowing = sheetSnap === 'half' || sheetSnap === 'full';

  // Publish the sheet's footprint so fixed elements outside this tree (the toast
  // stack, the consent banner) can sit clear of it — and reclaim the space when
  // it closes.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--os-sheet-inset', sheetOpen ? '7rem' : '0px');
    return () => {
      root.style.removeProperty('--os-sheet-inset');
    };
  }, [sheetOpen]);
  const [csIndex, setCsIndex] = useState(1);
  const [focusedSection, setFocusedSection] = useState<number | null>(null);
  // Transient cross-pane scrub: the board-length x being hovered in the rocker/outline,
  // mirrored to the other panes as a vertical guide + an interpolated section preview.
  const [scrubX, setScrubX] = useState<number | null>(null);
  // Mirrored into a ref so the Escape shortcut can tell "a marker was focused" from
  // "nothing to release" without re-binding the global key listener on every focus.
  const focusedSectionRef = useRef<number | null>(null);
  const focusSection = useCallback((index: number | null) => {
    if (index !== null) {
      setScrubX(null);
      // Cross-section markers and spline controls share one interaction focus.
      // Taking marker focus clears any selected endpoint/tangent in every pane.
      activeStore.getState().select(null);
    }
    focusedSectionRef.current = index;
    setFocusedSection(index);
  }, []);
  const clearSectionFocus = useCallback(() => {
    if (focusedSectionRef.current === null) return false;
    focusSection(null);
    return true;
  }, [focusSection]);
  const scrubSection = useCallback(
    (position: number | null) => setScrubX(focusedSection === null ? position : null),
    [focusedSection],
  );
  const [unitKey, setUnitKey] = useState<string>(
    () => readRaw('bs.lengthUnit') ?? DEFAULT_LENGTH_UNIT.key,
  );
  const units = lengthUnitByKey(unitKey);
  useEffect(() => {
    writeRaw('bs.lengthUnit', unitKey);
  }, [unitKey]);
  const [measurementAxis, setMeasurementAxis] = useState<MeasurementAxis>(() => {
    const stored = readRaw('bs.measurementAxis');
    return stored === 'o-curve' ? 'o-curve' : 'x-axis';
  });
  useEffect(() => {
    writeRaw('bs.measurementAxis', measurementAxis);
  }, [measurementAxis]);
  // Keyed on the bottom rocker only while o/curve is on, so the default x-axis (and any
  // edit that leaves the rocker alone) keeps the same object and the memoized sidebar
  // does not re-render on every drag frame.
  const overCurveBottom = measurementAxis === 'o-curve' ? (board?.bottom ?? null) : null;
  const longitudinal = useMemo(
    () => longitudinalFor(overCurveBottom, measurementAxis),
    [overCurveBottom, measurementAxis],
  );
  const [view3d, setView3d] = useState<View3DSettings>(
    bootViewState.current.view3d ?? DEFAULT_VIEW_3D,
  );
  const patchView3d = (patch: Partial<View3DSettings>) => setView3d((s) => ({ ...s, ...patch }));
  useEffect(() => {
    liveViewState.current = { ...liveViewState.current, view3d };
    scheduleViewSave();
  }, [view3d, scheduleViewSave]);
  const [csClipboard, setCsClipboard] = useState<Spline | null>(null);
  const [ghost, setGhost] = useState<BezierBoard | null>(null);
  const trace = useTrace();
  const [meta, setMeta] = useState<BoardMeta>({});
  const metaRef = useRef(meta); // for the session autosave (stable callbacks)
  metaRef.current = meta;
  const ghostRef = useRef(ghost); // for the pagehide session flush (stable listener)
  ghostRef.current = ghost;

  // Continuous autosave: after every committed change to the board, its
  // metadata, or the ghost, snapshot the session to IndexedDB (debounced —
  // store commits land on pointer-up, so this coalesces bursts of edits).
  const saveSeq = useRef(0);
  const persistSession = useCallback(() => {
    // The classic document is the board that was opened; with the NURBS engine on, the section document
    // is what was edited, and it is saved beside it (docs/design/m2-editor.md §5): a restore brings back
    // both, and the engine setting picks the one shown.
    const classic = boardStore.getState().board;
    if (!classic || !hydrated.current) return;
    const m = metaRef.current;
    const metadata = Object.values(m).some(Boolean) ? (m as Record<string, unknown>) : undefined;
    const g = ghostRef.current;
    const seq = ++saveSeq.current;
    const write = (sectionsJson?: string) => {
      if (seq !== saveSeq.current) return; // a newer snapshot has been taken
      void saveSession({
        boardJson: writeBoardJson(classic, metadata),
        ...(g ? { ghostJson: writeBoardJson(g) } : {}),
        ...(sectionsJson !== undefined ? { sectionsJson } : {}),
      });
    };
    const sections = currentSections();
    if (!sections) return write();
    if ('text' in sections) return write(sections.text);
    // The file code is started loading when a document is attached; at pagehide there is no time to wait
    // for it, but a snapshot taken after that (the debounced one) has it.
    const now = sectionsTextNow(sections.doc, m);
    if (now !== null) return write(now);
    void sectionsText(sections.doc, m).then(write, () => write());
  }, []);
  const sessionSaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!board || !hydrated.current) return;
    window.clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = window.setTimeout(persistSession, 800);
  }, [board, meta, ghost, persistSession]);
  // A pending save must not outlive the editor. `boardStore` is a module
  // singleton, so a timer left running after unmount would write whatever board
  // the *next* mount holds into the session — the tests unmount between cases,
  // and that stray write made a later "empty browser" case find existing work.
  useEffect(() => () => window.clearTimeout(sessionSaveTimer.current), []);
  // Flush a pending debounce when the tab is being closed/backgrounded, so
  // "edit, then immediately close" still lands in the session.
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(sessionSaveTimer.current);
      persistSession();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [persistSession]);
  // One `session_summary` per editing session, sent on pagehide. Edit depth is
  // read from the history stack at flush time rather than counted per edit, so
  // nothing is added to the drag path. See session-metrics.ts for why this is
  // an aggregate rather than a per-action stream.
  useEffect(() => installSessionSummary(() => activeStore.getState().past.length), []);
  const [resize, setResize] = useState<ResizeFields>({ l: '', w: '', t: '' });
  const [templateKind, setTemplateKind] = useState<'hws' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const [stepDialogOpen, setStepDialogOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [stepSettings, setStepSettings] = useState<StepSettings>(() => loadStep());
  const [railBandsDialogOpen, setRailBandsDialogOpen] = useState(false);
  const [railBandsSettings, setRailBandsSettings] = useState<RailBandsSettings>(() =>
    loadRailBands(),
  );
  const [pdf1to1, setPdf1to1] = useState<Pdf1to1Settings>(() => loadPdf1to1());
  const [settings, setSettings] = useState<EditorSettings>(() => loadSettings());
  // "Engine: NURBS (experimental)": the saved setting, or `?engine=nurbs` this session.
  const engineParam = useEngineParam();
  const nurbsEngine = settings.nurbsEngine || engineParam;
  nurbsOnRef.current = nurbsEngine;
  // Turning it off ends the worker (and any conversion in it) and drops the cached meshes.
  useReleaseNurbsWhenOff(nurbsEngine);
  // The engine picks the store the editors edit (docs/design/m2-editor.md §1): the section store with
  // the engine on and the open board converted into it, the classic store otherwise. A board the NURBS
  // model cannot hold stays classic, with the reasons in the 3D view's popover.
  const sectionEngine = useSectionEngine(nurbsEngine);
  useLayoutEffect(() => {
    activeStore.use(sectionEngine.ready ? sectionStore : boardStore);
  }, [sectionEngine.ready]);
  // A board the NURBS model cannot hold stays classic; say why, as an import notice (the 3D popover has the
  // converter's own words too). Lengths in the message follow the display unit.
  const [engineNotice, setEngineNotice] = useState<string[] | null>(null);
  const refusal = sectionEngine.refusal;
  useEffect(() => {
    if (!refusal) {
      setEngineNotice(null);
      return;
    }
    const reasons = refusal.issues
      .filter((i) => i.severity === 'error')
      .map((i) => refusalHint(i.code) ?? localizeLengths(i.message, units));
    setEngineNotice(
      [...new Set(reasons.length > 0 ? reasons : [localizeLengths(refusal.error, units)])].slice(
        0,
        4,
      ),
    );
  }, [refusal, units]);
  // The specs: the classic worker's readouts, and with the NURBS document open the volume, plan area and
  // centre of mass of its mesh instead (features and asymmetry show), computed in a worker as well.
  const meshSpecs = useMeshSpecs(sectionEngine.ready);
  const classicSpecs = workerResult?.specs ?? null;
  const specs = useMemo(
    () => (classicSpecs ? specsFromMesh(classicSpecs, meshSpecs) : null),
    [classicSpecs, meshSpecs],
  );
  const handleSaveSettings = (s: EditorSettings) => {
    saveSettings(s);
    setSettings(s);
  };
  // Mirror the persisted "resize cross-sections to rocker/deck" preference into the store
  // (legacy JC-4-y): when off, a curve edit no longer reshapes the cross-sections.
  useEffect(() => {
    boardStore.getState().setAdjustThickness(settings.adjustCrossSectionThickness);
  }, [settings.adjustCrossSectionThickness]);
  // Imperative view commands for the 2D editor panes (fit / life-size).
  // The `seq` counter ensures the same command kind can be fired multiple times
  // — each menu press increments it, which triggers the SplineEditor effect.
  const [viewCmd, setViewCmd] = useState<{ seq: number; kind: 'fit' | 'lifeSize' } | undefined>(
    undefined,
  );
  const sendViewCmd = (kind: 'fit' | 'lifeSize') =>
    setViewCmd((cur) => ({ seq: (cur?.seq ?? 0) + 1, kind }));

  // Board3DView reads `initialCamera` once, as the Canvas's initial state, so
  // "reset the 3D camera" means clearing the stored pose and remounting the
  // pane. Bumping this key is that remount.
  const [cameraEpoch, setCameraEpoch] = useState(0);
  // Fitting the 2D panes has to wait for them to exist: adopting a shared board
  // switches to Quad in the same batch, so the fit is deferred to the effect
  // that runs once those panes have mounted.
  const [fitEpoch, setFitEpoch] = useState(0);
  useEffect(() => {
    if (fitEpoch > 0) sendViewCmd('fit');
  }, [fitEpoch]);

  // Recent boards: re-read from localStorage whenever the menu is constructed so
  // it stays in sync with saves/opens from this session.
  const [recentBoards, setRecentBoards] = useState(() => getRecentBoards());

  // Ctrl/Cmd+S takes File > Save's path (`saveBoardFile`, defined below), so it
  // is recorded and refreshes Open recent. A ref keeps the shortcut stable.
  const saveBoardFileRef = useRef<() => void>(() => {});
  const saveFromShortcut = useCallback(() => saveBoardFileRef.current(), []);
  useKeyboardShortcuts({
    setView: selectView,
    setCsIndex,
    onSave: saveFromShortcut,
    onCommandPalette: togglePalette,
    clearSectionFocus,
  });

  const sectionCount = board?.crossSections.length ?? 0;
  // An asymmetric NURBS board has a spline for each half: the outline and cross-section panes show both.
  const asymmetric = board ? minusHalf(board) !== undefined : false;
  const lastReal = Math.max(1, sectionCount - 2);
  const clampedCs = clampSectionIndex(csIndex, sectionCount);

  // The active station's length position. Derived unconditionally — the toggle
  // governs whether the guide is drawn, not whether the position is known.
  const activeSectionX = board ? (board.crossSections[clampedCs]?.position ?? null) : null;

  // The sections the NURBS surface has at the selected station and under the scrub are drawn dashed in the
  // cross-section pane; the layer over the 3D view asks the worker for them (nurbs-probes.ts).
  const nurbsSections = sectionEngine.ready;
  useEffect(() => {
    const xs: number[] = [];
    if (nurbsSections && activeSectionX != null) xs.push(activeSectionX);
    if (nurbsSections && scrubX != null && scrubX !== activeSectionX) xs.push(scrubX);
    setWantedProbes(xs);
  }, [nurbsSections, activeSectionX, scrubX]);

  // Real cross-sections (skip the nose/tail dummies) as pickable outline markers.
  const sectionMarkers = board
    ? board.crossSections.slice(1, sectionCount - 1).map((cs, i) => ({
        pos: cs.position,
        index: i + 1,
        active: i + 1 === clampedCs,
      }))
    : [];

  // Cross-section management (legacy Cross-sections menu), shown in the cross-section pane header.
  /** Insert a station at an explicit board-length x (the rocker/outline right-click action). */
  const addSectionAt = (pos: number) => {
    const idx = activeStore.getState().addCrossSection(pos);
    if (idx > 0) {
      focusSection(null);
      setCsIndex(idx);
    }
  };
  const moveSection = (index: number, position: number) => {
    activeStore.getState().moveCrossSection(index, position);
    setCsIndex(index);
  };
  const addSection = () => {
    const b = activeStore.getState().board;
    if (!b) return;
    const cur = b.crossSections[clampedCs]?.position ?? 0;
    const next = b.crossSections[clampedCs + 1]?.position ?? cur;
    const pos = next > cur ? (cur + next) / 2 : cur + 5; // midpoint, or nudge past the last
    addSectionAt(pos);
  };
  const deleteSectionAt = (index: number) => {
    activeStore.getState().deleteCrossSection(index);
    focusSection(null);
    const count = activeStore.getState().board?.crossSections.length ?? 0;
    setCsIndex(clampSectionIndex(index, count));
  };
  const deleteSection = () => deleteSectionAt(clampedCs);
  // On an asymmetric board copy and paste act on the half whose point is selected, else the plus half.
  const sectionSide = (): 'minus' | undefined => {
    const t = activeStore.getState().selection?.target;
    return t?.kind === 'crossSection' && t.side === 'minus' ? 'minus' : undefined;
  };
  const copySection = () => {
    const b = activeStore.getState().board;
    if (!b) return;
    const half = sectionSide() === 'minus' ? (minusHalf(b) ?? b) : b;
    setCsClipboard(half.crossSections[clampedCs]?.spline ?? null);
  };
  const pasteSection = () => {
    if (csClipboard)
      activeStore.getState().pasteCrossSection(clampedCs, csClipboard, sectionSide());
  };

  // Resize: blank fields keep that dimension; others scale to the typed target.
  const applyResize = useCallback(() => {
    if (!specs) return;
    const factor = (text: string, cur: number) => {
      const t = text.trim();
      if (!t || cur <= 0) return 1;
      const v = parseLen(t, units);
      return v > 0 ? v / cur : 1;
    };
    activeStore
      .getState()
      .scaleBoard(
        factor(resize.l, specs.length),
        factor(resize.w, specs.maxWidth),
        factor(resize.t, specs.thickness),
      );
    setResize({ l: '', w: '', t: '' });
  }, [specs, resize, units]);

  // Board ▸ Resize…: the tool lives in a section of the Shape tab that no view opens
  // on its own, so asking to scale a finished design did not lead to it. The command
  // brings it on screen — panel unfolded, or the sheet raised on the compact tiers —
  // and puts the cursor in its first field.
  //
  // An effect keyed on a request counter rather than a call made here: the panel may
  // be folded or the sheet closed, so the field does not exist until the commit these
  // updates cause. Passive rather than layout, so it lands after every cleanup in that
  // commit — a closing dialog handing focus back to its opener cannot take it back.
  //
  // Focus without the browser's own scroll, then scroll the form in once the sheet has
  // settled. The sheet animates its height, and a field focused mid-grow is centred in
  // the still-tiny body — a scroll offset it keeps at full height, which parks the tab
  // strip and the Resize header above the fold. `nearest` leaves a form that already
  // fits where it is; the form's scroll margins keep its header and the sticky support
  // bar's strip clear (`ResizeSection`).
  const resizeForm = useRef<HTMLDivElement>(null);
  const [resizeFocus, setResizeFocus] = useState(0);
  useEffect(() => {
    const form = resizeForm.current;
    if (resizeFocus === 0 || !form) return;
    form.querySelector('input')?.focus({ preventScroll: true });
    const reveal = () => form.scrollIntoView?.({ block: 'nearest' });
    // getAnimations flushes style, so a height transition this commit started is
    // already listed. Absent in jsdom.
    const growing = form.closest('[role="dialog"]')?.getAnimations?.() ?? [];
    if (growing.length === 0) {
      reveal();
      return;
    }
    let live = true;
    void Promise.allSettled(growing.map((a) => a.finished)).then(() => {
      if (live) reveal();
    });
    return () => {
      live = false;
    };
  }, [resizeFocus]);
  const openResize = () => {
    setSidebar((s) => revealSection(s, 'resize'));
    // `half` is where the panels button opens it; one already at `full` stays there. A
    // short (landscape) half is too low to show the form above the support bar, so it
    // goes to `full` — the board is not what this command is about.
    if (!isDesktop) {
      if (isShort) setSheetSnap('full');
      else if (!panelsShowing) setSheetSnap('half');
    }
    setResizeFocus((n) => n + 1);
  };

  // Fins are part of the board model now; resolve their geometry against the current
  // shape for the 2D overlays (plan footprint + box; profile blade silhouette).
  const resolvedFins = useMemo(() => (board ? resolveFins(board) : []), [board]);

  // Per-view trace-image interaction props for an EditorPane (outline / rocker).
  const traceProps = (view: TraceView) => ({
    background: trace.backgroundFor(view),
    traceInteractive: trace.activeView === view && trace.interactive,
    onTraceTransform: (t: SimilarityParams) => trace.commitTransform(view, t),
    calibration: trace.activeView === view ? trace.calibration : undefined,
    onCalibrationClick: trace.activeView === view ? trace.onCalibrationClick : undefined,
  });

  // Checked, not cast: an unknown value from a file would make the weight NaN.
  const foamType = FOAM_TYPES.find((f) => f === meta.foamType) ?? 'PU';
  const glassSchedule = GLASS_SCHEDULES.find((g) => g === meta.glassSchedule) ?? '4+4';
  // Weight estimate: specs.area (planshape area cm²) comes from the worker result —
  // same value as getArea(settledBoard) but without a redundant main-thread kernel call.
  const weight = useMemo(
    () =>
      specs
        ? estimateWeight(specs.volume / 1000, specs.area / 10000, foamType, glassSchedule)
        : null,
    [specs, foamType, glassSchedule],
  );

  // The depth of the NURBS board's bottom features, drawn as a strip across the rocker view.
  const features = useSyncExternalStore(sectionStore.subscribe, () =>
    nurbsSections ? sectionStore.getState().doc?.features : undefined,
  );
  const depthStrip = useMemo(
    () => (features ? depthSeries(features, units) : undefined),
    [features, units],
  );

  const overlaysFor = (kind: EditorKind): EditorOverlays => {
    const longitudinal = kind === 'outline' || kind === 'rocker';
    const verticalMarkers: { x: number; color: string; label?: string }[] = [];
    if (longitudinal && overlayToggles.com && specs)
      verticalMarkers.push({ x: specs.centerOfMass, color: '#22D3EE', label: 'CoM' });
    return {
      grid: overlayToggles.grid,
      curvatureComb: overlayToggles.comb,
      tunni: overlayToggles.tunni,
      verticalMarkers: verticalMarkers.length ? verticalMarkers : undefined,
      // Cross-pane "sliding location": the hovered board-x as a solid-inside / dashed
      // probe in every length-axis pane (the hovered pane included — it tracks the cursor).
      scrubProbe: longitudinal && scrubX != null ? scrubX : undefined,
      distribution: longitudinal ? volumeDist : undefined,
      // Gated on the toggle as well as the result: switching it off must hide the line
      // at once, not when (or if) the worker answers the request without it.
      apexHeight: kind === 'rocker' && overlayToggles.apex ? apexHeight : undefined,
      // Plan footprint + box on the outline; blade silhouette on the rocker (rail) view.
      fins:
        (kind === 'outline' || kind === 'rocker') && resolvedFins.length ? resolvedFins : undefined,
      finView: kind === 'rocker' ? 'profile' : 'plan',
      featureDepth: kind === 'rocker' ? depthStrip : undefined,
    };
  };

  // Read-only ghost splines per pane: the reference (ghost) board comparison, plus — for
  // the cross-section pane — the live interpolated section at the scrub x and faint
  // neighbour stations (fairing context).
  const probes = useProbes();
  const ghostSplinesFor = (kind: EditorKind): Spline[] | undefined => {
    const out: Spline[] = [];
    // A pane that shows both halves of an asymmetric board does not mirror its ghosts, so a ghost of a
    // symmetric thing (the classic ghost board) is drawn on both sides, and one of a half gets its own.
    const axis = kind === 'outline' ? 'y' : 'x';
    const both = (spline: Spline) => {
      out.push(spline);
      if (asymmetric) out.push(reflectSpline(spline, axis));
    };
    if (ghost) {
      if (kind === 'outline') both(ghost.outline);
      else if (kind === 'rocker') out.push(ghost.deck, ghost.bottom);
      else {
        const pos = board?.crossSections[clampedCs]?.position;
        if (pos !== undefined) {
          const cs = loftCrossSection(ghost, pos);
          if (cs) both(cs.spline);
        }
      }
    }
    if (kind === 'crossSection' && board) {
      // The two halves of a probed section: the minus one is drawn on the far side of the centre line.
      const probed = (p: { plus: readonly number[]; minus: readonly number[] | null }) => {
        out.push(probeSpline(p.plus));
        if (asymmetric && p.minus) out.push(reflectSpline(probeSpline(p.minus), 'x'));
      };
      if (sectionEngine.ready) {
        // The NURBS board: the sections the built surface really has (blend and all), from the
        // worker, at the selected station and under the scrub. While a scrub answer is on its way
        // the previous one stays (any probe that is not the station's), so the dashed line does not
        // flicker between pointer moves.
        const station = activeSectionX != null ? probeAt(probes, activeSectionX) : undefined;
        if (station) probed(station);
        const hovered = scrubX != null ? probes.find((p) => p.xi !== activeSectionX) : undefined;
        if (hovered) probed(hovered);
      } else if (scrubX != null) {
        // The lofted surface, so the section under the scrub reads the same here as it
        // does in the 3D view beside it.
        const preview = loftCrossSection(board, scrubX);
        if (preview) out.push(preview.spline);
      }
      // Adjacent real stations (skip the nose/tail dummies at 0 / last).
      const last = board.crossSections.length - 1;
      const prev = clampedCs - 1;
      const next = clampedCs + 1;
      const half = minusHalf(board);
      for (const i of [prev, next]) {
        if (i < 1 || i > last - 1) continue;
        out.push(board.crossSections[i]!.spline);
        const m = asymmetric && half ? half.crossSections[i]?.spline : undefined;
        if (m) out.push(reflectSpline(m, 'x'));
      }
    }
    return out.length ? out : undefined;
  };
  const ghostSpecs = useMemo(() => (ghost ? selectSpecs(ghost) : null), [ghost]);

  // Transient error notice (file-open / pop-up failures), auto-dismissed.
  const [toast, setToast] = useState<string | null>(null);
  // Info-only repairs: a persistent dismissible notice (not the 6s error toast).
  const [importNotice, setImportNotice] = useState<{
    title: string;
    messages: string[];
  } | null>(null);
  // Pending data-loss import awaiting user confirmation.
  const [pendingImport, setPendingImport] = useState<{
    fileName: string;
    dropped: ImportWarning[];
    info: ImportWarning[];
    commit: () => void;
  } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  /**
   * Transient notice, auto-dismissed. Mostly failures (file-open, pop-up
   * blocked), but Share reuses it to confirm a copy — same 6s toast either way.
   */
  const showToast = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  /**
   * Download the board as a native `.board` document. Shared by File > Save and
   * by the Share dialog, which offers it when a board is too large to link.
   */
  const saveBoardFile = () => {
    if (!board) return;
    // With the NURBS document open the file is the document (asymmetric halves, tail settings, bottom
    // features and all), not its classic projection; opening it tells the two kinds apart by version.
    const doc = sectionEngine.ready ? sectionStore.getState().doc : null;
    if (doc) {
      const done = (text: string) => {
        downloadBoardText(text, meta);
        track('save_board', { format: 'board' });
        markSave();
        setRecentBoards(getRecentBoards());
      };
      // At once when the file code is loaded (it starts loading with the document), so the download
      // stays inside the click; otherwise after the chunk arrives.
      const now = sectionsTextNow(doc, meta);
      if (now !== null) done(now);
      else
        void sectionsText(doc, meta).then(done, () =>
          showToast('Could not save the board: the NURBS engine could not be loaded.'),
        );
      return;
    }
    downloadBoard(board, meta);
    track('save_board', { format: 'board' });
    markSave();
    // downloadBoard records internally; refresh the menu's snapshot.
    setRecentBoards(getRecentBoards());
  };
  saveBoardFileRef.current = saveBoardFile;

  /** Open a print-friendly spec sheet (board info + dimensions) in a new tab. */
  const openSpecSheet = () => {
    if (!board) return;
    // Prefer the worker's specs, but fall back to a synchronous compute so the sheet
    // never depends on the worker having responded yet (selectSpecs is memoized).
    const sheetSpecs = specs ?? selectSpecs(board);
    if (!openHtmlInNewTab(specSheetHtmlFor(board, sheetSpecs, meta, units, board.fins))) {
      showToast('Pop-up blocked — allow pop-ups to open the spec sheet.');
    }
  };

  /**
   * Given a parsed import's warnings + the action that actually loads it, either
   * load immediately (showing an info notice if any), or stage a confirmation
   * when geometry was dropped.
   */
  const applyImport = (
    fileName: string,
    warnings: readonly ImportWarning[],
    commit: () => void,
  ) => {
    const { action, dropped, info } = decideImport(warnings);
    if (action === 'confirm') {
      setPendingImport({ fileName, dropped, info, commit });
      return;
    }
    commit();
    setImportNotice(importedNotice(info));
  };

  /**
   * Open a NURBS document as the board (an opened file, a share link, a recent board). With the engine on
   * it loads at once; with it off the person is asked (`NurbsOpenPrompt`): turn the engine on and open it,
   * or open a classic copy.
   */
  const [pendingSections, setPendingSections] = useState<SectionsOpen | null>(null);
  const commitSections = (o: SectionsOpen) => {
    openSectionDoc(o.doc);
    hydrated.current = true;
    const m = metaOfDoc(o.doc.meta);
    setMeta(m);
    void sectionsText(o.doc, m).then(
      (text) => {
        recordRecentBoard(o.recentName, text);
        setRecentBoards(getRecentBoards());
      },
      () => {},
    );
    o.onOpened?.();
  };
  const openClassicCopy = (o: SectionsOpen) => {
    boardStore.getState().load(projectDoc(o.doc));
    hydrated.current = true;
    setMeta(metaOfDoc(o.doc.meta));
    showToast(
      'Opened a classic copy of the NURBS board. The file is not changed; saving writes a classic file.',
    );
    o.onOpened?.();
  };
  const openSections = (o: SectionsOpen) => {
    if (nurbsEngine) commitSections(o);
    else setPendingSections(o);
  };
  /** Revive a parsed NURBS document and open it; the reasons are a toast when it is not one. */
  const openSectionsJson = async (json: unknown, o: Omit<SectionsOpen, 'doc'>, label: string) => {
    const r = await prepareSectionDoc(json);
    if (!r.ok) {
      showToast(`Could not open ${label}: ${r.error}`);
      if (!boardStore.getState().board) loadSample();
      return false;
    }
    openSections({ ...o, doc: r.doc });
    return true;
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const onOpenFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-opening the same file
    if (!file) return;
    // Record in the recent list under the file's base name (extension stripped).
    const baseName = file.name.replace(/\.(board\.json|json|board|brd|s3dx|s3d|srf)$/i, '');
    try {
      const { board, meta, warnings } = await openBoardFile(file);
      const commit = () => {
        boardStore.getState().load(board);
        setMeta(meta);
        // Record in the recent list. Re-serialise to canonical .board.json so the snapshot
        // is always in the native format regardless of the source format (.brd etc.)
        const metadata =
          meta && Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined;
        recordRecentBoard(baseName, writeBoardJson(board, metadata));
        setRecentBoards(getRecentBoards());
      };
      // Import is the on-ramp from legacy BoardCAD and was previously
      // unmeasured in both directions. Counts only: `ImportWarning` carries a
      // free-text `message` with line numbers and positions interpolated in,
      // which would be a useless high-cardinality breakdown. Giving the type a
      // stable `code` in @openshaper/io is the follow-up that would make
      // warning *kinds* analysable. The file name is never sent — user content.
      track('board_imported', {
        source: sourceExtension(file.name),
        warning_count: warnings.length,
        dropped_count: warnings.filter((w) => w.severity === 'dropped').length,
      });
      markImport();
      applyImport(file.name, warnings, commit);
    } catch (err) {
      if (err instanceof SectionsFileError) {
        // A NURBS document: nothing is dropped or repaired, so there is no import warning to weigh.
        if (await openSectionsJson(err.json, { recentName: baseName }, file.name)) {
          track('board_imported', {
            source: sourceExtension(file.name),
            warning_count: 0,
            dropped_count: 0,
          });
          markImport();
        }
        return;
      }
      console.error('Failed to open board', err);
      // A visitor who cannot open their own board is the worst outcome in the
      // app, and until now it failed silently as far as analytics went.
      track('import_failed', {
        source: sourceExtension(file.name),
        reason: (err as Error).message.slice(0, 200),
      });
      showToast(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };

  const ghostInput = useRef<HTMLInputElement>(null);
  const onOpenGhost = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { board, warnings } = await openBoardFile(file);
      applyImport(file.name, warnings, () => setGhost(board));
    } catch (err) {
      if (err instanceof SectionsFileError) {
        // A NURBS board as the comparison: its classic projection (the lines and the stations).
        const r = await prepareSectionDoc(err.json);
        if (r.ok) setGhost(projectDoc(r.doc));
        else showToast(`Could not open ${file.name}: ${r.error}`);
        return;
      }
      console.error('Failed to open ghost board', err);
      showToast(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };

  // New board from a type template — loads the authentic legacy .brd geometry.
  const newFromTemplate = (name: string) => {
    if (nurbsEngine) {
      void newFromNurbsTemplate(name);
      return;
    }
    const t = BOARD_TEMPLATES.find((x) => x.name === name);
    if (!t) return;
    try {
      const { board: tBoard } = parseBrd(t.brd);
      boardStore.getState().load(tBoard);
      setMeta({ model: t.name });
      setGhost(null);
      // Record the template load so it appears in the recent-boards list.
      recordRecentBoard(t.name, writeBoardJson(tBoard, { model: t.name }));
      setRecentBoards(getRecentBoards());
      track('template_loaded', { template: t.name });
      markTemplate();
    } catch (err) {
      console.error('Failed to load template', err);
      // Also a bundled .brd of ours, and the only failure here with no visible
      // message at all: the click simply does nothing.
      captureError('template_load', err);
    }
  };

  /** The same templates with the NURBS engine on: documents of the section model, opened as they are. */
  const newFromNurbsTemplate = async (name: string) => {
    const t = NURBS_TEMPLATES.find((x) => x.name === name);
    if (!t) return;
    try {
      const text = await t.load();
      const opened = await openSectionsJson(
        JSON.parse(text) as unknown,
        {
          recentName: t.name,
          onOpened: () => {
            setGhost(null);
            track('template_loaded', { template: t.name });
            markTemplate();
          },
        },
        t.name,
      );
      if (!opened) captureError('template_load', new Error(`NURBS template ${t.name}`));
    } catch (err) {
      console.error('Failed to load template', err);
      captureError('template_load', err);
      showToast(`Could not load the ${t.name} template.`);
    }
  };

  /** Load a board that was previously recorded in the recent list. */
  const loadFromRecent = async (entry: { name: string; boardJson: string }, position: number) => {
    try {
      const file = readBoardText(entry.boardJson);
      if (file.kind === 'sections') {
        await openSectionsJson(
          file.json,
          {
            recentName: entry.name,
            onOpened: () => {
              setGhost(null);
              track('recent_board_opened', { position });
            },
          },
          entry.name,
        );
        return;
      }
      const { board: rBoard, metadata } = file;
      boardStore.getState().load(rBoard);
      setMeta(toBoardMeta(metadata));
      setGhost(null);
      // Refresh the recent list so this entry bubbles to top (re-record updates savedAt).
      recordRecentBoard(entry.name, entry.boardJson);
      setRecentBoards(getRecentBoards());
      // The only return-visitor signal available on the anonymous baseline:
      // the recent list lives in localStorage, so reopening from it proves a
      // repeat visit without any persistent analytics identity. Retention
      // insights can't see this. The board name is deliberately omitted — it's
      // user content; position alone says whether the list is browsed or only
      // ever used for the newest entry.
      track('recent_board_opened', { position });
    } catch (err) {
      console.error('Failed to load recent board', err);
      // Written by us into localStorage and unreadable on the way back out.
      captureError('recent_board', err);
      showToast(`Could not reload "${entry.name}": ${(err as Error).message}`);
    }
  };

  /**
   * Open a shared board as the working document.
   *
   * Presentation is reset rather than inherited: the sender's framing, camera
   * and selected station are artifacts of their editing session, not a view of
   * the board. The recipient's own units and 3D appearance settings are left
   * alone — those are preferences, not state belonging to this board.
   */
  const adoptSharedBoard = async (file: BoardFile) => {
    if (file.kind === 'sections') {
      // A NURBS board: the same open as a file, then the same fresh presentation.
      clearSharedPayload();
      setPendingShare(null);
      const name = sectionsName(file.json);
      await openSectionsJson(
        file.json,
        {
          recentName: name ? `${name} (shared)` : 'Shared board',
          onOpened: () => {
            setGhost(null);
            presentSharedBoard();
          },
        },
        'the shared board',
      );
      return;
    }
    const sMeta = toBoardMeta(file.metadata);
    const sBoard = file.board;
    // load() resets past/future, so undo cannot reach back past a board that
    // was never edited here.
    boardStore.getState().load(sBoard);
    setMeta(sMeta);
    // Clearing the state is not enough on its own — the autosave that follows
    // rewrites the session record without ghostJson, so a reload cannot
    // resurrect a comparison board belonging to the previous workspace.
    setGhost(null);

    const model = sMeta.model?.trim();
    // The suffix is a display name for the recent list only; meta.model itself
    // is untouched. Two shared boards with the same model collide and the newer
    // replaces the older — the same de-duplication every other entry gets.
    recordRecentBoard(
      model ? `${model} (shared)` : 'Shared board',
      writeBoardJson(sBoard, file.metadata),
    );
    setRecentBoards(getRecentBoards());
    presentSharedBoard();
  };
  /** What opening a shared board resets, whichever kind it is (it needs the board to be open already). */
  const presentSharedBoard = () => {
    const sBoard = boardStore.getState().board;
    // A share link never carries a trace, so the recipient's own trace would
    // otherwise sit under a stranger's outline. Hidden, not deleted.
    trace.hideAll();

    setPickedView('quad');
    if (sBoard) setCsIndex(nearestMidpointSection(sBoard));
    // Drop any restored framing so the panes fit this board, not the last one.
    pendingViews2d.current = {};
    liveViewState.current = { ...liveViewState.current, views2d: {} };
    delete liveViewState.current.camera3d;
    setCameraEpoch((n) => n + 1);
    setFitEpoch((n) => n + 1);
    scheduleViewSave();

    hydrated.current = true;
    clearSharedPayload();
    setPendingShare(null);
    showToast('Shared board opened as an editable copy. Changes stay in this browser.');
    // Count only — see docs/design/analytics.md.
    track('shared_board_opened');
  };
  // The mount effect closes over the first render, and it is the one caller
  // that cannot simply be re-created: route the call through a ref so it always
  // runs the current closure.
  const adoptRef = useRef(adoptSharedBoard);
  adoptRef.current = adoptSharedBoard;

  const traceInput = useRef<HTMLInputElement>(null);
  // Which view a just-opened file picker targets (File menu / Sidebar share the input).
  const pendingTraceView = useRef<TraceView>('outline');
  // Refs only, so it is stable — the memoized Sidebar receives it.
  const openTracePicker = useCallback((view: TraceView) => {
    pendingTraceView.current = view;
    traceInput.current?.click();
  }, []);
  const onOpenTrace = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Distinctive feature (shape from a photo) with zero visibility until now.
    // Only the target view is sent — never the image or its name.
    track('trace_image_loaded', { target: pendingTraceView.current });
    trace.loadImage(pendingTraceView.current, file, board ? getLength(board) : 0);
  };

  const tab = (v: View, label: string) => (
    <Button size="sm" variant={view === v ? 'secondary' : 'ghost'} onClick={() => selectView(v)}>
      {label}
    </Button>
  );

  // A station inside a swallow or fish notch is cut across the rail (a chord from the stringer to the
  // outline), not across the board: say so, so the shape is not mistaken for a plain section.
  const csDoc = sectionEngine.ready ? sectionStore.getState().doc : null;
  const inNotch =
    csDoc !== null &&
    csDoc.tail.kind === 'notched' &&
    activeSectionX !== null &&
    activeSectionX < csDoc.outline.plus.knots[0]!.p[0] + csDoc.tail.zone;
  const csTitle = inNotch ? 'Cross-section (rail section)' : 'Cross-section';

  const csControls = (
    <CrossSectionControls
      index={clampedCs}
      total={lastReal}
      onPrev={() => setCsIndex(clampedCs - 1)}
      onNext={() => setCsIndex(clampedCs + 1)}
      onAdd={addSection}
      onDelete={deleteSection}
      onCopy={copySection}
      onPaste={pasteSection}
      canPaste={!!csClipboard}
      positionCm={
        board?.crossSections[clampedCs]
          ? longitudinal.toDisplay(board.crossSections[clampedCs]!.position)
          : null
      }
      positionMark={longitudinal.mark}
      units={units}
      onMoveTo={(position) => moveSection(clampedCs, longitudinal.toModel(position))}
    />
  );

  const interp = board?.interpolationType ?? 'controlPoint';

  const fileMenu: MenuItem[] = [
    { kind: 'label', label: 'New' },
    // With the NURBS engine on the chooser lists the documents of the section model (the same three boards,
    // already converted, and the swallow and fish shortboards); otherwise the classic templates.
    ...(nurbsEngine ? NURBS_TEMPLATES : BOARD_TEMPLATES).map((t) => ({
      kind: 'action' as const,
      label: t.name,
      onSelect: () => newFromTemplate(t.name),
    })),
    { kind: 'separator' },
    { kind: 'action', label: 'Open…', onSelect: () => fileInput.current?.click() },
    {
      kind: 'action',
      label: 'Save',
      shortcut: 'Ctrl S',
      disabled: !board,
      onSelect: saveBoardFile,
    },
    // Reaches the command palette for free — it derives from these menus.
    {
      kind: 'action',
      label: 'Share…',
      disabled: !board,
      onSelect: () => setShareOpen(true),
    },
    { kind: 'separator' },
    // Open recent: one named entry per recorded board, newest first.
    ...(recentBoards.length > 0
      ? ([
          { kind: 'label', label: 'Open recent' } as MenuItem,
          ...recentBoards.map((e, i) => ({
            kind: 'action' as const,
            label: e.name,
            onSelect: () => void loadFromRecent(e, i),
          })),
          { kind: 'separator' } as MenuItem,
          {
            kind: 'action' as const,
            label: 'Clear recent',
            onSelect: () => {
              clearRecentBoards();
              setRecentBoards([]);
            },
          },
          { kind: 'separator' } as MenuItem,
        ] satisfies MenuItem[])
      : []),
    { kind: 'action', label: 'Load trace image…', onSelect: () => openTracePicker('outline') },
  ];

  // STEP cannot describe a concave (swallow / fish) tail yet, so the item is
  // disabled with the reason rather than silently emitting a solid with the notch
  // filled in.
  const stepSupport = board ? stepExportSupport(board) : null;

  const exportMenu: MenuItem[] = [
    ...(
      [
        ['stl', 'STL'],
        ['dxf', 'DXF (polyline)'],
        ['dxf-spline', 'DXF (spline)'],
      ] as [ExportFormat, string][]
    ).map(([f, label]) => ({
      kind: 'action' as const,
      label,
      disabled: !board,
      onSelect: () => {
        if (!board) return;
        exportBoard(board, f, meta, units, ghost ?? undefined);
        track('export_board', { format: f });
        markExport();
      },
    })),
    {
      kind: 'action',
      label: 'STEP (surfaces)…',
      disabled: !board || stepSupport?.ok === false,
      title: stepSupport?.ok === false ? stepSupport.reason : undefined,
      onSelect: () => setStepDialogOpen(true),
    },
    {
      kind: 'action',
      label: 'PDF 1:1…',
      disabled: !board,
      onSelect: () => setPdfDialogOpen(true),
    },
    {
      kind: 'action',
      label: 'Rail bands…',
      disabled: !board,
      onSelect: () => {
        // Opening is interest, exporting is use; the gap between the two is the signal —
        // the same pair `hws_template_opened` / `hws_template_exported` measures. It
        // matters more here than for a one-click format, because this dialog asks the
        // shaper to choose a marking mode before it will give them anything.
        track('rail_bands_opened');
        setRailBandsDialogOpen(true);
      },
    },
    {
      kind: 'action',
      label: 'Spec sheet…',
      disabled: !board,
      onSelect: () => {
        track('spec_sheet_opened');
        openSpecSheet();
      },
    },
    { kind: 'separator' },
    { kind: 'label', label: 'Templates' },
    {
      kind: 'action',
      label: 'Hollow Wood Frame…',
      disabled: !board,
      onSelect: () => {
        // Templating is the roadmap phase currently in progress, and shipped
        // with no instrumentation at all. This is the ship-or-cut signal for
        // the work in flight.
        track('hws_template_opened');
        setTemplateKind('hws');
      },
    },
    { kind: 'separator' },
    {
      kind: 'action',
      label: 'Legacy .brd',
      disabled: !board,
      onSelect: () => {
        if (!board) return;
        downloadBrd(board, meta);
        track('save_board', { format: 'brd' });
        markSave();
      },
    },
  ];

  const editMenu: MenuItem[] = [
    {
      kind: 'action',
      label: 'Undo',
      shortcut: 'Ctrl Z',
      disabled: !canUndo,
      onSelect: () => activeStore.getState().undo(),
    },
    {
      kind: 'action',
      label: 'Redo',
      shortcut: 'Ctrl Y',
      disabled: !canRedo,
      onSelect: () => activeStore.getState().redo(),
    },
    { kind: 'separator' },
    {
      kind: 'action',
      label: 'Settings…',
      onSelect: () => setSettingsOpen(true),
    },
  ];

  const viewMenu: MenuItem[] = [
    { kind: 'label', label: 'Overlays' },
    {
      kind: 'checkbox',
      label: 'Grid & guides',
      checked: overlayToggles.grid,
      onSelect: () => toggleOverlay('grid'),
    },
    {
      kind: 'checkbox',
      label: 'Curvature comb',
      checked: overlayToggles.comb,
      onSelect: () => toggleOverlay('comb'),
    },
    {
      kind: 'checkbox',
      label: 'Center of mass',
      checked: overlayToggles.com,
      onSelect: () => toggleOverlay('com'),
    },
    {
      kind: 'checkbox',
      label: 'Volume distribution',
      checked: overlayToggles.dist,
      onSelect: () => toggleOverlay('dist'),
    },
    {
      kind: 'checkbox',
      label: 'Apex height',
      checked: overlayToggles.apex,
      onSelect: () => toggleOverlay('apex'),
    },
    {
      kind: 'checkbox',
      label: 'Tunni controls',
      checked: overlayToggles.tunni,
      onSelect: () => toggleOverlay('tunni'),
    },
    { kind: 'separator' },
    { kind: 'label', label: 'Zoom' },
    {
      kind: 'action' as const,
      label: 'Fit view',
      onSelect: () => sendViewCmd('fit'),
    },
    {
      kind: 'action' as const,
      label: 'Life-size (1:1)',
      onSelect: () => sendViewCmd('lifeSize'),
    },
    { kind: 'separator' },
    { kind: 'label', label: 'Units' },
    ...LENGTH_UNITS.map((u) => ({
      kind: 'checkbox' as const,
      label: u.label,
      checked: unitKey === u.key,
      onSelect: () => {
        setUnitKey(u.key);
        // Imperial vs metric vs fractional inches is the clearest read on who
        // the audience actually is — a US shaper working in fractions wants
        // different defaults from a European one in millimetres.
        track('units_changed', { units: u.key });
      },
    })),
  ];

  const boardMenu: MenuItem[] = [
    { kind: 'action', label: 'Resize…', onSelect: openResize },
    { kind: 'separator' },
    ghost
      ? { kind: 'action', label: 'Clear ghost', onSelect: () => setGhost(null) }
      : { kind: 'action', label: 'Open ghost…', onSelect: () => ghostInput.current?.click() },
    // The interpolation model is a classic-engine setting: NURBS sections always blend smoothly.
    ...(sectionEngine.ready
      ? []
      : ([
          { kind: 'separator' },
          // The model drives the integrated specs (volume / CoM / distribution); the 2D/3D
          // previews always render the control-point surface (see kernel InterpolationType).
          { kind: 'label', label: 'Interpolation' },
          {
            kind: 'checkbox',
            label: 'Control point',
            checked: interp === 'controlPoint',
            onSelect: () => activeStore.getState().setInterpolationType('controlPoint'),
          },
          {
            kind: 'checkbox',
            label: 'S-blend',
            checked: interp === 'sLinear',
            onSelect: () => activeStore.getState().setInterpolationType('sLinear'),
          },
        ] satisfies MenuItem[])),
  ];

  const helpMenu: MenuItem[] = [
    {
      kind: 'action',
      label: 'Documentation',
      onSelect: () => {
        window.location.href = '/docs';
      },
    },
    {
      kind: 'action',
      label: 'Keyboard shortcuts',
      onSelect: () => {
        window.location.href = '/docs/shortcuts';
      },
    },
    { kind: 'separator' },
    {
      kind: 'action',
      label: 'About & guides',
      onSelect: () => {
        window.location.href = '/about';
      },
    },
    ...(SUPPORT_URL
      ? [
          {
            kind: 'action' as const,
            label: 'Buy me a coffee',
            onSelect: () => window.open(SUPPORT_URL, '_blank', 'noopener'),
          },
        ]
      : []),
  ];

  // The exact curvature modes read the fitted surface, which a concave tail does not
  // have; the controls list them disabled with the reason, as the STEP item is. The
  // deviation map likewise needs a ghost to measure against.
  // A saved "Deviation from classic" means nothing without the NURBS engine: it is
  // ignored (not erased) until the engine is on again.
  const view3dShown = useMemo(
    () => ({ ...view3d, analysis: effectiveAnalysis(view3d.analysis, nurbsEngine) }),
    [view3d, nurbsEngine],
  );
  const exactUnavailable = exactAnalysisUnavailable(board);
  const ghostUnavailable = ghostDeviationUnavailable(ghost);

  // One 3D pane element and one set of 2D pane props, shared by the quad/split layout
  // and the single-view layout so the two cannot drift apart.
  const threeDPane = (
    <ThreeDPane
      store={activeStore}
      mode={view3d.mode}
      lighting={view3d.lighting}
      material={view3d.material}
      color={view3d.color}
      finColor={settings.finColor}
      viewCubeLineColor={settings.outlineColor}
      analysis={view3dShown.analysis}
      ghost={ghost}
      deviationBand={view3d.deviationBand}
      units={units}
      nurbsEngine={nurbsEngine}
      targetFaceSize={faceSizeFor(view3d.meshQuality)}
      showStringer={view3d.showStringer}
      showSections={view3d.showSections}
      showApex={view3d.showApex}
      activeSectionX={activeSectionX}
      key={cameraEpoch}
      initialCamera={liveViewState.current.camera3d}
      onCameraChange={onCameraChange}
    />
  );

  const editorPaneProps = (kind: EditorKind) => ({
    title: kind === 'outline' ? 'Outline' : kind === 'rocker' ? 'Rocker (deck + bottom)' : csTitle,
    kind,
    csIndex: clampedCs,
    asymmetric,
    units,
    longitudinal,
    // The cross-section pane has no length axis, so `EditorPane` drops the station
    // markers, the scrub and the trace props for it — passing them uniformly here
    // keeps that one decision in one place.
    sectionMarkers,
    onPickSection: setCsIndex,
    focusedSection,
    onFocusSection: focusSection,
    onMoveSection: moveSection,
    onDeleteSection: deleteSectionAt,
    onAddSectionAt: addSectionAt,
    onScrub: scrubSection,
    overlays: overlaysFor(kind),
    onTunniChange: setTunniOverlay,
    ghostSplines: ghostSplinesFor(kind),
    ...(kind === 'crossSection' ? {} : traceProps(kind)),
    headerActions: kind === 'crossSection' ? csControls : undefined,
    settings,
    viewCommand: viewCmd,
    initialView: pendingViews2d.current[kind],
    onViewChange: reportPaneView(kind),
  });

  /**
   * One pane of a multi-pane layout. Quad and Split show the same panes with the
   * same wiring — the layout decides only how many there are and, through
   * `titleControl`, whether the heading names the pane or picks it.
   */
  const layoutPane = (kind: SplitPaneKind, titleControl?: React.ReactNode) => {
    if (kind === '3d')
      return (
        <Panel key="3d" className="flex min-h-0 flex-col">
          <ViewPaneHeader className="flex items-center justify-between gap-2">
            {titleControl ?? (
              <ViewToggleTitle onDoubleClick={() => selectView('3d')}>3D</ViewToggleTitle>
            )}
            <ThreeDControls
              settings={view3dShown}
              onChange={patchView3d}
              units={units}
              exactUnavailable={exactUnavailable}
              ghostUnavailable={ghostUnavailable}
              nurbsEngine={nurbsEngine}
              compact
            />
          </ViewPaneHeader>
          <PanelBody className="min-h-0 flex-1 p-0">{threeDPane}</PanelBody>
        </Panel>
      );
    return (
      <EditorPane
        key={kind}
        {...editorPaneProps(kind)}
        titleControl={titleControl}
        // In Split the heading is the pane picker, so there is no title left to
        // double-click — and no single sensible target for it either.
        onTitleDoubleClick={titleControl ? undefined : () => selectView(kind)}
      />
    );
  };

  // The four quad panes, arranged either as a 2×2 grid (desktop) or a vertical
  // scrolling stack (compact) — the panes themselves are identical in both. Only
  // built for the view that uses them: the phone tier never offers quad, and this
  // array carries the lazy 3D panel.
  const quadPanes =
    view !== 'quad'
      ? []
      : (['outline', 'crossSection', 'rocker', '3d'] as const).map((kind) => layoutPane(kind));

  // Built per mount: only the desktop one offers the fold-to-rail control, since the
  // sheet's snap points already are its collapse.
  const sidebarFor = (collapsible: boolean) => (
    <Sidebar
      collapsible={collapsible}
      nurbsEngine={sectionEngine.ready}
      specs={specs}
      units={units}
      resize={resize}
      setResize={setResize}
      applyResize={applyResize}
      resizeFormRef={resizeForm}
      meta={meta}
      setMeta={setMeta}
      foamType={foamType}
      glassSchedule={glassSchedule}
      weight={weight}
      trace={trace}
      onLoadTrace={openTracePicker}
      overlayToggles={overlayToggles}
      setOverlay={setOverlay}
      ghost={!!ghost}
      ghostSpecs={ghostSpecs}
      sidebar={sidebar}
      onSidebarChange={setSidebar}
      onUnitChange={isPhone ? setUnitKey : undefined}
      longitudinal={longitudinal}
      onMeasurementAxisChange={isPhone ? setMeasurementAxis : undefined}
    />
  );

  // Collapsed-sheet header: headline dimensions + volume, always visible on mobile.
  const sheetPeek = specs ? (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate font-mono text-[13px] tabular-nums text-foreground">
        {fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units)}
      </span>
      <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">
        {fmtVol(specs.volume)}
      </span>
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">Board panels</span>
  );

  // The Show tips setting reaches every tooltip by context: the memoised panels
  // that render tooltips are not re-rendered or rethreaded when it changes.
  const shell = (
    <div className="flex h-full flex-col">
      {/* Two 44px rows cost 88px, which is 23% of a landscape phone. Where height
          is the scarce axis they sit side by side as one 44px row instead — the
          wordmark and the Coffee link drop out to make the width work. */}
      <div
        className={cn(
          'flex border-b border-border bg-card text-card-foreground',
          isShort ? 'items-center' : 'flex-col',
        )}
      >
        {/* Row 1 — application menubar */}
        <div className="flex h-11 shrink-0 items-center gap-1 px-1.5 sm:gap-2 sm:px-2">
          <a
            href="/"
            className="group flex items-center gap-2 px-1.5 font-semibold transition-colors hover:text-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
            title="OpenShaper home"
            // The wordmark beside the brandmark is `hidden sm:inline`, so below 640px
            // this link has no text content at all and `title` was its only name.
            aria-label="OpenShaper home"
          >
            <Brandmark className="h-6 w-6 transition-transform duration-300 group-hover:rotate-3" />
            {!isShort && (
              <span className="hidden sm:inline">
                Open<span className="text-primary">Shaper</span>
              </span>
            )}
          </a>
          <ToolbarSeparator className="hidden sm:block" />
          {/* Phones: a single button opens the command palette, which lists every menu
              action. Tablets and up get the full menubar. */}
          <HelpTooltip label="Menu and commands" helpId="toolbar:menu">
            <Button
              size="sm"
              variant="ghost"
              className="sm:hidden"
              aria-label="Menu and commands"
              onClick={togglePalette}
            >
              <MenuIcon className="size-4" />
            </Button>
          </HelpTooltip>
          <MenuBar className="hidden sm:flex">
            <Menu label="File" items={fileMenu} />
            <Menu label="Edit" items={editMenu} />
            <Menu label="View" items={viewMenu} />
            <Menu label="Board" items={boardMenu} />
            <Menu label="Export" items={exportMenu} />
            <Menu label="Help" items={helpMenu} />
          </MenuBar>
          {/* Sharing is the one action aimed at someone who is not in the room,
              so it gets a button of its own rather than living only in a menu.
              The label drops below sm, where the menubar is a hamburger. */}
          <HelpTooltip label="Share this board as a link" helpId="toolbar:share">
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              disabled={!board}
              aria-label="Share board"
              onClick={() => setShareOpen(true)}
            >
              <Share2 className="size-4" />
              <span className="hidden sm:inline">Share</span>
            </Button>
          </HelpTooltip>
          {!isShort && <div className="flex-1" />}
          {SUPPORT_URL && !isShort && (
            <a
              href={SUPPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'hidden text-primary hover:text-primary sm:inline-flex',
              )}
              title="Buy me a coffee — OpenShaper is free & open-source"
            >
              <CoffeeIcon className="size-4" />
              Coffee
            </a>
          )}
        </div>

        {/* Row 2 — view tabs. The tabs scroll horizontally on narrow screens while the
            unit selector and (mobile) Panels toggle stay pinned to the right. */}
        <div
          className={cn(
            'flex h-11 min-w-0 flex-1 items-center gap-1 px-2',
            isShort ? 'border-l border-border' : 'border-t border-border',
          )}
        >
          <div
            role="group"
            aria-label="Views"
            className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            {views.map((v) => (
              <Fragment key={v.view}>{tab(v.view, v.tabLabel)}</Fragment>
            ))}
          </div>
          {/* On a phone this row has no room for it — it moves into the sheet,
              where the current unit stays visible next to the dimensions it
              formats. See `UnitSelect`. */}
          {!isPhone && (
            <div className="flex shrink-0 items-center gap-1">
              <UnitSelect value={unitKey} onChange={setUnitKey} />
              <MeasurementAxisSelect value={measurementAxis} onChange={setMeasurementAxis} />
            </div>
          )}
          {/* Below lg the sidebar lives in a bottom sheet; this opens it. Gated on the
              tier rather than `lg:hidden` so it is not merely invisible on desktop: it
              names the same action as the rail's own control, and two mounted buttons
              claiming it is one ambiguity for assistive tech and one for tests. */}
          {!isDesktop && (
            <HelpTooltip
              label={panelsShowing ? 'Hide board panels' : 'Show board panels'}
              helpId="toolbar:panels"
            >
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                aria-label={panelsShowing ? 'Hide board panels' : 'Show board panels'}
                onClick={() => setSheetSnap(panelsShowing ? 'closed' : 'half')}
              >
                <SlidersHorizontal className="size-4" />
              </Button>
            </HelpTooltip>
          )}
        </div>

        <LandscapeHint />

        {/* Hidden file inputs. The trace input is shared by the File menu + Sidebar,
            targeting whichever view `openTracePicker` last set on `pendingTraceView`. */}
        <input
          ref={fileInput}
          type="file"
          accept=".board,.board.json,.json,.brd,.s3d,.s3dx,.srf"
          className="hidden"
          onChange={onOpenFile}
        />
        <input
          ref={traceInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onOpenTrace}
        />
        <input
          ref={ghostInput}
          type="file"
          accept=".board,.board.json,.json,.brd,.s3d,.s3dx,.srf"
          className="hidden"
          onChange={onOpenGhost}
        />
      </div>

      {/* pb clears the bottom sheet, which is fixed over the viewport bottom on
          compact layouts. It belongs here rather than on the quad column: every
          view needs it, and a maximized pane was running 99px underneath. */}
      <div className={cn('flex min-h-0 flex-1 gap-3 p-3', sheetOpen && 'pb-28')}>
        <div className="min-h-0 min-w-0 flex-1">
          {view === 'quad' ? (
            isDesktop ? (
              <div className="grid h-full grid-cols-2 grid-rows-2 gap-3">{quadPanes}</div>
            ) : (
              // Compact: a single scrolling column, each pane a comfortable fixed
              // height. Clearance for the sheet lives on the container above.
              <div className="flex h-full flex-col gap-3 overflow-y-auto">
                {quadPanes.map((pane, i) => (
                  <div
                    key={i}
                    className="grid h-[68vw] max-h-[28rem] min-h-64 min-w-0 shrink-0 overflow-hidden"
                  >
                    {pane}
                  </div>
                ))}
              </div>
            )
          ) : view === 'split' ? (
            // Two full-width panes, one above the other. Both halves keep the
            // board's length axis running the same way across the window, which
            // is the whole point of stacking rather than sitting side by side:
            // outline over rocker reads as one drawing.
            <div className="grid h-full grid-rows-2 gap-3">
              {layoutPane(
                split.top,
                <SplitPaneSelect
                  slot="Top"
                  value={split.top}
                  onChange={(k) => setSplitPane('top', k)}
                />,
              )}
              {layoutPane(
                split.bottom,
                <SplitPaneSelect
                  slot="Bottom"
                  value={split.bottom}
                  onChange={(k) => setSplitPane('bottom', k)}
                />,
              )}
            </div>
          ) : view === '3d' ? (
            <Panel className="flex h-full flex-col">
              <ViewPaneHeader className="flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <ViewToggleTitle onDoubleClick={() => selectView('quad')}>3D</ViewToggleTitle>
                  <span className="text-xs text-muted-foreground">
                    drag to orbit • scroll to zoom
                  </span>
                </div>
                <ThreeDControls
                  settings={view3dShown}
                  onChange={patchView3d}
                  units={units}
                  exactUnavailable={exactUnavailable}
                  ghostUnavailable={ghostUnavailable}
                  nurbsEngine={nurbsEngine}
                />
              </ViewPaneHeader>
              <PanelBody className="min-h-0 flex-1 p-0">{threeDPane}</PanelBody>
            </Panel>
          ) : (
            <EditorPane {...editorPaneProps(view)} onTitleDoubleClick={() => selectView('quad')} />
          )}
        </div>

        {/* Desktop: sidebar beside the viewport. Compact: it moves into a bottom sheet. */}
        {isDesktop && sidebarFor(true)}
      </div>

      {!isDesktop && (
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={setSheetSnap}
          peek={sheetPeek}
          canClose={isPhone}
        >
          {sidebarFor(false)}
        </BottomSheet>
      )}

      {toast && <Toast onClick={() => setToast(null)}>{toast}</Toast>}

      {pendingImport && (
        <ImportWarningsDialog
          fileName={pendingImport.fileName}
          dropped={pendingImport.dropped}
          info={pendingImport.info}
          onCancel={() => setPendingImport(null)}
          onImportAnyway={() => {
            pendingImport.commit();
            setImportNotice(importedNotice(pendingImport.info));
            setPendingImport(null);
          }}
        />
      )}

      {engineNotice && (
        <Toast onClick={() => setEngineNotice(null)} data-testid="engine-refusal">
          <span className="font-medium">
            The NURBS engine cannot hold this board, so the classic editor is shown:
          </span>{' '}
          {engineNotice.map((m, i) => (
            <span key={i} className="block">
              {m}
            </span>
          ))}
        </Toast>
      )}

      {importNotice && (
        <Toast onClick={() => setImportNotice(null)}>
          <span className="font-medium">{importNotice.title}</span>{' '}
          {importNotice.messages.join(' · ')}
        </Toast>
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commandsFromMenus(
            [
              ['File', fileMenu],
              ['Edit', editMenu],
              ['View', viewMenu],
              ['Board', boardMenu],
              ['Export', exportMenu],
              ['Help', helpMenu],
            ],
            commandHelp,
          )}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {heldPrompt && !nurbsEngine && (
        <Toast onClick={() => setHeldPrompt(false)}>
          This session has a NURBS board, and the NURBS engine is off.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => handleSaveSettings({ ...settings, nurbsEngine: true })}
          >
            Turn the NURBS engine on to keep editing it
          </button>
        </Toast>
      )}

      {pendingSections && (
        <NurbsOpenPrompt
          name={pendingSections.doc.meta.name || undefined}
          onTurnOn={() => {
            handleSaveSettings({ ...settings, nurbsEngine: true });
            commitSections(pendingSections);
            setPendingSections(null);
          }}
          onOpenCopy={() => {
            openClassicCopy(pendingSections);
            setPendingSections(null);
          }}
          onCancel={() => {
            setPendingSections(null);
            // a link into an empty browser has nothing else to show
            if (!boardStore.getState().board) loadSample();
          }}
        />
      )}

      {pendingShare && (
        <SharedBoardPrompt
          model={
            pendingShare.kind === 'sections'
              ? sectionsName(pendingShare.json)
              : toBoardMeta(pendingShare.metadata).model
          }
          onKeepCurrent={() => {
            // The shared board never entered the store, so declining is a
            // no-op beyond forgetting it.
            clearSharedPayload();
            setPendingShare(null);
          }}
          onOpenShared={() => void adoptSharedBoard(pendingShare)}
        />
      )}

      {shareOpen && board && (
        <ShareDialog
          board={board}
          sections={sectionEngine.ready ? sectionStore.getState().doc : null}
          meta={meta}
          setMeta={setMeta}
          onCopied={() => {
            setShareOpen(false);
            showToast('Share link copied');
            // Count only. No property here may derive from the URL, the board,
            // its metadata or its dimensions — see docs/design/analytics.md.
            track('share_link_copied');
          }}
          onDownloadBoard={saveBoardFile}
          onClose={() => setShareOpen(false)}
        />
      )}

      {stepDialogOpen && board && (
        <ExportStepDialog
          units={units}
          settings={stepSettings}
          onExport={(s) => {
            saveStep(s);
            setStepSettings(s);
            downloadStep(board, s, meta, units);
            track('export_board', { format: 'step' });
            markExport();
          }}
          onClose={() => setStepDialogOpen(false)}
        />
      )}

      {railBandsDialogOpen && board && (
        <ExportRailBandsDialog
          board={board}
          units={units}
          settings={railBandsSettings}
          onExport={(s) => {
            saveRailBands(s);
            setRailBandsSettings(s);
            downloadRailBands(board, s, meta, units);
            track('export_board', { format: 'rail-bands' });
            markExport();
          }}
          onClose={() => setRailBandsDialogOpen(false)}
        />
      )}

      {pdfDialogOpen && board && (
        <ExportPdf1to1Dialog
          units={units}
          settings={pdf1to1}
          onExport={(s) => {
            savePdf1to1(s);
            setPdf1to1(s);
            downloadPdf1to1(board, s, meta, units);
            track('export_board', { format: 'pdf-1to1-custom' });
            markExport();
          }}
          onClose={() => setPdfDialogOpen(false)}
        />
      )}

      {templateKind === 'hws' && board && (
        <ConstructionPanel
          board={board}
          boardName={meta?.model}
          units={units}
          specs={
            specs
              ? { length: specs.length, maxWidth: specs.maxWidth, thickness: specs.thickness }
              : null
          }
          onClose={() => setTemplateKind(null)}
        />
      )}
    </div>
  );
  return <ShowTipsProvider value={settings.showTips}>{shell}</ShowTipsProvider>;
}

export function App() {
  return <AppShell />;
}
