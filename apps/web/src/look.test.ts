// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Look model: the groups and their names, that every look round-trips through the settings,
 * that every setting the app can hold reads as exactly one look, and that an unavailable look
 * carries its reason.
 */
import { parseBrd } from '@openshaper/io';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LIGHTS,
  LOOK_GROUPS,
  LOOKS,
  lookApplies,
  lookBlock,
  lookHasBand,
  lookOf,
  lookPatch,
  PATCHES_UNAVAILABLE,
  settingsFor,
  type Look,
  type LookAvailability,
} from './look';
import lookSource from './look.ts?raw';
import sampleBrd from './sample-board.brd?raw';
import { swallowBoard } from './test/swallow-board';
import { DEFAULT_VIEW_STATE, loadViewState, saveViewState } from './view-state';
import {
  ANALYSIS_3D,
  DEFAULT_VIEW_3D,
  exactAnalysisUnavailable,
  ghostDeviationUnavailable,
  LIGHTING_3D,
  MATERIAL_3D,
  MODE_3D,
  type View3DSettings,
} from './view3d-settings';

const look = (id: string): Look => {
  const found = LOOKS.find((l) => l.id === id);
  if (!found) throw new Error(`no look ${id}`);
  return found;
};

/** Every settings the saved state can hold, as far as a look reads them: each analysis with each material. */
const everySetting = (): View3DSettings[] =>
  ANALYSIS_3D.flatMap((a) =>
    MATERIAL_3D.map((m) => ({ ...DEFAULT_VIEW_3D, analysis: a.value, material: m.value })),
  );

const ALL_AVAILABLE: LookAvailability = { exact: null, ghost: null, patches: true };

describe('the groups', () => {
  it('are Shaping, Surface and Realistic, with the names the plan gives', () => {
    expect(LOOK_GROUPS.map((g) => [g.id, g.label, g.looks.map((l) => l.label)])).toEqual([
      ['shaping', 'Shaping', ['Patches']],
      [
        'surface',
        'Surface',
        [
          'Zebra',
          'Mean curvature',
          'Gaussian curvature',
          'Rail radius',
          'Normal change (approx.)',
          'Slope',
          'Deviation from ghost',
        ],
      ],
      ['realistic', 'Realistic', ['Glassed gloss', 'Raw foam', 'Matte']],
    ]);
  });

  it('offer no “Deviation from classic”, no “No analysis” and no Clay', () => {
    const labels = LOOKS.map((l) => l.label);
    for (const gone of ['Deviation from classic', 'No analysis', 'Clay']) {
      expect(labels).not.toContain(gone);
    }
    expect(LOOKS.map((l) => l.analysis)).not.toContain('nurbs-deviation');
  });

  it('are the rows of the view’s own tables, not a copy of them', () => {
    // Patches and the surface modes are the analysis rows, bar "No analysis" and the experimental check
    const rows = ANALYSIS_3D.filter((o) => o.value !== 'none' && !o.nurbs);
    expect(LOOKS.filter((l) => l.group !== 'realistic').map((l) => [l.analysis, l.label])).toEqual(
      rows.map((o) => [o.value, o.label]),
    );
    // the realistic looks are the materials
    expect(LOOKS.filter((l) => l.group === 'realistic').map((l) => [l.material, l.label])).toEqual(
      MATERIAL_3D.map((m) => [m.value, m.label]),
    );
    expect(LIGHTS).toBe(LIGHTING_3D);
  });

  it('have an id each, unique, and a sentence of help', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    for (const l of LOOKS) expect(l.hint.length, l.id).toBeGreaterThan(20);
  });

  it('carry what each needs, from the flags of the analysis table', () => {
    const needs = Object.fromEntries(LOOKS.map((l) => [l.id, l.needs]));
    expect(needs).toMatchObject({
      patches: 'patches',
      'mean-curvature': 'fitted-surface',
      'gaussian-curvature': 'fitted-surface',
      'rail-radius': 'fitted-surface',
      'ghost-deviation': 'ghost',
    });
    for (const id of ['zebra', 'curvature', 'slope', 'gloss', 'foam', 'matte']) {
      expect(needs[id], id).toBeUndefined();
    }
  });
});

describe('lookOf and settingsFor', () => {
  const currents: View3DSettings[] = [
    DEFAULT_VIEW_3D,
    { ...DEFAULT_VIEW_3D, analysis: 'patches' },
    { ...DEFAULT_VIEW_3D, analysis: 'zebra', material: 'matte' },
    { ...DEFAULT_VIEW_3D, analysis: 'curvature', material: 'foam', lighting: 'shaping-bay' },
    { ...DEFAULT_VIEW_3D, analysis: 'nurbs-deviation', material: 'foam' },
    { ...DEFAULT_VIEW_3D, analysis: 'ghost-deviation', mode: 'normals', showApex: true },
  ];

  it('round-trip: every look, from every kind of current settings', () => {
    for (const l of LOOKS) {
      for (const current of currents) {
        expect(lookOf(settingsFor(l, current)), `${l.id} from ${current.analysis}`).toBe(l);
      }
    }
  });

  it('read every setting the app can hold as exactly one look', () => {
    for (const s of everySetting()) {
      const applying = LOOKS.filter((l) => lookApplies(l, s));
      expect(applying, `${s.analysis} / ${s.material}`).toHaveLength(1);
      expect(lookOf(s)).toBe(applying[0]);
    }
  });

  it('read a saved state as the look it was saved as, through the sanitiser', () => {
    for (const s of everySetting()) {
      localStorage.clear();
      saveViewState({ ...DEFAULT_VIEW_STATE, view3d: s });
      const loaded = loadViewState().view3d;
      expect(loaded, `${s.analysis} / ${s.material}`).toBeDefined();
      expect(lookOf(loaded!)).toBe(lookOf(s));
    }
  });

  it('choosing a look changes the analysis, and a realistic look’s material, and nothing else', () => {
    const current: View3DSettings = {
      ...DEFAULT_VIEW_3D,
      analysis: 'zebra',
      material: 'matte',
      lighting: 'neutral',
      color: '#112233',
      mode: 'shaded-wire',
      showStringer: true,
      showSections: true,
      showApex: true,
      meshQuality: 'fine',
      deviationBand: 1.25,
    };
    expect(settingsFor(look('patches'), current)).toEqual({ ...current, analysis: 'patches' });
    expect(settingsFor(look('slope'), current)).toEqual({ ...current, analysis: 'slope' });
    // the material the realistic looks were last shown with survives a trip through a surface look
    expect(settingsFor(look('foam'), current)).toEqual({
      ...current,
      analysis: 'none',
      material: 'foam',
    });
    expect(lookPatch(look('gloss'))).toEqual({ analysis: 'none', material: 'gloss' });
    expect(lookPatch(look('zebra'))).toEqual({ analysis: 'zebra' });
    expect(current.analysis).toBe('zebra');
  });

  it('read “Deviation from classic” as the realistic look the material implies, and leave it stored until a look is chosen', () => {
    const stored: View3DSettings = {
      ...DEFAULT_VIEW_3D,
      analysis: 'nurbs-deviation',
      material: 'foam',
    };
    expect(lookOf(stored)).toBe(look('foam'));
    expect(lookOf({ ...stored, material: 'gloss' })).toBe(look('gloss'));
    // reading does not change what is stored
    expect(stored.analysis).toBe('nurbs-deviation');
    // choosing the look the settings already read as puts the settings in step with it
    expect(settingsFor(lookOf(stored), stored).analysis).toBe('none');
  });

  it('read a material the view does not have as the first realistic look, so a corrupt object still draws', () => {
    const corrupt = { ...DEFAULT_VIEW_3D, material: 'chrome' } as unknown as View3DSettings;
    expect(lookOf(corrupt)).toBe(LOOKS.find((l) => l.group === 'realistic'));
  });
});

describe('an unavailable look', () => {
  const exact = exactAnalysisUnavailable(swallowBoard());
  const ghost = ghostDeviationUnavailable(null);

  it('is still listed, and carries the reason the analysis select gave', () => {
    expect(exact).not.toBeNull();
    expect(ghost).not.toBeNull();
    const none: LookAvailability = { exact, ghost, patches: false };
    for (const id of ['mean-curvature', 'gaussian-curvature', 'rail-radius']) {
      expect(lookBlock(look(id), none), id).toBe(exact);
    }
    expect(lookBlock(look('ghost-deviation'), none)).toBe(ghost);
    expect(lookBlock(look('patches'), none)).toBe(PATCHES_UNAVAILABLE);
  });

  it('is nothing else: the looks that need nothing are always available', () => {
    const none: LookAvailability = { exact, ghost, patches: false };
    for (const id of ['zebra', 'curvature', 'slope', 'gloss', 'foam', 'matte']) {
      expect(lookBlock(look(id), none), id).toBeNull();
    }
  });

  it('has a reason and a short form that fit a menu entry', () => {
    for (const block of [exact!, ghost!, PATCHES_UNAVAILABLE]) {
      expect(block.reason.length).toBeGreaterThan(30);
      expect(block.short.length).toBeGreaterThan(0);
      expect(block.short.length).toBeLessThan(30);
    }
  });

  it('is available once the board has what it needs', () => {
    const board = parseBrd(sampleBrd).board;
    const ready: LookAvailability = {
      exact: exactAnalysisUnavailable(board),
      ghost: ghostDeviationUnavailable(board),
      patches: true,
    };
    for (const l of LOOKS) expect(lookBlock(l, ready), l.id).toBeNull();
    expect(lookBlock(look('patches'), ALL_AVAILABLE)).toBeNull();
  });

  it('gets the deviation band beside it only with a ghost to measure against', () => {
    expect(lookHasBand(look('ghost-deviation'), ALL_AVAILABLE)).toBe(true);
    expect(lookHasBand(look('ghost-deviation'), { ...ALL_AVAILABLE, ghost })).toBe(false);
    expect(lookHasBand(look('zebra'), ALL_AVAILABLE)).toBe(false);
  });
});

describe('the module', () => {
  it('has the same shape for every mode of the view: a look never reads the wireframe or the light', () => {
    for (const m of MODE_3D) {
      for (const lighting of LIGHTING_3D) {
        const s = { ...DEFAULT_VIEW_3D, mode: m.value, lighting: lighting.value };
        expect(lookOf(s)).toBe(lookOf(DEFAULT_VIEW_3D));
      }
    }
  });

  it('imports nothing from React, the DOM or three.js', () => {
    const imports = [...lookSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./view3d-settings']);
    expect(lookSource).not.toMatch(/\b(document|window|HTMLElement)\b/);
  });
});

beforeEach(() => localStorage.clear());
