// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental NURBS viewer's layer over the 3D pane (docs/design/board2.md, "V1
 * viewer"): it feeds the live board to the viewer, hands the 3D view the NURBS surface
 * when there is one for the board on screen, and draws the badge, the Classic / NURBS
 * toggle, the progress line and the "i" popover.
 *
 * Loaded lazily (`ThreeDPane` in App.tsx) and only with the engine flag on, so none
 * of this, nor the worker it starts, is downloaded otherwise.
 */
import { sameHull, type ExternalSurface } from '@openshaper/render3d';
import type { BoardState } from '@openshaper/store';
import { Info, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { fmtSmallLen, type LengthUnit } from './format';
import { createNurbsClient } from './nurbs-client';
import { surfaceOf } from './nurbs-surface';
import { localizeLengths, statusText } from './nurbs-text';
import { createNurbsViewer, type NurbsViewer, type ViewerState } from './nurbs-viewer';

/** One viewer for the session, so its cache outlives the pane being remounted. */
let shared: NurbsViewer | null = null;
const sharedViewer = (): NurbsViewer =>
  (shared ??= createNurbsViewer({ client: createNurbsClient() }));

// --- Classic / NURBS choice, kept across remounts ----------------------------

export type ShownEngine = 'nurbs' | 'classic';
let choice: ShownEngine = 'nurbs';
const choiceListeners = new Set<() => void>();
const setChoice = (next: ShownEngine): void => {
  choice = next;
  for (const l of [...choiceListeners]) l();
};
const subscribeChoice = (l: () => void) => {
  choiceListeners.add(l);
  return () => void choiceListeners.delete(l);
};

/** Milliseconds since `since`, ticking while it is set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function InfoPanel({ state, units }: { state: ViewerState; units: LengthUnit }) {
  const { model, issues, error } = state;
  const warnings = issues.filter((i) => i.severity === 'warning');
  const errors = issues.filter((i) => i.severity === 'error');
  return (
    <div
      role="dialog"
      aria-label="NURBS conversion details"
      data-testid="nurbs-info"
      className="mt-1 max-h-72 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border border-border bg-card/95 px-2 py-1.5 text-xs text-card-foreground shadow-lg"
    >
      {error && (
        <p className="text-red-400">
          <strong>Conversion failed:</strong> {localizeLengths(error, units)}. The classic mesh is
          shown.
        </p>
      )}
      {errors.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {errors.map((i, k) => (
            <li key={k}>
              <span className="font-mono">{i.code}</span> {localizeLengths(i.message, units)}
            </li>
          ))}
        </ul>
      )}
      {model && (
        <>
          <p>
            The NURBS surface is converted from the classic board, so it differs from it by the fit.
            Use <strong>Deviation from classic</strong> to see where.
          </p>
          {model.summary && (
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 tabular-nums">
              <dt>Outline fit</dt>
              <dd>{fmtSmallLen(model.summary.planError, units)}</dd>
              <dt>Rocker fit</dt>
              <dd>{fmtSmallLen(model.summary.rockerError, units)}</dd>
              <dt>Deck fit</dt>
              <dd>{fmtSmallLen(model.summary.deckSurfaceError, units)}</dd>
              <dt>Bottom fit</dt>
              <dd>{fmtSmallLen(model.summary.bottomSurfaceError, units)}</dd>
              <dt>Rail fit</dt>
              <dd>{fmtSmallLen(model.summary.bandError, units)}</dd>
            </dl>
          )}
          <p className="mt-1 text-muted-foreground tabular-nums">
            Converted in {sec(model.timings.convertMs)}, meshed in{' '}
            {sec(model.timings.tessellateMs + model.timings.deviationMs)} (
            {(model.mesh.positions.length / 3).toLocaleString('en-US')} vertices).
          </p>
        </>
      )}
      <p className="mt-1 font-medium">
        {warnings.length > 0
          ? `Warnings (${warnings.length})`
          : model
            ? 'No warnings.'
            : 'No further details.'}
      </p>
      {warnings.length > 0 && (
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
          {warnings.map((i, k) => (
            <li key={k}>
              <span className="font-mono">{i.code}</span> {localizeLengths(i.message, units)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface NurbsLayerProps {
  store: StoreApi<BoardState>;
  /** The viewport face size (cm) the surface is meshed for. */
  faceSize: number;
  units: LengthUnit;
  /** Receives the surface to draw (null: draw the classic hull). */
  onSurface: (surface: ExternalSurface | null) => void;
  /** Tests inject their own; the app uses the session's shared viewer. */
  viewer?: NurbsViewer;
}

export default function NurbsLayer({
  store,
  faceSize,
  units,
  onSurface,
  viewer: injected,
}: NurbsLayerProps) {
  const viewer = injected ?? sharedViewer();
  const state = useSyncExternalStore(viewer.subscribe, viewer.getState, viewer.getState);
  const showing = useSyncExternalStore(
    subscribeChoice,
    () => choice,
    () => 'nurbs' as const,
  );
  const [infoOpen, setInfoOpen] = useState(false);

  // Feed the live board to the viewer without re-rendering on every drag move.
  useEffect(() => {
    const push = () => {
      const s = store.getState();
      viewer.setInput({ enabled: true, board: s.board, faceSize, editing: s.editing });
    };
    push();
    const unsubscribe = store.subscribe(push);
    return () => {
      unsubscribe();
      // Leaving the 3D pane stops the quiet-period timer but lets a running
      // conversion finish into the cache, so coming back does not start over.
      viewer.pause();
    };
  }, [store, viewer, faceSize]);

  // The surface the 3D view should draw: only for the board on screen.
  const model = state.model;
  const board = state.board;
  const surface: ExternalSurface | null =
    showing === 'nurbs' && model && board && sameHull(model.board, board) ? surfaceOf(model) : null;
  useEffect(() => {
    onSurface(surface);
  }, [surface, onSurface]);
  useEffect(() => () => onSurface(null), [onSurface]);

  const elapsed = useElapsed(state.job?.startedAt ?? null);
  const hasDetails = !!(state.model || state.error || state.issues.length);
  const warnings = state.issues.filter((i) => i.severity === 'warning').length;
  const ready = state.phase === 'ready';
  const toggle = useCallback((next: ShownEngine) => setChoice(next), []);

  return (
    <div
      className="absolute right-2 top-2 z-[2] flex max-w-[calc(100%-1rem)] flex-col items-end gap-1 text-xs"
      data-testid="nurbs-layer"
    >
      <div className="flex items-center gap-1">
        <span
          data-testid="nurbs-badge"
          data-phase={state.phase}
          data-showing={surface ? 'nurbs' : 'classic'}
          className="rounded-md border border-amber-500/60 bg-card/90 px-2 py-1 font-medium text-amber-300 shadow-lg"
        >
          NURBS (experimental) — read-only
        </span>
        {hasDetails && (
          <button
            type="button"
            aria-label="NURBS conversion details"
            aria-expanded={infoOpen}
            title={
              warnings > 0 || state.error
                ? `NURBS conversion details (${state.error ? 'failed' : `${warnings} warning${warnings === 1 ? '' : 's'}`})`
                : 'NURBS conversion details'
            }
            onClick={() => setInfoOpen((o) => !o)}
            onKeyDown={(e) => e.key === 'Escape' && setInfoOpen(false)}
            className="relative grid size-7 place-items-center rounded-md border border-border bg-card/90 text-foreground shadow-lg hover:bg-card pointer-coarse:size-11"
          >
            <Info aria-hidden="true" className="size-4" />
            {(warnings > 0 || state.error) && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-400"
              />
            )}
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label="Engine shown in the 3D view"
        className="flex overflow-hidden rounded-md border border-border bg-card/90 shadow-lg"
      >
        {(['classic', 'nurbs'] as const).map((e) => (
          <button
            key={e}
            type="button"
            aria-pressed={showing === e}
            disabled={e === 'nurbs' && !ready}
            onClick={() => toggle(e)}
            title={
              e === 'nurbs'
                ? ready
                  ? 'Show the NURBS surface'
                  : 'The NURBS surface is not ready yet'
                : 'Show the classic mesh'
            }
            className={`px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:px-3 ${
              showing === e ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground'
            } disabled:opacity-50`}
          >
            {e === 'nurbs' ? 'NURBS' : 'Classic'}
          </button>
        ))}
      </div>
      {statusText(state, surface ? 'nurbs' : 'classic', elapsed) && (
        <div
          role="status"
          data-testid="nurbs-status"
          className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-muted-foreground shadow-lg"
        >
          {state.job && <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />}
          {statusText(state, surface ? 'nurbs' : 'classic', elapsed)}
        </div>
      )}
      {infoOpen && hasDetails && <InfoPanel state={state} units={units} />}
    </div>
  );
}
