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
 *   the reasons in `refusal` (the app shows them as an import notice; the 3D view's popover has them too).
 * - **Edits while converting.** The classic board is the one edited until the document is ready. An edit
 *   made in that window (a conversion takes 0.1 to 0.3 s) would be lost when the document replaced the
 *   board, so a conversion whose board was edited meanwhile (or is being dragged) is thrown away and
 *   made again from the edited board: the document that lands always includes every edit. The undo
 *   history of the window starts over with the document, like any load.
 * - **Documents that arrive whole.** A saved NURBS document (an opened `.board` file, a share link, a
 *   restored session) is loaded as the section store's document directly ({@link openSectionDoc},
 *   {@link attachSectionDoc}), with its classic projection as the classic store's board: no conversion.
 *   A session restored with the engine off holds the document's text ({@link holdSectionsText}), and
 *   turning the engine on revives it instead of converting.
 *
 * The converter runs in the NURBS worker (`kind: 'convert'`): the main chunk never imports board2. This is
 * the only conversion; edits go to the worker as documents (`nurbs-viewer.ts`).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { loadNurbsCore, readSections } from './section-files';
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

/** The text of a saved document waiting for the engine to be turned on, for one load of the classic store. */
let held: { readonly loadCount: number; readonly text: string } | null = null;

/** Forget what was converted (tests). */
export const resetSectionEngine = (): void => {
  held = null;
  setSync({ convertedFrom: null, refused: null });
};

/**
 * Keep the text of a saved NURBS document for the classic board just loaded (a session restored while the
 * engine is off). The next autosave writes it back unchanged, and turning the engine on revives it.
 */
export const holdSectionsText = (text: string): void => {
  held = { loadCount: boardStore.getState().loadCount, text };
};

/** The held text for the classic board now open, if any. */
const heldFor = (loadCount: number): string | null =>
  held && held.loadCount === loadCount ? held.text : null;

/**
 * The section document that belongs to the classic board now open: the section store's, when it was
 * converted from or loaded with this board; else the held text. Null when there is none (the engine has
 * not run for this board). What the session autosave writes.
 */
export function currentSections(): { doc: BoardDoc } | { text: string } | null {
  const loadCount = boardStore.getState().loadCount;
  const doc = sectionStore.getState().doc;
  if (doc && sync.convertedFrom === loadCount) return { doc };
  const text = heldFor(loadCount);
  return text === null ? null : { text };
}

/**
 * Revive a saved document and get it ready to load: board2's code is loaded (the section store's
 * notch-zone chord comes from it, and the document is revived and written by it), the chord provider is
 * injected for a notched tail. The reasons come back when it is not a NURBS board document.
 */
export async function prepareSectionDoc(
  json: unknown,
): Promise<
  { ok: true; doc: BoardDoc } | { ok: false; error: string; reason: 'unavailable' | 'invalid' }
> {
  const r = await readSections(json);
  if (r.ok) await injectNotchChords(r.doc);
  return r;
}

/**
 * Make `doc` the section store's document for the classic board that is open now (call it right after the
 * classic store loaded that board: a restored session). Starts loading the file code in the background,
 * which autosave and Save need.
 */
export function attachSectionDoc(doc: BoardDoc): void {
  sectionStore.getState().loadDoc(doc);
  held = null;
  setSync({ convertedFrom: boardStore.getState().loadCount, refused: null });
  void loadNurbsCore().catch(() => {});
}

/**
 * Open `doc` as the board: the section store takes it, and the classic store takes its projection (what the
 * engine-off view, the "Deviation from classic" reference and the ghost see), so no conversion follows.
 * The document must have been through {@link prepareSectionDoc}.
 */
export function openSectionDoc(doc: BoardDoc): void {
  sectionStore.getState().loadDoc(doc);
  const projection = sectionStore.getState().board;
  if (projection) boardStore.getState().load(projection);
  attachSectionDoc(doc);
}

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
    const { notchChords } = await loadNurbsCore();
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
  // One object per refusal, so an effect that reports it runs once.
  const refusal = useMemo(
    () => (refused ? { error: refused.error, issues: refused.issues } : null),
    [refused],
  );

  useEffect(() => {
    if (!engineOn || !hasBoard || upToDate || refused) return;
    let cancelled = false;
    const cleanups = new Set<() => void>();
    const refuse = (error: string, issues: readonly NurbsIssue[] = []) =>
      setSync({ ...sync, refused: { loadCount, error, issues } });
    /** Resolves when the classic board is not being dragged (at once if it is not). */
    const settled = (): Promise<void> =>
      new Promise((resolve) => {
        if (!boardStore.getState().editing) return resolve();
        const unsubscribe = boardStore.subscribe((s) => {
          if (s.editing) return;
          unsubscribe();
          cleanups.delete(unsubscribe);
          resolve();
        });
        cleanups.add(unsubscribe);
      });

    const run = async (): Promise<void> => {
      // A saved document waiting for the engine (a session restored with it off) is revived, not converted.
      const text = heldFor(loadCount);
      if (text !== null) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const r = await prepareSectionDoc(json);
        if (cancelled) return;
        if (r.ok) {
          attachSectionDoc(r.doc);
          return;
        }
        if (r.reason === 'unavailable') {
          // The code would not load (offline, a stale app shell): the saved document is intact, so it is
          // kept (the autosave writes it back) and nothing is converted over it.
          refuse(
            'The saved NURBS board could not be loaded (offline?). It is kept; the classic board is shown.',
          );
          return;
        }
        held = null; // not a document after all: convert the classic board
      }
      // The client is loaded when a conversion is wanted, so the engine-off page never fetches it.
      const { createNurbsClient, SupersededError } = await import('./nurbs-client');
      if (cancelled) return;
      const client = createNurbsClient();
      cleanups.add(() => client.dispose());
      for (;;) {
        await settled();
        if (cancelled) return;
        const board = boardStore.getState().board;
        if (!board) return;
        let answer: Awaited<ReturnType<typeof client.convert>>;
        try {
          answer = await client.convert(board);
          if (answer.ok) await injectNotchChords(answer.doc);
        } catch (err) {
          if (cancelled || err instanceof SupersededError) return;
          refuse(err instanceof Error ? err.message : String(err));
          return;
        }
        if (cancelled) return;
        // The board was edited while it converted: the answer is for an older board. Convert again, so
        // the edit is in the document that lands rather than lost to it.
        const now = boardStore.getState();
        if (now.board !== board || now.editing) continue;
        if (answer.ok) {
          sectionStore.getState().loadDoc(answer.doc);
          setSync({ convertedFrom: loadCount, refused: null });
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
  }, [engineOn, hasBoard, loadCount, upToDate, refused]);

  if (!engineOn) return OFF;
  return {
    ready: upToDate,
    refusal,
    converting: hasBoard && !upToDate && !refused,
  };
}
