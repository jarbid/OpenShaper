// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keeps the section store (the NURBS document the editors edit) in step with the classic store it is
 * converted from (docs/design/m2-editor.md §1, "Engine switch").
 *
 * - **Off to on.** The classic board is converted when the section store is empty, or when the classic
 *   store has loaded another document since the last conversion (`loadCount`). Otherwise the document
 *   already in the section store is kept, so switching the engine off and on again loses no NURBS edit.
 * - **While on.** Opening a file, starting a template or restoring a session loads the classic store
 *   (that is where files are read); the change of `loadCount` converts the new board into the section
 *   store.
 * - **On to off.** Nothing to do: the classic store is shown as it was.
 * - **Refusal.** A board the converter cannot hold (and a worker that cannot load) leaves the previous
 *   document in the section store and `ready` false, so the app keeps editing the classic board, with
 *   the reasons in `refusal`. The 3D view's own classic path explains them in its popover.
 *
 * The converter runs in the NURBS worker (`kind: 'convert'`): the main chunk never imports board2. This is
 * the only conversion; edits go to the worker as documents (`nurbs-viewer.ts`).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { boardStore, sectionStore } from './store';
import type { BoardDoc } from '@openshaper/board2';
import type { NurbsIssue } from './workers/nurbs-protocol';

interface Sync {
  /** `boardStore.loadCount` of the classic document the section store's document came from. */
  readonly convertedFrom: number | null;
  /** `boardStore.loadCount` of the classic document that was refused, with the reasons. */
  readonly refused: {
    readonly loadCount: number;
    readonly error: string;
    readonly issues: readonly NurbsIssue[];
  } | null;
}

let sync: Sync = { convertedFrom: null, refused: null };
const listeners = new Set<() => void>();
const setSync = (next: Sync): void => {
  sync = next;
  for (const l of [...listeners]) l();
};
const subscribeSync = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Forget what was converted (tests). */
export const resetSectionEngine = (): void => setSync({ convertedFrom: null, refused: null });

/**
 * Give the section store the notch-zone chord before a notched board is loaded (docs/design/m2-editor.md
 * §4, step 2). A station inside a swallow or fish notch is edited in the frame of its chord across the rail,
 * whose length needs board2's frame; the store may not import board2, so the code is loaded here, from the
 * compute module the worker also carries (a lazy chunk), and only for a notched board: a standard tail's
 * half-width is a function of x, which the store computes itself.
 */
export async function injectNotchChords(doc: BoardDoc): Promise<void> {
  if (doc.tail.kind !== 'notched') return;
  await loadNotchChords();
}

/**
 * Load the chord provider into the section store (idempotent: the chunk is loaded once). A tail change to
 * a swallow or fish needs it before the notched document is committed, or the projection shows the plan's
 * outer rail for the stations in the notch zone. A chunk that will not load (offline after a deploy)
 * leaves the plan rail in use; the edit still goes ahead.
 */
export async function loadNotchChords(): Promise<void> {
  try {
    const { notchChords } = await import('./workers/nurbs-core');
    sectionStore.getState().setNotchChords(notchChords);
  } catch {
    // keep the fallback
  }
}

export interface SectionEngine {
  /** The section store holds the document of the classic board now open: the editors may use it. */
  readonly ready: boolean;
  /** Why the open board was refused, when it was. */
  readonly refusal: { readonly error: string; readonly issues: readonly NurbsIssue[] } | null;
  /** A conversion is under way. */
  readonly converting: boolean;
}

const OFF: SectionEngine = { ready: false, refusal: null, converting: false };

export function useSectionEngine(engineOn: boolean): SectionEngine {
  const loadCount = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().loadCount,
  );
  const hasBoard = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().board !== null,
  );
  const current = useSyncExternalStore(subscribeSync, () => sync);

  const upToDate = current.convertedFrom === loadCount && sectionStore.getState().doc !== null;
  const refused = current.refused?.loadCount === loadCount ? current.refused : null;

  useEffect(() => {
    if (!engineOn || !hasBoard || upToDate || refused) return;
    const board = boardStore.getState().board;
    if (!board) return;
    let cancelled = false;
    let dispose = () => {};
    const refuse = (error: string, issues: readonly NurbsIssue[] = []) =>
      setSync({ ...sync, refused: { loadCount, error, issues } });
    // The client is loaded when a conversion is wanted, so the engine-off page never fetches it.
    void import('./nurbs-client')
      .then(({ createNurbsClient, SupersededError }) => {
        if (cancelled) return;
        const client = createNurbsClient();
        dispose = () => client.dispose();
        return client.convert(board).then(
          async (answer) => {
            if (cancelled) return;
            if (answer.ok) {
              await injectNotchChords(answer.doc);
              if (cancelled) return;
              sectionStore.getState().loadDoc(answer.doc);
              setSync({ convertedFrom: loadCount, refused: null });
            } else {
              refuse(answer.error, answer.issues);
            }
            client.dispose();
          },
          (err: unknown) => {
            client.dispose();
            if (cancelled || err instanceof SupersededError) return;
            refuse(err instanceof Error ? err.message : String(err));
          },
        );
      })
      .catch((err: unknown) => {
        // the chunk would not load (offline, or removed by a deploy)
        if (!cancelled) refuse(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [engineOn, hasBoard, loadCount, upToDate, refused]);

  if (!engineOn) return OFF;
  return {
    ready: upToDate,
    refusal: refused ? { error: refused.error, issues: refused.issues } : null,
    converting: hasBoard && !upToDate && !refused,
  };
}
