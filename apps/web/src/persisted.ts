/**
 * The localStorage pattern every settings module shares: read JSON, run the
 * module's migration, fall back to its defaults on anything missing or broken.
 * Keys, shapes and migrations stay with each module.
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
 * Store `value` as JSON under `key`. Deliberately unguarded — a quota or
 * blocked-storage error reaches the caller, as it always has.
 */
export function writeStored(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}
