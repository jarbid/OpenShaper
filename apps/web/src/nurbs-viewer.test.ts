// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The viewer's protocol: convert after edits settle, drop superseded jobs, cache by
 * identity. A fake client stands in for the worker, so a "conversion" finishes when
 * the test says so; a manual clock stands in for the quiet period.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { SupersededError, type NurbsAnswer, type NurbsClient } from './nurbs-client';
import { createNurbsViewer, DEBOUNCE_MS, type ViewerInput } from './nurbs-viewer';
import type { NurbsMeshData } from './workers/nurbs-protocol';

/** A board whose hull parts are distinct objects, so `sameHull` can tell them apart. */
const makeBoard = (): BezierBoard =>
  ({
    outline: {},
    bottom: {},
    deck: {},
    crossSections: [],
    interpolationType: 0,
    fins: { setup: 'none' },
  }) as unknown as BezierBoard;
const hullEdit = (b: BezierBoard): BezierBoard => ({ ...b, deck: {} }) as unknown as BezierBoard;
const finEdit = (b: BezierBoard): BezierBoard => ({ ...b, fins: { setup: 'twin' } }) as BezierBoard;

const meshAt = (faceSize: number): NurbsMeshData => ({ faceSize }) as unknown as NurbsMeshData;
const okAnswer = (modelId: number, faceSize: number): NurbsAnswer => ({
  ok: true,
  modelId,
  docJson: '{}',
  issues: [{ code: 'not-converged', severity: 'warning', message: 'band 42x target' }],
  summary: null,
  timings: { convertMs: 1, buildMs: 0, tessellateMs: 1, deviationMs: 1, totalMs: 3 },
  mesh: meshAt(faceSize),
});

interface Call {
  kind: 'convert' | 'mesh';
  modelId: number;
  board: BezierBoard;
  faceSize: number;
  answer: Deferred<NurbsAnswer>;
  stage?: (s: 'converting' | 'meshing' | 'deviation') => void;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: Error): void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

const harness = () => {
  const calls: Call[] = [];
  let cancels = 0;
  let disposed = false;
  const client: NurbsClient = {
    convert(modelId, board, faceSize, stage) {
      const answer = deferred<NurbsAnswer>();
      calls.push({ kind: 'convert', modelId, board, faceSize, answer, stage });
      return answer.promise;
    },
    mesh(modelId, _doc, board, faceSize, stage) {
      const answer = deferred<NurbsAnswer>();
      calls.push({ kind: 'mesh', modelId, board, faceSize, answer, stage });
      return answer.promise;
    },
    cancel() {
      cancels++;
      // A real client rejects the job in flight.
      calls.at(-1)?.answer.reject(new SupersededError());
    },
    dispose() {
      disposed = true;
    },
  };
  // A manual clock: timers fire when the test advances time.
  let t = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const viewer = createNurbsViewer({
    client,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(nextHandle, { at: t + ms, fn });
      return nextHandle++;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const advance = (ms: number) => {
    t += ms;
    for (const [h, tm] of [...timers]) {
      if (tm.at <= t) {
        timers.delete(h);
        tm.fn();
      }
    }
  };
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const input = (patch: Partial<ViewerInput> & { board: BezierBoard | null }) =>
    viewer.setInput({ enabled: true, faceSize: 0.9, editing: false, ...patch });
  return {
    viewer,
    calls,
    advance,
    flush,
    input,
    cancels: () => cancels,
    disposed: () => disposed,
    pendingTimers: () => timers.size,
  };
};

const converted = async (h: ReturnType<typeof harness>, board: BezierBoard, faceSize = 0.9) => {
  h.input({ board, faceSize });
  h.advance(DEBOUNCE_MS);
  const call = h.calls.at(-1)!;
  call.answer.resolve(okAnswer(call.modelId, faceSize));
  await h.flush();
};

describe('convert after edits settle', () => {
  it('shows the classic board (waiting) and converts once the quiet period passes', () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    expect(h.viewer.getState().phase).toBe('waiting');
    h.advance(DEBOUNCE_MS - 1);
    expect(h.calls).toHaveLength(0);
    h.advance(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ kind: 'convert', board, faceSize: 0.9 });
    expect(h.viewer.getState()).toMatchObject({
      phase: 'converting',
      job: { kind: 'convert', startedAt: DEBOUNCE_MS, stage: 'converting' },
    });
  });

  it('restarts the quiet period on every hull change', () => {
    const h = harness();
    let board = makeBoard();
    h.input({ board });
    for (let i = 0; i < 5; i++) {
      h.advance(DEBOUNCE_MS - 100);
      board = hullEdit(board);
      h.input({ board });
    }
    expect(h.calls).toHaveLength(0);
    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.board).toBe(board);
  });

  it('never converts mid-gesture, and starts the period when the gesture ends', () => {
    const h = harness();
    let board = makeBoard();
    h.input({ board, editing: true });
    h.advance(10 * DEBOUNCE_MS);
    for (let i = 0; i < 3; i++) {
      board = hullEdit(board);
      h.input({ board, editing: true });
      h.advance(DEBOUNCE_MS * 2);
    }
    expect(h.calls).toHaveLength(0);
    expect(h.pendingTimers()).toBe(0);
    h.input({ board, editing: false });
    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
  });

  it('does not restart the period for a fin edit (the hull is the same)', () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    h.advance(DEBOUNCE_MS - 200);
    h.input({ board: finEdit(board) });
    h.advance(200);
    expect(h.calls).toHaveLength(1);
  });

  it('keeps converting through a fin edit instead of starting over', () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    h.advance(DEBOUNCE_MS);
    h.input({ board: finEdit(board) });
    expect(h.calls).toHaveLength(1);
    expect(h.cancels()).toBe(0);
    expect(h.viewer.getState().phase).toBe('converting');
  });

  it('does nothing while disabled, and goes idle when switched off', () => {
    const h = harness();
    const board = makeBoard();
    h.viewer.setInput({ enabled: false, board, faceSize: 0.9, editing: false });
    h.advance(10 * DEBOUNCE_MS);
    expect(h.calls).toHaveLength(0);
    expect(h.viewer.getState().phase).toBe('idle');

    h.input({ board });
    h.advance(DEBOUNCE_MS);
    expect(h.viewer.getState().phase).toBe('converting');
    h.viewer.setInput({ enabled: false, board, faceSize: 0.9, editing: false });
    expect(h.viewer.getState().phase).toBe('idle');
    expect(h.cancels()).toBe(1);
  });
});

describe('dropping superseded jobs', () => {
  it('cancels a running conversion when the hull changes and ignores its answer', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.advance(DEBOUNCE_MS);
    const first = h.calls[0]!;

    const b = hullEdit(a);
    h.input({ board: b });
    expect(h.cancels()).toBe(1);
    expect(h.viewer.getState().phase).toBe('waiting');
    // Even if the stale answer slipped through, it must not become the model.
    first.answer.resolve(okAnswer(first.modelId, 0.9));
    await h.flush();
    expect(h.viewer.getState().model).toBeNull();

    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.board).toBe(b);
    expect(h.calls[1]!.modelId).toBeGreaterThan(first.modelId);
  });

  it('reports the stage the worker is in', () => {
    const h = harness();
    h.input({ board: makeBoard() });
    h.advance(DEBOUNCE_MS);
    h.calls[0]!.stage!('meshing');
    expect(h.viewer.getState().job?.stage).toBe('meshing');
  });
});

describe('the result and its cache', () => {
  it('is ready with the model, its warnings and no job once the answer lands', async () => {
    const h = harness();
    const board = makeBoard();
    await converted(h, board);
    const s = h.viewer.getState();
    expect(s.phase).toBe('ready');
    expect(s.job).toBeNull();
    expect(s.model?.board).toBe(board);
    expect(s.issues.map((i) => i.code)).toEqual(['not-converged']);
  });

  it('shows a hull converted before again without converting (undo, view switch)', async () => {
    const h = harness();
    const a = makeBoard();
    await converted(h, a);
    const b = hullEdit(a);
    h.input({ board: b });
    expect(h.viewer.getState().phase).toBe('waiting');
    // Back to the first hull (undo): at once, no timer, no job.
    h.input({ board: a });
    expect(h.viewer.getState().phase).toBe('ready');
    expect(h.viewer.getState().model?.board).toBe(a);
    h.advance(10 * DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    // A fin edit of it is the same hull: still the same model.
    h.input({ board: finEdit(a) });
    expect(h.viewer.getState().phase).toBe('ready');
    expect(h.calls).toHaveLength(1);
  });

  it('re-meshes at a new quality without converting again', async () => {
    const h = harness();
    const board = makeBoard();
    await converted(h, board, 0.9);
    h.input({ board, faceSize: 0.5 });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ kind: 'mesh', faceSize: 0.5 });
    // The surface at the old density stays up meanwhile.
    expect(h.viewer.getState()).toMatchObject({
      phase: 'ready',
      job: { kind: 'mesh' },
      model: { mesh: { faceSize: 0.9 } },
    });
    h.calls[1]!.answer.resolve(okAnswer(h.calls[1]!.modelId, 0.5));
    await h.flush();
    expect(h.viewer.getState().model?.mesh.faceSize).toBe(0.5);
    expect(h.viewer.getState().job).toBeNull();
    expect(h.calls).toHaveLength(2);
  });

  it('does not retry a re-mesh that failed, and keeps the surface it has', async () => {
    const h = harness();
    const board = makeBoard();
    await converted(h, board, 0.9);
    h.input({ board, faceSize: 0.5 });
    h.calls[1]!.answer.resolve({ ok: false, error: 'tessellation failed', issues: [] });
    await h.flush();
    h.input({ board, faceSize: 0.5 });
    expect(h.calls).toHaveLength(2);
    expect(h.viewer.getState()).toMatchObject({
      phase: 'ready',
      model: { mesh: { faceSize: 0.9 } },
    });
  });

  it('falls back to classic with the reason when the conversion fails, and remembers it', async () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    h.advance(DEBOUNCE_MS);
    h.calls[0]!.answer.resolve({
      ok: false,
      error: 'concave tails are not supported',
      issues: [{ code: 'unsupported-tail', severity: 'error', message: 'swallow tail' }],
    });
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({
      phase: 'failed',
      error: 'concave tails are not supported',
      model: null,
    });
    expect(h.viewer.getState().issues).toHaveLength(1);
    // The same hull again does not convert again; another one does.
    h.input({ board: finEdit(board) });
    h.advance(10 * DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    h.input({ board: hullEdit(board) });
    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
  });

  it('surfaces a crashed worker as a failure', async () => {
    const h = harness();
    h.input({ board: makeBoard() });
    h.advance(DEBOUNCE_MS);
    h.calls[0]!.answer.reject(new Error('The NURBS worker failed to load.'));
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({
      phase: 'failed',
      error: 'The NURBS worker failed to load.',
    });
  });

  it('keeps only a few converted boards', async () => {
    const h = harness();
    const first = makeBoard();
    let board = first;
    for (let i = 0; i < 4; i++) {
      await converted(h, board);
      board = hullEdit(board);
    }
    expect(h.calls).toHaveLength(4);
    // The first is out of the cache: it converts again.
    h.input({ board: first });
    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(5);
  });

  it('disposes the client', () => {
    const h = harness();
    h.viewer.dispose();
    expect(h.disposed()).toBe(true);
  });

  it('dispose() (the engine turned off) cancels a running conversion and drops the cache', async () => {
    const h = harness();
    const board = makeBoard();
    const other = hullEdit(board);
    await converted(h, board); // cached
    h.input({ board: other });
    h.advance(DEBOUNCE_MS); // converting `other`: 12 to 22 s in a real worker
    expect(h.viewer.getState().phase).toBe('converting');
    const cancels = h.cancels();
    h.viewer.dispose();
    expect(h.cancels()).toBe(cancels + 1);
    expect(h.disposed()).toBe(true);
    expect(h.viewer.getState().phase).toBe('idle');
    expect(h.viewer.getState().model).toBeNull();
    // The cache is gone: the first board converts again instead of showing at once.
    h.input({ board });
    expect(h.viewer.getState().phase).toBe('waiting');
    h.advance(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(3);
    // No timer outlives it.
    h.viewer.dispose();
    expect(h.pendingTimers()).toBe(0);
  });

  it('pause() (a pane remount) keeps the cache and any conversion running', async () => {
    const h = harness();
    const board = makeBoard();
    await converted(h, board);
    h.viewer.pause();
    expect(h.disposed()).toBe(false);
    h.input({ board });
    expect(h.viewer.getState().phase).toBe('ready');
    expect(h.calls).toHaveLength(1);
  });
});

describe('published state', () => {
  it('does not change on drag moves of an unconverted hull, so subscribers do not re-render', () => {
    const h = harness();
    let board = makeBoard();
    h.input({ board, editing: true });
    let notified = 0;
    h.viewer.subscribe(() => notified++);
    const before = h.viewer.getState();
    for (let i = 0; i < 20; i++) {
      board = hullEdit(board);
      h.input({ board, editing: true });
    }
    expect(notified).toBe(0);
    expect(h.viewer.getState()).toBe(before);
  });

  it('does not change on a fin edit of a converted hull either', async () => {
    const h = harness();
    const board = makeBoard();
    await converted(h, board);
    let notified = 0;
    h.viewer.subscribe(() => notified++);
    h.input({ board: finEdit(board) });
    expect(notified).toBe(0);
  });
});
