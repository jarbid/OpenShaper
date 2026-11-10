// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer's autosave: one record holding the fin being worked on, as
 * `.fin.json` text, in IndexedDB, so a reload or a closed tab never loses it. The same
 * shape as the board's session-store.ts, in its own database so the two never clash.
 *
 * Every function swallows storage failures (private browsing, denied quota, no
 * IndexedDB): the designer then just starts from a default fin, never crashes.
 */
import { objectStore, openSingleStoreDb, promisify } from '../idb';

/** Bump when the stored shape changes in a breaking way. */
export const FIN_SESSION_VERSION = 1;

const DB_NAME = 'bs.fin-session';
const STORE_NAME = 'session';
const KEY = 'current';

interface StoredFin {
  key: typeof KEY;
  version: number;
  finJson: string;
  savedAt: number;
}

const openDb = (factory: IDBFactory) =>
  openSingleStoreDb(factory, DB_NAME, FIN_SESSION_VERSION, STORE_NAME, 'key');

const globalFactory = (): IDBFactory | undefined =>
  typeof indexedDB === 'undefined' ? undefined : indexedDB;

/** Store the fin (its `.fin.json` text). Failures are swallowed. */
export async function saveFinSession(finJson: string, factory?: IDBFactory): Promise<void> {
  const f = factory ?? globalFactory();
  if (!f) return;
  try {
    const db = await openDb(f);
    try {
      const rec: StoredFin = {
        key: KEY,
        version: FIN_SESSION_VERSION,
        finJson,
        savedAt: Date.now(),
      };
      await promisify(objectStore(db, STORE_NAME, 'readwrite').put(rec));
    } finally {
      db.close();
    }
  } catch {
    // Quota, private browsing, blocked upgrade: degrade silently.
  }
}

/** The stored fin's `.fin.json` text, or undefined (none, other version, storage error). */
export async function loadFinSession(factory?: IDBFactory): Promise<string | undefined> {
  const f = factory ?? globalFactory();
  if (!f) return undefined;
  try {
    const db = await openDb(f);
    try {
      const rec = (await promisify(objectStore(db, STORE_NAME, 'readonly').get(KEY))) as
        Partial<StoredFin> | undefined;
      if (!rec || rec.version !== FIN_SESSION_VERSION || typeof rec.finJson !== 'string') {
        return undefined;
      }
      return rec.finJson;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
