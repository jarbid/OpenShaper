// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The viewer's protocol with the debounce gone: every hull change starts a job at once,
 * the newest wins and stale answers are dropped, ladders are reused while an edit is in
 * progress and re-derived when it settles, a refusal leaves no model, a test board
 * replaces the classic one. A fake client stands in for the worker, so a job finishes
 * when the test says so.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { SupersededError, type NurbsAnswer, type NurbsClient } from './nurbs-client';
import {
  BUSY_AFTER_MS,
  createNurbsViewer,
  VIEWER_INPUT_OFF,
  type ViewerInput,
} from './nurbs-viewer';
import type {
  JobOptions,
  NurbsMeshData,
  NurbsSummary,
  TestBoardName,
} from './workers/nurbs-protocol';

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

const okAnswer = (tag = 'm'): NurbsAnswer => ({
  ok: true,
  issues: [{ code: 'blend-overshoot', severity: 'warning', message: 'a little' }],
  summary: { source: 'classic' } as unknown as NurbsSummary,
  timings: { convertMs: 1, buildMs: 1, meshMs: 1, curvatureMs: 0, deviationMs: 0, totalMs: 3 },
  mesh: { tag } as unknown as NurbsMeshData,
});
const refusal: NurbsAnswer = {
  ok: false,
  error: 'slice at x = 5: V bottom',
  issues: [{ code: 'convert-slice', severity: 'error', message: 'slice at x = 5: V bottom' }],
};

interface Call {
  kind: 'classic' | 'test';
  board?: BezierBoard;
  name?: TestBoardName;
  options: JobOptions;
  answer: Deferred<NurbsAnswer>;
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
  let disposed = false;
  let cancels = 0;
  // Like the real client: a newer request rejects the one before it.
  const supersede = () => calls.at(-1)?.answer.reject(new SupersededError());
  const client: NurbsClient = {
    classic(board, options) {
      supersede();
      const answer = deferred<NurbsAnswer>();
      calls.push({ kind: 'classic', board, options, answer });
      return answer.promise;
    },
    test(name, options) {
      supersede();
      const answer = deferred<NurbsAnswer>();
      calls.push({ kind: 'test', name, options, answer });
      return answer.promise;
    },
    cancel() {
      cancels++;
      supersede();
    },
    dispose() {
      disposed = true;
    },
  };
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
  const input = (patch: Partial<ViewerInput>) =>
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, ...patch });
  return {
    viewer,
    calls,
    advance,
    flush,
    input,
    cancels: () => cancels,
    disposed: () => disposed,
  };
};

describe('every edit converts at once', () => {
  it('starts a job the moment a board arrives, with no quiet period', () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ kind: 'classic', board });
    expect(h.viewer.getState().phase).toBe('converting');
  });

  it('shows the answer and keeps the model while the next edit is computed', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({ phase: 'ready', error: null });
    expect(h.viewer.getState().model?.board).toBe(a);
    expect(h.viewer.getState().issues).toHaveLength(1);

    // A hull edit: a new job at once; the surface on screen stays the previous one.
    const b = hullEdit(a);
    h.input({ board: b, editing: true });
    expect(h.calls).toHaveLength(2);
    expect(h.viewer.getState().phase).toBe('ready');
    expect(h.viewer.getState().model?.board).toBe(a);
    h.calls[1]!.answer.resolve(okAnswer('b'));
    await h.flush();
    expect(h.viewer.getState().model?.board).toBe(b);
    expect(h.viewer.getState().model?.sequence).toBe(2);
  });

  it('starts nothing for a repeated input or an edit that leaves the hull alone', () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.input({ board: a });
    h.input({ board: finEdit(a) });
    expect(h.calls).toHaveLength(1);
  });

  it('drops the answer of a superseded job: the newest wins', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    const b = hullEdit(a);
    h.input({ board: b, editing: true });
    const c = hullEdit(b);
    h.input({ board: c, editing: true });
    // The first two were replaced (the fake client rejects them); only the last counts.
    h.calls[0]!.answer.resolve(okAnswer('late'));
    h.calls[1]!.answer.resolve(okAnswer('late'));
    await h.flush();
    expect(h.viewer.getState().model).toBeNull();
    h.calls[2]!.answer.resolve(okAnswer('c'));
    await h.flush();
    expect(h.viewer.getState().model?.board).toBe(c);
    expect(h.viewer.getState().model?.mesh).toMatchObject({ tag: 'c' });
  });
});

describe('ladders and curvature', () => {
  it('reuses the ladders while editing, and derives them afresh when the edit settles', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    expect(h.calls[0]!.options).toEqual({ curvature: true, deviation: false, reuseLadders: false });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();

    const b = hullEdit(a);
    h.input({ board: b, editing: true });
    expect(h.calls[1]!.options).toEqual({ curvature: false, deviation: false, reuseLadders: true });
    h.calls[1]!.answer.resolve(okAnswer());
    await h.flush();

    // The gesture ends on the same hull: one more job, ladders and curvature afresh.
    h.input({ board: b, editing: false });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.options).toEqual({ curvature: true, deviation: false, reuseLadders: false });
  });

  it('asks for curvature on every update while an exact mode is shown', () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a, editing: true, wantCurvature: true });
    expect(h.calls[0]!.options.curvature).toBe(true);
  });

  it('re-requests when curvature or deviation is wanted and the surface has not got it', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a, editing: true });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.calls[0]!.options.curvature).toBe(false);
    h.input({ board: a, editing: true, wantCurvature: true });
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.answer.resolve(okAnswer());
    await h.flush();
    h.input({ board: a, editing: true, wantCurvature: true, wantDeviation: true });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.options).toMatchObject({ curvature: true, deviation: true });
    // Switching the mode off needs nothing new.
    h.input({ board: a, editing: true });
    expect(h.calls).toHaveLength(3);
  });
});

describe('refusals', () => {
  it('leaves no model, keeps the reasons, and recovers when the board is fixed', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.viewer.getState().model).not.toBeNull();

    const bad = hullEdit(a);
    h.input({ board: bad });
    h.calls[1]!.answer.resolve(refusal);
    await h.flush();
    const s = h.viewer.getState();
    expect(s).toMatchObject({ phase: 'failed', model: null, error: 'slice at x = 5: V bottom' });
    expect(s.issues[0]?.code).toBe('convert-slice');

    // The same refused board again is not retried; an edit is.
    h.input({ board: bad });
    expect(h.calls).toHaveLength(2);
    h.input({ board: hullEdit(bad) });
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.viewer.getState().phase).toBe('ready');
  });

  it('turns a crashed worker into a failure the popover can show', async () => {
    const h = harness();
    h.input({ board: makeBoard() });
    h.calls[0]!.answer.reject(new Error('The NURBS worker failed to load.'));
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({
      phase: 'failed',
      error: 'The NURBS worker failed to load.',
    });
  });
});

describe('a refusal in the middle of an edit', () => {
  it('keeps the last good surface, marked stale, while the gesture lasts; the settled board decides', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();

    // a drag passes through a state the model cannot hold: no flash back to the classic mesh
    const bad = hullEdit(a);
    h.input({ board: bad, editing: true });
    h.calls[1]!.answer.resolve(refusal);
    await h.flush();
    let s = h.viewer.getState();
    expect(s).toMatchObject({ phase: 'failed', stale: true, error: 'slice at x = 5: V bottom' });
    expect(s.model?.board).toBe(a);
    expect(s.model?.mesh).toMatchObject({ tag: 'a' });

    // the drag continues to a good board: the surface is fresh again
    const good = hullEdit(bad);
    h.input({ board: good, editing: true });
    h.calls[2]!.answer.resolve(okAnswer('good'));
    await h.flush();
    s = h.viewer.getState();
    expect(s).toMatchObject({ phase: 'ready', stale: false });
    expect(s.model?.board).toBe(good);

    // ... and a refusal of the settled board leaves no model, as before
    const settledBad = hullEdit(good);
    h.input({ board: settledBad, editing: true });
    h.calls[3]!.answer.resolve(okAnswer('x'));
    await h.flush();
    h.input({ board: settledBad, editing: false });
    h.calls[4]!.answer.resolve(refusal);
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({ phase: 'failed', model: null, stale: false });
  });

  it('does not carry the old document over a refusal of the new one', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a, generation: 1 });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    h.input({ board: makeBoard(), generation: 2, editing: true });
    h.calls[1]!.answer.resolve(refusal);
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({ phase: 'failed', model: null, stale: false });
  });
});

describe('opening another document', () => {
  it('tags the model with the document generation and starts a job even for an identical hull', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a, generation: 1 });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({ generation: 1 });
    expect(h.viewer.getState().model?.generation).toBe(1);

    // another file with the very same hull objects: still a new document, still a new job
    h.input({ board: a, generation: 2 });
    expect(h.calls).toHaveLength(2);
    // meanwhile the state says the model belongs to another document
    const s = h.viewer.getState();
    expect(s.generation).toBe(2);
    expect(s.model?.generation).toBe(1);
    h.calls[1]!.answer.resolve(okAnswer('b'));
    await h.flush();
    expect(h.viewer.getState().model?.generation).toBe(2);
  });
});

describe('test boards', () => {
  it('shows the chosen test board instead of the classic board, and back', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();

    h.input({ board: a, testBoard: 'fish' });
    expect(h.calls[1]).toMatchObject({ kind: 'test', name: 'fish' });
    expect(h.calls[1]!.options.deviation).toBe(false);
    h.calls[1]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.viewer.getState().model).toMatchObject({ board: null, testBoard: 'fish' });

    // Classic edits do not touch a test board on screen.
    h.input({ board: hullEdit(a), testBoard: 'fish', editing: true });
    expect(h.calls).toHaveLength(2);

    h.input({ board: a });
    expect(h.calls[2]).toMatchObject({ kind: 'classic' });
    // Ladders carry over only between jobs for classic boards.
    expect(h.calls[2]!.options.reuseLadders).toBe(false);
  });
});

describe('the busy indicator', () => {
  it('shows a job only once it has run for a while', async () => {
    const h = harness();
    h.input({ board: makeBoard() });
    expect(h.viewer.getState().job).toBeNull();
    h.advance(BUSY_AFTER_MS);
    expect(h.viewer.getState().job).not.toBeNull();
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.viewer.getState().job).toBeNull();
  });

  it('never shows one for a job that answers quickly', async () => {
    const h = harness();
    h.input({ board: makeBoard() });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    h.advance(10 * BUSY_AFTER_MS);
    expect(h.viewer.getState().job).toBeNull();
  });
});

describe('turning off and disposing', () => {
  it('goes idle, cancels the job and forgets what it asked for when disabled', async () => {
    const h = harness();
    const a = makeBoard();
    h.input({ board: a });
    h.viewer.setInput({ ...VIEWER_INPUT_OFF });
    expect(h.cancels()).toBe(1);
    expect(h.viewer.getState().phase).toBe('idle');
    h.input({ board: a });
    expect(h.calls).toHaveLength(2);
  });

  it('dispose() releases the client and the listeners', () => {
    const h = harness();
    let notified = 0;
    h.viewer.subscribe(() => notified++);
    h.input({ board: makeBoard() });
    h.viewer.dispose();
    expect(h.disposed()).toBe(true);
    expect(h.viewer.getState().phase).toBe('idle');
    const after = notified;
    h.viewer.setInput({ ...VIEWER_INPUT_OFF });
    expect(notified).toBe(after);
  });
});
