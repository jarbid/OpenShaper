// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keeps the rails store (the rails board the editors edit with the rails engine on) in step with the
 * document that is open. The counterpart of `use-section-engine.ts` for a rails board; none of this is
 * in that module, so the sections path can go without touching it.
 *
 * The identity of the document open is the classic store's `loadCount` (every load of a file, template,
 * session or share link changes it). The rails store's board belongs to the load it was made for
 * (`from`), exactly as the section store's document does (`convertedFrom`).
 *
 * - **Turned on.** The board being edited becomes the rails board: converted from the section store's
 *   document when it holds this document (so NURBS edits are kept), otherwise from the classic board. It
 *   is kept: turning the switch off and on again converts nothing and loses no rails edit, until another
 *   document is loaded.
 * - **While on.** A file, template or session loads the classic store (or, for a sections document, both
 *   it and the section store); the change of `loadCount` converts the new board into the rails store.
 * - **Documents that arrive whole.** A rails board (an opened file, a share link, a restored session) is
 *   loaded into the rails store directly ({@link openRailsBoard}, {@link attachRailsBoard}), with its
 *   classic projection as the classic store's board: no conversion.
 * - **Turned off.** Nothing happens here: the section (or classic) store is shown as it was, and the rails
 *   store keeps its board and its history.
 * - **Refusal.** A board the converter refuses leaves the store being edited as it was and `ready` false;
 *   the reasons are in `refusal`.
 * - **Edits while converting.** The store being edited until the rails board is ready is the section
 *   store (or the classic one). An edit made while a conversion runs would be lost when the board
 *   replaced it, so a conversion whose source was edited meanwhile (or is being dragged) is thrown away and
 *   made again from the edited source: the board that lands includes every edit.
 *
 * Conversion runs in the NURBS worker (`kind: 'to-rails'`); the main chunk never imports board2.
 */
import type { RailsBoard } from '@openshaper/board2';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { loadNurbsCore } from './section-files';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import type { NurbsIssue } from './workers/nurbs-protocol';

interface Sync {
  /** `boardStore.loadCount` of the document the rails store's board belongs to. */
  readonly from: number | null;
  /** The load that was refused, with the reasons. */
  readonly refused: {
    readonly loadCount: number;
    readonly error: string;
    readonly issues: readonly NurbsIssue[];
  } | null;
}

let sync: Sync = { from: null, refused: null };
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
export const resetRailsEngine = (): void => {
  setSync({ from: null, refused: null });
};

/**
 * Make `board` the rails store's board for the classic document that is open now (call it right after
 * the classic store loaded that document: a restored session). Starts loading the file code in the
 * background, which autosave and Save need.
 */
export function attachRailsBoard(board: RailsBoard): void {
  railsStore.getState().loadDoc(board);
  setSync({ from: boardStore.getState().loadCount, refused: null });
  void loadNurbsCore().catch(() => {});
}

/**
 * Open `board` as the document: the rails store takes it, and the classic store takes its projection
 * (what the engine-off view, the "Deviation from classic" reference and the ghost see), so no
 * conversion follows.
 */
export function openRailsBoard(board: RailsBoard): void {
  railsStore.getState().loadDoc(board);
  const projection = railsStore.getState().board;
  if (projection) boardStore.getState().load(projection);
  attachRailsBoard(board);
}

/** The rails board being edited, when the rails store is the one shown and holds the open document. What the session autosave writes. */
export function currentRails(): RailsBoard | null {
  if (activeStore.target !== railsStore) return null;
  return sync.from === boardStore.getState().loadCount ? railsStore.getState().doc : null;
}

/** Whether the rails store holds the board of the open document (shown or not). */
export function useRailsCurrent(): boolean {
  const loadCount = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().loadCount,
  );
  const current = useSyncExternalStore(subscribeSync, () => sync);
  return current.from === loadCount && railsStore.getState().doc !== null;
}

export interface RailsEngine {
  /** The rails store holds the board of the open document and the switch is on: the editors may use it. */
  readonly ready: boolean;
  /** Why the open board was refused, when it was. */
  readonly refusal: { readonly error: string; readonly issues: readonly NurbsIssue[] } | null;
  /** A conversion is under way. */
  readonly converting: boolean;
}

const OFF: RailsEngine = { ready: false, refusal: null, converting: false };

/**
 * @param on The NURBS engine and the rails switch are both on.
 * @param sections The section engine's state: a conversion waits for it, so the source is one document.
 */
export function useRailsEngine(
  on: boolean,
  sections: { readonly ready: boolean; readonly converting: boolean },
): RailsEngine {
  const loadCount = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().loadCount,
  );
  const hasBoard = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().board !== null,
  );
  const current = useSyncExternalStore(subscribeSync, () => sync);

  const upToDate = current.from === loadCount && railsStore.getState().doc !== null;
  const refused = current.refused?.loadCount === loadCount ? current.refused : null;
  // One object per refusal, so an effect that reports it runs once.
  const refusal = useMemo(
    () => (refused ? { error: refused.error, issues: refused.issues } : null),
    [refused],
  );
  const waiting = sections.converting;
  const fromSections = sections.ready;

  useEffect(() => {
    if (!on || !hasBoard || upToDate || refused || waiting) return;
    let cancelled = false;
    const cleanups = new Set<() => void>();
    /** The load this conversion is for is no longer the open one, or already has its rails board. */
    const stale = (): boolean =>
      boardStore.getState().loadCount !== loadCount || sync.from === loadCount;
    const refuse = (error: string, issues: readonly NurbsIssue[] = []) => {
      if (!stale()) setSync({ ...sync, refused: { loadCount, error, issues } });
    };

    /** The document the conversion is made from: the section store's when it holds this document. */
    const source = () =>
      fromSections && sectionStore.getState().doc
        ? ({
            of: sectionStore.getState().doc!,
            editing: sectionStore.getState().editing,
          } as const)
        : ({
            of: boardStore.getState().board,
            editing: boardStore.getState().editing,
          } as const);
    /** Resolves when the source is not being dragged (at once if it is not). */
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        const store = fromSections ? sectionStore : boardStore;
        if (!store.getState().editing) return resolve();
        const unsubscribe = store.subscribe((s) => {
          if (s.editing) return;
          unsubscribe();
          cleanups.delete(unsubscribe);
          resolve();
        });
        cleanups.add(unsubscribe);
      });

    const run = async (): Promise<void> => {
      // The client is loaded when a conversion is wanted, so the engine-off page never fetches it.
      const { createNurbsClient, SupersededError } = await import('./nurbs-client');
      if (cancelled) return;
      const client = createNurbsClient();
      cleanups.add(() => client.dispose());
      for (;;) {
        await settled();
        if (cancelled) return;
        const from = source();
        if (!from.of) return;
        let answer: Awaited<ReturnType<typeof client.toRails>>;
        try {
          answer = await client.toRails(from.of);
        } catch (err) {
          if (cancelled || err instanceof SupersededError) return;
          refuse(err instanceof Error ? err.message : String(err));
          return;
        }
        // Another document was loaded (or a rails board attached to this one) while it converted: the
        // answer is not wanted. Checked on the stores themselves, because a load made in the same task as
        // the answer arrives has not yet re-rendered this hook, and a rails board opened whole leaves the
        // section store's document, the source here, as it was.
        if (cancelled || stale()) return;
        // The source was edited while it converted: the answer is for an older one. Convert again, so
        // the edit is in the board that lands rather than lost to it.
        const now = source();
        if (now.of !== from.of || now.editing) continue;
        if (answer.ok) {
          railsStore.getState().loadDoc(answer.board);
          setSync({ from: loadCount, refused: null });
          void loadNurbsCore().catch(() => {});
        } else {
          refuse(answer.error, answer.issues);
        }
        client.dispose();
        return;
      }
    };
    run().catch((err: unknown) => {
      // the chunk would not load (offline, or removed by a deploy)
      if (!cancelled) refuse(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [on, hasBoard, loadCount, upToDate, refused, waiting, fromSections]);

  if (!on) return OFF;
  return {
    ready: upToDate,
    refusal,
    converting: hasBoard && !upToDate && !refused,
  };
}
