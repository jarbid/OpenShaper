// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental NURBS viewer's layer over the 3D pane (docs/design/m1-model.md §3): it
 * feeds the live board to the viewer, hands the 3D view the NURBS surface when there is
 * one, and draws the badge, the Classic / NURBS toggle, the test-board picker, the
 * status line and the "i" popover.
 *
 * Loaded lazily (`ThreeDPane` in App.tsx) and only with the engine flag on, so none
 * of this, nor the worker it starts, is downloaded otherwise.
 */
import { isExactAnalysis, type Board3DViewProps, type ExternalSurface } from '@openshaper/render3d';
import type { BoardState } from '@openshaper/store';
import { Info, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { fmtSmallLen, fmtVol, type LengthUnit } from './format';
import { createNurbsClient } from './nurbs-client';
import { registerNurbsRelease } from './nurbs-session';
import { surfaceOf } from './nurbs-surface';
import { localizeLengths, refusalHint, statusText } from './nurbs-text';
import { createNurbsViewer, type NurbsViewer, type ViewerState } from './nurbs-viewer';
import { TEST_BOARDS, type TestBoardName } from './workers/nurbs-protocol';

/** One viewer for the session, so its cache outlives the pane being remounted. */
let shared: NurbsViewer | null = null;
const sharedViewer = (): NurbsViewer => {
  if (!shared) {
    const viewer = createNurbsViewer({ client: createNurbsClient() });
    shared = viewer;
    // Turning the engine off (nurbs-session.ts) disposes it: worker, jobs and caches.
    registerNurbsRelease(() => {
      viewer.dispose();
      if (shared === viewer) shared = null;
    });
  }
  return shared;
};

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

// --- Test board shown instead of the classic board, kept across remounts -----

let testChoice: TestBoardName | null = null;
const testListeners = new Set<() => void>();
const setTestChoice = (next: TestBoardName | null): void => {
  testChoice = next;
  for (const l of [...testListeners]) l();
};
const subscribeTest = (l: () => void) => {
  testListeners.add(l);
  return () => void testListeners.delete(l);
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

const ms = (v: number): string => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);

function InfoPanel({ state, units }: { state: ViewerState; units: LengthUnit }) {
  const { model, issues, error } = state;
  const warnings = issues.filter((i) => i.severity === 'warning');
  const errors = issues.filter((i) => i.severity === 'error');
  const summary = model?.summary;
  const conversion = summary?.conversion;
  return (
    <div
      role="dialog"
      aria-label="NURBS conversion details"
      data-testid="nurbs-info"
      className="mt-1 max-h-72 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border border-border bg-card/95 px-2 py-1.5 text-xs text-card-foreground shadow-lg"
    >
      {error && (
        <p className="text-red-400" data-testid="nurbs-refusal">
          <strong>The NURBS model cannot hold this board yet.</strong> The classic mesh is shown.
        </p>
      )}
      {errors.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {errors.map((i, k) => {
            const hint = refusalHint(i.code);
            return (
              <li key={k}>
                {hint && <span className="block">{hint}</span>}
                <span className="text-muted-foreground">
                  <span className="font-mono">{i.code}</span> {localizeLengths(i.message, units)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && errors.length === 0 && (
        <p className="mt-1 text-muted-foreground">{localizeLengths(error, units)}</p>
      )}
      {model && summary && (
        <>
          <p>
            {summary.source === 'test' ? (
              <>
                This is one of the NURBS <strong>test boards</strong>, shown on its own. It is not
                your board, and the classic editors do not change it.
              </>
            ) : (
              <>
                The NURBS surface is built from the classic board&apos;s outline, rocker, deck and
                cross-sections. It matches them at the stations and differs between them by design.
                Use <strong>Deviation from classic</strong> to see where.
              </>
            )}
          </p>
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 tabular-nums">
            <dt>Volume</dt>
            <dd>{fmtVol(summary.volume)}</dd>
            {conversion && (
              <>
                <dt>Stations</dt>
                <dd>{conversion.stations}</dd>
                <dt>Tail</dt>
                <dd>{conversion.tail === 'notched' ? 'notched (swallow / fish)' : 'standard'}</dd>
              </>
            )}
            <dt>Station fit</dt>
            <dd>{fmtSmallLen(summary.stationFitError, units)}</dd>
            {summary.blendOvershoot > 0 && (
              <>
                <dt>Blend overshoot (clamped)</dt>
                <dd>{fmtSmallLen(summary.blendOvershoot, units)}</dd>
              </>
            )}
          </dl>
          <p className="mt-1 text-muted-foreground tabular-nums">
            Last update {ms(model.roundTripMs)}: converted {ms(model.timings.convertMs)}, built{' '}
            {ms(model.timings.buildMs)}, meshed {ms(model.timings.meshMs)} (
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
  /**
   * The analysis mode shown: an exact curvature mode has curvature computed on every
   * update, "Deviation from classic" the deviation.
   */
  analysis: NonNullable<Board3DViewProps['analysis']>;
  units: LengthUnit;
  /** Receives the surface to draw (null: draw the classic hull). */
  onSurface: (surface: ExternalSurface | null) => void;
  /** Tests inject their own; the app uses the session's shared viewer. */
  viewer?: NurbsViewer;
}

export default function NurbsLayer({
  store,
  analysis,
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
  const testBoard = useSyncExternalStore(
    subscribeTest,
    () => testChoice,
    () => null,
  );
  const [infoOpen, setInfoOpen] = useState(false);
  const wantCurvature = isExactAnalysis(analysis);
  const wantDeviation = analysis === 'nurbs-deviation';

  // Feed the live board to the viewer without re-rendering on every drag move: every
  // change converts at once (the section model takes milliseconds).
  useEffect(() => {
    const push = () => {
      const s = store.getState();
      viewer.setInput({
        enabled: true,
        board: s.board,
        editing: s.editing,
        wantCurvature,
        wantDeviation,
        testBoard,
      });
    };
    push();
    const unsubscribe = store.subscribe(push);
    return () => {
      unsubscribe();
      viewer.pause();
    };
  }, [store, viewer, wantCurvature, wantDeviation, testBoard]);

  // The surface the 3D view should draw.
  const model = state.model;
  const surface: ExternalSurface | null = showing === 'nurbs' && model ? surfaceOf(model) : null;
  useEffect(() => {
    onSurface(surface);
  }, [surface, onSurface]);
  useEffect(() => () => onSurface(null), [onSurface]);

  const elapsed = useElapsed(state.job?.startedAt ?? null);
  const hasDetails = !!(state.model || state.error || state.issues.length);
  const shownTest = model?.testBoard ?? null;
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
          // Timings of the update on screen, for the browser measurement script.
          data-update={model?.sequence}
          data-round-trip-ms={model ? model.roundTripMs : undefined}
          data-worker-ms={model ? model.timings.totalMs.toFixed(1) : undefined}
          data-convert-ms={model ? model.timings.convertMs.toFixed(1) : undefined}
          data-build-ms={model ? model.timings.buildMs.toFixed(1) : undefined}
          data-mesh-ms={model ? model.timings.meshMs.toFixed(1) : undefined}
          data-curvature-ms={model ? model.timings.curvatureMs.toFixed(1) : undefined}
          data-deviation-ms={model ? model.timings.deviationMs.toFixed(1) : undefined}
          data-ladders-reused={model ? String(model.mesh.laddersReused) : undefined}
          data-test-board={shownTest ?? undefined}
          data-vertices={model ? model.mesh.positions.length / 3 : undefined}
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
      <label className="flex items-center gap-1 rounded-md border border-border bg-card/90 px-2 py-1 text-muted-foreground shadow-lg pointer-coarse:min-h-11">
        <span>Test board</span>
        <select
          data-testid="nurbs-test-board"
          aria-label="NURBS test board (experimental)"
          title="Show one of the NURBS test boards instead of your board. Experimental, display only: the classic editors keep editing your board."
          value={testBoard ?? ''}
          onChange={(e) => setTestChoice((e.target.value || null) as TestBoardName | null)}
          className="rounded border border-border bg-background px-1 py-0.5 text-foreground"
        >
          <option value="">My board</option>
          {TEST_BOARDS.map((n) => (
            <option key={n} value={n}>
              {n[0]!.toUpperCase() + n.slice(1)}
            </option>
          ))}
        </select>
      </label>
      {statusText(state, surface ? 'nurbs' : 'classic', elapsed, shownTest) && (
        <div
          role="status"
          data-testid="nurbs-status"
          className="flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2 py-1 text-muted-foreground shadow-lg"
        >
          {state.job && <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />}
          {statusText(state, surface ? 'nurbs' : 'classic', elapsed, shownTest)}
        </div>
      )}
      {infoOpen && hasDetails && <InfoPanel state={state} units={units} />}
    </div>
  );
}
