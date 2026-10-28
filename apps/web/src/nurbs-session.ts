// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Ties the lazily loaded NURBS layer's long-lived resources (the shared viewer, its
 * worker and its cached meshes) to the engine setting, without the main chunk
 * importing the layer.
 *
 * The layer registers a release function when it creates the shared viewer. Turning
 * the engine off calls it: the worker is terminated (even mid-conversion, which runs
 * 12 to 22 s) and the caches are dropped. Leaving the 3D pane does not: a pane
 * remount only pauses the viewer, so coming back finds the cache.
 */
import { useEffect } from 'react';

let release: (() => void) | null = null;

/** The layer: call `fn` when the engine is turned off. Replaces an earlier registration. */
export const registerNurbsRelease = (fn: (() => void) | null): void => {
  release = fn;
};

/** Run and forget the registered release, if any. */
export const releaseNurbs = (): void => {
  const fn = release;
  release = null;
  fn?.();
};

/** Release the NURBS resources whenever `engineOn` is (or becomes) false. */
export function useReleaseNurbsWhenOff(engineOn: boolean): void {
  useEffect(() => {
    if (!engineOn) releaseNurbs();
  }, [engineOn]);
}
