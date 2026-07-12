/**
 * Trace-image persistence.
 *
 * Each editor view (outline / rocker) may hold one reference image the shaper
 * traces over. The image bytes are too large for localStorage, so they live in
 * IndexedDB — one record per view, keyed by view — alongside their placement
 * transform. This survives reload but is intentionally board-independent and is
 * NOT written into the .brd file (see docs plan). Mirrors the versioned
 * load/migrate shape of settings.ts.
 */
import type { SimilarityParams } from '@openshaper/render2d';

export type TraceView = 'outline' | 'rocker';

/** Bump when the StoredTrace shape changes in a breaking way. */
export const TRACE_STORE_VERSION = 1;

const DB_NAME = 'bs.trace';
const STORE_NAME = 'traces';

export interface StoredTrace {
  /** keyPath — 'outline' | 'rocker'. */
  view: TraceView;
  /** Original file bytes, replayed into an object URL on load. */
  blob: Blob;
  mime: string;
  naturalWidth: number;
  naturalHeight: number;
  opacity: number;
  transform: SimilarityParams;
  /** Last calibration reference points (image px), for re-edit/UX. */
  refPointsImg?: [{ x: number; y: number }, { x: number; y: number }];
  version: number;
  updatedAt: number;
}

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Open (and if needed create/upgrade) the trace database. `factory` is injectable
 * so tests can pass a fake-indexeddb instance; production uses the global.
 */
export function openTraceDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, TRACE_STORE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'view' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore =>
  db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);

/** Insert or replace the trace record for a view. */
export async function putTrace(rec: StoredTrace, factory?: IDBFactory): Promise<void> {
  const db = await openTraceDb(factory);
  try {
    await promisify(tx(db, 'readwrite').put({ ...rec, version: TRACE_STORE_VERSION }));
  } finally {
    db.close();
  }
}

/** Read one view's trace record, or undefined if none / on any error. */
export async function getTrace(
  view: TraceView,
  factory?: IDBFactory,
): Promise<StoredTrace | undefined> {
  const db = await openTraceDb(factory);
  try {
    const rec = await promisify(tx(db, 'readonly').get(view));
    return rec as StoredTrace | undefined;
  } finally {
    db.close();
  }
}

/** Read all stored traces (used to rehydrate on app mount). */
export async function getAllTraces(factory?: IDBFactory): Promise<StoredTrace[]> {
  const db = await openTraceDb(factory);
  try {
    const all = await promisify(tx(db, 'readonly').getAll());
    return (all as StoredTrace[]) ?? [];
  } finally {
    db.close();
  }
}

/** Delete one view's trace record (Clear). */
export async function deleteTrace(view: TraceView, factory?: IDBFactory): Promise<void> {
  const db = await openTraceDb(factory);
  try {
    await promisify(tx(db, 'readwrite').delete(view));
  } finally {
    db.close();
  }
}
