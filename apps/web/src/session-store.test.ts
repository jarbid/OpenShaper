/**
 * Session persistence — the single autosaved "current session" record in
 * IndexedDB that lets the app silently restore the working board on revisit.
 *
 * Uses fake-indexeddb: each test gets its own IDBFactory so tests are isolated
 * and never touch a real browser database.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSession, loadSession, saveSession, SESSION_VERSION } from './session-store';

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

describe('session-store', () => {
  it('returns undefined when nothing has been saved', async () => {
    expect(await loadSession(factory)).toBeUndefined();
  });

  it('round-trips a saved session (board + ghost)', async () => {
    await saveSession({ boardJson: '{"board":1}', ghostJson: '{"ghost":1}' }, factory);
    const s = await loadSession(factory);
    expect(s).toBeDefined();
    expect(s!.boardJson).toBe('{"board":1}');
    expect(s!.ghostJson).toBe('{"ghost":1}');
  });

  it('omits ghostJson when the session was saved without a ghost', async () => {
    await saveSession({ boardJson: '{"board":1}' }, factory);
    const s = await loadSession(factory);
    expect(s!.boardJson).toBe('{"board":1}');
    expect(s!.ghostJson).toBeUndefined();
  });

  it('keeps a single record — the latest save wins', async () => {
    await saveSession({ boardJson: 'first' }, factory);
    await saveSession({ boardJson: 'second' }, factory);
    const s = await loadSession(factory);
    expect(s!.boardJson).toBe('second');
  });

  it('treats a version-mismatched record as absent', async () => {
    await saveSession({ boardJson: 'x' }, factory);
    // Corrupt the stored version out-of-band, as a future/foreign schema would.
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = factory.open('bs.session', SESSION_VERSION);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('session', 'readwrite');
      const req = tx
        .objectStore('session')
        .put({ key: 'current', version: SESSION_VERSION + 1, boardJson: 'x', savedAt: 0 });
      req.onsuccess = res;
      req.onerror = () => rej(req.error);
    });
    db.close();
    expect(await loadSession(factory)).toBeUndefined();
  });

  it('treats a malformed record (missing boardJson) as absent', async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = factory.open('bs.session', SESSION_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('session', { keyPath: 'key' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const req = db
        .transaction('session', 'readwrite')
        .objectStore('session')
        .put({ key: 'current', version: SESSION_VERSION, savedAt: 0 });
      req.onsuccess = res;
      req.onerror = () => rej(req.error);
    });
    db.close();
    expect(await loadSession(factory)).toBeUndefined();
  });

  it('clearSession removes the stored session', async () => {
    await saveSession({ boardJson: 'x' }, factory);
    await clearSession(factory);
    expect(await loadSession(factory)).toBeUndefined();
  });

  it('degrades gracefully when IndexedDB is unavailable', async () => {
    // No injected factory and no global indexedDB (plain jsdom): every call
    // must resolve without throwing, and loads report "no session".
    await expect(saveSession({ boardJson: 'x' })).resolves.toBeUndefined();
    await expect(loadSession()).resolves.toBeUndefined();
    await expect(clearSession()).resolves.toBeUndefined();
  });

  it('degrades gracefully when the database cannot be opened', async () => {
    const broken = {
      open() {
        throw new Error('denied');
      },
    } as unknown as IDBFactory;
    await expect(saveSession({ boardJson: 'x' }, broken)).resolves.toBeUndefined();
    await expect(loadSession(broken)).resolves.toBeUndefined();
    await expect(clearSession(broken)).resolves.toBeUndefined();
  });
});
