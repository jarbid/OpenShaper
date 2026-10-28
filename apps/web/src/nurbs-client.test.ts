// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The client's worker protocol with a fake worker: ids rise, stale answers are dropped,
 * the worker gets one request at a time with only the newest waiting behind it (and is
 * never terminated for being slow), errors surface, and with no Worker the compute runs
 * on this thread.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  createNurbsClient,
  SupersededError,
  type NurbsTransport,
  type TransportFactory,
  type TransportHandlers,
} from './nurbs-client';
import type {
  JobOptions,
  NurbsMeshData,
  NurbsRequest,
  NurbsResponse,
  NurbsSummary,
} from './workers/nurbs-protocol';

const board = {} as BezierBoard;
const mesh = { laddersReused: false } as unknown as NurbsMeshData;
const summary = { source: 'classic' } as unknown as NurbsSummary;
const timings = { convertMs: 1, buildMs: 1, meshMs: 1, curvatureMs: 0, deviationMs: 0, totalMs: 3 };
const options: JobOptions = { curvature: false, deviation: false, reuseLadders: false };

/** A spawn that records every worker it makes and every request each receives. */
const fakeWorkers = () => {
  const workers: { requests: NurbsRequest[]; terminated: boolean; handlers: TransportHandlers }[] =
    [];
  const spawn: TransportFactory = (handlers) => {
    const w = { requests: [] as NurbsRequest[], terminated: false, handlers };
    workers.push(w);
    const transport: NurbsTransport = {
      post: (r) => void w.requests.push(r),
      terminate: () => void (w.terminated = true),
    };
    return transport;
  };
  return { workers, spawn };
};

const done = (id: number): NurbsResponse => ({
  kind: 'done',
  id,
  ok: true,
  issues: [],
  summary,
  timings,
  mesh,
});

describe('request ids and stale answers', () => {
  it('numbers requests monotonically, whatever their kind, one at a time', () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    client.classic(board, options).catch(() => {});
    expect(workers[0]!.requests.map((r) => r.id)).toEqual([1]);
    workers[0]!.handlers.onMessage(done(1));
    client.test('fish', options).catch(() => {});
    workers[0]!.handlers.onMessage(done(2));
    client.classic(board, options).catch(() => {});
    expect(workers[0]!.requests.map((r) => `${r.kind}${r.id}`)).toEqual([
      'classic1',
      'test2',
      'classic3',
    ]);
  });

  it('resolves with the answer to the current request', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.classic(board, options);
    workers[0]!.handlers.onMessage(done(1));
    await expect(p).resolves.toMatchObject({ ok: true, mesh, summary });
  });

  it('passes the worker’s stage reports to the current job only', () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const stages: string[] = [];
    client.classic(board, options, (s) => stages.push(s)).catch(() => {});
    workers[0]!.handlers.onMessage({ kind: 'progress', id: 1, stage: 'meshing' });
    workers[0]!.handlers.onMessage({ kind: 'progress', id: 99, stage: 'deviation' });
    expect(stages).toEqual(['meshing']);
  });

  it('resolves a refused board with the converter’s issues instead of throwing', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.classic(board, options);
    const issues = [{ code: 'convert-slice', severity: 'error', message: 'V bottom' }] as const;
    workers[0]!.handlers.onMessage({
      kind: 'done',
      id: 1,
      ok: false,
      error: 'V bottom',
      issues,
    });
    await expect(p).resolves.toEqual({ ok: false, error: 'V bottom', issues });
  });
});

describe('newest wins', () => {
  it('keeps only the newest request waiting behind the one the worker is running', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const first = client.classic(board, options);
    const second = client.classic(board, { ...options, curvature: true });
    const third = client.classic(board, { ...options, reuseLadders: true });
    first.catch(() => {});
    second.catch(() => {});
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(second).rejects.toBeInstanceOf(SupersededError);
    // The worker has only seen the first; the second never goes out.
    expect(workers[0]!.requests.map((r) => r.id)).toEqual([1]);
    // Its (stale) answer frees the worker and sends the third.
    workers[0]!.handlers.onMessage(done(1));
    expect(workers[0]!.requests.map((r) => r.id)).toEqual([1, 3]);
    workers[0]!.handlers.onMessage(done(3));
    await expect(third).resolves.toMatchObject({ ok: true });
  });

  it('drops a stale answer and never terminates the worker', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const first = client.classic(board, options);
    first.catch(() => {});
    const second = client.classic(board, options);
    let settled = false;
    second.then(() => (settled = true));
    workers[0]!.handlers.onMessage(done(1));
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[0]!.handlers.onMessage(done(2));
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
  });

  it('cancel() rejects the job in flight and forgets what was waiting', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.classic(board, options);
    client.classic(board, options).catch(() => {});
    client.cancel();
    await expect(p).rejects.toBeInstanceOf(SupersededError);
    workers[0]!.handlers.onMessage(done(1));
    expect(workers[0]!.requests.map((r) => r.id)).toEqual([1]);
    // Cancelling with nothing in flight is harmless.
    client.cancel();
    // And the worker is still usable.
    const next = client.classic(board, options);
    expect(workers[0]!.requests.map((r) => r.id)).toEqual([1, 3]);
    workers[0]!.handlers.onMessage(done(3));
    await expect(next).resolves.toMatchObject({ ok: true });
  });
});

describe('errors', () => {
  it('rejects the job and drops the worker when the worker crashes, then recovers', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.classic(board, options);
    workers[0]!.handlers.onError('The NURBS worker failed to load.');
    await expect(p).rejects.toThrow('The NURBS worker failed to load.');
    expect(workers[0]!.terminated).toBe(true);
    const next = client.classic(board, options);
    expect(workers).toHaveLength(2);
    workers[1]!.handlers.onMessage(done(2));
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('rejects when posting to the worker throws', async () => {
    const client = createNurbsClient(() => ({
      post() {
        throw new Error('DataCloneError');
      },
      terminate() {},
    }));
    await expect(client.classic(board, options)).rejects.toThrow('DataCloneError');
  });

  it('rejects (and does not stay pending) when the worker cannot be constructed', async () => {
    let attempts = 0;
    const client = createNurbsClient(() => {
      attempts++;
      throw new Error('Failed to construct Worker');
    });
    await expect(client.classic(board, options)).rejects.toThrow('Failed to construct Worker');
    await expect(client.classic(board, options)).rejects.toThrow('Failed to construct Worker');
    expect(attempts).toBe(2);
  });

  it('dispose() rejects the job and releases the worker', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.classic(board, options);
    client.dispose();
    await expect(p).rejects.toBeInstanceOf(SupersededError);
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('without a Worker', () => {
  it('computes on this thread through the core, and drops a superseded job unrun', async () => {
    const calls: string[] = [];
    const ok = { ok: true as const, issues: [], summary, timings, mesh };
    const core = async () => ({
      convertAndMesh: (_b: unknown, o: JobOptions) => {
        calls.push(`classic reuse=${o.reuseLadders}`);
        return ok;
      },
      meshTestBoard: (name: string) => {
        calls.push(`test ${name}`);
        return ok;
      },
    });
    const client = createNurbsClient(() => null, core);

    const first = client.classic(board, options);
    first.catch(() => {});
    const second = client.classic(board, { ...options, reuseLadders: true });
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(second).resolves.toMatchObject({ ok: true });
    // The first was replaced before the core had loaded: it never ran.
    expect(calls).toEqual(['classic reuse=true']);

    await expect(client.test('swallow', options)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(['classic reuse=true', 'test swallow']);
  });

  it('reports a failing core as a rejection', async () => {
    const client = createNurbsClient(
      () => null,
      async () => {
        throw new Error('chunk failed to load');
      },
    );
    await expect(client.classic(board, options)).rejects.toThrow('chunk failed to load');
  });
});
