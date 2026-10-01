/**
 * The few IndexedDB helpers the persistence modules (session-store, trace-store)
 * share. Each module owns its own database, version and record shape; these only
 * remove the boilerplate around them.
 */

/** Resolve with an IDBRequest's result, reject with its error. */
export const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Open `name` at `version`, creating the single object store `storeName` if missing. */
export function openSingleStoreDb(
  factory: IDBFactory,
  name: string,
  version: number,
  storeName: string,
  keyPath: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The object store `storeName` in a fresh transaction of `mode`. */
export const objectStore = (
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
): IDBObjectStore => db.transaction(storeName, mode).objectStore(storeName);
