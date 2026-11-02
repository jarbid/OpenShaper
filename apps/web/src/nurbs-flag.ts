// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental-engine flag: "Engine: NURBS (experimental)".
 *
 * Off by default. It is on when the user has turned it on in Settings (persisted with
 * the other editor settings, `EditorSettings.nurbsEngine`) or when the page was opened
 * with `?engine=nurbs`, which turns it on for that session only and is never written
 * back to the settings. With it on the editors edit the NURBS section store
 * (docs/design/m2-editor.md); saving and exporting still use the classic board.
 */
import { useSyncExternalStore } from 'react';

/** The query parameter and the value that turns the engine on. */
export const ENGINE_PARAM = 'engine';
export const ENGINE_NURBS = 'nurbs';

/** Whether a URL query string (`location.search`) asks for the NURBS engine. */
export const engineFromSearch = (search: string): boolean => {
  try {
    return new URLSearchParams(search).get(ENGINE_PARAM)?.toLowerCase() === ENGINE_NURBS;
  } catch {
    return false;
  }
};

/** Whether the NURBS engine is on: the persisted setting, or this session's URL. */
export const nurbsEngineOn = (setting: boolean, search: string): boolean =>
  setting || engineFromSearch(search);

const noopSubscribe = () => () => {};

/**
 * `?engine=nurbs` as a hook. The server snapshot is false, so a prerendered or
 * hydrating page matches the static HTML and the flag applies right after hydration.
 */
export function useEngineParam(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => engineFromSearch(window.location.search),
    () => false,
  );
}
