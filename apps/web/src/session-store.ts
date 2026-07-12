/**
 * Session persistence — silent session restore.
 *
 * One autosaved "current session" record (the working board, its metadata baked
 * into the board JSON, and the ghost/comparison board if any) lives in
 * IndexedDB, so closing or reloading the tab never loses work. Board JSON can
 * exceed localStorage budgets, hence IndexedDB; mirrors the versioned schema
 * and injectable-factory shape of trace-store.ts.
 *
 * Every function swallows storage failures (private browsing, denied quota,
 * missing IndexedDB): persistence degrades to "no session", never to a crash.
 */

/** Bump when the StoredSession shape changes in a breaking way. */
export const SESSION_VERSION = 1;

const DB_NAME = 'bs.session';
const STORE_NAME = 'session';
/** keyPath value — there is exactly one session record. */
const KEY = 'current';

/** What the app hands in / gets back: serialized boards, meta inside boardJson. */
export interface SessionSnapshot {
  /** Full `.board.json` text from writeBoardJson (includes metadata). */
  boardJson: string;
  /** Serialized ghost/comparison board, when one is loaded. */
  ghostJson?: string;
}

interface StoredSession extends SessionSnapshot {
  key: typeof KEY;
  version: number;
  savedAt: number;
}

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, SESSION_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const store = (db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore =>
  db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);

/** The global factory, or undefined where IndexedDB doesn't exist (tests, old jsdom). */
const globalFactory = (): IDBFactory | undefined =>
  typeof indexedDB === 'undefined' ? undefined : indexedDB;

/** Insert or replace the single session record. Failures are swallowed. */
export async function saveSession(snapshot: SessionSnapshot, factory?: IDBFactory): Promise<void> {
  const f = factory ?? globalFactory();
  if (!f) return;
  try {
    const db = await openDb(f);
    try {
      const rec: StoredSession = {
        key: KEY,
        version: SESSION_VERSION,
        boardJson: snapshot.boardJson,
        ...(snapshot.ghostJson !== undefined ? { ghostJson: snapshot.ghostJson } : {}),
        savedAt: Date.now(),
      };
      await promisify(store(db, 'readwrite').put(rec));
    } finally {
      db.close();
    }
  } catch {
    // QuotaExceededError, private browsing, blocked upgrade — degrade silently.
  }
}

/**
 * Read the stored session, or undefined when there is none / the record is
 * from another schema version / the record is malformed / storage errors.
 */
export async function loadSession(factory?: IDBFactory): Promise<SessionSnapshot | undefined> {
  const f = factory ?? globalFactory();
  if (!f) return undefined;
  try {
    const db = await openDb(f);
    try {
      const rec = (await promisify(store(db, 'readonly').get(KEY))) as
        | Partial<StoredSession>
        | undefined;
      if (!rec || rec.version !== SESSION_VERSION || typeof rec.boardJson !== 'string') {
        return undefined;
      }
      return {
        boardJson: rec.boardJson,
        ...(typeof rec.ghostJson === 'string' ? { ghostJson: rec.ghostJson } : {}),
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** Delete the stored session. Failures are swallowed. */
export async function clearSession(factory?: IDBFactory): Promise<void> {
  const f = factory ?? globalFactory();
  if (!f) return;
  try {
    const db = await openDb(f);
    try {
      await promisify(store(db, 'readwrite').delete(KEY));
    } finally {
      db.close();
    }
  } catch {
    // Ignore — nothing to clear or storage locked.
  }
}
