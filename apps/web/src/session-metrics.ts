/**
 * Per-session usage counters, emitted as a single `session_summary` event when
 * the tab goes away.
 *
 * Why a summary instead of tracking each action: the interesting editor work
 * (dragging control points, orbiting the 3D view, scrubbing cross-sections)
 * happens at frame rate, so capturing it per-action would be millions of
 * events carrying the same information. One event per session answers "how far
 * did they actually get" at a fraction of the volume.
 *
 * Why it matters more here than in a typical app: `persistence: 'memory'`
 * (see analytics.ts) makes one page load one anonymous person, so cross-visit
 * depth is unmeasurable by construction. Within-session depth is the only
 * depth there is, and this is where it comes from.
 *
 * Nothing here records board content or file names — only counts, booleans,
 * and a fixed set of view names.
 */
import { track } from './analytics';

let startedAt = 0;
let installed = false;
let flushed = false;
let exported = false;
let saved = false;
let imported = false;
let templateUsed = false;
const viewsUsed = new Set<string>();

export function markView(view: string): void {
  viewsUsed.add(view);
}

export function markExport(): void {
  exported = true;
}

export function markSave(): void {
  saved = true;
}

export function markImport(): void {
  imported = true;
}

export function markTemplate(): void {
  templateUsed = true;
}

/** Test seam: clear all counters and allow a fresh install. */
export function resetSessionMetrics(): void {
  startedAt = 0;
  installed = false;
  flushed = false;
  exported = false;
  saved = false;
  imported = false;
  templateUsed = false;
  viewsUsed.clear();
}

/**
 * Emit the summary. Guarded so a `pagehide` → restore-from-bfcache → `pagehide`
 * cycle can't double-count the same session.
 */
export function flushSessionSummary(getEditCount: () => number): void {
  if (flushed) return;
  flushed = true;
  track('session_summary', {
    // Undoable steps taken this session. Read from the history stack at flush
    // time rather than incremented per edit, so the edit path stays untouched.
    edits: getEditCount(),
    views_used: [...viewsUsed].sort(),
    view_count: viewsUsed.size,
    exported,
    saved,
    imported,
    template_used: templateUsed,
    duration_s: startedAt === 0 ? 0 : Math.round((Date.now() - startedAt) / 1000),
  });
}

/**
 * Start the session clock and arrange for the summary to be sent on `pagehide`
 * (rather than `beforeunload`, which is unreliable on mobile). Returns a
 * cleanup function.
 */
export function installSessionSummary(getEditCount: () => number): () => void {
  if (installed) return () => {};
  installed = true;
  startedAt = Date.now();
  const onHide = () => flushSessionSummary(getEditCount);
  window.addEventListener('pagehide', onHide);
  return () => {
    window.removeEventListener('pagehide', onHide);
    installed = false;
  };
}
