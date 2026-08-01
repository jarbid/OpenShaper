// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Service-worker helpers for the editor.
 *
 * Registration is deliberately editor-only (mounted from EditorPage, not
 * RootLayout): a visitor who only reads the guide pages should never precache
 * the editor's three.js bundle. See docs/design/offline.md.
 *
 * Dependencies are injected rather than read from globals, matching the
 * `factory?: IDBFactory` style in session-store.ts, so both functions are
 * testable in jsdom without stubbing the environment.
 */

/**
 * Whether a service worker can be registered here at all.
 *
 * Mirrors the `HAS_WORKER` capability check in use-specs-worker.ts: probe for
 * the feature and degrade quietly rather than branching on the environment.
 * Returns false under the Tauri desktop shell, which serves bundled files from
 * a relative base over a custom protocol and has no service-worker support.
 */
export function canUseServiceWorker(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  base: string = import.meta.env.BASE_URL,
): boolean {
  if (base !== '/') return false;
  return !!nav && 'serviceWorker' in nav;
}

export interface IdleGateOptions {
  /** Store subscription; every call signals activity. Returns an unsubscribe fn. */
  subscribe: (onActivity: () => void) => () => void;
  /** How long the editor must be quiet before a withheld callback runs. */
  quietMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/**
 * Withholds a callback until the editor has been idle for `quietMs`.
 *
 * Board edits commit to the store on pointer-up, so a run of commits means the
 * user is actively shaping. Surfacing "update available" mid-drag invites a
 * reload at the worst possible moment, so the prompt waits for a lull.
 */
export function createIdleGate({
  subscribe,
  quietMs = 20_000,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimer = (h) => globalThis.clearTimeout(h),
}: IdleGateOptions) {
  return {
    /** Run `cb` once the editor goes quiet. Returns a cleanup function. */
    onSettled(cb: () => void): () => void {
      let timer: number | null = null;
      let done = false;

      const arm = () => {
        if (done) return;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => {
          done = true;
          cb();
        }, quietMs);
      };

      const unsubscribe = subscribe(arm);
      arm();

      return () => {
        done = true;
        if (timer !== null) clearTimer(timer);
        unsubscribe();
      };
    },
  };
}
