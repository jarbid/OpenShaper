/**
 * The localStorage pattern every settings module shares: read JSON, run the
 * module's migration, fall back to its defaults on anything missing or broken.
 * Keys, shapes and migrations stay with each module. Nothing here throws: blocked
 * or full storage degrades to "not remembered", never to a crash.
 */

/** Stored value for `key` passed through `migrate`, or `fallback` if absent/unreadable. */
export function readStored<T>(key: string, fallback: T, migrate: (parsed: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return migrate(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/**
 * Store `value` as JSON under `key`. Returns false if storage refused it (quota
 * exceeded, storage blocked, private mode) — settings are a convenience, so a
 * failure to remember them must never stop the action that saved them (an export,
 * closing the settings dialog).
 */
export function writeStored(key: string, value: unknown): boolean {
  return writeRaw(key, JSON.stringify(value));
}

/** The raw string stored under `key`, or null if absent or storage is unavailable. */
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store a raw string; returns false (and does nothing else) if storage refuses. */
export function writeRaw(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
