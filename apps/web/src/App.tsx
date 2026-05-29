import { parseBrd } from '@board-studio/io';
import { SplineEditor } from '@board-studio/render2d';
import { selectSpecs, type SplineTarget } from '@board-studio/store';
import {
  Button,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Toolbar,
  ToolbarSeparator,
} from '@board-studio/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';

type EditorKind = 'outline' | 'rocker' | 'crossSection';
type View = 'quad' | EditorKind;

const cm = (v: number) => `${v.toFixed(2)} cm`;
const inches = (v: number) => `${(v / 2.54).toFixed(2)}"`;

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
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

function EditorPane({ title, kind, csIndex }: { title: string; kind: EditorKind; csIndex: number }) {
  const p = paneProps(kind, csIndex);
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBody className="min-h-0 flex-1 p-0">
        <SplineEditor
          key={p.key}
          store={boardStore}
          targets={p.targets}
          mirrorY={p.mirrorY}
          mirrorX={p.mirrorX}
        />
      </PanelBody>
    </Panel>
  );
}

export function App() {
  const board = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().board);
  // Re-render on history changes so undo/redo buttons enable/disable.
  useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().past.length);

  useEffect(() => {
    if (boardStore.getState().board) return;
    try {
      const { board } = parseBrd(sampleBrd);
      boardStore.getState().load(board);
    } catch (e) {
      console.error('Failed to load sample board', e);
    }
  }, []);

  const specs = board ? selectSpecs(board) : null;
  const s = boardStore.getState();
  const [view, setView] = useState<View>('quad');
  const [csIndex, setCsIndex] = useState(1);

  const sectionCount = board?.crossSections.length ?? 0;
  const lastReal = Math.max(1, sectionCount - 2);
  const clampedCs = Math.min(Math.max(csIndex, 1), lastReal);

  const tab = (v: View, label: string) => (
    <Button size="sm" variant={view === v ? 'secondary' : 'ghost'} onClick={() => setView(v)}>
      {label}
    </Button>
  );

  const csTitle = `Cross-section ${clampedCs} / ${lastReal}`;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="px-2 font-semibold">Board Studio</span>
        <ToolbarSeparator />
        {tab('quad', 'Quad')}
        {tab('outline', 'Outline')}
        {tab('rocker', 'Rocker')}
        {tab('crossSection', 'Cross-section')}
        <Button size="sm" variant="ghost" disabled>
          3D
        </Button>
        <ToolbarSeparator />
        {view === 'crossSection' && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={clampedCs <= 1}
              onClick={() => setCsIndex(clampedCs - 1)}
            >
              ‹ Prev
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={clampedCs >= lastReal}
              onClick={() => setCsIndex(clampedCs + 1)}
            >
              Next ›
            </Button>
            <ToolbarSeparator />
          </>
        )}
        <Button size="sm" variant="ghost" disabled={!s.canUndo()} onClick={() => s.undo()}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" disabled={!s.canRedo()} onClick={() => s.redo()}>
          Redo
        </Button>
        <div className="flex-1" />
        <Button size="sm" disabled>
          New board
        </Button>
      </Toolbar>

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="min-h-0 flex-1">
          {view === 'quad' ? (
            <div className="grid h-full grid-cols-2 grid-rows-2 gap-3">
              <EditorPane title="Outline" kind="outline" csIndex={clampedCs} />
              <EditorPane title={csTitle} kind="crossSection" csIndex={clampedCs} />
              <EditorPane title="Rocker (deck + bottom)" kind="rocker" csIndex={clampedCs} />
              <Panel className="flex items-center justify-center text-sm text-muted-foreground">
                3D view — coming soon
              </Panel>
            </div>
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
            />
          )}
        </div>

        <Panel className="w-72 shrink-0">
          <PanelHeader>
            <PanelTitle>Specs</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1 text-sm">
            {specs ? (
              <>
                <SpecRow label="Length" value={`${inches(specs.length)} (${cm(specs.length)})`} />
                <SpecRow label="Width" value={`${inches(specs.maxWidth)} (${cm(specs.maxWidth)})`} />
                <SpecRow
                  label="Thickness"
                  value={`${inches(specs.thickness)} (${cm(specs.thickness)})`}
                />
                <SpecRow label="Wide point" value={cm(specs.maxWidthPos)} />
                <SpecRow label="Max rocker" value={cm(specs.maxRocker)} />
                <SpecRow label="Volume" value={`${specs.volumeLiters.toFixed(1)} L`} />
                <SpecRow label="Center of mass" value={cm(specs.centerOfMass)} />
                <p className="pt-2 text-xs text-muted-foreground">
                  Live from the kernel — every pane edits the same board, so changes sync
                  across views and the specs update instantly.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Loading…</p>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
