import { parseBrd, readBoardJson, writeBoardJson } from '@openshaper/io';
import {
  getInterpolatedCrossSection,
  getLength,
  resolveFins,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';
import { type EditorOverlays } from '@openshaper/render2d';
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
  PanelHeader,
  PanelTitle,
  Toast,
  ToolbarSeparator,
  type MenuItem,
  type SheetSnap,
} from '@openshaper/ui';
import { Menu as MenuIcon, SlidersHorizontal } from 'lucide-react';
import {
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
  downloadBoard,
  downloadBrd,
  exportBoard,
  openBoardFile,
  type BoardMeta,
  type ExportFormat,
} from './file-io';
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
import { Brandmark } from './components/marks';
import { CommandPalette, commandsFromMenus } from './CommandPalette';
import { ConstructionPanel } from './ConstructionPanel';
import { SettingsDialog } from './SettingsDialog';
import { loadSettings, saveSettings, type EditorSettings } from './settings';
import { CrossSectionControls } from './CrossSectionControls';
import { CoffeeIcon } from './components/Support';
import { Sidebar, type OverlayToggles, type ResizeFields } from './Sidebar';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';
import { SUPPORT_URL } from './support';
import { BOARD_TEMPLATES } from './templates';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { useSettledBoard } from './use-settled-board';
import { useIsDesktop } from './useMediaQuery';
import { useSpecsWorker } from './use-specs-worker';
import {
  EditorPane,
  faceSizeFor,
  ThreeDControls,
  type EditorKind,
  type View,
  type View3DSettings,
} from './view-toolkit';
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

  useEffect(() => {
    if (boardStore.getState().board) return;
    try {
      const { board } = parseBrd(sampleBrd);
      boardStore.getState().load(board);
    } catch (e) {
      console.error('Failed to load sample board', e);
    }
  }, []);

  // Overlay toggles are declared early so the dist flag can be forwarded to the
  // specs worker (the worker re-runs the distribution only when the flag is on).
  const [overlayToggles, setOverlayToggles] = useState<OverlayToggles>({
    grid: false,
    comb: false,
    com: false,
    dist: false,
  });

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

  const [view, setView] = useState<View>('quad');
  // Editor layout tier: at `lg`+ the sidebar sits beside the viewport; below it the
  // sidebar moves into a draggable bottom sheet and the quad view stacks vertically.
  const isDesktop = useIsDesktop();
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('peek');
  const [csIndex, setCsIndex] = useState(1);
  // Transient cross-pane scrub: the board-length x being hovered in the rocker/outline,
  // mirrored to the other panes as a vertical guide + an interpolated section preview.
  const [scrubX, setScrubX] = useState<number | null>(null);
  const [unitKey, setUnitKey] = useState<string>(
    () => localStorage.getItem('bs.lengthUnit') ?? DEFAULT_LENGTH_UNIT.key,
  );
  const units = lengthUnitByKey(unitKey);
  useEffect(() => {
    localStorage.setItem('bs.lengthUnit', unitKey);
  }, [unitKey]);
  const [view3d, setView3d] = useState<View3DSettings>({
    mode: 'shaded',
    lighting: 'studio',
    material: 'gloss',
    color: '#E8EEF5',
    analysis: 'none',
    meshQuality: 'standard',
    showSection: false,
  });
  const patchView3d = (patch: Partial<View3DSettings>) => setView3d((s) => ({ ...s, ...patch }));
  const [csClipboard, setCsClipboard] = useState<Spline | null>(null);
  const [ghost, setGhost] = useState<BezierBoard | null>(null);
  const [trace, setTrace] = useState<HTMLImageElement | null>(null);
  const [traceOpacity, setTraceOpacity] = useState(0.5);
  const [traceScale, setTraceScale] = useState(1);
  const [traceOffset, setTraceOffset] = useState({ x: 0, y: 0 });
  const [meta, setMeta] = useState<BoardMeta>({});
  const metaRef = useRef(meta); // for the Ctrl+S handler (stable keydown effect)
  metaRef.current = meta;
  const [resize, setResize] = useState<ResizeFields>({ l: '', w: '', t: '' });
  const [templateKind, setTemplateKind] = useState<'hws' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // Recent boards: re-read from localStorage whenever the menu is constructed so
  // it stays in sync with saves/opens from this session.
  const [recentBoards, setRecentBoards] = useState(() => getRecentBoards());

  useKeyboardShortcuts({ setView, setCsIndex, metaRef, onCommandPalette: togglePalette });

  const sectionCount = board?.crossSections.length ?? 0;
  const lastReal = Math.max(1, sectionCount - 2);
  const clampedCs = Math.min(Math.max(csIndex, 1), lastReal);

  // Active cross-section's length position, for the optional 3D mesh highlight.
  const sectionX =
    view3d.showSection && board ? (board.crossSections[clampedCs]?.position ?? null) : null;

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
    if (idx > 0) setCsIndex(idx);
  };
  const addSection = () => {
    const b = boardStore.getState().board;
    if (!b) return;
    const cur = b.crossSections[clampedCs]?.position ?? 0;
    const next = b.crossSections[clampedCs + 1]?.position ?? cur;
    const pos = next > cur ? (cur + next) / 2 : cur + 5; // midpoint, or nudge past the last
    addSectionAt(pos);
  };
  const deleteSection = () => boardStore.getState().deleteCrossSection(clampedCs);
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

  // Reference-image placement for tracing on the outline (world-space, centered).
  const traceBg =
    trace && board
      ? {
          image: trace,
          opacity: traceOpacity,
          rect: (() => {
            const len = getLength(board);
            const w = len * traceScale;
            const aspect = trace.naturalWidth / trace.naturalHeight || 1;
            return { x: len / 2 + traceOffset.x, y: traceOffset.y, w, h: w / aspect };
          })(),
        }
      : undefined;

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
          const cs = getInterpolatedCrossSection(ghost, pos);
          if (cs) out.push(cs.spline);
        }
      }
    }
    if (kind === 'crossSection' && board) {
      if (scrubX != null) {
        const preview = getInterpolatedCrossSection(board, scrubX);
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
  const toastTimer = useRef<number>();
  const showError = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  /** Open a print-friendly spec sheet (board info + dimensions) in a new tab. */
  const openSpecSheet = () => {
    if (!specs || !board) return;
    if (!openHtmlInNewTab(specSheetHtmlFor(board, specs, meta, units, board.fins))) {
      showError('Pop-up blocked — allow pop-ups to open the spec sheet.');
    }
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const onOpenFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-opening the same file
    if (!file) return;
    try {
      const { board, meta } = await openBoardFile(file);
      boardStore.getState().load(board);
      setMeta(meta);
      // Record in the recent list. Use the file's base name (strip extension) as
      // the display name; re-serialise to canonical .board.json so the snapshot
      // is always in the native format regardless of the source format (.brd etc.)
      const baseName = file.name.replace(/\.(board\.json|json|brd)$/i, '');
      const metadata =
        meta && Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined;
      recordRecentBoard(baseName, writeBoardJson(board, metadata));
      setRecentBoards(getRecentBoards());
    } catch (err) {
      console.error('Failed to open board', err);
      showError(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };

  const ghostInput = useRef<HTMLInputElement>(null);
  const onOpenGhost = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setGhost((await openBoardFile(file)).board);
    } catch (err) {
      console.error('Failed to open ghost board', err);
      showError(`Could not open ${file.name}: ${(err as Error).message}`);
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
    } catch (err) {
      console.error('Failed to load template', err);
    }
  };

  /** Load a board that was previously recorded in the recent list. */
  const loadFromRecent = (entry: { name: string; boardJson: string }) => {
    try {
      const { board: rBoard, metadata } = readBoardJson(entry.boardJson);
      boardStore.getState().load(rBoard);
      setMeta((metadata as BoardMeta) ?? {});
      setGhost(null);
      // Refresh the recent list so this entry bubbles to top (re-record updates savedAt).
      recordRecentBoard(entry.name, entry.boardJson);
      setRecentBoards(getRecentBoards());
    } catch (err) {
      console.error('Failed to load recent board', err);
      showError(`Could not reload "${entry.name}": ${(err as Error).message}`);
    }
  };

  const traceInput = useRef<HTMLInputElement>(null);
  const onOpenTrace = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => setTrace(img);
    img.src = URL.createObjectURL(file);
  };

  const tab = (v: View, label: string) => (
    <Button size="sm" variant={view === v ? 'secondary' : 'ghost'} onClick={() => setView(v)}>
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
      onSelect: () => {
        if (!board) return;
        downloadBoard(board, meta);
        // downloadBoard records internally; refresh the menu's snapshot.
        setRecentBoards(getRecentBoards());
      },
    },
    { kind: 'separator' },
    // Open recent: one named entry per recorded board, newest first.
    ...(recentBoards.length > 0
      ? ([
          { kind: 'label', label: 'Open recent' } as MenuItem,
          ...recentBoards.map((e) => ({
            kind: 'action' as const,
            label: e.name,
            onSelect: () => loadFromRecent(e),
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
    { kind: 'action', label: 'Load trace image…', onSelect: () => traceInput.current?.click() },
    { kind: 'separator' },
    { kind: 'label', label: 'Export' },
    ...(['stl', 'dxf', 'pdf'] as ExportFormat[]).map((f) => ({
      kind: 'action' as const,
      label: f.toUpperCase(),
      disabled: !board,
      onSelect: () =>
        board &&
        exportBoard(board as Parameters<typeof exportBoard>[0], f, meta, units, ghost ?? undefined),
    })),
    {
      kind: 'action',
      label: 'PDF 1:1 (outline/rocker)',
      disabled: !board,
      onSelect: () =>
        board &&
        exportBoard(
          board as Parameters<typeof exportBoard>[0],
          'pdf-1to1',
          meta,
          units,
          ghost ?? undefined,
        ),
    },
    {
      kind: 'action',
      label: 'Legacy .brd',
      disabled: !board,
      onSelect: () => board && downloadBrd(board, meta),
    },
    { kind: 'action', label: 'Spec sheet…', disabled: !specs, onSelect: openSpecSheet },
    { kind: 'separator' },
    { kind: 'label', label: 'Templates' },
    {
      kind: 'action',
      label: 'Hollow Wood Frame…',
      disabled: !board,
      onSelect: () => setTemplateKind('hws'),
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
      onSelect: () => setOverlayToggles((s) => ({ ...s, grid: !s.grid })),
    },
    {
      kind: 'checkbox',
      label: 'Curvature comb',
      checked: overlayToggles.comb,
      onSelect: () => setOverlayToggles((s) => ({ ...s, comb: !s.comb })),
    },
    {
      kind: 'checkbox',
      label: 'Center of mass',
      checked: overlayToggles.com,
      onSelect: () => setOverlayToggles((s) => ({ ...s, com: !s.com })),
    },
    {
      kind: 'checkbox',
      label: 'Volume distribution',
      checked: overlayToggles.dist,
      onSelect: () => setOverlayToggles((s) => ({ ...s, dist: !s.dist })),
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
      onSelect: () => setUnitKey(u.key),
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

  // The four quad panes, built once and arranged either as a 2×2 grid (desktop) or a
  // vertical scrolling stack (compact) — the panes themselves are identical in both.
  const quadPanes = [
    <EditorPane
      key="outline"
      title="Outline"
      kind="outline"
      csIndex={clampedCs}
      units={units}
      sectionMarkers={sectionMarkers}
      onPickSection={setCsIndex}
      onAddSectionAt={addSectionAt}
      onScrub={setScrubX}
      overlays={overlaysFor('outline')}
      ghostSplines={ghostSplinesFor('outline')}
      background={traceBg}
      settings={settings}
      viewCommand={viewCmd}
    />,
    <EditorPane
      key="crossSection"
      title={csTitle}
      kind="crossSection"
      csIndex={clampedCs}
      units={units}
      overlays={overlaysFor('crossSection')}
      ghostSplines={ghostSplinesFor('crossSection')}
      viewCommand={viewCmd}
      headerActions={csControls}
      settings={settings}
    />,
    <EditorPane
      key="rocker"
      title="Rocker (deck + bottom)"
      kind="rocker"
      csIndex={clampedCs}
      units={units}
      sectionMarkers={sectionMarkers}
      onPickSection={setCsIndex}
      onAddSectionAt={addSectionAt}
      onScrub={setScrubX}
      overlays={overlaysFor('rocker')}
      ghostSplines={ghostSplinesFor('rocker')}
      settings={settings}
      viewCommand={viewCmd}
    />,
    <Panel key="3d" className="flex min-h-0 flex-col">
      <PanelHeader className="flex items-center justify-between gap-2">
        <PanelTitle>3D</PanelTitle>
        <ThreeDControls settings={view3d} onChange={patchView3d} compact />
      </PanelHeader>
      <PanelBody className="min-h-0 flex-1 p-0">
        <ThreeDPane
          store={boardStore}
          mode={view3d.mode}
          lighting={view3d.lighting}
          material={view3d.material}
          color={view3d.color}
          finColor={settings.finColor}
          analysis={view3d.analysis}
          targetFaceSize={faceSizeFor(view3d.meshQuality)}
          sectionX={sectionX}
        />
      </PanelBody>
    </Panel>,
  ];

  const sidebarEl = (
    <Sidebar
      specs={specs}
      units={units}
      interpolationType={board?.interpolationType ?? 'controlPoint'}
      resize={resize}
      setResize={setResize}
      applyResize={applyResize}
      meta={meta}
      setMeta={setMeta}
      foamType={foamType}
      glassSchedule={glassSchedule}
      weight={weight}
      trace={trace}
      setTrace={setTrace}
      traceInput={traceInput}
      onOpenTrace={onOpenTrace}
      traceOpacity={traceOpacity}
      setTraceOpacity={setTraceOpacity}
      traceScale={traceScale}
      setTraceScale={setTraceScale}
      traceOffset={traceOffset}
      setTraceOffset={setTraceOffset}
      overlayToggles={overlayToggles}
      setOverlayToggles={setOverlayToggles}
      ghost={!!ghost}
      ghostSpecs={ghostSpecs}
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
      <div className="flex flex-col border-b border-border bg-card text-card-foreground">
        {/* Row 1 — application menubar */}
        <div className="flex h-11 items-center gap-1 px-1.5 sm:gap-2 sm:px-2">
          <a
            href="/"
            className="group flex items-center gap-2 px-1.5 font-semibold transition-colors hover:text-primary"
            title="OpenShaper home"
          >
            <Brandmark className="h-6 w-6 transition-transform duration-300 group-hover:rotate-3" />
            <span className="hidden sm:inline">
              Open<span className="text-primary">Shaper</span>
            </span>
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
            <Menu label="Help" items={helpMenu} />
          </MenuBar>
          <div className="flex-1" />
          {SUPPORT_URL && (
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
        <div className="flex h-11 items-center gap-1 border-t border-border px-2">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tab('quad', 'Quad')}
            {tab('outline', 'Outline')}
            {tab('rocker', 'Rocker')}
            {tab('crossSection', 'Cross-section')}
            {tab('3d', '3D')}
          </div>
          <select
            value={unitKey}
            onChange={(e) => setUnitKey(e.target.value)}
            title="Display units"
            className="h-8 shrink-0 rounded-md border border-border bg-transparent px-2 text-sm"
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
          </select>
          {/* Below lg the sidebar lives in a bottom sheet; this opens it. */}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 lg:hidden"
            title="Show board panels"
            aria-label="Show board panels"
            onClick={() => setSheetSnap('half')}
          >
            <SlidersHorizontal className="size-4" />
          </Button>
        </div>

        {/* Hidden file inputs (the trace input lives in the Sidebar, sharing traceInput). */}
        <input
          ref={fileInput}
          type="file"
          accept=".board,.board.json,.json,.brd,.s3d,.srf"
          className="hidden"
          onChange={onOpenFile}
        />
        <input
          ref={ghostInput}
          type="file"
          accept=".board,.board.json,.json,.brd,.s3d,.srf"
          className="hidden"
          onChange={onOpenGhost}
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="min-h-0 min-w-0 flex-1">
          {view === 'quad' ? (
            isDesktop ? (
              <div className="grid h-full grid-cols-2 grid-rows-2 gap-3">{quadPanes}</div>
            ) : (
              // Compact: a single scrolling column, each pane a comfortable fixed height.
              // pb clears the collapsed bottom sheet (PEEK_PX≈112px, fixed over the viewport
              // bottom) so the last pane — the 3D view — can scroll fully into view above it.
              <div className="flex h-full flex-col gap-3 overflow-y-auto pb-28">
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
          ) : view === '3d' ? (
            <Panel className="flex h-full flex-col">
              <PanelHeader className="flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <PanelTitle>3D</PanelTitle>
                  <span className="text-xs text-muted-foreground">
                    drag to orbit • scroll to zoom
                  </span>
                </div>
                <ThreeDControls settings={view3d} onChange={patchView3d} />
              </PanelHeader>
              <PanelBody className="min-h-0 flex-1 p-0">
                <ThreeDPane
                  store={boardStore}
                  mode={view3d.mode}
                  lighting={view3d.lighting}
                  material={view3d.material}
                  color={view3d.color}
                  finColor={settings.finColor}
                  analysis={view3d.analysis}
                  targetFaceSize={faceSizeFor(view3d.meshQuality)}
                  sectionX={sectionX}
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
              onAddSectionAt={addSectionAt}
              onScrub={setScrubX}
              overlays={overlaysFor(view)}
              ghostSplines={ghostSplinesFor(view)}
              background={traceBg}
              viewCommand={viewCmd}
              headerActions={view === 'crossSection' ? csControls : undefined}
              settings={settings}
            />
          )}
        </div>

        {/* Desktop: sidebar beside the viewport. Compact: it moves into a bottom sheet. */}
        {isDesktop && sidebarEl}
      </div>

      {!isDesktop && (
        <BottomSheet snap={sheetSnap} onSnapChange={setSheetSnap} peek={sheetPeek}>
          {sidebarEl}
        </BottomSheet>
      )}

      {toast && <Toast onClick={() => setToast(null)}>{toast}</Toast>}

      {paletteOpen && (
        <CommandPalette
          commands={commandsFromMenus([
            ['File', fileMenu],
            ['Edit', editMenu],
            ['View', viewMenu],
            ['Board', boardMenu],
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

      {templateKind === 'hws' && board && (
        <ConstructionPanel
          board={board}
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
