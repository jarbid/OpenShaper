import { specSheetHtml } from '@openshaper/export';
import { parseBrd } from '@openshaper/io';
import {
  getArea,
  getCrossSectionAreaAt,
  getInterpolatedCrossSection,
  getLength,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';
import { type EditorOverlays } from '@openshaper/render2d';
import type { Board3DViewProps } from '@openshaper/render3d';
import { selectSpecs } from '@openshaper/store';
import { Unit } from '@openshaper/units';
import {
  Button,
  buttonVariants,
  Menu,
  MenuBar,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  ToolbarSeparator,
  type MenuItem,
} from '@openshaper/ui';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  downloadBoard,
  exportBoard,
  openBoardFile,
  type BoardMeta,
  type ExportFormat,
} from './file-io';
import {
  DEFAULT_LENGTH_UNIT,
  fmtLen,
  fmtVol,
  LENGTH_UNITS,
  lengthUnitByKey,
  parseLen,
} from './format';
import { Brandmark } from './components/marks';
import { ConstructionPanel } from './ConstructionPanel';
import { CrossSectionControls } from './CrossSectionControls';
import { CoffeeIcon } from './components/Support';
import { finsFor, type FinSetup } from './fins';
import { Sidebar, type OverlayToggles, type ResizeFields } from './Sidebar';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';
import { SUPPORT_URL } from './support';
import { BOARD_TEMPLATES } from './templates';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
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

/**
 * The board as of the last *settled* (non-dragging) moment. Heavy derived values
 * — volume, planshape area, center of mass, cross-section-area distribution — read
 * from this instead of the live board, so the numerical integration runs on edit
 * commit rather than on every pointer-move during a drag. The editors and the 3D
 * view still subscribe to the live board, so dragging stays smooth; the specs
 * snap to the final value on release. When not dragging, this *is* the live board,
 * so steady-state behavior is unchanged.
 */
function useSettledBoard(): BezierBoard | null {
  const board = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().board);
  const editing = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().editing);
  const ref = useRef(board);
  if (!editing) ref.current = board;
  return ref.current;
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

  // Specs (and the other integration-heavy values below) read the settled board so
  // they don't re-integrate on every drag move — see useSettledBoard.
  const settledBoard = useSettledBoard();
  const specs = settledBoard ? selectSpecs(settledBoard) : null;
  const [view, setView] = useState<View>('quad');
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
  const [overlayToggles, setOverlayToggles] = useState<OverlayToggles>({
    grid: false,
    comb: false,
    com: false,
    dist: false,
  });
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

  useKeyboardShortcuts({ setView, setCsIndex, metaRef });

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

  // Cross-sectional-area distribution (legacy volume distribution), recomputed
  // only when the (settled) board changes and the overlay is enabled.
  const volumeDist = useMemo(() => {
    if (!settledBoard || !overlayToggles.dist) return undefined;
    const len = getLength(settledBoard);
    const N = 40;
    return Array.from({ length: N + 1 }, (_, i) => {
      const x = (i / N) * len;
      return { x, value: getCrossSectionAreaAt(settledBoard, x, 10) };
    });
  }, [settledBoard, overlayToggles.dist]);

  const finType = (meta.finType as FinSetup) ?? 'none';
  const finMarkers = board && finType !== 'none' ? finsFor(finType, board) : undefined;

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
  const weight = useMemo(
    () =>
      settledBoard && specs
        ? estimateWeight(
            specs.volume / 1000,
            getArea(settledBoard) / 10000,
            foamType,
            glassSchedule,
          )
        : null,
    [settledBoard, specs, foamType, glassSchedule],
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
      fins: kind === 'outline' ? finMarkers : undefined,
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

  /** Open a print-friendly spec sheet (board info + dimensions) in a new window. */
  const openSpecSheet = () => {
    if (!specs) return;
    const html = specSheetHtml({
      title: meta.model || 'Surfboard',
      designer: meta.designer,
      info: (['designer', 'model', 'surfer', 'comments'] as const)
        .map((k) => [k[0]!.toUpperCase() + k.slice(1), meta[k] ?? ''] as [string, string])
        .filter(([, v]) => v),
      rows: [
        ['Length', fmtLen(specs.length, units)],
        ['Width', fmtLen(specs.maxWidth, units)],
        ['Thickness', fmtLen(specs.thickness, units)],
        ['Wide point', fmtLen(specs.maxWidthPos, units)],
        ['Max rocker', fmtLen(specs.maxRocker, units)],
        ['Volume', fmtVol(specs.volume)],
        ['Center of mass', fmtLen(specs.centerOfMass, units)],
      ],
    });
    const w = window.open('', '_blank');
    if (!w) {
      alert('Pop-up blocked — allow pop-ups to open the spec sheet.');
      return;
    }
    w.document.write(html);
    w.document.close();
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
    } catch (err) {
      console.error('Failed to open board', err);
      alert(`Could not open ${file.name}: ${(err as Error).message}`);
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
      alert(`Could not open ${file.name}: ${(err as Error).message}`);
    }
  };

  // New board from a type template — loads the authentic legacy .brd geometry.
  const newFromTemplate = (name: string) => {
    const t = BOARD_TEMPLATES.find((x) => x.name === name);
    if (!t) return;
    try {
      boardStore.getState().load(parseBrd(t.brd).board);
      setMeta({ model: t.name });
      setGhost(null);
    } catch (err) {
      console.error('Failed to load template', err);
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
      onSelect: () => board && downloadBoard(board, meta),
    },
    { kind: 'separator' },
    { kind: 'action', label: 'Load trace image…', onSelect: () => traceInput.current?.click() },
    { kind: 'separator' },
    { kind: 'label', label: 'Export' },
    ...(['stl', 'dxf', 'pdf'] as ExportFormat[]).map((f) => ({
      kind: 'action' as const,
      label: f.toUpperCase(),
      disabled: !board,
      onSelect: () =>
        board &&
        exportBoard(
          board as Parameters<typeof exportBoard>[0],
          f,
          meta,
          units.unit === Unit.INCHES ? 'in' : 'cm',
        ),
    })),
    { kind: 'action', label: 'Spec sheet…', disabled: !specs, onSelect: openSpecSheet },
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

  const templatesMenu: MenuItem[] = [
    { kind: 'label', label: 'Construction' },
    {
      kind: 'action',
      label: 'Hollow Wood Frame…',
      disabled: !board,
      onSelect: () => setTemplateKind('hws'),
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col border-b border-border bg-card text-card-foreground">
        {/* Row 1 — application menubar */}
        <div className="flex h-11 items-center gap-2 px-2">
          <a
            href="/"
            className="group flex items-center gap-2 px-1.5 font-semibold transition-colors hover:text-primary"
            title="OpenShaper home"
          >
            <Brandmark className="h-6 w-6 transition-transform duration-300 group-hover:rotate-3" />
            <span>
              Open<span className="text-primary">Shaper</span>
            </span>
          </a>
          <ToolbarSeparator />
          <MenuBar>
            <Menu label="File" items={fileMenu} />
            <Menu label="Edit" items={editMenu} />
            <Menu label="View" items={viewMenu} />
            <Menu label="Board" items={boardMenu} />
            <Menu label="Templates" items={templatesMenu} />
            <Menu label="Help" items={helpMenu} />
          </MenuBar>
          <div className="flex-1" />
          {SUPPORT_URL && (
            <a
              href={SUPPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} text-primary hover:text-primary`}
              title="Buy me a coffee — OpenShaper is free & open-source"
            >
              <CoffeeIcon className="size-4" />
              Coffee
            </a>
          )}
        </div>

        {/* Row 2 — view tabs */}
        <div className="flex h-11 items-center gap-1 border-t border-border px-2">
          {tab('quad', 'Quad')}
          {tab('outline', 'Outline')}
          {tab('rocker', 'Rocker')}
          {tab('crossSection', 'Cross-section')}
          {tab('3d', '3D')}
          <div className="flex-1" />
          <select
            value={unitKey}
            onChange={(e) => setUnitKey(e.target.value)}
            title="Display units"
            className="h-8 rounded-md border border-border bg-transparent px-2 text-sm"
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
          </select>
        </div>

        {/* Hidden file inputs (the trace input lives in the Sidebar, sharing traceInput). */}
        <input
          ref={fileInput}
          type="file"
          accept=".board.json,.json,.brd"
          className="hidden"
          onChange={onOpenFile}
        />
        <input
          ref={ghostInput}
          type="file"
          accept=".board.json,.json,.brd"
          className="hidden"
          onChange={onOpenGhost}
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="min-h-0 flex-1">
          {view === 'quad' ? (
            <div className="grid h-full grid-cols-2 grid-rows-2 gap-3">
              <EditorPane
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
              />
              <EditorPane
                title={csTitle}
                kind="crossSection"
                csIndex={clampedCs}
                units={units}
                overlays={overlaysFor('crossSection')}
                ghostSplines={ghostSplinesFor('crossSection')}
                headerActions={csControls}
              />
              <EditorPane
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
              />
              <Panel className="flex min-h-0 flex-col">
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
                    analysis={view3d.analysis}
                    targetFaceSize={faceSizeFor(view3d.meshQuality)}
                    sectionX={sectionX}
                  />
                </PanelBody>
              </Panel>
            </div>
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
              headerActions={view === 'crossSection' ? csControls : undefined}
            />
          )}
        </div>

        <Sidebar
          specs={specs}
          units={units}
          interpolationType={board?.interpolationType ?? 'controlPoint'}
          resize={resize}
          setResize={setResize}
          applyResize={applyResize}
          meta={meta}
          setMeta={setMeta}
          finType={finType}
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
      </div>

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
