// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom features the "Bottom features" section offers (NURBS engine only), and the fields of each,
 * as data. Kept apart from the component so the docs coverage test can diff the kinds against `/docs`
 * (`docs/coverage.test.ts`) and the unit round trip can be tested without React.
 *
 * Lengths are centimetres in the document and shown in the editor's unit (`apps/web/CLAUDE.md`); a
 * fraction of the chord is shown as a percentage, a count as a number.
 */
import type { BottomFeature } from '@openshaper/board2';
import type { DepthSeries } from '@openshaper/render2d';
import {
  depthPolyline,
  featureKindOf,
  type FeatureKind,
  type FeatureParamName,
} from '@openshaper/store/sections';
import {
  cmToUnitNumber,
  fmtLen,
  fmtSmallLen,
  parseTypedLen,
  unitDecimals,
  type LengthUnit,
} from './format';

export const BOTTOM_FEATURES: readonly {
  value: FeatureKind;
  label: string;
  hint: string;
  /** The colour of the kind's line in the rocker pane's depth strip. */
  color: string;
}[] = [
  {
    value: 'vee',
    label: 'Vee',
    hint: 'The bottom rises towards the rails, flat at the stringer.',
    color: '#60A5FA',
  },
  {
    value: 'single-concave',
    label: 'Single concave',
    hint: 'One shallow hollow across the middle of the bottom.',
    color: '#F59E0B',
  },
  {
    value: 'double-concave',
    label: 'Double concave',
    hint: 'Two hollows, one each side of the stringer.',
    color: '#F472B6',
  },
  {
    value: 'channels',
    label: 'Channels',
    hint: 'Narrow grooves along the bottom, parallel to the rails.',
    color: '#A78BFA',
  },
];

export const featureLabel = (kind: FeatureKind): string =>
  BOTTOM_FEATURES.find((f) => f.value === kind)!.label;

/** How a field's number is shown and typed. */
export type FieldKind = 'length' | 'percent' | 'count';

export type FieldKey = FeatureParamName | 'from' | 'to';

export interface FieldDef {
  key: FieldKey;
  label: string;
  kind: FieldKind;
  hint: string;
}

const COMMON: readonly FieldDef[] = [
  { key: 'depth', label: 'Depth', kind: 'length', hint: 'The greatest depth along the board.' },
  {
    key: 'from',
    label: 'Tail end — from tail',
    kind: 'length',
    hint: 'Where the feature ends at the tail side, measured from the tail. The least it can be means it runs out the tail.',
  },
  {
    key: 'to',
    label: 'Nose end — from nose',
    kind: 'length',
    hint: 'Where the feature ends at the nose side, measured back from the nose tip.',
  },
];

/**
 * The two ends of a feature along the board, in the order the views draw it (tail on the left, nose on
 * the right). The document stores both as `s`, cm from the tail; the nose end is shown from the nose.
 */
export type EndKey = 'from' | 'to';
export const isEndKey = (key: FieldKey): key is EndKey => key === 'from' || key === 'to';

/** Stored `s` (cm from the tail) to the distance back from the nose tip, and back again. */
export const sToFromNose = (s: number, length: number): number => length - s;
export const fromNoseToS = (fromNose: number, length: number): number => length - fromNose;

/** The range a nose-end field takes (from the nose), given the range of the stored `s`. */
export const noseEndRange = (r: { min: number; max: number }, length: number) => ({
  min: sToFromNose(r.max, length),
  max: sToFromNose(r.min, length),
});

/**
 * A typed value of an end, held to the board and to the other end: the tail end stays at least `minSpan`
 * on the tail side of the nose end and vice versa. Returns the stored `s`.
 */
export function holdEnd(
  end: EndKey,
  s: number,
  other: number,
  room: { min: number; max: number },
  minSpan: number,
): number {
  const lo = end === 'from' ? room.min : other + minSpan;
  const hi = end === 'from' ? other - minSpan : room.max;
  return Math.min(Math.max(s, lo), Math.max(lo, hi));
}

/** What the quiet line under an end says, in the other reference. */
export function endReadout(
  end: EndKey,
  s: number,
  length: number,
  atTail: boolean,
  units: LengthUnit,
): string {
  if (end === 'from') {
    return atTail ? 'Runs out the tail' : `= ${fmtLen(sToFromNose(s, length), units)} from nose`;
  }
  return `= ${fmtLen(s, units)} from tail`;
}

/** The "Runs 120.0 cm" line: the feature's length along the board. */
export const spanReadout = (tailS: number, noseS: number, units: LengthUnit): string =>
  `Runs ${fmtLen(noseS - tailS, units)}`;

const KIND_FIELDS: Record<FeatureKind, readonly FieldDef[]> = {
  vee: [
    {
      key: 'stringerRadius',
      label: 'Stringer blend',
      kind: 'percent',
      hint: 'How much of the half-width is rounded off at the stringer.',
    },
  ],
  'single-concave': [
    {
      key: 'width',
      label: 'Width',
      kind: 'percent',
      hint: 'Half-width of the hollow, as a share of the half-width of the bottom.',
    },
  ],
  'double-concave': [
    {
      key: 'width',
      label: 'Hollow width',
      kind: 'percent',
      hint: 'Half-width of each hollow, as a share of the half-width of the bottom.',
    },
    {
      key: 'centre',
      label: 'Hollow centre',
      kind: 'percent',
      hint: 'Distance of each hollow from the stringer, as a share of the half-width of the bottom.',
    },
  ],
  channels: [
    { key: 'count', label: 'Channels', kind: 'count', hint: 'How many grooves.' },
    { key: 'width', label: 'Channel width', kind: 'length', hint: 'Width of one groove.' },
    { key: 'pitch', label: 'Spacing', kind: 'length', hint: 'Centre to centre of two grooves.' },
    {
      key: 'railInset',
      label: 'Rail inset',
      kind: 'length',
      hint: 'Distance of the outer groove from the outline.',
    },
  ],
};

/** The fields of a feature kind, in the order the section shows them. */
export const fieldsFor = (kind: FeatureKind): readonly FieldDef[] => [
  ...COMMON,
  ...KIND_FIELDS[kind],
];

/** The value of a field in the document's own units (cm, a fraction, a count). */
export function fieldValue(f: BottomFeature, key: FieldKey): number {
  const keys = f.depth.keys;
  switch (key) {
    case 'depth':
      return keys.reduce((m, k) => Math.max(m, k.value), 0);
    case 'from':
      return keys[0]!.s;
    case 'to':
      return keys[keys.length - 1]!.s;
    default:
      return (f as unknown as Record<string, number>)[key] ?? 0;
  }
}

const PERCENT_DECIMALS = 0;

/** The text a field shows for `value` (cm, a fraction or a count). */
export function fieldText(value: number, kind: FieldKind, units: LengthUnit): string {
  switch (kind) {
    case 'length':
      return cmToUnitNumber(value, units).toFixed(unitDecimals(units));
    case 'percent':
      return (value * 100).toFixed(PERCENT_DECIMALS);
    case 'count':
      return String(Math.round(value));
  }
}

/** The value (cm, a fraction, a count) a typed field means; null for text that holds no number. */
export function parseField(text: string, kind: FieldKind, units: LengthUnit): number | null {
  switch (kind) {
    case 'length':
      return parseTypedLen(text, units);
    case 'percent': {
      const n = Number.parseFloat(text.replace(',', '.'));
      return Number.isFinite(n) ? n / 100 : null;
    }
    case 'count': {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
}

/** Whether two values are the same as far as the field shows them (a blur that changed nothing commits nothing). */
export const sameShown = (a: number, b: number, kind: FieldKind, units: LengthUnit): boolean =>
  fieldText(a, kind, units) === fieldText(b, kind, units);

/**
 * The rocker pane's depth strip: one line per enabled feature, labelled with its greatest depth in the
 * display unit. One array per `features` value, so a pane that did not change is not redrawn.
 */
export function depthSeries(
  features: readonly BottomFeature[],
  units: LengthUnit,
): readonly DepthSeries[] | undefined {
  const series = features
    .filter((f) => f.enabled)
    .map((f): DepthSeries => {
      const kind = featureKindOf(f);
      return {
        color: BOTTOM_FEATURES.find((k) => k.value === kind)!.color,
        label: `${featureLabel(kind)} ${fmtSmallLen(fieldValue(f, 'depth'), units)}`,
        points: depthPolyline(f.depth),
      };
    });
  return series.length > 0 ? series : undefined;
}
