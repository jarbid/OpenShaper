// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Show: what the 3D view draws over a look, as the settings hold it.
 *
 * The guides (the stringer, a ring at each station, the apex line) are separate switches and are
 * drawn over every look. The wireframe and the normals are one setting, the view's `mode`, and
 * the view only applies it to the realistic looks: Patches and the surface analyses paint the
 * board themselves. `mode` holds one of four values, so each is one state here and the two
 * controls over it cannot disagree:
 *
 * | `mode`        | Wireframe        | Normals |
 * | ------------- | ---------------- | ------- |
 * | `shaded`      | Off              | off     |
 * | `shaded-wire` | Over the surface | off     |
 * | `wireframe`   | Alone            | off     |
 * | `normals`     | Off              | on      |
 *
 * Pure: no React, no DOM.
 */
import type { Board3DMode } from '@openshaper/render3d';
import type { Look } from './look';
import type { AnalysisBlock, View3DSettings } from './view3d-settings';

export type WireframeState = 'off' | 'over' | 'alone';

/** The wireframe choices, and the `mode` each one is. */
export const WIREFRAME: readonly {
  readonly value: WireframeState;
  readonly label: string;
  readonly mode: Board3DMode;
}[] = [
  { value: 'off', label: 'Off', mode: 'shaded' },
  { value: 'over', label: 'Over the surface', mode: 'shaded-wire' },
  { value: 'alone', label: 'Alone', mode: 'wireframe' },
];

/** The `mode` that draws the normals. */
export const NORMALS_MODE: Board3DMode = 'normals';

/** A guide that is drawn over any look, and the setting that switches it. */
export interface Overlay {
  readonly key: 'showStringer' | 'showSections' | 'showApex';
  readonly label: string;
  readonly hint: string;
}

export const OVERLAYS: readonly Overlay[] = [
  {
    key: 'showStringer',
    label: 'Stringer',
    hint: 'Draw the stringer line down the centre of the board',
  },
  {
    key: 'showSections',
    label: 'Stations',
    hint: 'Draw a ring at every cross-section (the active one in cyan)',
  },
  {
    key: 'showApex',
    label: 'Apex line',
    hint: 'Draw the rail apex: each station’s widest point, where the deck meets the bottom',
  },
];

/** The change to the settings that switches a guide on or off. */
export const overlayPatch = (key: Overlay['key'], on: boolean): Partial<View3DSettings> => {
  switch (key) {
    case 'showStringer':
      return { showStringer: on };
    case 'showSections':
      return { showSections: on };
    case 'showApex':
      return { showApex: on };
  }
};

/** What Show says about the settings. */
export interface Shown {
  readonly stringer: boolean;
  readonly stations: boolean;
  readonly apex: boolean;
  readonly wireframe: WireframeState;
  readonly normals: boolean;
}

export const showOf = (
  s: Pick<View3DSettings, 'mode' | 'showStringer' | 'showSections' | 'showApex'>,
): Shown => ({
  stringer: s.showStringer,
  stations: s.showSections,
  apex: s.showApex,
  wireframe: WIREFRAME.find((w) => w.mode === s.mode)?.value ?? 'off',
  normals: s.mode === NORMALS_MODE,
});

/** The `mode` after a wireframe state is chosen. With Normals on, Off is already so: nothing changes. */
export const modeAfterWireframe = (state: WireframeState, current: Board3DMode): Board3DMode =>
  state === 'off' && current === NORMALS_MODE
    ? current
    : (WIREFRAME.find((w) => w.value === state)?.mode ?? 'shaded');

/** The `mode` after Normals is turned on or off: off goes back to the plain surface. */
export const modeAfterNormals = (on: boolean): Board3DMode => (on ? NORMALS_MODE : 'shaded');

/** Shown on the wireframe and the normals under a look that paints the board itself. */
export const MODE_NEEDS_REALISTIC: AnalysisBlock = {
  reason:
    'The wireframe and the normals show on the realistic looks. Patches and the surface analyses paint the board themselves.',
  short: 'realistic looks only',
};

/** Why the wireframe and the normals have no effect under `look`, or null where they do. */
export const modeBlock = (look: Look): AnalysisBlock | null =>
  look.group === 'realistic' ? null : MODE_NEEDS_REALISTIC;
