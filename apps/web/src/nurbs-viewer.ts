// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental NURBS viewer's state machine (docs/design/m1-model.md §3): which
 * board is converted, when, and what the 3D view may show of it. Plain TypeScript with
 * an injectable client, clock and timers, so the protocol (supersession, ladder reuse)
 * is testable without React or a worker.
 *
 * ## Rules
 *
 * - **Every edit converts at once.** The section model converts, builds and meshes in
 *   milliseconds, so there is no quiet period and no "not while dragging" gate: a change
 *   to the board's hull (outline, rocker curves, cross-sections: `sameHull`) starts a
 *   job immediately. A fin edit leaves the hull alone and costs nothing.
 * - **Newest wins.** A job is never awaited: a hull change while one runs replaces it
 *   (the client drops the stale answer). The surface on screen is the last answer, so a
 *   drag never falls back to the classic mesh between answers.
 * - **Settle.** While the store is mid-gesture (`editing`) a job reuses the last mesh's
 *   ladders (cheap) and leaves out curvature unless an exact mode shows it. When the
 *   gesture ends one more job runs: fresh ladders, curvature included.
 * - **Refusals.** A board the converter refuses leaves no model: the classic mesh is
 *   shown and the reasons are in {@link ViewerState.issues}.
 * - **Test boards.** With a test board chosen the viewer ignores the classic board and
 *   shows board2's test board (a standalone surface).
 * - **Read-only.** Nothing here writes to the board or the store.
 */
import { sameHull } from '@openshaper/render3d';
import type { BezierBoard } from '@openshaper/kernel';
import { SupersededError, type NurbsClient } from './nurbs-client';
import type {
  JobOptions,
  NurbsIssue,
  NurbsMeshData,
  NurbsSummary,
  NurbsTimings,
  TestBoardName,
} from './workers/nurbs-protocol';

/** A job still running after this long shows as busy in the status line (ms). */
export const BUSY_AFTER_MS = 250;

/** The surface on screen. */
export interface NurbsModel {
  /** The classic board it was converted from; null for a test board. */
  readonly board: BezierBoard | null;
  /** The test board it shows, when it is one. */
  readonly testBoard: TestBoardName | null;
  readonly issues: readonly NurbsIssue[];
  readonly summary: NurbsSummary;
  /** The worker's timings of the job that made it. */
  readonly timings: NurbsTimings;
  /** Request to answer on this thread (clone, compute, transfer), ms. */
  readonly roundTripMs: number;
  /** Jobs completed so far (the browser measurement counts updates with it). */
  readonly sequence: number;
  readonly mesh: NurbsMeshData;
}

export type ViewerPhase = 'idle' | 'converting' | 'ready' | 'failed';

export interface ViewerJob {
  /** `now()` when it started, for the elapsed-time readout. */
  readonly startedAt: number;
}

/**
 * What the view needs and no more: the board itself is deliberately not published, so
 * the layer does not re-render on every drag move.
 */
export interface ViewerState {
  readonly phase: ViewerPhase;
  /** A job that has run for more than {@link BUSY_AFTER_MS}. */
  readonly job: ViewerJob | null;
  /** The latest surface; kept while the next one is computed. */
  readonly model: NurbsModel | null;
  /** Why the board was refused. */
  readonly error: string | null;
  /** The issues of the latest conversion (or of its refusal). */
  readonly issues: readonly NurbsIssue[];
}

export const VIEWER_IDLE: ViewerState = {
  phase: 'idle',
  job: null,
  model: null,
  error: null,
  issues: [],
};

export interface ViewerInput {
  readonly enabled: boolean;
  readonly board: BezierBoard | null;
  /** The store is mid-gesture (a drag). */
  readonly editing: boolean;
  /** An exact curvature mode is shown: curvature is wanted on every update. */
  readonly wantCurvature: boolean;
  /** "Deviation from classic" is shown. */
  readonly wantDeviation: boolean;
  /** Show this test board instead of the classic board. */
  readonly testBoard: TestBoardName | null;
}

export const VIEWER_INPUT_OFF: ViewerInput = {
  enabled: false,
  board: null,
  editing: false,
  wantCurvature: false,
  wantDeviation: false,
  testBoard: null,
};

export interface ViewerDeps {
  readonly client: NurbsClient;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface NurbsViewer {
  getState(): ViewerState;
  subscribe(listener: () => void): () => void;
  setInput(input: ViewerInput): void;
  /**
   * The view that feeds this viewer went away (the 3D pane unmounted): nothing to do
   * for a viewer with no timers of its own beyond the busy indicator, which it drops.
   */
  pause(): void;
  /**
   * The engine was turned off: cancel the job in flight, drop the model, the worker
   * and the listeners.
   */
  dispose(): void;
}

/** What the last job was asked for, to tell a repeated input from a new one. */
interface Requested {
  readonly board: BezierBoard | null;
  readonly testBoard: TestBoardName | null;
  readonly curvature: boolean;
  readonly deviation: boolean;
  readonly editing: boolean;
}

export function createNurbsViewer(deps: ViewerDeps): NurbsViewer {
  const { client } = deps;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: ViewerState = VIEWER_IDLE;
  const listeners = new Set<() => void>();
  let input: ViewerInput = VIEWER_INPUT_OFF;
  let requested: Requested | null = null;
  // The job whose answer counts; a newer one replaces it.
  let running: object | null = null;
  let busyTimer: unknown = null;
  let sequence = 0;

  const set = (patch: Partial<ViewerState>): void => {
    const next = { ...state, ...patch };
    const same = (Object.keys(next) as (keyof ViewerState)[]).every((k) => next[k] === state[k]);
    if (same) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  const clearBusy = (): void => {
    if (busyTimer !== null) {
      clearTimer(busyTimer);
      busyTimer = null;
    }
  };

  /** Whether the input asks for something the last job did not deliver. */
  const needsJob = (i: ViewerInput, curvature: boolean, deviation: boolean): boolean => {
    const r = requested;
    if (!r) return true;
    if (i.testBoard !== null) return r.testBoard !== i.testBoard || (curvature && !r.curvature);
    if (r.testBoard !== null || !r.board || !i.board) return true;
    if (!sameHull(r.board, i.board)) return true;
    // The edit settled on the same hull: derive fresh ladders and add curvature.
    if (r.editing && !i.editing) return true;
    return (curvature && !r.curvature) || (deviation && !r.deviation);
  };

  const start = (i: ViewerInput, options: JobOptions): void => {
    const me = {};
    running = me;
    requested = {
      board: i.testBoard ? null : i.board,
      testBoard: i.testBoard,
      curvature: options.curvature,
      deviation: options.deviation,
      editing: i.editing,
    };
    const t0 = now();
    clearBusy();
    busyTimer = setTimer(() => {
      busyTimer = null;
      if (running === me) set({ job: { startedAt: t0 } });
    }, BUSY_AFTER_MS);
    // First surface: say so; afterwards the previous model stays until the next arrives.
    if (!state.model) set({ phase: 'converting' });
    const board = i.board!;
    const testBoard = i.testBoard;
    const job = testBoard ? client.test(testBoard, options) : client.classic(board, options);
    job
      .then((answer) => {
        if (running !== me) return;
        running = null;
        clearBusy();
        if (answer.ok) {
          set({
            phase: 'ready',
            job: null,
            model: {
              board: testBoard ? null : board,
              testBoard,
              issues: answer.issues,
              summary: answer.summary,
              timings: answer.timings,
              roundTripMs: now() - t0,
              sequence: ++sequence,
              mesh: answer.mesh,
            },
            error: null,
            issues: answer.issues,
          });
        } else {
          set({
            phase: 'failed',
            job: null,
            model: null,
            error: answer.error,
            issues: answer.issues,
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError || running !== me) return;
        running = null;
        clearBusy();
        set({
          phase: 'failed',
          job: null,
          model: null,
          error: err instanceof Error ? err.message : String(err),
          issues: [],
        });
      });
  };

  function reconcile(): void {
    const i = input;
    if (!i.enabled || (!i.board && !i.testBoard)) {
      clearBusy();
      running = null;
      requested = null;
      client.cancel();
      set(VIEWER_IDLE);
      return;
    }
    // Curvature when an exact mode shows it, and on every settled board.
    const curvature = i.wantCurvature || !i.editing;
    const deviation = i.wantDeviation && i.testBoard === null;
    if (!needsJob(i, curvature, deviation)) return;
    // Ladders carry over only from a job for the same kind of board, while editing.
    const reuseLadders = i.editing && i.testBoard === null && state.model?.board != null;
    start(i, { curvature, deviation, reuseLadders });
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
    pause: clearBusy,
    dispose() {
      clearBusy();
      running = null;
      requested = null;
      input = VIEWER_INPUT_OFF;
      set(VIEWER_IDLE);
      listeners.clear();
      client.dispose();
    },
  };
}
