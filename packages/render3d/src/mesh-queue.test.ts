import type { BezierBoard, BoardMesh } from '@openshaper/kernel';
import { describe, expect, it, vi } from 'vitest';
import { createMeshQueue } from './mesh-queue';

// Boards are only used as identities here.
const boards = (n: number) => Array.from({ length: n }, () => ({}) as BezierBoard);
const mesh = (): BoardMesh => ({
  positions: new Float32Array(3),
  normals: new Float32Array(3),
  indices: new Uint32Array(3),
});

const setup = () => {
  const posts: { id: number; board: BezierBoard; face: number }[] = [];
  const onResult = vi.fn();
  const q = createMeshQueue((id, board, face) => posts.push({ id, board, face }), onResult);
  const finish = (i: number) => {
    const m = mesh();
    q.receive(posts[i]!.id, m);
    return m;
  };
  return { q, posts, onResult, finish };
};

describe('mesh queue', () => {
  it('posts one job at a time and resolves in order', async () => {
    const { q, posts, finish, onResult } = setup();
    const [a, b] = boards(2);
    const pa = q.request(a!, 1);
    const pb = q.request(b!, 1);
    expect(posts.map((p) => p.board)).toEqual([a]);

    const ma = finish(0);
    await expect(pa).resolves.toBe(ma);
    expect(posts.map((p) => p.board)).toEqual([a, b]);
    const mb = finish(1);
    await expect(pb).resolves.toBe(mb);
    expect(onResult.mock.calls).toEqual([
      [a, 1, ma],
      [b, 1, mb],
    ]);
  });

  it('shares one job between identical requests', async () => {
    const { q, posts, finish } = setup();
    const [a] = boards(1);
    const p1 = q.request(a!, 1);
    const p2 = q.request(a!, 1);
    const p3 = q.request(a!, 0.5); // different face size is a different job
    expect(p1).toBe(p2);
    const m = finish(0);
    await expect(p2).resolves.toBe(m);
    expect(posts).toHaveLength(2);
    finish(1);
    await p3;
  });

  it('drops a waiting job once every requester aborts — a drag computes only the latest', async () => {
    const { q, posts, finish } = setup();
    const bs = boards(5);
    const signals = bs.map(() => new AbortController());
    const promises = bs.map((b, i) => q.request(b, 1, signals[i]!.signal));
    promises.forEach((p) => p.catch(() => {}));
    // Each new board supersedes the previous one, as the effect cleanup does.
    for (let i = 0; i < bs.length - 1; i++) signals[i]!.abort();

    // bs[0] was already in flight: it still finishes. bs[1..3] never start.
    finish(0);
    expect(posts.map((p) => p.board)).toEqual([bs[0], bs[4]]);
    for (const p of promises.slice(1, 4)) {
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    }
    finish(1);
    await expect(promises[4]).resolves.toBeDefined();
  });

  it('keeps a job alive while any requester still wants it', async () => {
    const { q, posts, finish } = setup();
    const [a, b] = boards(2);
    q.request(a!, 1); // occupies the worker
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p = q.request(b!, 1, c1.signal);
    q.request(b!, 1, c2.signal);
    c1.abort();
    finish(0);
    expect(posts.map((x) => x.board)).toEqual([a, b]);
    finish(1);
    await expect(p).resolves.toBeDefined();
  });

  it('ignores stale or unknown worker replies', () => {
    const { q, posts, onResult } = setup();
    const [a] = boards(1);
    q.request(a!, 1);
    q.receive(posts[0]!.id + 99, mesh());
    expect(onResult).not.toHaveBeenCalled();
  });

  it('does not start a job for an already-aborted request', async () => {
    const { q, posts } = setup();
    const [a] = boards(1);
    const c = new AbortController();
    c.abort();
    await expect(q.request(a!, 1, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(posts).toHaveLength(0);
  });

  it('a failed job rejects and the queue moves on to the next board', async () => {
    const { q, posts, finish } = setup();
    const [a, b] = boards(2);
    const pa = q.request(a!, 1);
    const pb = q.request(b!, 1);
    q.fail(posts[0]!.id, new Error('kernel threw'));
    await expect(pa).rejects.toThrow('kernel threw');
    expect(posts.map((p) => p.board)).toEqual([a, b]);
    finish(1);
    await expect(pb).resolves.toBeDefined();
    // A failed board is not remembered as in progress: asking again starts a job.
    q.request(a!, 1).catch(() => {});
    expect(posts).toHaveLength(3);
  });

  it('a dead worker rejects every job', async () => {
    const { q, posts } = setup();
    const [a, b] = boards(2);
    const pa = q.request(a!, 1);
    const pb = q.request(b!, 1);
    q.failAll(new Error('worker gone'));
    await expect(pa).rejects.toThrow('worker gone');
    await expect(pb).rejects.toThrow('worker gone');
    expect(posts).toHaveLength(1);
  });
});
