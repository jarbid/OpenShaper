// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Look: how the 3D board is painted, as one choice.
 *
 * The view's settings keep their shape and their saved form (`View3DSettings`: an `analysis`
 * mode, a `material`, a `lighting` preset). A Look reads them as one thing, in three groups:
 *
 * - **Shaping**: Patches, the board painted by its parts (`analysis: 'patches'`).
 * - **Surface**: an analysis of the surface (`analysis: <mode>`): Zebra, the curvatures, Rail
 *   radius, Normal change, Slope, Deviation from the ghost.
 * - **Realistic**: the board as a painted object (`analysis: 'none'` plus a `material`). The
 *   light and the board colour are settings of their own: they apply to the realistic looks and
 *   to Patches, and a Look does not carry them.
 *
 * Every look is a row of the tables in `view3d-settings.ts` (the analysis modes and the
 * materials); nothing here repeats their names. "Deviation from classic" is the experimental
 * engine's own check against the classic surface, so no look offers it: a saved one reads as the
 * realistic look its material implies, and stays in the stored settings until a look is chosen.
 *
 * Pure: no React, no DOM, so `view-state.ts` and the tests can use it freely.
 */
import {
  ANALYSIS_3D,
  LIGHTING_3D,
  MATERIAL_3D,
  type AnalysisBlock,
  type View3DSettings,
} from './view3d-settings';

type Analysis = View3DSettings['analysis'];

export type LookGroupId = 'shaping' | 'surface' | 'realistic';

/** What a look needs before it can be drawn: the entries that cannot run without it are listed, disabled. */
export type LookNeed = 'fitted-surface' | 'ghost' | 'patches';

/** One choice. The same object comes back from {@link lookOf} each time, so looks compare with `===`. */
export interface Look {
  /** Stable key: `patches`, the analysis mode, or the material. */
  readonly id: string;
  readonly group: LookGroupId;
  readonly label: string;
  /** What the settings' `analysis` becomes when this look is chosen. */
  readonly analysis: Analysis;
  /** A realistic look's material; the surface and shaping looks leave the material alone. */
  readonly material?: View3DSettings['material'];
  /** What it needs, when it cannot always be drawn. */
  readonly needs?: LookNeed;
  /** One plain sentence on what it shows. */
  readonly hint: string;
}

export interface LookGroup {
  readonly id: LookGroupId;
  readonly label: string;
  readonly looks: readonly Look[];
}

const HINTS: Readonly<Record<string, string>> = {
  patches:
    'The board painted by its parts: the deck, the bottom, each rail zone and each corner. Tap it to choose one.',
  zebra:
    'Stripes, as if a striped room were reflected in the board. Stripes that run on smoothly mean a smooth surface; a kink is a crease.',
  'mean-curvature':
    'How much the surface bends, and which way: red is convex, blue is concave, grey is flat.',
  'gaussian-curvature':
    'Red where the surface domes, blue where it saddles, grey where it is flat or bent one way only.',
  'rail-radius': 'The tightest radius at each point: dark is a hard or tucked edge, light is flat.',
  curvature:
    'A quick view of how fast the surface turns from one pixel to the next. It changes with zoom and mesh quality.',
  slope: 'How far the surface faces away from straight up.',
  'ghost-deviation': 'How far the board lies from the ghost: red for more foam, blue for less.',
  gloss: 'The board glassed, with a polished highlight.',
  foam: 'Raw foam: a flat, pale finish that shows the shape without reflections.',
  matte: 'A satin finish: some sheen, no mirror reflections.',
};

const hintFor = (id: string): string => HINTS[id] ?? '';

type AnalysisRow = (typeof ANALYSIS_3D)[number];

const needOf = (row: AnalysisRow): LookNeed | undefined =>
  row.exact ? 'fitted-surface' : row.ghost ? 'ghost' : row.patches ? 'patches' : undefined;

const analysisLook = (group: LookGroupId, row: AnalysisRow): Look => {
  const needs = needOf(row);
  return {
    id: row.value,
    group,
    label: row.label,
    analysis: row.value,
    ...(needs ? { needs } : {}),
    hint: hintFor(row.value),
  };
};

/** Shaping: the analysis rows for a surface with patches. */
const SHAPING: readonly Look[] = ANALYSIS_3D.filter((row) => row.patches).map((row) =>
  analysisLook('shaping', row),
);

/**
 * Surface: every analysis row that is not "No analysis" (the realistic looks), not Patches and not
 * the experimental engine's own check.
 */
const SURFACE: readonly Look[] = ANALYSIS_3D.filter(
  (row) => row.value !== 'none' && !row.patches && !row.nurbs,
).map((row) => analysisLook('surface', row));

/** Realistic: one look for each material, drawn with no analysis. */
const REALISTIC: readonly Look[] = MATERIAL_3D.map((m) => ({
  id: m.value,
  group: 'realistic' as const,
  label: m.label,
  analysis: 'none' as const,
  material: m.value,
  hint: hintFor(m.value),
}));

export const LOOK_GROUPS: readonly LookGroup[] = [
  { id: 'shaping', label: 'Shaping', looks: SHAPING },
  { id: 'surface', label: 'Surface', looks: SURFACE },
  { id: 'realistic', label: 'Realistic', looks: REALISTIC },
];

/** Every look, in menu order. */
export const LOOKS: readonly Look[] = LOOK_GROUPS.flatMap((g) => g.looks);

/** The light the realistic looks and Patches are lit with: the three presets of the view. */
export const LIGHTS = LIGHTING_3D;

/** The analysis modes a Shaping or Surface look claims; every other mode is drawn as a realistic look. */
const CLAIMED: ReadonlySet<Analysis> = new Set(
  LOOKS.filter((l) => l.group !== 'realistic').map((l) => l.analysis),
);

/**
 * Whether `look` is what the settings show. Shaping and Surface looks are claimed by their own
 * analysis mode; a Realistic look by its material, for every analysis they do not claim (that is
 * "No analysis", and "Deviation from classic", which no look offers).
 */
export const lookApplies = (
  look: Look,
  s: Pick<View3DSettings, 'analysis' | 'material'>,
): boolean =>
  look.group === 'realistic'
    ? !CLAIMED.has(s.analysis) && s.material === look.material
    : s.analysis === look.analysis;

const FALLBACK: Look = REALISTIC[0]!;

/**
 * The look the settings show: exactly one, for every settings object the app can hold. (A material
 * that is not one of the view's reads as the first realistic look, so a corrupt object still draws.)
 */
export const lookOf = (s: Pick<View3DSettings, 'analysis' | 'material'>): Look =>
  LOOKS.find((l) => lookApplies(l, s)) ?? FALLBACK;

/** What changes in the settings to choose `look`: its analysis, and a realistic look's material. */
export const lookPatch = (
  look: Look,
): Pick<View3DSettings, 'analysis'> & Partial<Pick<View3DSettings, 'material'>> => ({
  analysis: look.analysis,
  ...(look.material ? { material: look.material } : {}),
});

/** The settings with `look` chosen: everything else (light, colour, mode, guides, band) as it was. */
export const settingsFor = (look: Look, current: View3DSettings): View3DSettings => ({
  ...current,
  ...lookPatch(look),
});

/** Whatever the board must have for `look` to be drawn. */
export interface LookAvailability {
  /** Why the exact surface analyses cannot run on this board (a concave tail), or null. */
  readonly exact: AnalysisBlock | null;
  /** Why "Deviation from ghost" cannot run (no ghost is loaded), or null. */
  readonly ghost: AnalysisBlock | null;
  /** The surface has patches (the rails engine's). */
  readonly patches: boolean;
}

/** Shown on Patches, listed disabled, where the surface has no patches. */
export const PATCHES_UNAVAILABLE: AnalysisBlock = {
  reason:
    'Patches paints the rails engine’s surface by its parts. Turn on Rails engine (experimental) in Settings to use it.',
  short: 'needs the rails engine',
};

/**
 * Why `look` cannot be drawn now, or null when it can. An unavailable look stays in the menu,
 * disabled, with this on it, as the analysis select has always done for a concave tail and for a
 * missing ghost.
 */
export const lookBlock = (look: Look, available: LookAvailability): AnalysisBlock | null => {
  switch (look.needs) {
    case 'fitted-surface':
      return available.exact;
    case 'ghost':
      return available.ghost;
    case 'patches':
      return available.patches ? null : PATCHES_UNAVAILABLE;
    default:
      return null;
  }
};

/**
 * The deviation band's control is shown with "Deviation from ghost" when a ghost is loaded: a
 * band is the one setting a look has of its own.
 */
export const lookHasBand = (look: Look, available: LookAvailability): boolean =>
  look.analysis === 'ghost-deviation' && !lookBlock(look, available);
