// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the fin sits on its tab, and the nudges that move it (the designer's arrow
 * buttons).
 *
 * - **Fore and aft** is the outline's own x, in the tab frame. Defaults are
 *   rear-aligned, the usual convention: the trailing-edge root on the tab's rear end.
 *   Forward stops hard when the leading edge overhangs the tab front by
 *   {@link FIN_MAX_FRONT_OVERHANG} (the grub screw). Back stops where the part behind
 *   the tab would hit the board while the fin rocks onto the rear pin
 *   (fin-clearance.ts), and in any case at the tab's rear end.
 * - **Across** is {@link FinDesign.lateralOffset}. By default:
 *   - a symmetric foil is centred on the tab;
 *   - any other foil has its chord line flush with the tab's inboard face, so a flat
 *     inside face is flush with the tab, the usual convention.
 *
 *   A curved inside face (most NACA foils) then overhangs the tab inboard. Sliding
 *   the blade sideways corrects that, as far as the tab stays under the foil: its
 *   centre plane between the root section's two faces at their thickest point.
 *
 * The frame is blade.ts's: the blade is fixed and the tab is placed under it.
 */
import { NO_LAMINATE, prepareBlade, rootThickestFaces, type FinLaminate } from './blade';
import { clearanceShortfall, rearClearance } from './fin-clearance';
import { FIN_MAX_FRONT_OVERHANG, finOutward, type FinDesign } from './fin-design';
import { US_BOX_HEAD, baseTrailingRoot, finTabOutline, futuresKind, type FinBase } from './fin-tab';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import { vec2, type Vec2 } from '../vec2';

const outwardOf = (d: FinDesign): 1 | -1 => finOutward(d.hand);

/** The tab's centre plane (blade-frame Y, cm) before any lateral offset. */
const defaultTabCentreY = (d: FinDesign): number =>
  d.section.inside === null ? 0 : (outwardOf(d) * finTabOutline(d.base, d.outline).thickness) / 2;

/** The tab's centre plane (blade-frame Y, cm): its default, less the blade's offset. */
export const tabCentreY = (d: FinDesign): number =>
  defaultTabCentreY(d) - outwardOf(d) * d.lateralOffset;

/**
 * The tab's two faces (blade-frame Y, cm), lower first. With a laminate that wraps the
 * tab ({@link FinLaminate.tab}), each laminated face is pulled in by its laminate, so
 * the tab is its core too: on a flat inside face it stays flush with the blade's core,
 * and the laminate runs unbroken from the blade over the base.
 */
export const tabFacesY = (
  d: FinDesign,
  laminate: FinLaminate = NO_LAMINATE,
): readonly [number, number] => {
  const half = finTabOutline(d.base, d.outline).thickness / 2;
  const yc = tabCentreY(d);
  const out = outwardOf(d);
  const outside = yc + out * (half - (laminate.tab ? laminate.outside : 0));
  const inside = yc - out * (half - (laminate.tab ? laminate.inside : 0));
  return outside < inside ? [outside, inside] : [inside, outside];
};

/**
 * The lateral offsets (cm) that keep the tab under the foil: its centre plane between
 * the root section's inside and outside faces where the foil is thickest.
 */
export const lateralOffsetRange = (d: FinDesign): { min: number; max: number } => {
  const faces = rootThickestFaces(prepareBlade(d));
  const c0 = defaultTabCentreY(d);
  const w = outwardOf(d);
  // Centre c = c0 − w·offset, so offset = w·(c0 − c) for each face's y.
  const a = w * (c0 - faces.inside);
  const o = w * (c0 - faces.outside);
  return { min: Math.min(a, o), max: Math.max(a, o) };
};

/**
 * Fore-aft limits on the leading-edge root's x (cm), from the design's tab. Futures: on
 * the tab, overhanging its front by no more than the grub-screw allowance. FCS: the tab
 * stays wholly under the blade's root, so the leading-edge root is at or ahead of the
 * tab's front and the trailing-edge root at or behind its rear.
 */
export const leadingRootRange = (d: FinDesign): { min: number; max: number } => {
  // A US box head moves with the fin: there is nothing to slide along.
  // US box: the blade slides along the head, whose rear end is fixed at 0 and front
  // follows the leading edge. Back until the trailing-edge root reaches the rear end;
  // forward until the head would be over its maximum length.
  if (d.base === 'us-box') {
    const knots = d.outline.knots;
    const chord = knots[0]!.end.x - knots[knots.length - 1]!.end.x;
    return { min: chord, max: Math.max(chord, US_BOX_HEAD.maxLength - US_BOX_HEAD.noseAhead) };
  }
  const tab = finTabOutline(d.base, d.outline);
  if (futuresKind(d.base)) return { min: 0, max: tab.length + FIN_MAX_FRONT_OVERHANG };
  const knots = d.outline.knots;
  const chord = knots[0]!.end.x - knots[knots.length - 1]!.end.x;
  return { min: tab.length, max: Math.max(tab.length, chord) };
};

const shiftOutline = (d: FinDesign, dx: number): FinDesign => {
  const m = (p: Vec2) => vec2(p.x + dx, p.y);
  return {
    ...d,
    outline: splineFromKnots(
      d.outline.knots.map((k) =>
        knot(m(k.end), m(k.tangentToPrev), m(k.tangentToNext), k.continuous, k.other, k.lock),
      ),
    ),
  };
};

/**
 * Move the fin `dx` cm toward the nose (negative: toward the tail). Forward stops hard
 * at the front-overhang limit. Back stops at the tab's rear end, or sooner where the
 * part behind the tab would hit the board as the fin rocks in (fin-clearance.ts). A
 * fin already short of clearance cannot be moved further back.
 */
export const nudgeFore = (d: FinDesign, dx: number): FinDesign => {
  const le = d.outline.knots[0]!.end.x;
  const { min, max } = leadingRootRange(d);
  let to = Math.min(max, Math.max(min, le + dx));
  const kind = futuresKind(d.base);
  if (to < le && kind) {
    const c = rearClearance(kind);
    const clear = (x: number) => clearanceShortfall(shiftOutline(d, x - le).outline, c) <= 1e-9;
    if (!clear(le)) to = le;
    else if (!clear(to)) {
      // Moving back only adds shortfall, so bisect for the last clear position.
      let ok = le;
      let bad = to;
      for (let i = 0; i < 50; i++) {
        const mid = (ok + bad) / 2;
        if (clear(mid)) ok = mid;
        else bad = mid;
      }
      // Under a micron is rounding at the tab's rear end, not a move.
      to = le - ok < 1e-4 ? le : ok;
    }
  }
  return to === le ? d : shiftOutline(d, to - le);
};

/** Slide the blade `dy` cm outboard across the tab (negative: inboard), within range. */
export const nudgeLateral = (d: FinDesign, dy: number): FinDesign => {
  const { min, max } = lateralOffsetRange(d);
  const to = Math.min(max, Math.max(min, d.lateralOffset + dy));
  return to === d.lateralOffset ? d : { ...d, lateralOffset: to };
};

/**
 * The design moved onto another base, placed as that base's fins start: on an FCS single
 * tab, its root centred over the tab; on FCS 1, aligned from the back (the trailing-edge
 * root 20.5 mm behind the rear tab), so a bigger fin overhangs at the
 * front, and a smaller one comes forward to cover the front tab; both with no cant (the plug carries it). On a Gbox tab,
 * the same from the back, its trailing-edge root 13/16" behind the tab, and no cant (the
 * box carries it). On a Futures tab, rear-aligned (the
 * trailing-edge root on the tab's rear end), its cant kept. On a US box the head follows
 * the leading edge, its rear end fixed at x = 0: the fin starts with its trailing-edge
 * root 25 mm ahead of that rear end; no cant.
 */
export const placeOnBase = (d: FinDesign, base: FinBase): FinDesign => {
  if (base === d.base) return d;
  const knots = d.outline.knots;
  const le = knots[0]!.end.x;
  const te = knots[knots.length - 1]!.end.x;
  const tab = finTabOutline(base, d.outline);
  const fcs = !futuresKind(base);
  if (base === 'us-box') {
    // The trailing-edge root the usual stub ahead of the head's rear end, or back as far
    // as it takes to keep the head within its maximum length.
    const { rearStub, noseAhead, maxLength } = US_BOX_HEAD;
    let shift = rearStub - te;
    if (le + shift + noseAhead > maxLength) shift = Math.max(-te, maxLength - noseAhead - le);
    const moved = shift === 0 ? d : shiftOutline(d, shift);
    return { ...moved, base, cant: 0, toe: 0 };
  }
  const rear = baseTrailingRoot(base);
  let dx = rear === null ? tab.length / 2 - (le + te) / 2 : rear - te;
  // FCS 1 and Gbox: a fin too short for the usual spot comes forward just enough to
  // cover the (front) tab (one too short for it can't be placed, and says so).
  if ((base === 'fcs-1' || base === 'gbox') && le + dx < tab.length) {
    dx = Math.min(tab.length - le, -te);
  }
  const moved = dx === 0 ? d : shiftOutline(d, dx);
  return { ...moved, base, cant: fcs ? 0 : d.cant };
};
