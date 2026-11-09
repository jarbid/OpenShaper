// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What makes a {@link FinDesign} buildable. `validateFinDesign` lists every broken rule;
 * an empty list means the design can be meshed and exported. The store (step 9) uses
 * the same checks to clamp drags, so nothing invalid is ever committed.
 *
 * Exact where it matters: the outline, section and taper direction rules read the roots
 * of each Bézier segment's derivative (curve-shape.ts), not samples. Only the
 * "inside face stays inside the outside face" rule samples, at
 * {@link SECTION_CHECK_SAMPLES} chord stations.
 */
import { valueAt, type Spline } from '../bezier-spline';
import { slopeSigns, splineExtremes } from './curve-shape';
import {
  finHasToe,
  FIN_MAX_CANT,
  FIN_MAX_FRONT_OVERHANG,
  FIN_MAX_TOE,
  FIN_MIN_SLICE_CANT,
  FIN_MIN_THICKNESS_LIMITS,
  finMinThickness,
  FIN_SLICE_MIN_GAP,
  type FinDesign,
  type FinSection,
} from './fin-design';
import { finClearanceShortfall } from './fin-clearance';
import { lateralOffsetRange } from './fin-placement';
import { FIN_BASES, US_BOX_HEAD, finTabOutline, futuresKind } from './fin-tab';

export type FinIssueCode =
  | 'hand'
  | 'base'
  | 'toe'
  | 'cant'
  | 'outline-root'
  | 'outline-rising'
  | 'front-overhang'
  | 'tab-rear'
  | 'tab-cover'
  | 'head-length'
  | 'rear-clearance'
  | 'tab-contact'
  | 'section-ends'
  | 'section-direction'
  | 'section-crossing'
  | 'section-symmetry'
  | 'slice-height'
  | 'cant-line-height'
  | 'taper-span'
  | 'taper-thickness';

export interface FinIssue {
  readonly code: FinIssueCode;
  readonly message: string;
}

/** Positions compared to these are cm (or chord fractions); differences below are equal. */
const EPS = 1e-9;

export const SECTION_CHECK_SAMPLES = 256;

const first = (s: Spline) => s.knots[0]!.end;
const last = (s: Spline) => s.knots[s.knots.length - 1]!.end;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;
const sameSigns = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const checkOutline = (d: FinDesign, issues: FinIssue[]): void => {
  const o = d.outline;
  if (o.curves.length === 0) {
    issues.push({ code: 'outline-root', message: 'The profile has no curve.' });
    return;
  }
  const le = first(o);
  const te = last(o);
  if (!near(le.y, 0) || !near(te.y, 0)) {
    issues.push({
      code: 'outline-root',
      message: 'Both ends of the profile must sit on the tab top.',
    });
  } else if (le.x <= te.x + EPS) {
    issues.push({
      code: 'outline-root',
      message: 'The leading edge must meet the base in front of the trailing edge.',
    });
  }
  // Up the leading edge, then down the trailing edge: one peak, so every horizontal
  // slice crosses the outline exactly twice.
  if (!sameSigns(slopeSigns(o, 'y'), [1, -1])) {
    issues.push({
      code: 'outline-rising',
      message: 'The leading and trailing edges must each keep rising from base to tip.',
    });
  }
  const tab = finTabOutline(d.base, d.outline);
  if (futuresKind(d.base)) {
    if (le.x > tab.length + FIN_MAX_FRONT_OVERHANG + EPS) {
      issues.push({
        code: 'front-overhang',
        message: `The leading edge overhangs the front of the tab by more than ${FIN_MAX_FRONT_OVERHANG * 10} mm.`,
      });
    }
    if (le.x < -EPS) {
      issues.push({ code: 'tab-rear', message: 'The fin has slid off the back of the tab.' });
    }
  } else if (d.base === 'us-box') {
    // The blade slides along the head: not off its back, and the head no longer than a box takes.
    if (te.x < -EPS) {
      issues.push({ code: 'tab-rear', message: 'The fin has slid off the back of the head.' });
    }
    if (le.x + US_BOX_HEAD.noseAhead > US_BOX_HEAD.maxLength + EPS) {
      issues.push({
        code: 'head-length',
        message: `A US box head is at most ${US_BOX_HEAD.maxLength * 10} mm: move the fin back, or shorten its base.`,
      });
    }
  } else if (le.x < tab.length - EPS || te.x > EPS) {
    // An FCS tab drops straight into its plug: the blade's root must cover all of it.
    issues.push({
      code: 'tab-cover',
      message:
        tab.parts.length > 1
          ? 'Both tabs must sit wholly under the fin’s base.'
          : 'The tab must sit wholly under the fin’s base.',
    });
  }
  // Only meaningful once the outline itself is sound.
  if (issues.every((i) => i.code !== 'outline-root' && i.code !== 'outline-rising')) {
    const short = finClearanceShortfall(d);
    if (short > EPS) {
      issues.push({
        code: 'rear-clearance',
        message: `Behind the tab, the fin would hit the board as it rocks onto the rear pin. Raise the rear by ${(short * 10).toFixed(1)} mm.`,
      });
    }
  }
};

/** The tab stays under the foil (fin-placement.ts). Needs a buildable section. */
const checkTabContact = (d: FinDesign, issues: FinIssue[]): void => {
  const { min, max } = lateralOffsetRange(d);
  if (d.lateralOffset < min - EPS || d.lateralOffset > max + EPS) {
    issues.push({ code: 'tab-contact', message: 'The fin has slid sideways off the tab.' });
  }
};

/**
 * The face must run from the leading edge to the trailing edge (x 0 → 1), always moving
 * toward the trailing edge; with `onChord`, its ends on the chord line (y = 0).
 */
const checkFace = (
  face: Spline,
  name: string,
  where: string,
  issues: FinIssue[],
  onChord: boolean,
): boolean => {
  if (face.curves.length === 0) {
    issues.push({ code: 'section-ends', message: `The ${name} face has no curve${where}.` });
    return false;
  }
  const a = first(face);
  const b = last(face);
  if (!near(a.x, 0) || !near(b.x, 1) || (onChord && (!near(a.y, 0) || !near(b.y, 0)))) {
    issues.push({
      code: 'section-ends',
      message: `The ${name} face must run from the leading edge to the trailing edge${where}.`,
    });
    return false;
  }
  if (!sameSigns(slopeSigns(face, 'x'), [1])) {
    issues.push({
      code: 'section-direction',
      message: `The ${name} face must not turn back toward the leading edge${where}.`,
    });
    return false;
  }
  return true;
};

/** One foil's faces: ends, direction, no crossing, some thickness. `where` names it. */
const checkFoil = (d: FinDesign, sec: FinSection, where: string, issues: FinIssue[]): void => {
  const { outside, inside } = sec;
  if (d.position === 'centre' && inside !== null) {
    issues.push({
      code: 'section-symmetry',
      message: `A centre fin needs a symmetric foil${where}.`,
    });
  }
  // A symmetric foil's edges are on the chord line; any other's may be off it.
  const outsideOk = checkFace(outside, 'outside', where, issues, inside === null);
  const insideOk = inside === null || checkFace(inside, 'inside', where, issues, false);
  if (!outsideOk || !insideOk) return;
  if (
    inside &&
    (!near(first(outside).y, first(inside).y) || !near(last(outside).y, last(inside).y))
  ) {
    issues.push({
      code: 'section-ends',
      message: `The faces must meet at the leading and trailing edges${where}.`,
    });
    return;
  }

  // The inside face mirrors the outside when the foil is symmetric.
  const insideAt = (u: number) => (inside ? valueAt(inside, u) : -valueAt(outside, u));
  let thickest = 0;
  for (let i = 1; i < SECTION_CHECK_SAMPLES; i++) {
    const u = i / SECTION_CHECK_SAMPLES;
    const t = valueAt(outside, u) - insideAt(u);
    if (t < -EPS) {
      issues.push({
        code: 'section-crossing',
        message: `The inside face crosses the outside face${where}.`,
      });
      return;
    }
    thickest = Math.max(thickest, t);
  }
  if (thickest <= EPS) {
    issues.push({ code: 'section-crossing', message: `The foil has no thickness${where}.` });
  }
};

const checkSection = (d: FinDesign, issues: FinIssue[]): void => {
  checkFoil(d, d.section, '', issues);
  let below = 0;
  for (const slice of d.slices) {
    const pct = Math.round(slice.height * 100);
    if (
      !(slice.height >= below + FIN_SLICE_MIN_GAP - EPS) ||
      !(slice.height <= 1 - FIN_SLICE_MIN_GAP + EPS)
    ) {
      issues.push({
        code: 'slice-height',
        message: `Control sections must be at least ${FIN_SLICE_MIN_GAP * 100}% of the depth apart, and from the base and tip.`,
      });
      return;
    }
    below = slice.height;
    checkFoil(d, slice.section, ` (control section at ${pct}%)`, issues);
  }
};

const checkCantLines = (d: FinDesign, issues: FinIssue[]): void => {
  let below = 0;
  for (const l of d.cantLines ?? []) {
    const where = ` (cant line at ${Math.round(l.height * 100)}%)`;
    if (
      !(l.height >= below + FIN_SLICE_MIN_GAP - EPS) ||
      !(l.height <= 1 - FIN_SLICE_MIN_GAP + EPS)
    ) {
      issues.push({
        code: 'cant-line-height',
        message: `Cant lines must be at least ${FIN_SLICE_MIN_GAP * 100}% of the depth apart, and from the base and top.`,
      });
      return;
    }
    below = l.height;
    if (!(l.cant >= FIN_MIN_SLICE_CANT && l.cant <= FIN_MAX_CANT)) {
      issues.push({
        code: 'cant',
        message: `A cant line's cant must be −${-FIN_MIN_SLICE_CANT}° to ${FIN_MAX_CANT}°${where}.`,
      });
    }
    if (!(Math.abs(l.toe) <= FIN_MAX_TOE)) {
      issues.push({ code: 'toe', message: `Toe must be within ±${FIN_MAX_TOE}°${where}.` });
    }
  }
};

const checkTaper = (d: FinDesign, issues: FinIssue[]): void => {
  const t = d.taper;
  if (t.curves.length === 0 || !near(first(t).x, 0) || !near(last(t).x, 1)) {
    issues.push({
      code: 'taper-span',
      message: 'The thickness curve must run from the base to the tip.',
    });
    return;
  }
  if (!sameSigns(slopeSigns(t, 'x'), [1])) {
    issues.push({
      code: 'taper-span',
      message: 'The thickness curve must not turn back toward the base.',
    });
    return;
  }
  const min = finMinThickness(d);
  if (splineExtremes(t, 'y').min.point.y < min - EPS) {
    issues.push({
      code: 'taper-thickness',
      message: `The fin must be at least ${Math.round(min * 100) / 10} mm thick everywhere.`,
    });
  }
  const { min: lo, max: hi } = FIN_MIN_THICKNESS_LIMITS;
  if (d.minThickness !== undefined && !(d.minThickness >= lo - EPS && d.minThickness <= hi + EPS)) {
    issues.push({
      code: 'taper-thickness',
      message: `The minimum thickness must be ${lo * 10} to ${hi * 10} mm.`,
    });
  }
};

/** Every rule the design breaks; empty when it can be built. */
export const validateFinDesign = (d: FinDesign): FinIssue[] => {
  const issues: FinIssue[] = [];
  const centre = d.position === 'centre';
  if (centre ? d.hand !== null : d.hand === null) {
    issues.push({
      code: 'hand',
      message: centre ? 'A centre fin has no side.' : 'A side or quad-rear fin needs a side.',
    });
  }
  const fcs = !futuresKind(d.base);
  if (centre || fcs ? d.cant !== 0 : !(d.cant >= 0 && d.cant <= FIN_MAX_CANT)) {
    issues.push({
      code: 'cant',
      message: centre
        ? 'A centre fin has no cant.'
        : d.base === 'us-box'
          ? 'A fin in a US box has no cant.'
          : fcs
            ? 'On an FCS tab the plug sets the cant: the fin has none.'
            : `Cant must be 0° to ${FIN_MAX_CANT}°.`,
    });
  }
  if (!finHasToe(d) && (d.toe ?? 0) !== 0) {
    issues.push({
      code: 'toe',
      message:
        d.position === 'centre' ? 'A centre fin has no toe.' : 'A fin in a US box has no toe.',
    });
  } else if (!(Math.abs(d.toe ?? 0) <= FIN_MAX_TOE)) {
    issues.push({ code: 'toe', message: `Toe must be within ±${FIN_MAX_TOE}°.` });
  }
  if (!FIN_BASES.includes(d.base)) {
    issues.push({ code: 'base', message: 'Unknown tab.' });
  }
  checkOutline(d, issues);
  checkSection(d, issues);
  checkCantLines(d, issues);
  checkTaper(d, issues);
  // Placing the tab under the foil means building the root section, which needs the
  // rest of the design to be sound.
  if (issues.length === 0) checkTabContact(d, issues);
  return issues;
};
