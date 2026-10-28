// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The client's worker protocol with a fake worker: ids rise, stale answers are dropped,
 * a superseded conversion kills the worker (a re-mesh does not), errors surface, and
 * with no Worker the compute runs on this thread.
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
import type { NurbsMeshData, NurbsRequest } from './workers/nurbs-protocol';

const board = {} as BezierBoard;
const mesh = { faceSize: 0.9 } as unknown as NurbsMeshData;
const timings = { convertMs: 1, buildMs: 0, tessellateMs: 1, deviationMs: 1, totalMs: 3 };

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

const done = (id: number, modelId: number) =>
  ({
    kind: 'done',
    id,
    ok: true,
    modelId,
    docJson: '{}',
    issues: [],
    summary: null,
    timings,
    mesh,
  }) as const;

describe('request ids and stale answers', () => {
  it('numbers requests monotonically, whatever their kind', () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    client.convert(1, board, 0.9).catch(() => {});
    client.mesh(1, '{}', board, 0.5).catch(() => {});
    client.convert(2, board, 0.9).catch(() => {});
    const ids = workers.flatMap((w) => w.requests.map((r) => r.id));
    expect(ids).toEqual([1, 2, 3]);
  });

  it('resolves with the answer to the current request', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.convert(7, board, 0.9);
    workers[0]!.handlers.onMessage(done(1, 7));
    await expect(p).resolves.toMatchObject({ ok: true, modelId: 7, mesh });
  });

  it('drops an answer that is not for the current request', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const first = client.mesh(1, '{}', board, 0.5);
    first.catch(() => {});
    const second = client.mesh(1, '{}', board, 0.9);
    // The first's answer arrives late (a re-mesh is not killed): ignored.
    workers[0]!.handlers.onMessage(done(1, 1));
    let settled = false;
    second.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[0]!.handlers.onMessage(done(2, 1));
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(first).rejects.toBeInstanceOf(SupersededError);
  });

  it('passes the worker’s stage reports to the current job only', () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const stages: string[] = [];
    client.convert(1, board, 0.9, (s) => stages.push(s)).catch(() => {});
    workers[0]!.handlers.onMessage({ kind: 'progress', id: 1, stage: 'meshing' });
    workers[0]!.handlers.onMessage({ kind: 'progress', id: 99, stage: 'deviation' });
    expect(stages).toEqual(['meshing']);
  });

  it('resolves a failed conversion with the converter’s issues instead of throwing', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.convert(1, board, 0.9);
    workers[0]!.handlers.onMessage({
      kind: 'done',
      id: 1,
      ok: false,
      error: 'unsupported tail',
      issues: [{ code: 'unsupported-tail', severity: 'error', message: 'swallow' }],
    });
    await expect(p).resolves.toEqual({
      ok: false,
      error: 'unsupported tail',
      issues: [{ code: 'unsupported-tail', severity: 'error', message: 'swallow' }],
    });
  });
});

describe('superseding', () => {
  it('terminates the worker when a conversion is superseded, and starts a fresh one', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const first = client.convert(1, board, 0.9);
    const second = client.convert(2, board, 0.9);
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(false);
    expect(workers[1]!.requests.map((r) => r.id)).toEqual([2]);
    workers[1]!.handlers.onMessage(done(2, 2));
    await expect(second).resolves.toMatchObject({ ok: true, modelId: 2 });
  });

  it('leaves the worker alone when only a re-mesh is superseded', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const first = client.mesh(1, '{}', board, 0.5);
    client.convert(2, board, 0.9).catch(() => {});
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
  });

  it('cancel() rejects the job in flight and kills a conversion', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.convert(1, board, 0.9);
    client.cancel();
    await expect(p).rejects.toBeInstanceOf(SupersededError);
    expect(workers[0]!.terminated).toBe(true);
    // Cancelling with nothing in flight is harmless.
    client.cancel();
  });
});

describe('errors', () => {
  it('rejects the job and drops the worker when the worker crashes, then recovers', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.convert(1, board, 0.9);
    workers[0]!.handlers.onError('The NURBS worker failed to load.');
    await expect(p).rejects.toThrow('The NURBS worker failed to load.');
    expect(workers[0]!.terminated).toBe(true);
    const next = client.convert(2, board, 0.9);
    expect(workers).toHaveLength(2);
    workers[1]!.handlers.onMessage(done(2, 2));
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('rejects when posting to the worker throws', async () => {
    const client = createNurbsClient(() => ({
      post() {
        throw new Error('DataCloneError');
      },
      terminate() {},
    }));
    await expect(client.convert(1, board, 0.9)).rejects.toThrow('DataCloneError');
  });

  it('rejects (and does not stay pending) when the worker cannot be constructed', async () => {
    let attempts = 0;
    const client = createNurbsClient(() => {
      attempts++;
      throw new Error('Failed to construct Worker');
    });
    await expect(client.convert(1, board, 0.9)).rejects.toThrow('Failed to construct Worker');
    await expect(client.convert(2, board, 0.9)).rejects.toThrow('Failed to construct Worker');
    expect(attempts).toBe(2);
  });

  it('dispose() rejects the job and releases the worker', async () => {
    const { workers, spawn } = fakeWorkers();
    const client = createNurbsClient(spawn);
    const p = client.convert(1, board, 0.9);
    client.dispose();
    await expect(p).rejects.toBeInstanceOf(SupersededError);
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('without a Worker', () => {
  it('computes on this thread through the core, and drops a superseded job unrun', async () => {
    const calls: string[] = [];
    const core = async () => ({
      convertAndMesh: (modelId: number, _b: unknown, faceSize: number) => {
        calls.push(`convert ${modelId} ${faceSize}`);
        return { ok: true as const, docJson: '{}', issues: [], summary: null, timings, mesh };
      },
      remesh: (modelId: number, _d: string, _b: unknown, faceSize: number) => {
        calls.push(`mesh ${modelId} ${faceSize}`);
        return { ok: true as const, docJson: '{}', issues: [], summary: null, timings, mesh };
      },
    });
    const client = createNurbsClient(() => null, core);

    const first = client.convert(1, board, 0.9);
    first.catch(() => {});
    const second = client.convert(2, board, 0.5);
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(second).resolves.toMatchObject({ ok: true, modelId: 2 });
    // The first was replaced before the core had loaded: it never ran.
    expect(calls).toEqual(['convert 2 0.5']);

    await expect(client.mesh(2, '{}', board, 0.9)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(['convert 2 0.5', 'mesh 2 0.9']);
  });

  it('reports a failing core as a rejection', async () => {
    const client = createNurbsClient(
      () => null,
      async () => {
        throw new Error('chunk failed to load');
      },
    );
    await expect(client.convert(1, board, 0.9)).rejects.toThrow('chunk failed to load');
  });
});
