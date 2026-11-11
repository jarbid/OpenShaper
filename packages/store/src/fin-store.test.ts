// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  FIN_MAX_FRONT_OVERHANG,
  FIN_MIN_THICKNESS,
  FIN_PANEL_MAX_ANGLE,
  FIN_SLICE_MIN_GAP,
  FIN_THICKNESS_PATH_LIMITS,
  bladeSection,
  cosineStations,
  defaultFinDesign,
  prepareBlade,
  smoothFoilAt,
  yAtX,
  sectionThickest,
  thicknessPathOf,
  tipApexFraction,
  tipLineOf,
  tipTurnFraction,
  finReadouts,
  foilShare,
  knot,
  splineFromKnots,
  SPLIT_NOSE_ASPECT,
  validateFinDesign,
  vec2,
  type FinDesign,
} from '@openshaper/kernel';
import { foilTrueScale, getFinCurve, TIP_FOIL } from './fin-edits';
import { createFinStore } from './fin-store';

const storeWith = (d: FinDesign = defaultFinDesign('side', 'right')) => {
  const s = createFinStore();
  s.getState().load(d);
  return s;
};
const design = (s: ReturnType<typeof storeWith>) => s.getState().design!;
const knotAt = (s: ReturnType<typeof storeWith>, i: number) => design(s).outline.knots[i]!.end;

describe('fin store: history', () => {
  it('starts with a default fin and no history', () => {
    const s = createFinStore();
    s.getState().newFin('centre');
    expect(design(s).position).toBe('centre');
    expect(s.getState().canUndo()).toBe(false);
  });

  it('undoes and redoes an edit', () => {
    const s = storeWith();
    const before = design(s);
    expect(s.getState().setCant(10)).toBe(true);
    expect(design(s).cant).toBe(10);
    s.getState().undo();
    expect(design(s)).toBe(before);
    s.getState().redo();
    expect(design(s).cant).toBe(10);
  });

  it('records a whole drag as one undo step', () => {
    const s = storeWith();
    const before = design(s);
    const p = knotAt(s, 2);
    s.getState().beginEdit('Move control point');
    for (let i = 1; i <= 5; i++)
      s.getState().moveControlPoint('outline', 2, vec2(p.x + 0.02 * i, p.y));
    s.getState().endEdit();
    expect(s.getState().past).toHaveLength(1);
    s.getState().undo();
    expect(design(s)).toBe(before);
  });

  it('leaves no undo step for a drag that moved nothing', () => {
    const s = storeWith();
    s.getState().beginEdit();
    s.getState().endEdit();
    expect(s.getState().canUndo()).toBe(false);
  });

  it('makes starting a new fin undoable', () => {
    const s = storeWith();
    s.getState().newFin('quad-rear', 'left');
    expect(design(s).position).toBe('quad-rear');
    s.getState().undo();
    expect(design(s).position).toBe('side');
  });

  it('drops a selection whose point an undo removed', () => {
    const s = storeWith();
    expect(s.getState().addControlPoint('outline', vec2(8, 5))).toBe(true);
    const sel = s.getState().selection!;
    expect(sel.curve).toBe('outline');
    s.getState().undo();
    expect(s.getState().selection === null || sel.index < design(s).outline.knots.length).toBe(
      true,
    );
  });
});

describe('fin store: drags stay inside the rules', () => {
  it('keeps the outline roots on the base', () => {
    const s = storeWith();
    const le = knotAt(s, 0);
    s.getState().moveControlPoint('outline', 0, vec2(le.x - 0.5, 2));
    expect(knotAt(s, 0)).toEqual(vec2(le.x - 0.5, 0));
  });

  it('stops the leading-edge root at the 4 mm front overhang', () => {
    const s = storeWith();
    const le = knotAt(s, 0);
    s.getState().moveControlPoint('outline', 0, vec2(20, 0)); // far past the tab front
    const r = finReadouts(design(s));
    expect(r.frontOverhang).toBeLessThanOrEqual(FIN_MAX_FRONT_OVERHANG + 1e-9);
    // Clamped at the boundary, not refused: it moved nearly all the way there.
    expect(r.frontOverhang).toBeGreaterThan(FIN_MAX_FRONT_OVERHANG - 0.01);
    expect(knotAt(s, 0).x).toBeGreaterThan(le.x);
  });

  it('pins a symmetric foil’s faces to the leading and trailing edges', () => {
    const s = storeWith(defaultFinDesign('centre'));
    const before = design(s);
    expect(before.section.inside).toBeNull();
    expect(s.getState().moveControlPoint('outside', 0, vec2(0.2, 0.1))).toBe(false);
    const last = before.section.outside.knots.length - 1;
    expect(s.getState().moveControlPoint('outside', last, vec2(0.8, 0.1))).toBe(false);
    expect(design(s)).toBe(before); // nothing changed, and no undo step
    expect(s.getState().canUndo()).toBe(false);
  });

  it('makes stacked points one on loading, and the add button stacks none', () => {
    // Owner testing: thirty points stacked on one in the tip foil's inside face.
    const d = defaultFinDesign('side', 'right');
    const k = d.section.outside.knots[1]!;
    const dup = knot(k.end, k.end, k.end, true);
    const stacked = splineFromKnots([
      ...d.section.outside.knots.slice(0, 1),
      knot(k.end, k.tangentToPrev, k.end, true),
      dup,
      dup,
      knot(k.end, k.end, k.tangentToNext, true),
      ...d.section.outside.knots.slice(2),
    ]);
    const s = storeWith({ ...d, section: { ...d.section, outside: stacked } });
    expect(design(s).section.outside.knots).toHaveLength(d.section.outside.knots.length);
    // Each press adds a point halfway along the span after the selected one.
    s.getState().select({ curve: 'outside', index: 0, kind: 'end' });
    for (let i = 0; i < 4; i++)
      s.getState().addControlPointAfter('outside', s.getState().selection!.index);
    const xs = design(s).section.outside.knots.map((kk) => kk.end.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('moves an edge of a foil with its own inside face across the chord, both faces', () => {
    // Owner's request: edges off the chord line, to blend twists. The edge stays at the
    // edge (x), and the faces still meet there.
    const s = storeWith();
    const last = design(s).section.outside.knots.length - 1;
    s.getState().beginEdit();
    expect(s.getState().moveControlPoint('outside', last, vec2(0.8, 0.01))).toBe(true);
    s.getState().endEdit();
    const { outside, inside } = design(s).section;
    expect(outside.knots[last]!.end).toEqual(vec2(1, 0.01));
    expect(inside!.knots[inside!.knots.length - 1]!.end).toEqual(vec2(1, 0.01));
    expect(validateFinDesign(design(s))).toEqual([]);
    // From the inside face too, the leading edge.
    s.getState().moveControlPoint('inside', 0, vec2(0.1, -0.004));
    expect(design(s).section.outside.knots[0]!.end).toEqual(vec2(0, -0.004));
    // Made symmetric, the edges come back to the chord line.
    expect(s.getState().setInsideFace('symmetric')).toBe(true);
    expect(design(s).section.outside.knots[0]!.end).toEqual(vec2(0, 0));
    expect(design(s).section.outside.knots[last]!.end).toEqual(vec2(1, 0));
  });

  it('sets the fin’s minimum thickness, the taper’s tip and anything under it following', () => {
    // Owner request: the minimum set in the thickness view, 0.5 mm by default.
    const s = storeWith();
    const tip = () => design(s).taper.knots[design(s).taper.knots.length - 1]!.end;
    expect(tip().y).toBe(FIN_MIN_THICKNESS);
    expect(s.getState().setMinThickness(0.1)).toBe(true);
    expect(design(s).minThickness).toBe(0.1);
    expect(tip()).toEqual(vec2(1, 0.1));
    const lowest = Math.min(...design(s).taper.knots.flatMap((k) => [k.end.y, k.tangentToPrev.y]));
    expect(lowest).toBeGreaterThanOrEqual(0.1);
    expect(validateFinDesign(design(s))).toEqual([]);
    // The store stops a point there.
    s.getState().moveControlPoint('taper', design(s).taper.knots.length - 1, vec2(1, 0.07));
    expect(tip().y).toBeCloseTo(0.1, 9);
    // Within 0.5 to 3 mm, and back to the default leaves nothing in the file.
    s.getState().setMinThickness(1);
    expect(design(s).minThickness).toBe(0.3);
    s.getState().setMinThickness(0.01);
    expect('minThickness' in design(s)).toBe(false);
    expect(tip().y).toBeCloseTo(FIN_MIN_THICKNESS, 9);
    s.getState().undo();
    expect(design(s).minThickness).toBe(0.3);
  });

  it('keeps the taper ends at the root and the tip, and above the minimum', () => {
    const s = storeWith();
    const tip = design(s).taper.knots.length - 1;
    s.getState().moveControlPoint('taper', tip, vec2(0.7, 0));
    const end = design(s).taper.knots[tip]!.end;
    expect(end.x).toBe(1);
    expect(end.y).toBeGreaterThanOrEqual(FIN_MIN_THICKNESS - 1e-9);
  });

  it('will not drag an outline into a dip, only up to it', () => {
    const s = storeWith();
    const before = design(s);
    // Drag a leading-edge point far above the tip: the edge would no longer rise.
    const p = knotAt(s, 1);
    s.getState().moveControlPoint('outline', 1, vec2(p.x, p.y + 50));
    expect(validateFinDesign(design(s))).toEqual([]);
    expect(design(s)).not.toBe(before);
  });

  it('refuses a deletion that would break a rule, and allows one that would not', () => {
    const s = storeWith();
    const n = design(s).outline.knots.length;
    // Every default outline knot can go except the ends; the result must stay valid.
    const ok = s.getState().deleteControlPoint('outline', 2);
    expect(ok).toBe(validateFinDesign(design(s)).length === 0);
    if (ok) expect(design(s).outline.knots).toHaveLength(n - 1);
    expect(s.getState().deleteControlPoint('outline', 0)).toBe(false);
  });

  it('lets a design that already breaks a rule be edited without adding another', () => {
    const s = storeWith({ ...defaultFinDesign('side', 'right'), cant: 30 });
    expect(validateFinDesign(design(s)).map((i) => i.code)).toEqual(['cant']);
    expect(s.getState().setRootThickness(0.7)).toBe(true);
    expect(s.getState().setCant(12)).toBe(true); // and fixing it is fine
    expect(validateFinDesign(design(s))).toEqual([]);
  });
});

describe('fin store: fin-wide edits', () => {
  it('clamps cant, and keeps a centre fin upright', () => {
    const s = storeWith();
    s.getState().setCant(35);
    expect(design(s).cant).toBe(20);
    s.getState().setCant(-4);
    expect(design(s).cant).toBe(0);
    const c = storeWith(defaultFinDesign('centre'));
    expect(c.getState().setCant(5)).toBe(false);
    expect(design(c).cant).toBe(0);
  });

  it('sets the root thickness, keeping the taper’s shape and minimum', () => {
    const s = storeWith();
    s.getState().setRootThickness(0.6);
    const t = design(s).taper.knots;
    expect(t[0]!.end.y).toBeCloseTo(0.6, 12);
    expect(t[t.length - 1]!.end.y).toBeGreaterThanOrEqual(FIN_MIN_THICKNESS);
  });

  it('sets the depth over the same base', () => {
    const s = storeWith();
    const chord = finReadouts(design(s)).rootChord;
    s.getState().setDepth(11.5);
    expect(finReadouts(design(s)).depth).toBeCloseTo(11.5, 9);
    expect(finReadouts(design(s)).rootChord).toBeCloseTo(chord, 12);
  });

  it('applies NACA presets, symmetric only on a centre fin', () => {
    const s = storeWith();
    expect(s.getState().applyNaca('2412')).toBe(true);
    expect(design(s).section.inside).not.toBeNull();
    expect(s.getState().past.at(-1)!.label).toBe('NACA 2412');
    const c = storeWith(defaultFinDesign('centre'));
    expect(c.getState().applyNaca('2412')).toBe(false);
    expect(c.getState().applyNaca('0010')).toBe(true);
    expect(c.getState().applyNaca('nope')).toBe(false);
  });

  it('switches a side fin between flat-inside and symmetric', () => {
    const s = storeWith();
    expect(s.getState().setInsideFace('symmetric')).toBe(true);
    expect(design(s).section.inside).toBeNull();
    expect(s.getState().setInsideFace('flat')).toBe(true);
    expect(storeWith(defaultFinDesign('centre')).getState().setInsideFace('flat')).toBe(false);
  });

  it('sets the hand of a side fin only', () => {
    const s = storeWith();
    expect(s.getState().setHand('left')).toBe(true);
    expect(design(s).hand).toBe('left');
    expect(storeWith(defaultFinDesign('centre')).getState().setHand('left')).toBe(false);
  });

  it('nudges along the tab, stopping at the front and at insertion clearance', () => {
    const s = storeWith();
    expect(s.getState().nudgeFore(0.05)).toBe(true);
    for (let i = 0; i < 40; i++) s.getState().nudgeFore(0.05);
    expect(finReadouts(design(s)).frontOverhang).toBeCloseTo(FIN_MAX_FRONT_OVERHANG, 9);
    expect(s.getState().nudgeFore(0.05)).toBe(false); // at the stop: nothing to undo
    // Back to rear-aligned, then no further: the flat base would hit the board.
    for (let i = 0; i < 60; i++) s.getState().nudgeFore(-0.05);
    expect(s.getState().nudgeFore(-0.05)).toBe(false);
  });

  it('nudges across the tab within range', () => {
    const s = storeWith();
    expect(s.getState().nudgeLateral(0.05)).toBe(true);
    expect(design(s).lateralOffset).toBeCloseTo(0.05, 12);
    for (let i = 0; i < 100; i++) s.getState().nudgeLateral(0.05);
    expect(validateFinDesign(design(s))).toEqual([]);
  });
});

describe('fin store: point tools', () => {
  const cross = (k: {
    end: { x: number; y: number };
    tangentToPrev: { x: number; y: number };
    tangentToNext: { x: number; y: number };
  }) => {
    const a = { x: k.tangentToPrev.x - k.end.x, y: k.tangentToPrev.y - k.end.y };
    const b = { x: k.tangentToNext.x - k.end.x, y: k.tangentToNext.y - k.end.y };
    return (a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
  };

  it('adds a point halfway along the span after the selected one, and selects it', () => {
    const s = storeWith();
    const n = design(s).taper.knots.length;
    expect(s.getState().addControlPointAfter('taper', 0)).toBe(true);
    expect(design(s).taper.knots.length).toBe(n + 1);
    expect(s.getState().selection).toEqual({ curve: 'taper', index: 1, kind: 'end' });
    // The new point is on the old curve, so the shape is unchanged.
    expect(validateFinDesign(design(s))).toEqual([]);
  });

  it('adds before the last point, which has no span after it', () => {
    const s = storeWith();
    const last = design(s).taper.knots.length - 1;
    expect(s.getState().addControlPointAfter('taper', last)).toBe(true);
    expect(s.getState().selection!.index).toBe(last);
  });

  it('turns a corner smooth by lining up its handles, keeping their lengths', () => {
    const s = storeWith();
    const i = 1;
    const k0 = design(s).outline.knots[i]!;
    s.getState().setContinuous('outline', i, false);
    // Kink it: swing the forward handle round.
    const h = k0.tangentToNext;
    s.getState().moveTangent('outline', i, 'next', vec2(h.x + 1, h.y - 1));
    const kinked = design(s).outline.knots[i]!;
    expect(Math.abs(cross(kinked))).toBeGreaterThan(0.01);
    expect(s.getState().setContinuous('outline', i, true)).toBe(true);
    const k = design(s).outline.knots[i]!;
    expect(k.continuous).toBe(true);
    expect(Math.abs(cross(k))).toBeLessThan(1e-9);
    const len = (p: { x: number; y: number }) => Math.hypot(p.x - k.end.x, p.y - k.end.y);
    const lenWas = (p: { x: number; y: number }) =>
      Math.hypot(p.x - kinked.end.x, p.y - kinked.end.y);
    expect(len(k.tangentToNext)).toBeCloseTo(lenWas(kinked.tangentToNext), 12);
    expect(len(k.tangentToPrev)).toBeCloseTo(lenWas(kinked.tangentToPrev), 12);
  });

  it('turns a smooth point to a corner without moving its handles', () => {
    const s = storeWith();
    const before = design(s).outline.knots[1]!;
    expect(s.getState().setContinuous('outline', 1, false)).toBe(true);
    const k = design(s).outline.knots[1]!;
    expect(k.continuous).toBe(false);
    expect(k.tangentToNext).toEqual(before.tangentToNext);
  });
});

describe('fin store: foil slices', () => {
  const outsideAt = (s: ReturnType<typeof storeWith>, foil: number) =>
    foil === 0 ? design(s).section.outside : design(s).slices[foil - 1]!.section.outside;

  it('adds a slice as the fin’s own section there, and edits it', () => {
    const s = storeWith();
    const before = design(s);
    expect(s.getState().addSlice(0.5)).toBe(true);
    expect(design(s).slices).toHaveLength(1);
    expect(design(s).slices[0]!.height).toBe(0.5);
    // The fin's section there: nothing changes yet, to the fit (0.1 mm: two percent).
    const width = (d: FinDesign, h: number) => {
      const b = prepareBlade(d);
      const sec = bladeSection(b, h * b.depth, cosineStations(40));
      return sec.outside.map((p, j) => Math.abs(p.y - sec.inside[j]!.y));
    };
    for (const h of [0.4, 0.5, 0.6]) {
      const was = width(before, h);
      width(design(s), h).forEach((t, j) => expect(Math.abs(t - was[j]!)).toBeLessThan(1e-2));
    }
    expect(s.getState().activeFoil).toBe(1);
    // NACA and the inside face now act on the slice, not the root.
    expect(s.getState().applyNaca('0010')).toBe(true);
    expect(design(s).slices[0]!.section.inside).toBeNull();
    expect(design(s).section.inside).not.toBeNull();
  });

  it('drags a slice’s point without touching the root', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().applyNaca('2410');
    const root = design(s).section;
    const k = outsideAt(s, 1).knots[1]!.end;
    s.getState().beginEdit();
    s.getState().moveControlPoint('outside', 1, vec2(k.x, k.y * 0.9));
    s.getState().endEdit();
    expect(outsideAt(s, 1).knots[1]!.end.y).toBeLessThan(k.y);
    expect(design(s).section).toBe(root);
  });

  it('stores a foil far from its true thickness at it, on loading and after a drag', () => {
    // Owner testing: drags ran a tip foil down to a millionth of its thickness (the foil
    // view's stretch, read afresh at every step), and the view zoomed far out.
    const d = defaultFinDesign('side', 'right');
    const thin = (sec: FinDesign['section'], k: number) => {
      const f = (s: FinDesign['section']['outside']) =>
        splineFromKnots(
          s.knots.map((kn) => {
            const g = (p: { x: number; y: number }) => vec2(p.x, p.y * k);
            return knot(g(kn.end), g(kn.tangentToPrev), g(kn.tangentToNext), kn.continuous);
          }),
        );
      return { outside: f(sec.outside), inside: sec.inside && f(sec.inside) };
    };
    const tiny = { ...d, tipSection: thin(d.section, 1e-6) };
    const s = storeWith(tiny);
    expect(foilTrueScale(tiny, TIP_FOIL)).toBeGreaterThan(1e5);
    expect(foilTrueScale(design(s), TIP_FOIL)).toBeCloseTo(1, 6);
    // The blade as it was: only the shape counts.
    const width = (x: FinDesign, h: number) => {
      const b = prepareBlade(x);
      const sec = bladeSection(b, h * b.depth, cosineStations(30));
      return sec.outside.map((p, j) => p.y - sec.inside[j]!.y);
    };
    const was = width(tiny, 0.9);
    width(design(s), 0.9).forEach((t, j) => expect(t).toBeCloseTo(was[j]!, 8));
    // A drag that leaves it far thinner: stored at its true thickness when it ends.
    // Stored thin, but within four times of its thickness: kept so on loading.
    const s2 = storeWith({ ...d, tipSection: thin(d.section, 0.07) });
    expect(foilTrueScale(design(s2), TIP_FOIL)).toBeGreaterThan(3);
    s2.getState().setActiveFoil(TIP_FOIL);
    const tip = getFinCurve(design(s2), 'outside', TIP_FOIL)!;
    const top = tip.knots.reduce((j, kn, i) => (kn.end.y > tip.knots[j]!.end.y ? i : j), 0);
    const at = tip.knots[top]!.end;
    s2.getState().beginEdit();
    s2.getState().moveControlPoint('outside', top, vec2(at.x, at.y / 20));
    expect(foilTrueScale(design(s2), TIP_FOIL)).toBeGreaterThan(4);
    s2.getState().endEdit();
    expect(foilTrueScale(design(s2), TIP_FOIL)).toBeCloseTo(1, 6);
  });

  it('moves a slice past another, keeping it selected, as one undo step per drag', () => {
    const s = storeWith();
    s.getState().addSlice(0.3);
    s.getState().addSlice(0.7);
    s.getState().setActiveFoil(1);
    s.getState().beginEdit('Move foil slice');
    s.getState().moveSlice(1, 0.5);
    // Up to the slice above: waits just short of it.
    s.getState().moveSlice(1, 0.695);
    expect(design(s).slices.map((sl) => sl.height)).toEqual([0.7 - FIN_SLICE_MIN_GAP, 0.7]);
    // Past it: hops over, and is now the second slice, still selected.
    s.getState().moveSlice(1, 0.705);
    expect(design(s).slices.map((sl) => sl.height)).toEqual([0.7, 0.7 + FIN_SLICE_MIN_GAP]);
    expect(s.getState().activeFoil).toBe(2);
    s.getState().moveSlice(2, 0.9);
    s.getState().endEdit();
    expect(design(s).slices.map((sl) => sl.height)).toEqual([0.7, 0.9]);
    expect(validateFinDesign(design(s))).toEqual([]);
    s.getState().undo();
    expect(design(s).slices.map((sl) => sl.height)).toEqual([0.3, 0.7]);
  });

  it('keeps a moved slice clear of the root and tip', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().moveSlice(1, 1.2);
    expect(design(s).slices[0]!.height).toBe(1 - FIN_SLICE_MIN_GAP);
    s.getState().moveSlice(1, -0.3);
    expect(design(s).slices[0]!.height).toBe(FIN_SLICE_MIN_GAP);
  });

  it("takes a slice's foil with it past another", () => {
    const s = storeWith();
    s.getState().addSlice(0.3);
    s.getState().applyNaca('0008');
    s.getState().addSlice(0.7);
    const moving = design(s).slices[0]!;
    s.getState().setActiveFoil(1);
    expect(s.getState().moveSlice(1, 0.9)).toBe(true);
    const [a, b] = design(s).slices;
    expect(a!.height).toBe(0.7);
    // Its reshaping goes with it: still symmetric, the 0008 laid on the fin up there.
    expect(b!.section.inside).toBeNull();
    expect(moving.section.inside).toBeNull();
    s.getState().moveSlice(2, 0.1);
    const low = design(s).slices[0]!;
    expect(low.height).toBe(0.1);
    expect(validateFinDesign(design(s))).toEqual([]);
  });

  it('sets the panel and turns the fin in it, undoably, within limits', () => {
    const s = storeWith();
    expect(s.getState().setPanelAngle(5)).toBe(false); // no panel yet
    expect(s.getState().setPanelThickness(0.9525)).toBe(true);
    expect(design(s).panel).toEqual({ thickness: 0.9525, angle: 0 });
    s.getState().setPanelAngle(-3.456);
    expect(design(s).panel!.angle).toBe(-3.46); // to a hundredth of a degree
    s.getState().setPanelAngle(80);
    expect(design(s).panel!.angle).toBe(FIN_PANEL_MAX_ANGLE);
    s.getState().setPanelThickness(10); // clamped to 30 mm, keeping the angle
    expect(design(s).panel).toEqual({ thickness: 3, angle: FIN_PANEL_MAX_ANGLE });
    s.getState().setPanelThickness(null);
    expect(design(s).panel).toBeUndefined();
    s.getState().undo();
    expect(design(s).panel!.thickness).toBe(3);
  });

  it('tilts the panel, and fits it in one step, storing no tilt as none', () => {
    const s = storeWith();
    expect(s.getState().setPanelTilt(5)).toBe(false); // no panel yet
    s.getState().setPanelThickness(0.9525);
    expect(s.getState().setPanelTilt(-60)).toBe(true);
    expect(design(s).panel!.tilt).toBe(-FIN_PANEL_MAX_ANGLE);
    expect(s.getState().fitPanel({ angle: -1.234, tilt: 5.5 })).toBe(true);
    expect(design(s).panel).toEqual({ thickness: 0.9525, angle: -1.23, tilt: 5.5 });
    expect(s.getState().past.at(-1)?.label).toBe('Fit to panel');
    expect(s.getState().fitPanel({ angle: -1.23, tilt: 5.5 })).toBe(false); // already there
    s.getState().setPanelTilt(0);
    expect(design(s).panel).toEqual({ thickness: 0.9525, angle: -1.23 });
    s.getState().undo();
    s.getState().undo();
    expect(design(s).panel!.tilt).toBe(-FIN_PANEL_MAX_ANGLE);
  });

  it('removes a slice and goes back to the root; an undo restores it', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    expect(s.getState().removeSlice(1)).toBe(true);
    expect(design(s).slices).toHaveLength(0);
    expect(s.getState().activeFoil).toBe(0);
    s.getState().undo();
    expect(design(s).slices).toHaveLength(1);
  });

  it('falls back to the root when an undo takes the active slice away', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    expect(s.getState().activeFoil).toBe(1);
    s.getState().undo();
    expect(design(s).slices).toHaveLength(0);
    expect(s.getState().activeFoil).toBe(0);
  });

  it('switches foils, dropping a selection on the old foil’s faces', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().select({ curve: 'outside', index: 1 });
    s.getState().setActiveFoil(0);
    expect(s.getState().selection).toBeNull();
    s.getState().select({ curve: 'outline', index: 1 });
    s.getState().setActiveFoil(1);
    expect(s.getState().selection).toEqual({ curve: 'outline', index: 1 });
  });
});

describe('fin store: cant lines', () => {
  const lines = (s: ReturnType<typeof storeWith>) => design(s).cantLines ?? [];

  it('adds one at what the blade has there, selected', () => {
    const s = storeWith();
    expect(s.getState().addCantLine(0.5)).toBe(true);
    expect(lines(s)[0]).toEqual({ height: 0.5, cant: design(s).cant, toe: 0 });
    expect(s.getState().activeCantLine).toBe(1);
  });

  it('clamps its values', () => {
    const s = storeWith();
    s.getState().addCantLine(0.5);
    s.getState().setCantLine(1, { cant: -40, toe: 9 });
    expect([lines(s)[0]!.cant, lines(s)[0]!.toe]).toEqual([-20, 5]);
    expect(validateFinDesign(design(s))).toEqual([]);
  });

  it('moves between its neighbours, keeps its values, and stops short of them', () => {
    const s = storeWith();
    s.getState().addCantLine(0.3);
    s.getState().addCantLine(0.7);
    s.getState().setCantLine(1, { toe: 1 });
    s.getState().moveCantLine(1, 0.9);
    expect(lines(s)[0]!.height).toBeCloseTo(0.7 - FIN_SLICE_MIN_GAP, 9);
    expect(lines(s)[0]!.toe).toBe(1);
  });

  it('removes one, and an undo brings it back', () => {
    const s = storeWith();
    s.getState().addCantLine(0.5);
    s.getState().setCantLine(1, { toe: 1 });
    expect(s.getState().removeCantLine(1)).toBe(true);
    expect(design(s).cantLines).toBeUndefined();
    expect(s.getState().activeCantLine).toBe(0);
    s.getState().undo();
    expect(lines(s)[0]!.toe).toBe(1);
  });
});

describe('fin store: selecting several points', () => {
  const sel = (s: ReturnType<typeof storeWith>) => s.getState().selection;

  it('adds and removes points with shift-click', () => {
    const s = storeWith();
    s.getState().select({ curve: 'outline', index: 1, kind: 'end' });
    s.getState().toggleSelect({ curve: 'outline', index: 2, kind: 'end' });
    expect(sel(s)).toEqual({ curve: 'outline', index: 2, kind: 'end', also: [1] });
    s.getState().toggleSelect({ curve: 'outline', index: 1, kind: 'end' });
    expect(sel(s)).toEqual({ curve: 'outline', index: 2, kind: 'end', also: [] });
    s.getState().toggleSelect({ curve: 'outline', index: 2, kind: 'end' });
    expect(sel(s)).toBeNull();
  });

  it('keeps the group when one of it is grabbed, and drops it for another point', () => {
    const s = storeWith();
    s.getState().select({ curve: 'outline', index: 1, kind: 'end' });
    s.getState().toggleSelect({ curve: 'outline', index: 2, kind: 'end' });
    s.getState().select({ curve: 'outline', index: 1, kind: 'end' });
    expect(sel(s)).toEqual({ curve: 'outline', index: 1, kind: 'end', also: [2] });
    s.getState().select({ curve: 'outline', index: 3, kind: 'end' });
    expect(sel(s)).toEqual({ curve: 'outline', index: 3, kind: 'end' });
  });

  it('selects a handle, or a point on another curve, on its own', () => {
    const s = storeWith();
    s.getState().select({ curve: 'outline', index: 1, kind: 'end' });
    s.getState().toggleSelect({ curve: 'outline', index: 2, kind: 'next' });
    expect(sel(s)).toEqual({ curve: 'outline', index: 2, kind: 'next' });
    s.getState().toggleSelect({ curve: 'taper', index: 1, kind: 'end' });
    expect(sel(s)).toEqual({ curve: 'taper', index: 1, kind: 'end' });
  });

  it('drags the selected points the same distance the same way, as one step', () => {
    const s = storeWith();
    const a = knotAt(s, 1);
    const b = knotAt(s, 2);
    s.getState().beginEdit();
    expect(s.getState().moveControlPoints('outline', [2, 1], 2, vec2(b.x + 0.1, b.y + 0.05))).toBe(
      true,
    );
    s.getState().endEdit();
    expect(knotAt(s, 1).x).toBeCloseTo(a.x + 0.1, 12);
    expect(knotAt(s, 1).y).toBeCloseTo(a.y + 0.05, 12);
    expect(knotAt(s, 2).x).toBeCloseTo(b.x + 0.1, 12);
    expect(knotAt(s, 2).y).toBeCloseTo(b.y + 0.05, 12);
    expect(knotAt(s, 3)).toEqual(knotAt(storeWith(), 3)); // unselected: left alone
    s.getState().undo();
    expect(knotAt(s, 1)).toEqual(a);
    expect(knotAt(s, 2)).toEqual(b);
  });

  it('keeps a pinned root on the base while the rest of the group moves freely', () => {
    const s = storeWith();
    const root = knotAt(s, 0);
    const a = knotAt(s, 1);
    s.getState().moveControlPoints('outline', [1, 0], 1, vec2(a.x - 0.1, a.y + 0.2));
    expect(knotAt(s, 0)).toEqual(vec2(root.x - 0.1, 0));
    expect(knotAt(s, 1).x).toBeCloseTo(a.x - 0.1, 12);
    expect(knotAt(s, 1).y).toBeCloseTo(a.y + 0.2, 12);
  });

  it('stops the whole group together where a rule would break', () => {
    const s = storeWith();
    const root = knotAt(s, 0);
    const a = knotAt(s, 1);
    s.getState().moveControlPoints('outline', [0, 1], 0, vec2(root.x + 20, 0)); // far forward
    expect(finReadouts(design(s)).frontOverhang).toBeLessThanOrEqual(FIN_MAX_FRONT_OVERHANG + 1e-9);
    const moved = knotAt(s, 0).x - root.x;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(20);
    expect(knotAt(s, 1).x - a.x).toBeCloseTo(moved, 12);
    expect(validateFinDesign(design(s))).toEqual([]);
  });

  it('deletes all the selected points in one step', () => {
    const s = storeWith();
    const n = design(s).outline.knots.length;
    expect(n).toBeGreaterThan(4);
    s.getState().select({ curve: 'outline', index: 1, kind: 'end' });
    s.getState().toggleSelect({ curve: 'outline', index: 2, kind: 'end' });
    // The pinned roots can't go: picking one as well is ignored, not refused.
    s.getState().toggleSelect({ curve: 'outline', index: n - 1, kind: 'end' });
    const before = design(s);
    expect(s.getState().deleteSelectedPoints()).toBe(true);
    expect(design(s).outline.knots).toHaveLength(n - 2);
    expect(sel(s)).toBeNull();
    s.getState().undo();
    expect(design(s)).toBe(before);
  });
});

describe('fin store: outside / inside split', () => {
  it('splits a side fin’s foil, true to its root, and it still builds', () => {
    const s = storeWith(defaultFinDesign('side', 'left'));
    expect(s.getState().setFoilSplit(0.7)).toBe(true);
    const sec = design(s).section;
    expect(foilShare(sec)).toBeCloseTo(0.7, 5);
    // The outside radius is 70% of the root thickness, in chords.
    const r = finReadouts(design(s));
    const root = design(s).taper.knots[0]!.end.y;
    // The leading edge leaves straight up into a radius 70% of the root thickness, in chords.
    const k = sec.outside.knots;
    const radius = (0.7 * root) / r.rootChord;
    expect(Math.hypot(k[1]!.end.x / SPLIT_NOSE_ASPECT - radius, k[1]!.end.y)).toBeCloseTo(
      radius,
      9,
    );
    expect(validateFinDesign(design(s))).toEqual([]);
    expect(s.getState().past.at(-1)!.label).toBe('Foil 70 / 30');
  });

  it('leaves a centre fin symmetric', () => {
    const s = storeWith(defaultFinDesign('centre'));
    expect(s.getState().setFoilSplit(0.7)).toBe(false);
    expect(design(s).section.inside).toBeNull();
  });
});

describe('fin store: the foil sweep', () => {
  it('moves the tip line’s ends, each kept on its side of the tip, undoably', () => {
    const s = storeWith();
    const before = tipLineOf(design(s));
    s.getState().beginEdit('Move the tip line');
    expect(s.getState().setTipLineEnd('start', before.start - 0.05)).toBe(true);
    s.getState().endEdit();
    expect(design(s).tipLine!.start).toBeCloseTo(before.start - 0.05, 9);
    expect(design(s).tipLine!.end).toBeCloseTo(before.end, 9);
    // Past the tip it stops short of it. Up round the top it goes where it is put (owner
    // testing: held where the leading edge turns onto the top, it seemed frozen).
    s.getState().setTipLineEnd('start', 0.99);
    expect(design(s).tipLine!.start).toBeLessThan(tipApexFraction(design(s).outline));
    expect(design(s).tipLine!.start).toBeGreaterThan(tipTurnFraction(design(s).outline));
    s.getState().undo();
    s.getState().undo();
    expect(design(s).tipLine).toBeUndefined();
    s.getState().setTipLineEnd('end', 0.7);
    expect(s.getState().resetTipLine()).toBe(true);
    expect(design(s).tipLine).toBeUndefined();
  });

  it('moves the thickness path: its ends reshape the base and tip foils, its middle is its own', () => {
    const s = storeWith();
    // The base point is the base foil's thickest point: moving it reshapes that foil.
    expect(s.getState().setThicknessPath(0, 0.45)).toBe(true);
    expect(sectionThickest(design(s).section).at).toBeCloseTo(0.45, 2);
    expect(design(s).tipSection).toBeUndefined(); // the tip foil follows the base until set
    // The tip point reshapes the tip foil, which now stands on its own.
    s.getState().setThicknessPath(2, 0.3);
    expect(sectionThickest(design(s).tipSection!).at).toBeCloseTo(0.3, 2);
    expect(sectionThickest(design(s).section).at).toBeCloseTo(0.45, 2);
    // The middle is stored on its own, within its limits.
    s.getState().setThicknessPath(1, 0.99);
    expect(design(s).thicknessMid).toBe(FIN_THICKNESS_PATH_LIMITS.max);
    expect(thicknessPathOf(design(s))[1]).toBe(FIN_THICKNESS_PATH_LIMITS.max);
    expect(s.getState().resetThicknessPath()).toBe(true);
    expect(design(s).thicknessMid).toBeUndefined();
    // And the other way round: moving a foil's thickest point moves the path's end.
    s.getState().setFoilThickest(TIP_FOIL, 0.4);
    expect(thicknessPathOf(design(s))[2]).toBeCloseTo(0.4, 2);
    expect(s.getState().past.at(-1)!.label).toBe('Move the thickest point');
  });

  it('edits the tip foil as its own foil', () => {
    const s = storeWith();
    const base = design(s).section;
    s.getState().setActiveFoil(TIP_FOIL);
    expect(s.getState().activeFoil).toBe(TIP_FOIL);
    s.getState().applyNaca('2410');
    expect(design(s).tipSection).toBeDefined();
    expect(design(s).section).toBe(base); // the base foil is left as it was
    s.getState().undo();
    expect(design(s).tipSection).toBeUndefined();
  });
});

describe('fin store: control sections as rows', () => {
  it('adds one as the row’s own foil, and moves it with its foil', () => {
    const s = storeWith(defaultFinDesign('side', 'left'));
    expect(s.getState().addSlice(0.5)).toBe(true);
    const sl = design(s).slices[0]!;
    // The row's foil there, not the sweep's horizontal section.
    const want = smoothFoilAt({ ...design(s), slices: [] }, 0.5);
    for (const x of [0.1, 0.4, 0.8]) {
      expect(yAtX(sl.section.outside, x)).toBeCloseTo(yAtX(want.outside, x), 9);
    }
    s.getState().beginEdit('Move foil slice');
    expect(s.getState().moveSlice(1, 0.7)).toBe(true);
    s.getState().endEdit();
    expect(design(s).slices[0]!.height).toBe(0.7);
    expect(design(s).slices[0]!.section).toBe(sl.section);
  });
});

describe('fin store: scaling the profile', () => {
  const rearRoot = (d: FinDesign) => d.outline.knots[d.outline.knots.length - 1]!.end;
  const top = (d: FinDesign) => Math.max(...d.outline.knots.map((k) => k.end.y));

  it('scales every point evenly about a point on the tab top, keeping the base on it', () => {
    const s = storeWith(defaultFinDesign('centre'));
    const before = design(s);
    const about = vec2(rearRoot(before).x, 0);
    expect(s.getState().scaleOutline(0.8, about)).toBe(true);
    const after = design(s);
    after.outline.knots.forEach((k, i) => {
      const b = before.outline.knots[i]!;
      expect(k.end.x).toBeCloseTo(about.x + (b.end.x - about.x) * 0.8, 12);
      expect(k.end.y).toBeCloseTo(b.end.y * 0.8, 12);
      expect(k.tangentToNext.y).toBeCloseTo(b.tangentToNext.y * 0.8, 12);
    });
    expect(rearRoot(after).x).toBe(rearRoot(before).x);
    expect(rearRoot(after).y).toBeCloseTo(0, 12);
    expect(after.outline.knots[0]!.end.y).toBeCloseTo(0, 12);
    // Only the profile: the thickness and the foils are as they were.
    expect(after.taper).toBe(before.taper);
    expect(after.section).toBe(before.section);
  });

  it('scales from where a drag began, so moves never compound, as one undo step', () => {
    const s = storeWith(defaultFinDesign('centre'));
    const before = design(s);
    const about = vec2(rearRoot(before).x, 0);
    s.getState().beginEdit('Scale fin');
    s.getState().scaleOutline(0.9, about);
    s.getState().scaleOutline(0.7, about);
    s.getState().scaleOutline(0.8, about);
    s.getState().endEdit();
    expect(top(design(s))).toBeCloseTo(top(before) * 0.8, 9);
    expect(s.getState().past.at(-1)!.label).toBe('Scale fin');
    s.getState().undo();
    expect(design(s)).toBe(before);
  });

  it('stops growing where the leading edge reaches the front-overhang limit', () => {
    const s = storeWith(defaultFinDesign('side', 'left'));
    const before = design(s);
    s.getState().scaleOutline(2, vec2(rearRoot(before).x, 0));
    const le = design(s).outline.knots[0]!.end.x;
    expect(le).toBeGreaterThan(before.outline.knots[0]!.end.x);
    expect(validateFinDesign(design(s))).toEqual([]);
    expect(top(design(s))).toBeLessThan(top(before) * 2);
  });

  it('takes an imported profile too big for the tab, but not one that isn’t a fin', () => {
    const s = storeWith(defaultFinDesign('side', 'left'));
    const at = (pts: [number, number][]) =>
      splineFromKnots(pts.map(([x, y]) => knot(vec2(x, y), vec2(x, y), vec2(x, y), false)));
    // Twice the tab's length: overhangs the front, which scaling down puts right.
    expect(
      s.getState().importOutline(
        at([
          [24, 0],
          [14, 20],
          [0, 0],
        ]),
      ),
    ).toEqual([]);
    expect(validateFinDesign(design(s)).map((i) => i.code)).toContain('front-overhang');
    // A leading edge that turns back down partway up: refused, the fin unchanged.
    const before = design(s);
    const wrong = s.getState().importOutline(
      at([
        [10, 0],
        [7, 5],
        [8, 2],
        [4, 8],
        [0, 0],
      ]),
    );
    expect(wrong.join()).toMatch(/rising/);
    expect(design(s)).toBe(before);
  });
});
