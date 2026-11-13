// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The viewer's protocol with the debounce gone: every hull change starts a job at once,
 * the newest wins and stale answers are dropped, ladders are reused while an edit is in
 * progress and re-derived when it settles, a refusal leaves no model, a test board
 * replaces the classic one. A fake client stands in for the worker, so a job finishes
 * when the test says so.
 */
import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  SupersededError,
  type NurbsAnswer,
  type NurbsClient,
  type ProbeAnswer,
} from './nurbs-client';
import {
  BUSY_AFTER_MS,
  createNurbsViewer,
  SETTLE_AFTER_MS,
  sameDocHull,
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
  probes: [{ xi: 20, plus: [0, 0, 1, 1], minus: null }],
});
const refusal: NurbsAnswer = {
  ok: false,
  error: 'slice at x = 5: V bottom',
  issues: [{ code: 'convert-slice', severity: 'error', message: 'slice at x = 5: V bottom' }],
};

interface Call {
  kind: 'classic' | 'test' | 'doc';
  board?: BezierBoard;
  doc?: BoardDoc | RailsBoard;
  reference?: BezierBoard | null;
  name?: TestBoardName;
  options: JobOptions;
  answer: Deferred<NurbsAnswer>;
  probes?: readonly number[];
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
  const probeCalls: {
    doc: BoardDoc | RailsBoard;
    probes: readonly number[];
    answer: Deferred<ProbeAnswer>;
  }[] = [];
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
    doc(doc, reference, options, _onStage, probes) {
      supersede();
      const answer = deferred<NurbsAnswer>();
      calls.push({ kind: 'doc', doc, reference, options, answer, probes });
      return answer.promise;
    },
    probe(doc, probes) {
      supersede();
      const answer = deferred<ProbeAnswer>();
      probeCalls.push({ doc, probes, answer });
      return answer.promise;
    },
    convert: () => new Promise(() => {}),
    toRails: () => new Promise(() => {}),
    measure: () => new Promise(() => {}),
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
    probeCalls,
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

/** A document whose parts are distinct objects, so `sameDocHull` can tell them apart. */
const makeDoc = (): BoardDoc =>
  ({
    outline: { plus: {} },
    rocker: {},
    deck: {},
    stations: [],
    features: [],
    tail: { kind: 'standard' },
    symmetry: 'mirror',
    build: {},
    fins: null,
  }) as unknown as BoardDoc;
const lineEdit = (d: BoardDoc): BoardDoc => ({ ...d, deck: {} }) as unknown as BoardDoc;
const docFinEdit = (d: BoardDoc): BoardDoc => ({ ...d, fins: { setup: 'twin' } }) as BoardDoc;
/** A station edit: a new `stations` array, nothing else. */
const stationEdit = (d: BoardDoc): BoardDoc => ({ ...d, stations: [] }) as unknown as BoardDoc;

describe('a new stations array is a new hull', () => {
  it('sameDocHull sees a station edit and ignores a fin edit', () => {
    const d = makeDoc();
    expect(sameDocHull(d, stationEdit(d))).toBe(false);
    expect(sameDocHull(d, docFinEdit(d))).toBe(true);
  });
});

describe('section probes', () => {
  it('rides along with a document job, and the answer is published', async () => {
    const h = harness();
    const doc = makeDoc();
    h.input({ board: makeBoard(), doc, probes: [20, 33] });
    expect(h.calls[0]!.probes).toEqual([20, 33]);
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    expect(h.viewer.getState().probes?.items).toEqual([
      { xi: 20, plus: [0, 0, 1, 1], minus: null },
    ]);
  });

  it('a hover asks for the probes alone when idle, and waits behind a running job', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc, probes: [20] });
    h.calls[0]!.answer.resolve(okAnswer());
    await h.flush();
    // idle: only the probes changed, so no mesh job
    h.input({ board, doc, probes: [20, 41] });
    expect(h.calls).toHaveLength(1);
    expect(h.probeCalls).toHaveLength(1);
    expect(h.probeCalls[0]!.probes).toEqual([20, 41]);
    h.probeCalls[0]!.answer.resolve({
      ok: true,
      probes: [{ xi: 41, plus: [0, 0, 2, 2], minus: null }],
    });
    await h.flush();
    expect(h.viewer.getState().probes?.items[0]!.xi).toBe(41);
    // an edit while the probes are wanted: a full job carries them, the model is not replaced by a hover
    const model = h.viewer.getState().model;
    const edited = lineEdit(doc);
    const editedBoard = hullEdit(board);
    h.input({ board: editedBoard, doc: edited, probes: [20, 41], editing: true });
    expect(h.calls).toHaveLength(2);
    h.input({ board: editedBoard, doc: edited, probes: [20, 55], editing: true });
    // a job is running: the new probes wait (the job was not superseded by a probe job)
    expect(h.probeCalls).toHaveLength(1);
    h.calls[1]!.answer.resolve(okAnswer('b'));
    await h.flush();
    expect(h.viewer.getState().model).not.toBe(model);
    expect(h.probeCalls).toHaveLength(2);
    expect(h.probeCalls[1]!.probes).toEqual([20, 55]);
  });
});

describe('documents (the section store)', () => {
  it('sends the document: no converter in the loop, and the projection is the board shown', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ kind: 'doc', doc });
    h.calls[0]!.answer.resolve(okAnswer('d'));
    await h.flush();
    expect(h.viewer.getState().model?.board).toBe(board);
  });

  it('starts a job for an edit of the lines and none for a fin edit', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    h.input({ board: finEdit(board), doc: docFinEdit(doc) });
    expect(h.calls).toHaveLength(1);
    h.input({ board: hullEdit(board), doc: lineEdit(doc), editing: true });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ kind: 'doc', options: { reuseLadders: true } });
  });

  it('reuses ladders across a drag of documents and re-derives them when it settles', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    const d2 = lineEdit(doc);
    h.input({ board: hullEdit(board), doc: d2, editing: true });
    expect(h.calls[1]!.options.reuseLadders).toBe(true);
    h.calls[1]!.answer.resolve(okAnswer('b'));
    await h.flush();
    h.input({ board: hullEdit(board), doc: d2, editing: false });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.options.reuseLadders).toBe(false);
  });

  it('a lone change reuses the ladders first, then derives fresh ones when the input goes quiet', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    const d2 = lineEdit(doc);
    h.input({ board: hullEdit(board), doc: d2 });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.options).toMatchObject({ reuseLadders: true, curvature: false });
    h.calls[1]!.answer.resolve(okAnswer('b'));
    await h.flush();
    // not yet: the input has not been quiet
    h.advance(SETTLE_AFTER_MS - 1);
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.options).toMatchObject({ reuseLadders: false, curvature: true });
  });

  it('sends the classic reference only while "Deviation from classic" is shown', () => {
    const h = harness();
    const reference = makeBoard();
    h.input({ board: makeBoard(), doc: makeDoc(), reference: null, wantDeviation: false });
    expect(h.calls[0]!.reference).toBeNull();
    const h2 = harness();
    h2.input({ board: makeBoard(), doc: makeDoc(), reference, wantDeviation: true });
    expect(h2.calls[0]).toMatchObject({ kind: 'doc', reference });
    expect(h2.calls[0]!.options.deviation).toBe(true);
  });

  it('switching between the classic board and a document starts a job', async () => {
    const h = harness();
    const board = makeBoard();
    h.input({ board });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    h.input({ board, doc: makeDoc() });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.kind).toBe('doc');
  });

  it('keeps the last good surface through a refused edit of the document, marked stale', async () => {
    const h = harness();
    const doc = makeDoc();
    const board = makeBoard();
    h.input({ board, doc });
    h.calls[0]!.answer.resolve(okAnswer('a'));
    await h.flush();
    h.input({ board: hullEdit(board), doc: lineEdit(doc), editing: true });
    h.calls[1]!.answer.resolve(refusal);
    await h.flush();
    expect(h.viewer.getState()).toMatchObject({ phase: 'failed', stale: true });
    expect(h.viewer.getState().model?.board).toBe(board);
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
