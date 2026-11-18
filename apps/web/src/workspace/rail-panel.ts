// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail panel's arithmetic and wording, with no React: where a dial's slider sits for a rail's number
 * and back, how a typed apex is read, what a rail is called when it has no name of its own, and the
 * sentence that says where the map's cursor is in a blend.
 */
import {
  BUILT_IN_RAILS,
  DIAL_RANGES,
  apexLabel,
  railDistance,
  railName,
  type NamedRail,
  type RailNumber,
  type RailRecipe,
} from '@openshaper/store/rails';
import type { SideZones } from '../rail-zones';

/** The slider of a dial has this many steps along its range. */
export const DIAL_STEPS = 100;

/** The three dials: what each is called, which of the rail's numbers it sets, and its ends in words. */
export interface DialSpec {
  readonly id: 'apex' | 'tuck' | 'edge';
  readonly label: string;
  /** The number of the rail the dial sets. */
  readonly number: RailNumber;
  /** The value at each end of the slider, from the first to the last. */
  readonly range: readonly [number, number];
  /** What each end is called. */
  readonly ends: readonly [string, string];
}

export const DIALS: readonly DialSpec[] = [
  {
    id: 'apex',
    label: 'Apex',
    number: 'apex',
    range: DIAL_RANGES.apex,
    // read from the range, so what the dial says can never disagree with where it stops
    ends: [apexLabel(DIAL_RANGES.apex[0]), apexLabel(DIAL_RANGES.apex[1])],
  },
  { id: 'tuck', label: 'Tuck', number: 'tuck', range: DIAL_RANGES.tuck, ends: ['none', 'deep'] },
  {
    id: 'edge',
    label: 'Edge',
    number: 'bottomEdge',
    range: DIAL_RANGES.edge,
    ends: ['none', 'hard'],
  },
];

/** A dial's value as a slider position, 0 to {@link DIAL_STEPS}; a value past an end sits at that end. */
export function dialPosition(value: number, range: readonly [number, number]): number {
  const t = (value - range[0]) / (range[1] - range[0]);
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * DIAL_STEPS);
}

/** The value at a slider position. */
export const dialValue = (position: number, range: readonly [number, number]): number =>
  range[0] + (position / DIAL_STEPS) * (range[1] - range[0]);

/** Whether a value is beyond the ends of a dial, so its slider cannot show it. */
export const beyondDial = (value: number, range: readonly [number, number]): boolean =>
  value < Math.min(range[0], range[1]) - 1e-9 || value > Math.max(range[0], range[1]) + 1e-9;

/** The apex as the number field shows it: percent of the way up the wall, to a tenth. */
export const apexShown = (apex: number): string => String(Math.round(apex * 1000) / 10);

/**
 * An apex as typed: `60/40` (the share above the widest point over the share below, as the dial reads
 * it), a percent (`43`), or a fraction (`0.43`); null when it is none of these.
 */
export function parseApex(text: string): number | null {
  const ratio = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (ratio) {
    const above = Number(ratio[1]);
    const below = Number(ratio[2]);
    return above + below > 0 ? below / (above + below) : null;
  }
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/** What a rail is called in the menu and under it: its name, and for Custom the closest named rail. */
export interface RailTitle {
  readonly name: string;
  /** For a rail with no name of its own: the built-in or saved rail it is nearest to. */
  readonly like: string | null;
  readonly kind: 'built-in' | 'mine' | 'custom';
}

/** The nearest named rail to `rail`, and how far (in the units `railDistance` reads). */
export function nearestRail(
  rail: RailRecipe,
  mine: readonly NamedRail[],
): { readonly name: string; readonly distance: number } | null {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of [...BUILT_IN_RAILS, ...mine]) {
    const distance = railDistance(rail, candidate.rail);
    if (best === null || distance < best.distance) best = { name: candidate.name, distance };
  }
  return best;
}

/** How to call `rail`: by name when it has one, else Custom, like the nearest. */
export function railTitle(rail: RailRecipe, mine: readonly NamedRail[]): RailTitle {
  const name = railName(rail, mine);
  if (name !== 'Custom') {
    return {
      name,
      like: null,
      kind: BUILT_IN_RAILS.some((b) => b.name === name) ? 'built-in' : 'mine',
    };
  }
  return { name, like: nearestRail(rail, mine)?.name ?? null, kind: 'custom' };
}

/** The menu's text for a rail's title: `Custom (like Tucked)` for a rail of no name. */
export const titleText = (t: RailTitle): string =>
  t.kind === 'custom' && t.like ? `Custom (like ${t.like})` : t.name;

/** A zone as the panel and the map's captions call it: by its rail's name, else by its number. */
export function zoneName(index: number, rail: RailRecipe, mine: readonly NamedRail[]): string {
  const name = railName(rail, mine);
  return name === 'Custom' ? `zone ${index + 1}` : name;
}

/**
 * Where a cursor at `at` is on a side's zones, in a sentence, or null when it is in a zone: "Between
 * Round and zone 3, 40% of the way."
 */
export function blendSentence(
  side: SideZones,
  at: number,
  mine: readonly NamedRail[],
): string | null {
  const blend = side.blends.find((b) => b.from < at && at < b.to);
  if (!blend) return null;
  const before = side.zones[blend.before]!;
  const after = side.zones[blend.after]!;
  const t = Math.round(((at - blend.from) / (blend.to - blend.from)) * 100);
  return `Between ${zoneName(blend.before, before.rail, mine)} and ${zoneName(blend.after, after.rail, mine)}, ${t}% of the way.`;
}
