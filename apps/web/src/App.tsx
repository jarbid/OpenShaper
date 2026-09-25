import { stepExportSupport } from '@openshaper/export';
import { decodeShareFragment, parseBrd, readBoardJson, writeBoardJson } from '@openshaper/io';
import {
  loftCrossSection,
  getLength,
  resolveFins,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';
import { type EditorOverlays, type SimilarityParams } from '@openshaper/render2d';
import type { Board3DViewProps } from '@openshaper/render3d';
import { selectSpecs } from '@openshaper/store';
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
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  decideImport,
  downloadBoard,
  downloadBrd,
  downloadPdf1to1,
  downloadRailBands,
  downloadStep,
  exportBoard,
  openBoardFile,
  sourceExtension,
  type BoardMeta,
  type ExportFormat,
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
} from './format';
import { openHtmlInNewTab, specSheetHtmlFor } from './spec-sheet-open';
import { loadSession, saveSession } from './session-store';
import { DEFAULT_SPLIT, loadViewState, saveViewState, type SplitPanes } from './view-state';
import { Brandmark } from './components/marks';
import { CommandPalette, commandsFromMenus } from './CommandPalette';
import { ConstructionPanel } from './ConstructionPanel';
import { SettingsDialog } from './SettingsDialog';
import { ShareDialog } from './ShareDialog';
import { SharedBoardPrompt } from './SharedBoardPrompt';
import { clearSharedPayload, peekSharedPayload } from './share-bootstrap';
import { shareLinkMessage } from './share-url';
import { loadSettings, saveSettings, type EditorSettings } from './settings';
import { CrossSectionControls } from './CrossSectionControls';
import { LandscapeHint } from './LandscapeHint';
import { CoffeeIcon } from './components/Support';
import { Sidebar, type OverlayToggles, type ResizeFields } from './Sidebar';
import { applyViewChange, DEFAULT_SIDEBAR_STATE, type SidebarState } from './sidebar-sections';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';
import { SUPPORT_URL } from './support';
import { BOARD_TEMPLATES } from './templates';
import { clampSectionIndex, nearestMidpointSection } from './section-index';
import { VIEW_KEYS } from './shortcuts';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { useSettledBoard } from './use-settled-board';
import { isShortViewport, useIsDesktop, useIsPhone, useIsShortViewport } from './useMediaQuery';
import { useSpecsWorker } from './use-specs-worker';
import { useTrace, type TraceView } from './use-trace';
import {
  EditorPane,
  faceSizeFor,
  FALLBACK_VIEW,
  isViewAvailable,
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
import { DEFAULT_VIEW_3D } from './view3d-settings';
import { estimateWeight, type FoamType, type GlassSchedule } from './weights';

// three.js / fiber / drei are the bulk of the bundle and are only needed once a 3D
// pane is shown, so load Board3DView as its own chunk. The 2D editor becomes
// interactive without waiting on the 3D stack, and 2D-only views never fetch it.
const Board3DView = lazy(() =>
  import('@openshaper/render3d').then((m) => ({ default: m.Board3DView })),
);

/** Board3DView behind a Suspense boundary, so the lazy 3D chunk can stream in. */
function ThreeDPane(props: Board3DViewProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading 3D…
        </div>
      }
    >
      <Board3DView {...props} />
    </Suspense>
  );
}

function AppShell() {
  const board = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().board);
  // Subscribe to history depth so the undo/redo buttons re-render with the right
  // enabled state, read live from the store rather than a render-time snapshot.
  const canUndo =
    useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().past.length) > 0;
  const canRedo =
    useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().future.length) > 0;

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
  const [pendingShare, setPendingShare] = useState<{
    board: BezierBoard;
    metadata?: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    if (boardStore.getState().board) {
      hydrated.current = true;
      return;
    }
    let cancelled = false;

    /** Restore the autosaved workspace; fall back to the bundled sample. */
    const restoreOrSample = (session: Awaited<ReturnType<typeof loadSession>>): boolean => {
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
          hydrated.current = true;
          boardStore.getState().load(sBoard);
          setMeta((metadata as BoardMeta) ?? {});
          if (sGhost) setGhost(sGhost);
          return true;
        } catch (e) {
          console.error('Failed to restore session', e);
          // The visitor's own work failing to come back. The JSON is ours, so
          // a parse failure here is our bug, not a bad file.
          captureError('session_restore', e);
        }
      }
      try {
        const { board } = parseBrd(sampleBrd);
        hydrated.current = true;
        boardStore.getState().load(board);
      } catch (e) {
        console.error('Failed to load sample board', e);
        // A bundled asset we ship failing to parse — the editor opens empty.
        captureError('sample_board', e);
      }
      return false;
    };

    void (async () => {
      // Startup precedence (docs/design/share-link.md §2.3): decode the link
      // first, but touch nothing until the session read has resolved, so the
      // "is there work to lose?" question is answered before it is asked.
      const payload = peekSharedPayload();
      const session = await loadSession();
      if (cancelled) return;

      let shared: { board: BezierBoard; metadata?: Record<string, unknown> } | null = null;
      if (payload) {
        try {
          shared = await decodeShareFragment(payload);
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
        adoptRef.current(shared.board, shared.metadata);
        return;
      }

      const hadSession = restoreOrSample(session);
      if (shared && hadSession) setPendingShare(shared);
      else if (shared) adoptRef.current(shared.board, shared.metadata);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overlay toggles are declared early so the dist flag can be forwarded to the
  // specs worker (the worker re-runs the distribution only when the flag is on).
  const [overlayToggles, setOverlayToggles] = useState<OverlayToggles>({
    grid: false,
    comb: false,
    com: false,
    dist: false,
  });
  // Flip one overlay and report it. These four are entirely unmeasured
  // otherwise — the curvature comb and volume distribution in particular are
  // expensive to maintain, so knowing whether anyone turns them on is the
  // difference between investing in them and retiring them.
  const toggleOverlay = (key: keyof OverlayToggles) => {
    // Reported outside the updater: StrictMode double-invokes updaters in dev,
    // which would double-count the event.
    track('overlay_toggled', { overlay: key, enabled: !overlayToggles[key] });
    setOverlayToggles((s) => ({ ...s, [key]: !s[key] }));
  };

  // Specs (and the distribution overlay) read the settled board so they don't
  // re-integrate on every drag move — see useSettledBoard. The integrals run in
  // the specs worker; previous values hold during recompute (no flicker).
  const settledBoard = useSettledBoard();
  const workerResult = useSpecsWorker(settledBoard, {
    wantDistribution: overlayToggles.dist,
    distributionIntervals: 40,
  });
  const specs = workerResult?.specs ?? null;
  // Volume-distribution overlay: computed off-thread when the overlay is enabled.
  // When disabled the worker skips the sampling, saving ~41 getCrossSectionAreaAt
  // calls per settled-board change.
  const volumeDist = workerResult?.distribution;

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
  const viewSaveTimer = useRef<number>();
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
      boardStore.getState().select(null);
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
    () => localStorage.getItem('bs.lengthUnit') ?? DEFAULT_LENGTH_UNIT.key,
  );
  const units = lengthUnitByKey(unitKey);
  useEffect(() => {
    localStorage.setItem('bs.lengthUnit', unitKey);
  }, [unitKey]);
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
  const metaRef = useRef(meta); // for the Ctrl+S handler (stable keydown effect)
  metaRef.current = meta;
  const ghostRef = useRef(ghost); // for the pagehide session flush (stable listener)
  ghostRef.current = ghost;

  // Continuous autosave: after every committed change to the board, its
  // metadata, or the ghost, snapshot the session to IndexedDB (debounced —
  // store commits land on pointer-up, so this coalesces bursts of edits).
  const persistSession = useCallback(() => {
    const b = boardStore.getState().board;
    if (!b || !hydrated.current) return;
    const m = metaRef.current;
    const metadata = Object.values(m).some(Boolean) ? (m as Record<string, unknown>) : undefined;
    const g = ghostRef.current;
    void saveSession({
      boardJson: writeBoardJson(b, metadata),
      ...(g ? { ghostJson: writeBoardJson(g) } : {}),
    });
  }, []);
  const sessionSaveTimer = useRef<number>();
  useEffect(() => {
    if (!board || !hydrated.current) return;
    window.clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = window.setTimeout(persistSession, 800);
  }, [board, meta, ghost, persistSession]);
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
  useEffect(() => installSessionSummary(() => boardStore.getState().past.length), []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitEpoch]);

  // Recent boards: re-read from localStorage whenever the menu is constructed so
  // it stays in sync with saves/opens from this session.
  const [recentBoards, setRecentBoards] = useState(() => getRecentBoards());

  useKeyboardShortcuts({
    setView: selectView,
    setCsIndex,
    metaRef,
    onCommandPalette: togglePalette,
    clearSectionFocus,
  });

  const sectionCount = board?.crossSections.length ?? 0;
  const lastReal = Math.max(1, sectionCount - 2);
  const clampedCs = clampSectionIndex(csIndex, sectionCount);

  // The active station's length position. Derived unconditionally — the toggle
  // governs whether the guide is drawn, not whether the position is known.
  const activeSectionX = board ? (board.crossSections[clampedCs]?.position ?? null) : null;

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
    const idx = boardStore.getState().addCrossSection(pos);
    if (idx > 0) {
      focusSection(null);
      setCsIndex(idx);
    }
  };
  const moveSection = (index: number, position: number) => {
    boardStore.getState().moveCrossSection(index, position);
    setCsIndex(index);
  };
  const addSection = () => {
    const b = boardStore.getState().board;
    if (!b) return;
    const cur = b.crossSections[clampedCs]?.position ?? 0;
    const next = b.crossSections[clampedCs + 1]?.position ?? cur;
    const pos = next > cur ? (cur + next) / 2 : cur + 5; // midpoint, or nudge past the last
    addSectionAt(pos);
  };
  const deleteSectionAt = (index: number) => {
    boardStore.getState().deleteCrossSection(index);
    focusSection(null);
    const count = boardStore.getState().board?.crossSections.length ?? 0;
    setCsIndex(clampSectionIndex(index, count));
  };
  const deleteSection = () => deleteSectionAt(clampedCs);
  const copySection = () => {
    const b = boardStore.getState().board;
    if (b) setCsClipboard(b.crossSections[clampedCs]?.spline ?? null);
  };
  const pasteSection = () => {
    if (csClipboard) boardStore.getState().pasteCrossSection(clampedCs, csClipboard);
  };

  // Resize: blank fields keep that dimension; others scale to the typed target.
  const applyResize = () => {
    if (!specs) return;
    const factor = (text: string, cur: number) => {
      const t = text.trim();
      if (!t || cur <= 0) return 1;
      const v = parseLen(t, units);
      return v > 0 ? v / cur : 1;
    };
    boardStore
      .getState()
      .scaleBoard(
        factor(resize.l, specs.length),
        factor(resize.w, specs.maxWidth),
        factor(resize.t, specs.thickness),
      );
    setResize({ l: '', w: '', t: '' });
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

  const foamType = (meta.foamType as FoamType) ?? 'PU';
  const glassSchedule = (meta.glassSchedule as GlassSchedule) ?? '4+4';
  // Weight estimate: specs.area (planshape area cm²) comes from the worker result —
  // same value as getArea(settledBoard) but without a redundant main-thread kernel call.
  const weight = useMemo(
    () =>
      specs
        ? estimateWeight(specs.volume / 1000, specs.area / 10000, foamType, glassSchedule)
        : null,
    [specs, foamType, glassSchedule],
  );

  const overlaysFor = (kind: EditorKind): EditorOverlays => {
    const longitudinal = kind === 'outline' || kind === 'rocker';
    const verticalMarkers: { x: number; color: string; label?: string }[] = [];
    if (longitudinal && overlayToggles.com && specs)
      verticalMarkers.push({ x: specs.centerOfMass, color: '#22D3EE', label: 'CoM' });
    return {
      grid: overlayToggles.grid,
      curvatureComb: overlayToggles.comb,
      verticalMarkers: verticalMarkers.length ? verticalMarkers : undefined,
      // Cross-pane "sliding location": the hovered board-x as a solid-inside / dashed
      // probe in every length-axis pane (the hovered pane included — it tracks the cursor).
      scrubProbe: longitudinal && scrubX != null ? scrubX : undefined,
      distribution: longitudinal ? volumeDist : undefined,
      // Plan footprint + box on the outline; blade silhouette on the rocker (rail) view.
      fins:
        (kind === 'outline' || kind === 'rocker') && resolvedFins.length ? resolvedFins : undefined,
      finView: kind === 'rocker' ? 'profile' : 'plan',
    };
  };

  // Read-only ghost splines per pane: the reference (ghost) board comparison, plus — for
  // the cross-section pane — the live interpolated section at the scrub x and faint
  // neighbour stations (fairing context).
  const ghostSplinesFor = (kind: EditorKind): Spline[] | undefined => {
    const out: Spline[] = [];
    if (ghost) {
      if (kind === 'outline') out.push(ghost.outline);
      else if (kind === 'rocker') out.push(ghost.deck, ghost.bottom);
      else {
        const pos = board?.crossSections[clampedCs]?.position;
        if (pos !== undefined) {
          const cs = loftCrossSection(ghost, pos);
          if (cs) out.push(cs.spline);
        }
      }
    }
    if (kind === 'crossSection' && board) {
      if (scrubX != null) {
        // The lofted surface, so the section under the scrub reads the same here as it
        // does in the 3D view beside it.
        const preview = loftCrossSection(board, scrubX);
        if (preview) out.push(preview.spline);
      }
      // Adjacent real stations (skip the nose/tail dummies at 0 / last).
      const last = board.crossSections.length - 1;
      const prev = clampedCs - 1;
      const next = clampedCs + 1;
      if (prev >= 1) out.push(board.crossSections[prev]!.spline);
      if (next <= last - 1) out.push(board.crossSections[next]!.spline);
    }
    return out.length ? out : undefined;
  };
  const ghostSpecs = useMemo(() => (ghost ? selectSpecs(ghost) : null), [ghost]);

  // Transient error notice (file-open / pop-up failures), auto-dismissed.
  const [toast, setToast] = useState<string | null>(null);
  // Info-only repairs: a persistent dismissible notice (not the 6s error toast).
  const [importNotice, setImportNotice] = useState<ImportWarning[] | null>(null);
  // Pending data-loss import awaiting user confirmation.
  const [pendingImport, setPendingImport] = useState<{
    fileName: string;
    dropped: ImportWarning[];
    info: ImportWarning[];
    commit: () => void;
  } | null>(null);
  const toastTimer = useRef<number>();
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
    downloadBoard(board, meta);
    track('save_board', { format: 'board' });
    markSave();
    // downloadBoard records internally; refresh the menu's snapshot.
    setRecentBoards(getRecentBoards());
  };

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
    setImportNotice(info.length > 0 ? info : null);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const onOpenFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-opening the same file
    if (!file) return;
    try {
      const { board, meta, warnings } = await openBoardFile(file);
      const commit = () => {
        boardStore.getState().load(board);
        setMeta(meta);
        // Record in the recent list. Use the file's base name (strip extension) as
        // the display name; re-serialise to canonical .board.json so the snapshot
        // is always in the native format regardless of the source format (.brd etc.)
        const baseName = file.name.replace(/\.(board\.json|json|brd|s3dx|s3d|srf)$/i, '');
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
      console.error('Failed to open ghost board', err);
      showToast(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };

  // New board from a type template — loads the authentic legacy .brd geometry.
  const newFromTemplate = (name: string) => {
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

  /** Load a board that was previously recorded in the recent list. */
  const loadFromRecent = (entry: { name: string; boardJson: string }, position: number) => {
    try {
      const { board: rBoard, metadata } = readBoardJson(entry.boardJson);
      boardStore.getState().load(rBoard);
      setMeta((metadata as BoardMeta) ?? {});
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
  const adoptSharedBoard = (sBoard: BezierBoard, metadata?: Record<string, unknown>) => {
    const sMeta = (metadata as BoardMeta) ?? {};
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
      writeBoardJson(sBoard, metadata),
    );
    setRecentBoards(getRecentBoards());

    // A share link never carries a trace, so the recipient's own trace would
    // otherwise sit under a stranger's outline. Hidden, not deleted.
    trace.hideAll();

    setPickedView('quad');
    setCsIndex(nearestMidpointSection(sBoard));
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
  const openTracePicker = (view: TraceView) => {
    pendingTraceView.current = view;
    traceInput.current?.click();
  };
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

  const csTitle = 'Cross-section';

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
      positionCm={board?.crossSections[clampedCs]?.position ?? null}
      units={units}
      onMoveTo={(position) => moveSection(clampedCs, position)}
    />
  );

  const interp = board?.interpolationType ?? 'controlPoint';

  const fileMenu: MenuItem[] = [
    { kind: 'label', label: 'New' },
    ...BOARD_TEMPLATES.map((t) => ({
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
            onSelect: () => loadFromRecent(e, i),
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
  const stepSupport = board ? stepExportSupport(board as BezierBoard) : null;

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
        exportBoard(board as Parameters<typeof exportBoard>[0], f, meta, units, ghost ?? undefined);
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
      onSelect: () => boardStore.getState().undo(),
    },
    {
      kind: 'action',
      label: 'Redo',
      shortcut: 'Ctrl Y',
      disabled: !canRedo,
      onSelect: () => boardStore.getState().redo(),
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
        // `from` makes the switch direction readable (metric → imperial is a
        // different story from the reverse); re-picking the current unit is
        // not a change, so it sends nothing.
        if (u.key !== unitKey) track('units_changed', { units: u.key, from: unitKey });
      },
    })),
  ];

  const boardMenu: MenuItem[] = [
    ghost
      ? { kind: 'action', label: 'Clear ghost', onSelect: () => setGhost(null) }
      : { kind: 'action', label: 'Open ghost…', onSelect: () => ghostInput.current?.click() },
    { kind: 'separator' },
    // The model drives the integrated specs (volume / CoM / distribution); the 2D/3D
    // previews always render the control-point surface (see kernel InterpolationType).
    { kind: 'label', label: 'Interpolation' },
    {
      kind: 'checkbox',
      label: 'Control point',
      checked: interp === 'controlPoint',
      onSelect: () => boardStore.getState().setInterpolationType('controlPoint'),
    },
    {
      kind: 'checkbox',
      label: 'S-blend',
      checked: interp === 'sLinear',
      onSelect: () => boardStore.getState().setInterpolationType('sLinear'),
    },
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
            <ThreeDControls settings={view3d} onChange={patchView3d} compact />
          </ViewPaneHeader>
          <PanelBody className="min-h-0 flex-1 p-0">
            <ThreeDPane
              store={boardStore}
              mode={view3d.mode}
              lighting={view3d.lighting}
              material={view3d.material}
              color={view3d.color}
              finColor={settings.finColor}
              viewCubeLineColor={settings.outlineColor}
              analysis={view3d.analysis}
              targetFaceSize={faceSizeFor(view3d.meshQuality)}
              showStringer={view3d.showStringer}
              showSections={view3d.showSections}
              activeSectionX={activeSectionX}
              key={cameraEpoch}
              initialCamera={liveViewState.current.camera3d}
              onCameraChange={onCameraChange}
            />
          </PanelBody>
        </Panel>
      );
    return (
      <EditorPane
        key={kind}
        title={
          kind === 'outline' ? 'Outline' : kind === 'rocker' ? 'Rocker (deck + bottom)' : csTitle
        }
        titleControl={titleControl}
        kind={kind}
        csIndex={clampedCs}
        units={units}
        // The cross-section pane has no length axis, so `EditorPane` drops the
        // station markers, the scrub and the trace props for it — passing them
        // uniformly here keeps that one decision in one place.
        sectionMarkers={sectionMarkers}
        onPickSection={setCsIndex}
        focusedSection={focusedSection}
        onFocusSection={focusSection}
        onMoveSection={moveSection}
        onDeleteSection={deleteSectionAt}
        onAddSectionAt={addSectionAt}
        onScrub={scrubSection}
        overlays={overlaysFor(kind)}
        ghostSplines={ghostSplinesFor(kind)}
        {...(kind === 'crossSection' ? {} : traceProps(kind))}
        headerActions={kind === 'crossSection' ? csControls : undefined}
        settings={settings}
        viewCommand={viewCmd}
        initialView={pendingViews2d.current[kind]}
        onViewChange={reportPaneView(kind)}
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
      specs={specs}
      units={units}
      resize={resize}
      setResize={setResize}
      applyResize={applyResize}
      meta={meta}
      setMeta={setMeta}
      foamType={foamType}
      glassSchedule={glassSchedule}
      weight={weight}
      trace={trace}
      onLoadTrace={openTracePicker}
      overlayToggles={overlayToggles}
      setOverlayToggles={setOverlayToggles}
      ghost={!!ghost}
      ghostSpecs={ghostSpecs}
      sidebar={sidebar}
      onSidebarChange={setSidebar}
      onUnitChange={isPhone ? setUnitKey : undefined}
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

  return (
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
          <Button
            size="sm"
            variant="ghost"
            className="sm:hidden"
            title="Menu / commands"
            aria-label="Menu and commands"
            onClick={togglePalette}
          >
            <MenuIcon className="size-4" />
          </Button>
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
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            disabled={!board}
            title="Share this board as a link"
            aria-label="Share board"
            onClick={() => setShareOpen(true)}
          >
            <Share2 className="size-4" />
            <span className="hidden sm:inline">Share</span>
          </Button>
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
          {!isPhone && <UnitSelect value={unitKey} onChange={setUnitKey} />}
          {/* Below lg the sidebar lives in a bottom sheet; this opens it. Gated on the
              tier rather than `lg:hidden` so it is not merely invisible on desktop: it
              names the same action as the rail's own control, and two mounted buttons
              claiming it is one ambiguity for assistive tech and one for tests. */}
          {!isDesktop && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              title={panelsShowing ? 'Hide board panels' : 'Show board panels'}
              aria-label={panelsShowing ? 'Hide board panels' : 'Show board panels'}
              onClick={() => setSheetSnap(panelsShowing ? 'closed' : 'half')}
            >
              <SlidersHorizontal className="size-4" />
            </Button>
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
                <ThreeDControls settings={view3d} onChange={patchView3d} />
              </ViewPaneHeader>
              <PanelBody className="min-h-0 flex-1 p-0">
                <ThreeDPane
                  store={boardStore}
                  mode={view3d.mode}
                  lighting={view3d.lighting}
                  material={view3d.material}
                  color={view3d.color}
                  finColor={settings.finColor}
                  viewCubeLineColor={settings.outlineColor}
                  analysis={view3d.analysis}
                  targetFaceSize={faceSizeFor(view3d.meshQuality)}
                  showStringer={view3d.showStringer}
                  showSections={view3d.showSections}
                  activeSectionX={activeSectionX}
                  key={cameraEpoch}
                  initialCamera={liveViewState.current.camera3d}
                  onCameraChange={onCameraChange}
                />
              </PanelBody>
            </Panel>
          ) : (
            <EditorPane
              title={
                view === 'outline'
                  ? 'Outline'
                  : view === 'rocker'
                    ? 'Rocker (deck + bottom)'
                    : csTitle
              }
              kind={view}
              csIndex={clampedCs}
              units={units}
              sectionMarkers={sectionMarkers}
              onPickSection={setCsIndex}
              focusedSection={focusedSection}
              onFocusSection={focusSection}
              onMoveSection={moveSection}
              onDeleteSection={deleteSectionAt}
              onAddSectionAt={addSectionAt}
              onScrub={scrubSection}
              overlays={overlaysFor(view)}
              ghostSplines={ghostSplinesFor(view)}
              {...(view === 'crossSection' ? {} : traceProps(view))}
              viewCommand={viewCmd}
              headerActions={view === 'crossSection' ? csControls : undefined}
              settings={settings}
              initialView={pendingViews2d.current[view]}
              onViewChange={reportPaneView(view)}
              onTitleDoubleClick={() => selectView('quad')}
            />
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
            setImportNotice(pendingImport.info.length > 0 ? pendingImport.info : null);
            setPendingImport(null);
          }}
        />
      )}

      {importNotice && (
        <Toast onClick={() => setImportNotice(null)}>
          <span className="font-medium">Imported with changes:</span>{' '}
          {importNotice.map((w) => w.message).join(' · ')}
        </Toast>
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commandsFromMenus([
            ['File', fileMenu],
            ['Edit', editMenu],
            ['View', viewMenu],
            ['Board', boardMenu],
            ['Export', exportMenu],
            ['Help', helpMenu],
          ])}
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

      {pendingShare && (
        <SharedBoardPrompt
          model={(pendingShare.metadata as BoardMeta | undefined)?.model}
          onKeepCurrent={() => {
            // The shared board never entered the store, so declining is a
            // no-op beyond forgetting it.
            clearSharedPayload();
            setPendingShare(null);
          }}
          onOpenShared={() => adoptSharedBoard(pendingShare.board, pendingShare.metadata)}
        />
      )}

      {shareOpen && board && (
        <ShareDialog
          board={board as BezierBoard}
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
          board={board as BezierBoard}
          units={units}
          settings={railBandsSettings}
          onExport={(s) => {
            saveRailBands(s);
            setRailBandsSettings(s);
            downloadRailBands(board as BezierBoard, s, meta, units);
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
}

export function App() {
  return <AppShell />;
}
