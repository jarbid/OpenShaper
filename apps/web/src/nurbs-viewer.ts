// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental NURBS viewer's state machine (docs/design/board2.md, "V1 viewer"):
 * which classic board is converted, when, and what the 3D view may show of it. Plain
 * TypeScript with an injectable client, clock and timers, so the protocol (debounce,
 * supersession, caching) is testable without React, a worker or a 15 s conversion.
 *
 * ## Rules
 *
 * - **Convert after edits settle.** A change to the board's hull (outline, rocker
 *   curves, cross-sections: `sameHull`) starts a timer of {@link DEBOUNCE_MS}; every
 *   further hull change, and any moment the store is mid-gesture (`editing`), restarts
 *   it. A fin edit leaves the hull alone and costs nothing.
 * - **Drop superseded jobs.** A hull change while a conversion runs cancels it (the
 *   client terminates the worker); the classic mesh is on screen meanwhile.
 * - **Cache by identity.** A converted (or failed) hull is remembered, a few at a
 *   time, so undo, a view switch or a remount shows it again without converting. A
 *   change of mesh quality re-meshes the held model without converting.
 * - **Read-only.** Nothing here writes to the board or the store.
 */
import { sameHull } from '@openshaper/render3d';
import type { BezierBoard } from '@openshaper/kernel';
import { SupersededError, type NurbsClient } from './nurbs-client';
import type {
  NurbsIssue,
  NurbsMeshData,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
} from './workers/nurbs-protocol';

/** How long the hull must stay unchanged before a conversion starts (ms). */
export const DEBOUNCE_MS = 1200;

/** Converted boards kept for undo and view switches (each ~3 MB of meshes). */
export const CACHE_SIZE = 3;

/** A converted board. */
export interface NurbsModel {
  readonly modelId: number;
  /** The classic board it was converted from. */
  readonly board: BezierBoard;
  readonly docJson: string;
  readonly issues: readonly NurbsIssue[];
  readonly summary: NurbsSummary | null;
  /** The timings of the conversion itself (a re-mesh does not replace them). */
  readonly timings: NurbsTimings;
  /** The latest mesh, at the face size it was made for. */
  readonly mesh: NurbsMeshData;
}

export type ViewerPhase = 'idle' | 'waiting' | 'converting' | 'ready' | 'failed';

export interface ViewerJob {
  readonly kind: 'convert' | 'mesh';
  /** `now()` when it started, for the elapsed-time readout. */
  readonly startedAt: number;
  readonly stage: NurbsStage;
}

export interface ViewerState {
  readonly phase: ViewerPhase;
  /** The latest classic board given to the viewer. */
  readonly board: BezierBoard | null;
  /** The job in flight, if any. */
  readonly job: ViewerJob | null;
  /** The converted model for `board`'s hull, once there is one. */
  readonly model: NurbsModel | null;
  /** Why the conversion of `board`'s hull failed. */
  readonly error: string | null;
  /** The issues of the conversion (or of its failure). */
  readonly issues: readonly NurbsIssue[];
}

export const VIEWER_IDLE: ViewerState = {
  phase: 'idle',
  board: null,
  job: null,
  model: null,
  error: null,
  issues: [],
};

export interface ViewerInput {
  readonly enabled: boolean;
  readonly board: BezierBoard | null;
  /** The viewport face size (cm) the surface is meshed for. */
  readonly faceSize: number;
  /** The store is mid-gesture (a drag): the board is not settled. */
  readonly editing: boolean;
}

interface CacheEntry {
  readonly board: BezierBoard;
  model: NurbsModel | null;
  error: string | null;
  issues: readonly NurbsIssue[];
  /** A face size whose re-mesh failed: not retried until the quality changes again. */
  meshFailedAt?: number;
}

export interface ViewerDeps {
  readonly client: NurbsClient;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly debounceMs?: number;
}

export interface NurbsViewer {
  getState(): ViewerState;
  subscribe(listener: () => void): () => void;
  setInput(input: ViewerInput): void;
  /**
   * The view that feeds this viewer went away (the 3D pane unmounted): stop the quiet
   * period so no conversion starts for a board nobody is watching. A conversion
   * already running finishes into the cache; the next `setInput` picks up from there.
   */
  pause(): void;
  dispose(): void;
}

export function createNurbsViewer(deps: ViewerDeps): NurbsViewer {
  const { client } = deps;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;

  let state: ViewerState = VIEWER_IDLE;
  const listeners = new Set<() => void>();
  let input: ViewerInput = { enabled: false, board: null, faceSize: 0.9, editing: false };
  const cache: CacheEntry[] = [];
  let timer: unknown = null;
  let nextModelId = 0;
  // The job in flight and what it is for: lets a repeated input (a fin edit, a
  // re-render) leave it alone, and a hull change cancel it.
  let running: { kind: 'convert' | 'mesh'; board: BezierBoard; faceSize: number } | null = null;

  const set = (patch: Partial<ViewerState>): void => {
    const next = { ...state, ...patch };
    const same = (Object.keys(next) as (keyof ViewerState)[]).every((k) => next[k] === state[k]);
    if (same) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  const clearTimerIfAny = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const remember = (entry: CacheEntry): void => {
    const i = cache.indexOf(entry);
    if (i !== -1) cache.splice(i, 1);
    cache.push(entry);
    while (cache.length > CACHE_SIZE) cache.shift();
  };

  const find = (board: BezierBoard): CacheEntry | undefined =>
    cache.find((e) => sameHull(e.board, board));

  const cancelRunning = (): void => {
    if (!running) return;
    running = null;
    client.cancel();
  };

  const startConvert = (board: BezierBoard, faceSize: number): void => {
    const modelId = ++nextModelId;
    const job: ViewerJob = { kind: 'convert', startedAt: now(), stage: 'converting' };
    running = { kind: 'convert', board, faceSize };
    const me = running;
    set({ phase: 'converting', job, model: null, error: null, issues: [] });
    client
      .convert(modelId, board, faceSize, (stage) => {
        if (running === me && state.job) set({ job: { ...state.job, stage } });
      })
      .then((answer) => {
        if (running !== me) return;
        running = null;
        const entry: CacheEntry = { board, model: null, error: null, issues: answer.issues };
        if (answer.ok) {
          entry.model = {
            modelId: answer.modelId,
            board,
            docJson: answer.docJson,
            issues: answer.issues,
            summary: answer.summary,
            timings: answer.timings,
            mesh: answer.mesh,
          };
        } else {
          entry.error = answer.error;
        }
        remember(entry);
        reconcile();
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError || running !== me) return;
        running = null;
        const entry: CacheEntry = {
          board,
          model: null,
          error: err instanceof Error ? err.message : String(err),
          issues: [],
        };
        remember(entry);
        reconcile();
      });
  };

  const startMesh = (entry: CacheEntry, faceSize: number): void => {
    const model = entry.model!;
    const job: ViewerJob = { kind: 'mesh', startedAt: now(), stage: 'meshing' };
    running = { kind: 'mesh', board: entry.board, faceSize };
    const me = running;
    set({ job });
    client
      .mesh(model.modelId, model.docJson, entry.board, faceSize, (stage) => {
        if (running === me && state.job) set({ job: { ...state.job, stage } });
      })
      .then((answer) => {
        if (running !== me) return;
        running = null;
        if (answer.ok) {
          entry.model = { ...model, mesh: answer.mesh };
        } else {
          // Keep the surface we have; say why the new density did not arrive.
          entry.issues = [...entry.issues, ...answer.issues];
          entry.meshFailedAt = faceSize;
        }
        reconcile();
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError || running !== me) return;
        running = null;
        entry.meshFailedAt = faceSize;
        reconcile();
      });
  };

  /**
   * Bring the state in line with the input and the cache: the one place that decides
   * what to do next. Idempotent, so every event just calls it.
   */
  function reconcile(): void {
    const { enabled, board, faceSize, editing } = input;
    if (!enabled || !board) {
      clearTimerIfAny();
      cancelRunning();
      set({ ...VIEWER_IDLE, board });
      return;
    }
    const entry = find(board);
    if (entry) {
      // The hull is known. Whatever was converting for another hull is moot.
      clearTimerIfAny();
      if (running && !sameHull(running.board, board)) cancelRunning();
      if (entry.model) {
        const stale = entry.model.mesh.faceSize !== faceSize && entry.meshFailedAt !== faceSize;
        if (stale && !(running?.kind === 'mesh' && running.faceSize === faceSize)) {
          cancelRunning();
          startMesh(entry, faceSize);
        } else if (!stale && running?.kind === 'mesh') {
          cancelRunning();
        }
        set({
          phase: 'ready',
          board,
          job: running ? state.job : null,
          model: entry.model,
          error: null,
          issues: entry.issues,
        });
        return;
      }
      cancelRunning();
      set({
        phase: 'failed',
        board,
        job: null,
        model: null,
        error: entry.error,
        issues: entry.issues,
      });
      return;
    }
    // A hull never converted.
    if (running && sameHull(running.board, board)) {
      // Already converting this very hull (a non-hull edit, a re-render): carry on.
      set({ board });
      return;
    }
    cancelRunning();
    if (editing) {
      clearTimerIfAny();
      set({ phase: 'waiting', board, job: null, model: null, error: null, issues: [] });
      return;
    }
    // Settled: (re)start the quiet period. A change of hull restarts it; the same
    // hull again (a fin edit) leaves the running timer alone.
    if (timer === null || state.board === null || !sameHull(state.board, board)) {
      clearTimerIfAny();
      timer = setTimer(() => {
        timer = null;
        const b = input.board;
        if (!input.enabled || !b || input.editing || find(b) || running) return;
        startConvert(b, input.faceSize);
      }, debounceMs);
    }
    set({ phase: 'waiting', board, job: null, model: null, error: null, issues: [] });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInput(next) {
      input = next;
      reconcile();
    },
    pause: clearTimerIfAny,
    dispose() {
      clearTimerIfAny();
      cancelRunning();
      listeners.clear();
      client.dispose();
    },
  };
}
