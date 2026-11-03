// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The sidebar's specs from the NURBS mesh (docs/design/m2-editor.md §4, step 5). With the engine on the
 * document is the board, so volume, plan area and the centre of mass are those of the surface it
 * describes, with its bottom features and its asymmetry, rather than the classic loft of its projection.
 *
 * Same pattern as `use-specs-worker.ts`: the compute is in a worker (a `measure` job: build, mesh, four
 * numbers; no surface comes back), it asks for the *settled* document so a drag does not measure on every
 * pointer move, the last values hold while a new one is computed, and a superseded job is dropped. This
 * hook has its own client rather than the 3D view's, so the specs are there with the 3D view hidden.
 *
 * A document the model refuses (an edit made a plan impossible) has no mesh: the measure is null and the
 * sidebar shows the classic specs of the projection until the board builds again.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { captureError } from './analytics';
import { sectionStore } from './store';
import type { NurbsClient, SupersededError } from './nurbs-client';
import type { MeshMeasure } from './workers/nurbs-protocol';

/** The measure of a document, with the load (`loadCount`) it was measured for. */
export interface MeshSpecs extends MeshMeasure {
  readonly loadCount: number;
}

export function useMeshSpecs(active: boolean): MeshSpecs | null {
  const doc = useSyncExternalStore(sectionStore.subscribe, () => sectionStore.getState().doc);
  const editing = useSyncExternalStore(
    sectionStore.subscribe,
    () => sectionStore.getState().editing,
  );
  const loadCount = useSyncExternalStore(
    sectionStore.subscribe,
    () => sectionStore.getState().loadCount,
  );
  // the document as of the last moment it was not being dragged
  const settled = useRef(doc);
  if (!editing) settled.current = doc;
  const target = active ? settled.current : null;

  const [result, setResult] = useState<MeshSpecs | null>(null);

  // One client (one worker) for as long as the specs come from the mesh.
  const clientRef = useRef<Promise<{
    client: NurbsClient;
    SupersededError: typeof SupersededError;
  }> | null>(null);
  useEffect(() => {
    if (!active) return;
    return () => {
      void clientRef.current?.then((c) => c.client.dispose());
      clientRef.current = null;
      setResult(null);
    };
  }, [active]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    // The client is loaded when a measure is wanted, so the engine-off page never fetches it.
    clientRef.current ??= import('./nurbs-client').then((m) => ({
      client: m.createNurbsClient(),
      SupersededError: m.SupersededError,
    }));
    clientRef.current
      .then(({ client, SupersededError: Superseded }) =>
        client.measure(target).then(
          (answer) => {
            if (!cancelled) setResult(answer.ok ? { ...answer, loadCount } : null);
          },
          (err: unknown) => {
            if (cancelled || err instanceof Superseded) return;
            captureError('nurbs_specs', err);
            setResult(null);
          },
        ),
      )
      .catch((err: unknown) => {
        // the chunk would not load (offline, or removed by a deploy): the classic specs stay
        if (!cancelled) captureError('nurbs_specs', err);
      });
    return () => {
      cancelled = true;
    };
  }, [target, loadCount]);

  return result && result.loadCount === loadCount ? result : null;
}
