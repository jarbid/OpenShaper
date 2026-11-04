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
  sliceTipCrossing,
  sliceTipPoint,
  tipFoilOf,
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
import { foilTrueScale, getFinCurve, tipSpanOf, TIP_FOIL } from './fin-edits';
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

  it('lets every point of a slice move, the tip’s part of its chord included', () => {
    // Owner testing: with the tip line moved forward, most of a slice's points sat in the
    // locked tip part and wouldn't move. Now the tip part is only shaded (tipSpanOf).
    const s = storeWith();
    s.getState().addSlice(0.93);
    const span = tipSpanOf(design(s), 1)!;
    expect(span[1]).toBe(1);
    const out = () => design(s).slices[0]!.section.outside;
    const past = out().knots.findIndex((k, i) => i > 0 && k.end.x >= span[0] - 1e-6);
    expect(past).toBeGreaterThan(0);
    const k = out().knots[past]!.end;
    expect(s.getState().moveControlPoint('outside', past, vec2(k.x, k.y * 0.8))).toBe(true);
    expect(s.getState().addControlPoint('outside', vec2((span[0] + 1) / 2, 0.005))).toBe(true);
  });

  it('puts a point where a new slice crosses the tip line, in both foils, shapes unchanged', () => {
    const s = storeWith();
    const tipBefore = tipFoilOf(design(s));
    s.getState().addSlice(0.93);
    const c = sliceTipCrossing(design(s), 0)!;
    const tip = tipFoilOf(design(s));
    expect(tip.outside.knots.some((k) => Math.abs(k.end.x - c.tipAt) < 0.01)).toBe(true);
    const slice = design(s).slices[0]!.section;
    expect(slice.outside.knots.some((k) => Math.abs(k.end.x - c.sliceAt) < 0.01)).toBe(true);
    for (const u of [0.1, 0.3, c.tipAt, 0.8]) {
      expect(yAtX(tip.outside, u)).toBeCloseTo(yAtX(tipBefore.outside, u), 9);
    }
    // And the two dots agree on an unedited slice: each is the fin there.
    expect(c.tipInSlice.outside).toBeCloseTo(yAtX(slice.outside, c.sliceAt), 3);
    expect(c.sliceInTip.outside).toBeCloseTo(yAtX(tip.outside, c.tipAt), 2);
    expect(s.getState().past).toHaveLength(1); // one step: the slice and its points
  });

  it('marks a new crossing when a drag moves the tip line', () => {
    const s = storeWith();
    s.getState().addSlice(0.93);
    const before = tipLineOf(design(s));
    s.getState().beginEdit('Move the tip line');
    s.getState().setTipLineEnd('end', before.end + 0.02); // lower down the trailing edge
    s.getState().endEdit();
    const c = sliceTipCrossing(design(s), 0)!;
    const tip = tipFoilOf(design(s));
    expect(tip.outside.knots.some((k) => Math.abs(k.end.x - c.tipAt) < 0.01)).toBe(true);
    s.getState().undo();
    expect(tipLineOf(design(s)).end).toBeCloseTo(before.end, 9); // one undo step
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
    width(design(s), 0.9).forEach((t, j) => expect(t).toBeCloseTo(was[j]!, 9));
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

  it('takes the old crossing point out when the crossing moves, unless it was dragged', () => {
    // Owner testing: each tip line or slice drag left a point at the crossing it had, three
    // or four of them a few percent apart in the tip foil.
    const s = storeWith();
    s.getState().addSlice(0.93);
    const count = () => tipFoilOf(design(s)).outside.knots.length;
    const shape = tipFoilOf(design(s));
    const n = count();
    const end = tipLineOf(design(s)).end;
    for (const step of [0.02, 0.04]) {
      s.getState().beginEdit('Move the tip line');
      s.getState().setTipLineEnd('end', end + step);
      s.getState().endEdit();
      const c = sliceTipCrossing(design(s), 0)!;
      const tip = tipFoilOf(design(s));
      expect(tip.outside.knots.some((k) => Math.abs(k.end.x - c.tipAt) < 0.01)).toBe(true);
      expect(count()).toBe(n); // the new point, and the old one out
      for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        expect(yAtX(tip.outside, u)).toBeCloseTo(yAtX(shape.outside, u), 9);
      }
    }
    // Dragged, the crossing point stays when the crossing moves on.
    const c = sliceTipCrossing(design(s), 0)!;
    s.getState().setActiveFoil(TIP_FOIL);
    const i = tipFoilOf(design(s)).outside.knots.findIndex(
      (k) => Math.abs(k.end.x - c.tipAt) < 0.01,
    );
    const k = tipFoilOf(design(s)).outside.knots[i]!.end;
    expect(s.getState().moveControlPoint('outside', i, vec2(k.x, k.y * 1.05))).toBe(true);
    s.getState().beginEdit('Move the tip line');
    s.getState().setTipLineEnd('end', end + 0.06);
    s.getState().endEdit();
    expect(count()).toBe(n + 1);
  }, 60_000); // four drags of real geometry: 5 s here, far more on a loaded CI runner

  it('drags a new slice up into the tip as the fin’s section there, not the one it was added with', () => {
    // Owner testing: added halfway up and dragged to 93 mm, the slice carried the section
    // from halfway up, its point on the tip line well off its foil.
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().beginEdit('Move foil slice');
    const t0 = performance.now();
    for (const h of [0.6, 0.7, 0.8, 0.9, 0.93]) s.getState().moveSlice(1, h);
    const perStep = (performance.now() - t0) / 5;
    s.getState().endEdit();
    expect(design(s).slices[0]!.height).toBe(0.93);
    const tp = sliceTipPoint(design(s), 0)!;
    const sec = design(s).slices[0]!.section;
    expect(yAtX(sec.outside, tp.at)).toBeCloseTo(tp.outside, 3);
    expect(s.getState().past).toHaveLength(2); // add, and one drag
    expect(perStep).toBeLessThan(2000); // a drag step stays usable
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

  it("takes a slice's foil and twist with it past another", () => {
    const s = storeWith();
    s.getState().addSlice(0.3);
    s.getState().applyNaca('0008');
    s.getState().setSliceTwist(1, { cant: 12 });
    s.getState().addSlice(0.7);
    const moving = design(s).slices[0]!;
    s.getState().setActiveFoil(1);
    expect(s.getState().moveSlice(1, 0.9)).toBe(true);
    const [a, b] = design(s).slices;
    expect(a!.height).toBe(0.7);
    // Its reshaping goes with it: still symmetric, the 0008 laid on the fin up there.
    expect(b!.section.inside).toBeNull();
    expect(moving.section.inside).toBeNull();
    expect(b!.twist).toEqual(moving.twist);
    s.getState().moveSlice(2, 0.1);
    const low = design(s).slices[0]!;
    expect(low.height).toBe(0.1);
    expect(low.twist).toEqual(moving.twist);
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

describe('fin store: a slice’s cant and toe', () => {
  it('starts a change from what the blade has there', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    expect(s.getState().setSliceTwist(1, { cant: 12 })).toBe(true);
    const tw = design(s).slices[0]!.twist!;
    expect(tw.cant).toBe(12);
    expect(tw.toe).toBe(0); // the fin's toe, unchanged
    expect(Object.keys(tw).sort()).toEqual(['cant', 'toe']);
  });

  it('clamps its values', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().setSliceTwist(1, { cant: -40, toe: 9 });
    const tw = design(s).slices[0]!.twist!;
    expect([tw.cant, tw.toe]).toEqual([-20, 5]);
    expect(validateFinDesign(design(s))).toEqual([]);
  });

  it('drops the change, and an undo brings it back', () => {
    const s = storeWith();
    s.getState().addSlice(0.5);
    s.getState().setSliceTwist(1, { toe: 1 });
    s.getState().setSliceTwist(1, null);
    expect(design(s).slices[0]!.twist).toBeUndefined();
    s.getState().undo();
    expect(design(s).slices[0]!.twist!.toe).toBe(1);
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
