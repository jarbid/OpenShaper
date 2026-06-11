/**
 * Recent boards — persistent "open-recent" list stored in localStorage.
 *
 * Browsers cannot re-open file paths, so we store the full serialized board
 * JSON alongside a display name and timestamp. On reload the JSON is fed back
 * through readBoardJson just like opening a file.
 *
 * Constraints:
 *  - Newest first.
 *  - De-duplicated by name (re-recording an existing name moves it to the top
 *    and replaces its JSON with the latest snapshot).
 *  - Capped at MAX_RECENT_ENTRIES (8) entries.
 *  - Capped at MAX_RECENT_BYTES (~1 MB) total serialized size; oldest entries
 *    are evicted first when the budget is exceeded.
 *  - localStorage failures (QuotaExceededError, private-browsing restrictions)
 *    are silently swallowed — the feature degrades gracefully.
 *  - Corrupt stored JSON is treated as an empty list.
 */

export const STORAGE_KEY = 'bs.recent';

/** Maximum number of entries kept in the list. */
export const MAX_RECENT_ENTRIES = 8;

/** Maximum total serialized size (bytes / characters) of the stored JSON string. */
export const MAX_RECENT_BYTES = 1_000_000;

/** A single recent-board record stored in localStorage. */
export interface RecentEntry {
  /** Display name shown in the menu (file base name, model name, or template name). */
  name: string;
  /** ISO 8601 date-time string of when this entry was last recorded. */
  savedAt: string;
  /** The full `.board.json` text; fed to readBoardJson on reload. */
  boardJson: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as RecentEntry[];
  } catch {
    return [];
  }
}

function save(entries: RecentEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // QuotaExceededError or private-browsing — degrade silently.
  }
}

/**
 * Trim `entries` (newest first) so that the serialized JSON fits within
 * MAX_RECENT_BYTES.  We always keep at least the first (newest) entry so that
 * an oversized single board does not result in an empty list.
 */
function trimToByteLimit(entries: RecentEntry[]): RecentEntry[] {
  if (entries.length === 0) return entries;
  let trimmed = entries;
  while (trimmed.length > 1) {
    const serialized = JSON.stringify(trimmed);
    if (serialized.length <= MAX_RECENT_BYTES) break;
    trimmed = trimmed.slice(0, trimmed.length - 1); // drop oldest
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read the current list (newest first). Returns [] on any storage/parse error. */
export function getRecentBoards(): RecentEntry[] {
  return load();
}

/**
 * Record a board in the recent list.
 *
 * @param name      Display name (file base name, meta.model, or template name).
 * @param boardJson Serialized `.board.json` text from writeBoardJson.
 */
export function recordRecentBoard(name: string, boardJson: string): void {
  // Load existing list, remove any prior entry with the same name, prepend the
  // new one, apply the count cap, then apply the byte cap.
  const existing = load().filter((e) => e.name !== name);

  const newEntry: RecentEntry = {
    name,
    savedAt: new Date().toISOString(),
    boardJson,
  };

  const capped = [newEntry, ...existing].slice(0, MAX_RECENT_ENTRIES);
  const trimmed = trimToByteLimit(capped);

  save(trimmed);
}

/**
 * Remove all entries from the recent list.
 */
export function clearRecentBoards(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-browsing or locked storage — ignore.
  }
}
