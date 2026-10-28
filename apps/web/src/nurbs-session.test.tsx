// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Turning the experimental engine off ends its worker and drops its caches; leaving the
 * 3D pane (an unmount) does not. The layer is rendered for real over a fake client, so
 * the shared viewer, its registration and the hook are exercised together.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LENGTH_UNIT } from './format';
import type { NurbsClient } from './nurbs-client';
import { releaseNurbs, useReleaseNurbsWhenOff } from './nurbs-session';
import { boardStore } from './store';

const clients: { client: NurbsClient; disposed: number; cancels: number }[] = [];
vi.mock('./nurbs-client', async (importActual) => ({
  ...(await importActual<typeof import('./nurbs-client')>()),
  createNurbsClient: (): NurbsClient => {
    const rec = { disposed: 0, cancels: 0 } as {
      client: NurbsClient;
      disposed: number;
      cancels: number;
    };
    rec.client = {
      classic: () => new Promise(() => {}), // a job that never finishes
      test: () => new Promise(() => {}),
      cancel: () => void rec.cancels++,
      dispose: () => void rec.disposed++,
    };
    clients.push(rec);
    return rec.client;
  },
}));

const { default: NurbsLayer } = await import('./nurbs-layer');

const mountLayer = () =>
  render(
    <NurbsLayer
      store={boardStore}
      analysis="none"
      units={DEFAULT_LENGTH_UNIT}
      onSurface={() => {}}
    />,
  );

function Engine({ on }: { on: boolean }) {
  useReleaseNurbsWhenOff(on);
  return null;
}

afterEach(() => {
  releaseNurbs();
  clients.length = 0;
});

describe('releasing the NURBS viewer', () => {
  it('leaving the pane (unmount) keeps the worker and caches; the viewer is shared again on return', () => {
    const first = mountLayer();
    expect(clients).toHaveLength(1);
    first.unmount();
    expect(clients[0]!.disposed).toBe(0);
    const second = mountLayer();
    expect(clients).toHaveLength(1); // the same shared viewer
    second.unmount();
    expect(clients[0]!.disposed).toBe(0);
  });

  it('turning the engine off disposes the shared viewer once, terminating its worker', () => {
    const layer = mountLayer();
    const { rerender } = render(<Engine on />);
    rerender(<Engine on />);
    expect(clients[0]!.disposed).toBe(0);
    rerender(<Engine on={false} />);
    expect(clients[0]!.disposed).toBe(1);
    rerender(<Engine on={false} />);
    expect(clients[0]!.disposed).toBe(1);
    layer.unmount();
    // Engine back on: a fresh viewer (and worker), not the disposed one.
    mountLayer();
    expect(clients).toHaveLength(2);
  });

  it('with the engine off from the start there is nothing to release', () => {
    expect(() => render(<Engine on={false} />)).not.toThrow();
    expect(clients).toHaveLength(0);
  });
});
