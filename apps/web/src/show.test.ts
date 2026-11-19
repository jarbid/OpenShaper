// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Show: the four modes of the view read as exactly one state each, the two controls over `mode` cannot
 * disagree, and they say why they do nothing under a look that paints the board itself.
 */
import { describe, expect, it } from 'vitest';
import { LOOKS } from './look';
import {
  MODE_NEEDS_REALISTIC,
  modeAfterNormals,
  modeAfterWireframe,
  modeBlock,
  NORMALS_MODE,
  OVERLAYS,
  overlayPatch,
  showOf,
  WIREFRAME,
  type WireframeState,
} from './show';
import showSource from './show.ts?raw';
import { DEFAULT_VIEW_3D, MODE_3D } from './view3d-settings';

describe('the modes', () => {
  it('each read as one state of the wireframe and the normals', () => {
    const states = MODE_3D.map((m) => {
      const s = showOf({ ...DEFAULT_VIEW_3D, mode: m.value });
      return [m.value, s.wireframe, s.normals];
    });
    expect(states).toEqual([
      ['shaded', 'off', false],
      ['shaded-wire', 'over', false],
      ['wireframe', 'alone', false],
      ['normals', 'off', true],
    ]);
    // and no two modes read the same
    expect(new Set(states.map(([, w, n]) => `${w}/${n}`)).size).toBe(MODE_3D.length);
  });

  it('are all covered: the wireframe states and Normals are the view’s four modes', () => {
    expect([...WIREFRAME.map((w) => w.mode), NORMALS_MODE].sort()).toEqual(
      MODE_3D.map((m) => m.value).sort(),
    );
  });

  it('go from a state to the mode that reads back as it', () => {
    for (const w of WIREFRAME) {
      for (const from of MODE_3D.map((m) => m.value)) {
        const next = modeAfterWireframe(w.value, from);
        const shown = showOf({ ...DEFAULT_VIEW_3D, mode: next });
        expect(shown.wireframe, `${from} -> ${w.value}`).toBe(w.value);
      }
    }
    expect(showOf({ ...DEFAULT_VIEW_3D, mode: modeAfterNormals(true) }).normals).toBe(true);
    expect(showOf({ ...DEFAULT_VIEW_3D, mode: modeAfterNormals(false) }).normals).toBe(false);
  });

  it('take Normals off when a wireframe is chosen, and leave Normals on when Off is chosen', () => {
    expect(modeAfterWireframe('over', 'normals')).toBe('shaded-wire');
    expect(modeAfterWireframe('alone', 'normals')).toBe('wireframe');
    // Off is already so while the normals are drawn: choosing it changes nothing
    expect(modeAfterWireframe('off', 'normals')).toBe('normals');
    expect(modeAfterWireframe('off', 'shaded-wire')).toBe('shaded');
    expect(modeAfterNormals(false)).toBe('shaded');
  });

  it('name the wireframe states in the words of the plan', () => {
    const labels: Record<WireframeState, string> = {
      off: 'Off',
      over: 'Over the surface',
      alone: 'Alone',
    };
    expect(WIREFRAME.map((w) => [w.value, w.label])).toEqual(Object.entries(labels));
  });
});

describe('the guides', () => {
  it('are the stringer, the stations’ rings and the apex line, one setting each', () => {
    expect(OVERLAYS.map((o) => [o.key, o.label])).toEqual([
      ['showStringer', 'Stringer'],
      ['showSections', 'Stations'],
      ['showApex', 'Apex line'],
    ]);
    for (const o of OVERLAYS) expect(o.hint.length, o.key).toBeGreaterThan(20);
  });

  it('are each switched by a patch of their own setting, and nothing else', () => {
    expect(overlayPatch('showStringer', true)).toEqual({ showStringer: true });
    expect(overlayPatch('showSections', false)).toEqual({ showSections: false });
    expect(overlayPatch('showApex', true)).toEqual({ showApex: true });
    for (const o of OVERLAYS) expect(Object.keys(overlayPatch(o.key, true))).toEqual([o.key]);
  });

  it('read from the settings', () => {
    expect(showOf({ ...DEFAULT_VIEW_3D, showStringer: true, showApex: true })).toMatchObject({
      stringer: true,
      stations: false,
      apex: true,
    });
  });
});

describe('the wireframe and the normals under a look', () => {
  it('show on the realistic looks and say why they do not under any other', () => {
    for (const l of LOOKS) {
      if (l.group === 'realistic') expect(modeBlock(l), l.id).toBeNull();
      else expect(modeBlock(l), l.id).toBe(MODE_NEEDS_REALISTIC);
    }
    expect(MODE_NEEDS_REALISTIC.reason).toMatch(/realistic looks/);
  });

  it('imports nothing from React, the DOM or three.js', () => {
    const imports = [...showSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./look', './view3d-settings', '@openshaper/render3d']);
    // the one import from the view is a type, erased at build
    expect(showSource).toMatch(/import type \{ Board3DMode \} from '@openshaper\/render3d'/);
    expect(showSource).not.toMatch(/\b(document|window|HTMLElement)\b/);
  });
});
