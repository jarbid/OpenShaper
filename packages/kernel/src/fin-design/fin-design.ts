// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A standalone fin design: the persisted intent of the fin designer
 * (docs/design/fin-designer.md). Everything a fin is made from — outline, foil section,
 * thickness taper, cant — is an editable curve or number here; the 3D blade and the
 * exports are computed from it and never stored.
 *
 * Independent of the board's `FinSpec`/`FinConfig` (fins.ts), which place fins on a
 * board; this describes one fin for manufacture.
 *
 * Units are the kernel's cm and degrees, except where a curve is normalised (stated
 * per field).
 */
import type { Spline } from '../bezier-spline';
import type { FinBase } from './fin-tab';
import type { FuturesTabKind } from './futures-tab';

/** Where the fin goes. Quad rears use the shallower centre tab but take cant and a side. */
export type FinPosition = 'side' | 'quad-rear' | 'centre';

export const FIN_POSITIONS: readonly FinPosition[] = ['side', 'quad-rear', 'centre'];

/**
 * Which side a side or quad-rear fin is for, named the way fin makers mark them: with
 * the board seen from below, nose up. That is the opposite of the rider's view from the
 * deck, so a "left" fin sits on the rider's right rail.
 */
export type FinHand = 'left' | 'right';

/**
 * +1 when the fin's outside face (and its cant) points to +Y in the blade frame, −1
 * when it points to −Y (blade.ts describes the frame). Seen from below with the nose
 * up, +Y is on the left, so a left fin faces +Y. A centre fin (no hand) uses +Y too; it
 * is symmetric with no cant, so the choice is moot.
 */
export const finOutward = (hand: FinHand | null): 1 | -1 => (hand === 'right' ? -1 : 1);

/**
 * Whether the fin can take a toe correction. A centre fin sits on the stringer and a
 * US box fin is a centre single fin, so neither has toe: theirs is always 0.
 */
export const finHasToe = (d: { readonly position: FinPosition; readonly base: string }): boolean =>
  d.position !== 'centre' && d.base !== 'us-box';

/** The Futures tab each position uses by default. */
export const finTabKind = (position: FinPosition): FuturesTabKind =>
  position === 'side' ? 'side' : 'centre';

/** The base a position starts on: its Futures tab. Canards choose the FCS single tab. */
export const defaultFinBase = (position: FinPosition): FinBase =>
  position === 'side' ? 'futures-side' : 'futures-centre';

/** Largest toe correction either way (deg). A little toe makes a big difference. */
export const FIN_MAX_TOE = 5;

/** Largest cant (blade lean from the tab, deg) the designer allows. */
export const FIN_MAX_CANT = 20;

/**
 * How far the leading-edge root may sit in front of a Futures tab's top-front corner
 * (cm): 4 mm. The base foil clears the box's grub screw by that much; the owner measured
 * production fins overhanging more than the 2.5 mm first assumed.
 */
export const FIN_MAX_FRONT_OVERHANG = 0.4;

/**
 * Thinnest the blade may get anywhere while designing — edges and tip (cm): 0.5 mm,
 * close to a hand-finished edge, and enough edge for the surface to stay a closed shape
 * (a knife edge breaks CAD imports). Exports can thicken it ({@link FIN_EXPORT_MIN_THICKNESS}).
 */
export const FIN_MIN_THICKNESS = 0.05;

/**
 * The export's minimum thickness (cm): what STEP, STL and core exports thicken the edges
 * and tip to, without changing the design. 1 mm by default, as some 3D printing materials
 * can't hold a thinner wall; from the design minimum up to 3 mm.
 */
export const FIN_EXPORT_MIN_THICKNESS = { default: 0.1, min: FIN_MIN_THICKNESS, max: 0.3 } as const;

/**
 * The horizontal foil, as two faces offset from the chord line. Frame: x = chord fraction
 * u (0 leading edge → 1 trailing edge), y = offset in chords, + toward the outside face.
 * Both faces run from the leading edge (x 0) to the trailing edge (x 1), and meet there:
 * on the chord line for a symmetric foil, anywhere either side of it otherwise (an edge
 * moved off the line, to blend a twist). Only the shape matters: step 4 scales the
 * section so its thickest point matches the taper, edges' offsets with the rest.
 */
export interface FinSection {
  /** The outside (outboard) face. */
  readonly outside: Spline;
  /**
   * The inside face, or `null` for a symmetric foil (the outside face mirrored). A flat
   * inside face is the straight line y = 0; a negative offset bulges inboard.
   */
  readonly inside: Spline | null;
}

/** A foil at one height up the blade (docs/design/fin-designer.md, foil slices). */
export interface FinSlice {
  /** Height as a fraction of the blade's depth, like the taper's x: 0 root, 1 tip. */
  readonly height: number;
  readonly section: FinSection;
  /**
   * A change of cant and toe at this slice, or none (the blade carries on as below it).
   * The blade eases from the cant and toe below (the root's, or the slice below's) to
   * these over the whole span up to the slice, and keeps them above it. More cant bends
   * the blade out, a different toe twists it (Futures' upper-blade designs). Each
   * section turns about its own centre (of area).
   */
  readonly twist?: FinTwist;
}

/** Cant and toe at a slice. */
export interface FinTwist {
  /** Cant at the slice and above (deg), {@link FIN_MIN_SLICE_CANT} to {@link FIN_MAX_CANT}. */
  readonly cant: number;
  /** Toe at the slice and above (deg, + toe in), ±{@link FIN_MAX_TOE}. */
  readonly toe: number;
}

/** A slice may take the blade's lean back past upright: an edge case owners asked for. */
export const FIN_MIN_SLICE_CANT = -20;

/**
 * How close slices may sit to each other, the root or the tip (fraction of the depth):
 * 2 mm on a 100 mm fin. Closer and the blend between them would turn too sharply.
 */
export const FIN_SLICE_MIN_GAP = 0.02;

/**
 * The panel a fin is machined from (panel-fit.ts): its thickness, and how the fin sits
 * in it: turned, seen from above, and tilted, seen from the front. Only a check: it
 * doesn't change the fin or its exports.
 */
export interface FinPanel {
  /** Panel thickness (cm). */
  readonly thickness: number;
  /**
   * The fin turned in the panel about an upright axis (deg, counter-clockwise seen from
   * above), within ±{@link FIN_PANEL_MAX_ANGLE}. 0: the panel's faces run along the tab.
   */
  readonly angle: number;
  /**
   * The panel's faces leaning from upright, seen from the front along the panel (deg,
   * + toward the fin's outside face, as cant leans the blade), within
   * ±{@link FIN_PANEL_MAX_ANGLE}. A canted blade on an upright tab fits a thinner panel
   * leaning between the two. Absent: 0.
   */
  readonly tilt?: number;
}

/** The furthest a fin may be turned or tilted in its panel (deg). */
export const FIN_PANEL_MAX_ANGLE = 45;

/** Panel thicknesses accepted (cm): 3 to 30 mm. */
export const FIN_PANEL_THICKNESS = { min: 0.3, max: 3 } as const;

/**
 * Where the foil sweep ends (owner proposal, swept-loft.ts): the tip line's two ends on
 * the outline, as fractions of its length from the leading-edge root (0) to the
 * trailing-edge root (1). `start` is on the leading edge's side of the tip, `end` on
 * the trailing edge's.
 */
export interface FinTipLine {
  readonly start: number;
  readonly end: number;
}

/**
 * The thickness path (swept-loft.ts): where each sweep section is thickest, as a fraction
 * of the section's length from the leading edge, at the base, halfway up and at the tip
 * line, curving smoothly between. Its ends are the base and tip foils' own thickest
 * points; only the middle is set on its own ({@link FinDesign.thicknessMid}).
 */
export type FinThicknessPath = readonly [number, number, number];

/** How near either edge the thickness path may go (fraction of the section). */
export const FIN_THICKNESS_PATH_LIMITS = { min: 0.1, max: 0.8 } as const;

export interface FinDesign {
  readonly position: FinPosition;
  /** `left` or `right` for side and quad-rear fins; `null` for a centre fin. */
  readonly hand: FinHand | null;
  /**
   * Lean of the blade out from the tab (deg), 0 to {@link FIN_MAX_CANT}; 0 for a centre
   * fin, and on an FCS single tab, whose plug carries the cant.
   */
  readonly cant: number;
  /** The tab the fin sits on (fin-tab.ts). */
  readonly base: FinBase;
  /**
   * Toe correction (deg), −{@link FIN_MAX_TOE} to +{@link FIN_MAX_TOE}: the blade turned
   * on its tab about an upright axis through the centre of the root's thickest point,
   * to correct a box set at the wrong angle to the stringer. Positive is more toe in
   * (the leading edge turned toward the stringer), whichever side the fin is for.
   */
  readonly toe: number;
  /**
   * The blade's side profile in the tab frame (cm): x from the tab's rear end toward its
   * front (+x toward the nose), y = height above the tab top (the blade root plane).
   * One open chain: leading-edge root → up the leading edge → tip → down the trailing
   * edge → trailing-edge root. The root edge between the two ends is implied.
   *
   * Being in the tab frame, the outline also places the fin fore and aft on the tab:
   * nudging the fin forward or back moves the whole outline (fin-placement.ts).
   */
  readonly outline: Spline;
  /**
   * How far the blade sits outboard of its default position across the tab (cm);
   * negative is inboard. By default a foil with a flat or curved inside face has its
   * chord line flush with the tab's inboard face, and a symmetric foil is centred
   * (fin-placement.ts). A strongly curved inside face overhangs the tab inboard, and
   * this lets the user slide the blade back over it.
   */
  readonly lateralOffset: number;
  /** The foil at the root (and all the way up, unless {@link slices} say otherwise). */
  readonly section: FinSection;
  /**
   * Foils at other heights, lowest first. Between two slices, and between the root and
   * the first, the shape blends smoothly with height; above the last it stays as the
   * last. Empty for a fin with one foil throughout.
   */
  readonly slices: readonly FinSlice[];
  /**
   * Thickness at the section's thickest point, up the blade. Frame: x = height as a
   * fraction of the blade's depth (0 root → 1 tip), y = thickness (cm). Normalising
   * the height keeps the taper valid when the outline's depth changes.
   */
  readonly taper: Spline;
  /** Where the foil sweep ends; absent for the default (swept-loft.ts, defaultTipLine). */
  readonly tipLine?: FinTipLine;
  /**
   * The foil at the tip line (foil sweep end): the sweep blends from {@link section} at
   * the base to this. Absent: the base foil all the way.
   */
  readonly tipSection?: FinSection;
  /**
   * Where the sweep's section halfway up is thickest (fraction along it); absent for
   * halfway between the base and tip foils' thickest points.
   */
  readonly thicknessMid?: number;
  /** The panel it's cut from, if the user has set one (File settings). */
  readonly panel?: FinPanel;
}
