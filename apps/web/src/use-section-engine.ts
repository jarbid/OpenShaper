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
import { createNurbsClient, SupersededError } from './nurbs-client';
import { boardStore, sectionStore } from './store';
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
    const client = createNurbsClient();
    let cancelled = false;
    client.convert(board).then(
      (answer) => {
        if (cancelled) return;
        if (answer.ok) {
          sectionStore.getState().loadDoc(answer.doc);
          setSync({ convertedFrom: loadCount, refused: null });
        } else {
          setSync({ ...sync, refused: { loadCount, error: answer.error, issues: answer.issues } });
        }
        client.dispose();
      },
      (err: unknown) => {
        client.dispose();
        if (cancelled || err instanceof SupersededError) return;
        setSync({
          ...sync,
          refused: {
            loadCount,
            error: err instanceof Error ? err.message : String(err),
            issues: [],
          },
        });
      },
    );
    return () => {
      cancelled = true;
      client.dispose();
    };
  }, [engineOn, hasBoard, loadCount, upToDate, refused]);

  if (!engineOn) return OFF;
  return {
    ready: upToDate,
    refusal: refused ? { error: refused.error, issues: refused.issues } : null,
    converting: hasBoard && !upToDate && !refused,
  };
}
