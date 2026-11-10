// SPDX-License-Identifier: GPL-3.0-or-later
/** The fin's base: Futures, FCS, US box and Gbox tabs (fin-tab.ts). */
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import type { BoardMesh } from '../tessellate';
import { vec2 } from '../vec2';
import { defaultCanard, defaultFinDesign, defaultSingleFin } from './fin-defaults';
import { finHasToe } from './fin-design';
import { finReadouts } from './fin-readouts';
import { finMesh } from './fin-mesh';
import { leadingRootRange, nudgeFore, placeOnBase, tabCentreY } from './fin-placement';
import { validateFinDesign } from './fin-rules';
import {
  FCS1_BASE,
  FCS_SINGLE_TAB,
  FIN_BASES,
  GBOX_TAB,
  US_BOX_HEAD,
  gboxNotchHeight,
  finTabOutline,
  futuresKind,
  usBoxHeadLength,
} from './fin-tab';
import { FUTURES_TABS } from './futures-tab';

/** Every directed edge once, and its reverse once: closed and consistently wound. */
const closedAndOriented = (m: BoardMesh): boolean => {
  const directed = new Map<string, number>();
  for (let i = 0; i < m.indices.length; i += 3) {
    const t = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
    for (let k = 0; k < 3; k++) {
      const key = `${t[k]},${t[(k + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(',');
    if (count !== 1 || directed.get(`${b},${a}`) !== 1) return false;
  }
  return true;
};

const canard = () => placeOnBase(defaultFinDesign('side', 'left'), 'fcs-single');

describe('finTabOutline', () => {
  it('is the Futures tab for a Futures base', () => {
    expect(finTabOutline('futures-side').height).toBe(FUTURES_TABS.side.height);
    expect(finTabOutline('futures-centre').height).toBe(FUTURES_TABS.centre.height);
  });

  it('is a plain 20.5 × 13.5 × 6.35 mm block for the FCS single tab', () => {
    const t = finTabOutline('fcs-single');
    expect([t.length, t.height, t.thickness]).toEqual([2.05, 1.35, 0.635]);
    expect(t.parts).toHaveLength(1);
    expect(t.parts[0]!.segments).toHaveLength(4);
    // Closed and counter-clockwise: positive signed area, equal to length × height.
    let area = 0;
    for (const s of t.parts[0]!.segments) area += s.from.x * s.to.y - s.to.x * s.from.y;
    expect(area / 2).toBeCloseTo(FCS_SINGLE_TAB.length * FCS_SINGLE_TAB.height, 12);
  });

  it('names a Futures kind only for the Futures bases', () => {
    expect(FIN_BASES.map(futuresKind)).toEqual(['side', 'centre', null, null, null, null]);
  });
});

describe('a fin on an FCS single tab', () => {
  it('starts centred over the tab, with no cant, and breaks no rule', () => {
    const d = canard();
    const k = d.outline.knots;
    const mid = (k[0]!.end.x + k[k.length - 1]!.end.x) / 2;
    expect(mid).toBeCloseTo(FCS_SINGLE_TAB.length / 2, 12);
    expect(d.cant).toBe(0);
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('keeps a flat inside face flush with the tab', () => {
    const d = canard();
    expect(tabCentreY(d)).toBeCloseTo(FCS_SINGLE_TAB.thickness / 2, 12); // left fin: +Y
  });

  it('has no cant: the plug carries it', () => {
    const codes = validateFinDesign({ ...canard(), cant: 5 }).map((i) => i.code);
    expect(codes).toContain('cant');
  });

  it('needs the tab wholly under the base, but has no Futures overhang or clearance rule', () => {
    const d = canard();
    const { min, max } = leadingRootRange(d);
    // The leading-edge root may run from the tab's front to a root chord ahead of it.
    expect(min).toBeCloseTo(FCS_SINGLE_TAB.length, 12);
    const k = d.outline.knots;
    expect(max).toBeCloseTo(k[0]!.end.x - k[k.length - 1]!.end.x, 12);
  });

  it('nudges fore and aft only as far as keeps the tab covered', () => {
    let d = canard();
    for (let i = 0; i < 200; i++) d = nudgeFore(d, 0.5);
    const k = () => d.outline.knots;
    expect(k()[k().length - 1]!.end.x).toBeCloseTo(0, 9); // trailing-edge root on the tab's rear end
    expect(validateFinDesign(d)).toEqual([]);
    for (let i = 0; i < 200; i++) d = nudgeFore(d, -0.5);
    expect(k()[0]!.end.x).toBeCloseTo(FCS_SINGLE_TAB.length, 9); // leading-edge root on its front
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('meshes the FCS tab as a closed block under the blade', () => {
    const m = finMesh(canard());
    expect(closedAndOriented(m.tab)).toBe(true);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < m.tab.positions.length; i += 3) {
      lo = Math.min(lo, m.tab.positions[i]!);
      hi = Math.max(hi, m.tab.positions[i]!);
    }
    expect(hi - lo).toBeCloseTo(FCS_SINGLE_TAB.length, 6); // positions are 32-bit
  });

  it('goes back to a Futures tab rear-aligned, cant free again', () => {
    const d = placeOnBase(canard(), 'futures-side');
    const k = d.outline.knots;
    expect(k[k.length - 1]!.end.x).toBeCloseTo(0, 12);
    expect(d.base).toBe('futures-side');
  });
});

describe('the starting canard', () => {
  it.each(['left', 'right'] as const)(
    'is a valid %s fin on the FCS tab, centred, no cant',
    (hand) => {
      const d = defaultCanard(hand);
      expect(validateFinDesign(d)).toEqual([]);
      expect(d.base).toBe('fcs-single');
      expect(d.cant).toBe(0);
      expect(d.hand).toBe(hand);
      const k = d.outline.knots;
      expect((k[0]!.end.x + k[k.length - 1]!.end.x) / 2).toBeCloseTo(FCS_SINGLE_TAB.length / 2, 9);
    },
  );

  it('is the owner’s canard: 69.3 mm at the base, 80.6 mm deep, 8 mm thick at the root', () => {
    const r = finReadouts(defaultCanard());
    expect(r.rootChord * 10).toBeCloseTo(69.26, 1);
    expect(r.depth * 10).toBeCloseTo(80.6, 0);
    expect(defaultCanard().taper.knots[0]!.end.y).toBeCloseTo(0.8, 12);
  });

  it('meshes as closed shells', () => {
    const m = finMesh(defaultCanard('right'));
    expect(closedAndOriented(m.blade)).toBe(true);
    expect(closedAndOriented(m.tab)).toBe(true);
  });
});

describe('the FCS 1 base', () => {
  const t = finTabOutline('fcs-1');
  const { tabLength: l, gap, height: H, cornerRadius: r } = FCS1_BASE;
  const signedArea = (segs: (typeof t.parts)[number]['segments']) => {
    // Lines exactly; each quarter-circle corner adds its bulge beyond the chord.
    let a = 0;
    for (const s of segs) {
      a += (s.from.x * s.to.y - s.to.x * s.from.y) / 2;
      if (s.kind === 'arc') a += (s.radius * s.radius * (Math.PI / 2 - 1)) / 2;
    }
    return a;
  };

  it('is two 20.5 × 13.5 × 6.35 mm tabs, 33 mm apart: 74 mm overall', () => {
    expect(t.length).toBeCloseTo(7.4, 12);
    expect([t.height, t.thickness]).toEqual([1.35, 0.635]);
    expect(t.parts).toHaveLength(2);
    const xs = t.parts.map((p) => p.segments.flatMap((s) => [s.from.x, s.to.x]));
    expect([Math.min(...xs[0]!), Math.max(...xs[0]!)]).toEqual([0, l]);
    expect([Math.min(...xs[1]!), Math.max(...xs[1]!)]).toEqual([l + gap, 2 * l + gap]);
    for (const p of t.parts) expect(p.holes).toEqual([]);
  });

  it('rounds each tab’s two lower corners to 1.5 mm, and is closed counter-clockwise', () => {
    for (const p of t.parts) {
      const arcs = p.segments.filter((s) => s.kind === 'arc');
      expect(arcs).toHaveLength(2);
      for (const a of arcs) expect(a.radius).toBe(r);
      // Each segment starts where the last ended.
      p.segments.forEach((s, i) => {
        const prev = p.segments[(i + p.segments.length - 1) % p.segments.length]!;
        expect(s.from).toEqual(prev.to);
      });
      expect(signedArea(p.segments)).toBeCloseTo(l * H - 2 * r * r * (1 - Math.PI / 4), 12);
    }
  });

  it('places a fin from the back: its trailing edge 20.5 mm behind the rear tab, no cant', () => {
    const d = placeOnBase(defaultFinDesign('side', 'left'), 'fcs-1');
    const knots = d.outline.knots;
    expect(knots[knots.length - 1]!.end.x).toBeCloseTo(-FCS1_BASE.rearBlade, 12);
    expect(d.cant).toBe(0);
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('brings a fin too short for that forward, just enough to cover the front tab', () => {
    const d = placeOnBase(defaultFinDesign('quad-rear', 'left'), 'fcs-1');
    expect(d.outline.knots[0]!.end.x).toBeCloseTo(t.length, 12);
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('asks for both tabs under the base of a fin too short to cover them', () => {
    const d = placeOnBase(defaultCanard('left'), 'fcs-1');
    expect(validateFinDesign(d).map((i) => i.message)).toContain(
      'Both tabs must sit wholly under the fin’s base.',
    );
  });

  it('meshes each tab as its own closed shell, spanning the base', () => {
    const m = finMesh(placeOnBase(defaultFinDesign('side', 'left'), 'fcs-1')).tab;
    const xs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) xs.push(m.positions[i]!);
    // Positions are stored as 32-bit floats.
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(t.length, 6);
    // Nothing in the gap between the tabs.
    expect(xs.some((x) => x > l + 1e-6 && x < l + gap - 1e-6)).toBe(false);
    // Closed: every edge is shared by exactly two triangles.
    const edges = new Map<string, number>();
    for (let i = 0; i < m.indices.length; i += 3) {
      const tri = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!;
        const b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
  });
});

describe('the Gbox base', () => {
  const t = finTabOutline('gbox');
  const segs = t.parts[0]!.segments;
  const mm = (cm: number) => cm * 10;

  // The drawing's inch figures (millimetres in brackets on it are rounded).
  it('is one 2 7/8" × 17/32" × 1/4" block', () => {
    expect(mm(t.length)).toBeCloseTo(73.025, 9);
    expect(mm(t.height)).toBeCloseTo(13.494, 3);
    expect(mm(t.thickness)).toBeCloseTo(6.35, 9);
    expect(t.parts).toHaveLength(1);
    expect(t.parts[0]!.holes).toEqual([]);
    expect(t.rear).toBe(0);
  });

  it('has a 7/8" hole-saw notch, centred, reaching 5/16" up into the underside', () => {
    const arcs = segs.filter((s) => s.kind === 'arc');
    expect(arcs).toHaveLength(1);
    const a = arcs[0]!;
    if (a.kind !== 'arc') throw new Error('arc expected');
    expect(mm(a.radius * 2)).toBeCloseTo(22.225, 9);
    expect(a.center.x).toBeCloseTo(t.length / 2, 12);
    expect(mm(-a.center.y)).toBeCloseTo(3.175, 9); // 1/8" below the bottom
    expect(mm(gboxNotchHeight())).toBeCloseTo(7.9375, 9); // 5/16"
    // Its feet are on the bottom, symmetric about the middle.
    expect(a.from.y).toBe(0);
    expect(a.to.y).toBe(0);
    expect(a.from.x + a.to.x).toBeCloseTo(t.length, 12);
    expect(a.ccw).toBe(false); // over the top of the circle: material stays above
  });

  it('is closed, each segment starting where the last ended', () => {
    segs.forEach((s, i) => expect(s.from).toEqual(segs[(i + segs.length - 1) % segs.length]!.to));
  });

  it('places a fin from the back: its trailing edge 13/16" behind the tab, no cant', () => {
    const d = placeOnBase(defaultFinDesign('side', 'left'), 'gbox');
    const knots = d.outline.knots;
    expect(mm(-knots[knots.length - 1]!.end.x)).toBeCloseTo(20.6375, 9);
    expect(d.cant).toBe(0);
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('says the box sets the cant', () => {
    const d = { ...placeOnBase(defaultFinDesign('side', 'left'), 'gbox'), cant: 5 };
    expect(validateFinDesign(d).map((i) => i.message)).toContain(
      'In a Gbox the box sets the cant: the fin has none.',
    );
  });

  it('brings a fin too short for that forward, just enough to cover the tab', () => {
    const d = placeOnBase(defaultFinDesign('quad-rear', 'left'), 'gbox');
    const k = d.outline.knots;
    // The default quad-rear's base is shorter than the tab plus the 13/16" overhang.
    expect(k[0]!.end.x - k[k.length - 1]!.end.x).toBeLessThan(t.length + GBOX_TAB.rearBlade);
    expect(k[0]!.end.x).toBeCloseTo(t.length, 12);
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('asks for the tab under the base of a fin too short to cover it', () => {
    const d = placeOnBase(defaultCanard('left'), 'gbox');
    expect(validateFinDesign(d).map((i) => i.message)).toContain(
      'The tab must sit wholly under the fin’s base.',
    );
  });

  it('meshes as one closed shell, with nothing in the notch', () => {
    const m = finMesh(placeOnBase(defaultFinDesign('side', 'left'), 'gbox')).tab;
    expect(closedAndOriented(m)).toBe(true);
    const { notchRadius: r, notchCentreBelow: c } = GBOX_TAB;
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i]!;
      expect(x).toBeGreaterThan(-1e-5);
      expect(x).toBeLessThan(t.length + 1e-5);
    }
    // Every vertex is outside the hole saw's circle (or on it), in the tab's own frame.
    const z0 = Math.min(...Array.from(m.positions).filter((_, i) => i % 3 === 2));
    for (let i = 0; i < m.positions.length; i += 3) {
      const dx = m.positions[i]! - t.length / 2;
      const dz = m.positions[i + 2]! - z0 + c;
      expect(Math.hypot(dx, dz)).toBeGreaterThan(r - 1e-4);
    }
  });
});

describe('the US box base', () => {
  const single = defaultSingleFin();
  const { noseAhead, rearStub, height, thickness, minLength, maxLength } = US_BOX_HEAD;
  const shift = (d: typeof single, dx: number): typeof single => ({
    ...d,
    outline: splineFromKnots(
      d.outline.knots.map((k) =>
        knot(
          vec2(k.end.x + dx, k.end.y),
          vec2(k.tangentToPrev.x + dx, k.tangentToPrev.y),
          vec2(k.tangentToNext.x + dx, k.tangentToNext.y),
          k.continuous,
        ),
      ),
    ),
  });
  const ends = (d: typeof single) => {
    const k = d.outline.knots;
    return { le: k[0]!.end.x, te: k[k.length - 1]!.end.x };
  };

  it('is a 25 mm deep, 9.6 mm thick head whose front follows the fin', () => {
    const t = finTabOutline('us-box', single.outline);
    const { le, te } = ends(single);
    expect([t.height, t.thickness]).toEqual([height, thickness]);
    expect(t.parts).toHaveLength(1);
    // Front: the nose ahead of the leading edge; rear: fixed at 0, the usual stub behind
    // the starting fin's trailing edge.
    expect(t.rear + t.length).toBeCloseTo(le + noseAhead, 12);
    expect(t.rear).toBe(0);
    expect(te).toBeCloseTo(rearStub, 12);
  });

  it('is never under 160 mm, and over 240 mm breaks a rule', () => {
    expect(usBoxHeadLength(5)).toBe(minLength);
    expect(usBoxHeadLength(15)).toBeCloseTo(15 + noseAhead, 12);
    const long = shift(single, maxLength - noseAhead - ends(single).le + 0.5);
    expect(validateFinDesign(long).map((i) => i.code)).toEqual(['head-length']);
  });

  it('has the drawing’s profile: closed, counter-clockwise, scoop and rear corner', () => {
    const p = finTabOutline('us-box', single.outline).parts[0]!;
    p.segments.forEach((s, i) => {
      const prev = p.segments[(i + p.segments.length - 1) % p.segments.length]!;
      expect(s.from.x).toBeCloseTo(prev.to.x, 12);
      expect(s.from.y).toBeCloseTo(prev.to.y, 12);
    });
    const arcs = p.segments.filter((s) => s.kind === 'arc');
    expect(arcs.map((a) => [a.radius, a.ccw])).toEqual([
      [US_BOX_HEAD.scoopRadius, false], // concave: material outside
      [US_BOX_HEAD.rearRadius, true],
    ]);
    // The nose is half the depth.
    const nose = p.segments.find(
      (s) =>
        s.kind === 'line' && s.from.y === US_BOX_HEAD.noseDepth && s.to.y === US_BOX_HEAD.noseDepth,
    );
    expect(nose).toBeDefined();
  });

  it('has the 4.5 mm screw hole down through the nose, just ahead of the blade', () => {
    const t = finTabOutline('us-box', single.outline);
    const [b] = t.parts[0]!.bores!;
    const { le } = ends(single);
    expect(b!.radius * 2).toBeCloseTo(0.45, 12);
    expect([b!.from, b!.to]).toEqual([US_BOX_HEAD.noseDepth, height]);
    expect(b!.x - b!.radius).toBeGreaterThan(le); // clear of the leading edge
    expect(b!.x + b!.radius).toBeLessThan(t.rear + t.length); // inside the nose
  });

  it('starts the Single fin 8" deep, symmetric, with no cant, breaking no rule', () => {
    const r = finReadouts(single);
    expect(r.depth).toBeCloseTo(20.32, 9);
    expect(single.section.inside).toBeNull();
    expect([single.position, single.hand, single.cant, single.base]).toEqual([
      'centre',
      null,
      0,
      'us-box',
    ]);
    expect(validateFinDesign(single)).toEqual([]);
  });

  it('moves any fin onto it without a rule to break, and without cant', () => {
    for (const d of [defaultFinDesign('centre'), defaultFinDesign('side', 'left')]) {
      const moved = placeOnBase(d, 'us-box');
      expect(moved.cant).toBe(0);
      expect(finTabOutline('us-box', moved.outline).rear).toBeCloseTo(0, 12);
      expect(validateFinDesign(moved).map((i) => i.code)).not.toContain('tab-cover');
    }
  });

  it('slides the blade along the head: back to its rear end, forward to 240 mm', () => {
    const back = nudgeFore(single, -10);
    expect(ends(back).te).toBeCloseTo(0, 12); // the trailing-edge root on the rear end
    expect(finTabOutline('us-box', back.outline).rear).toBe(0);
    expect(validateFinDesign(back)).toEqual([]);
    const fwd = nudgeFore(single, 10);
    expect(ends(fwd).le + noseAhead).toBeCloseTo(maxLength, 12);
    expect(validateFinDesign(fwd)).toEqual([]);
    // A small step moves both ends of the blade, and the head's front with it.
    const step = nudgeFore(single, 0.05);
    expect(ends(step).te - ends(single).te).toBeCloseTo(0.05, 12);
    const t = finTabOutline('us-box', step.outline);
    expect(t.rear + t.length).toBeCloseTo(ends(step).le + noseAhead, 12);
  });

  it('says so when the blade slides off the back of the head', () => {
    expect(validateFinDesign(shift(single, -ends(single).te - 0.1)).map((i) => i.code)).toEqual([
      'tab-rear',
    ]);
  });

  it('meshes as one closed shell, with the screw hole through it', () => {
    const m = finMesh(single).tab;
    const edges = new Map<string, number>();
    for (let i = 0; i < m.indices.length; i += 3) {
      const tri = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!;
        const b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
    // Inside the hole there is no material: no vertex nearer its axis than the radius.
    const [b] = finTabOutline('us-box', single.outline).parts[0]!.bores!;
    const yc = tabCentreY(single);
    for (let i = 0; i < m.positions.length; i += 3) {
      const r = Math.hypot(m.positions[i]! - b!.x, m.positions[i + 1]! - yc);
      expect(r).toBeGreaterThan(b!.radius - 1e-5);
    }
  });
});

describe('toe', () => {
  it('is off for centre fins and fins in a US box, and on for the rest', () => {
    expect(finHasToe(defaultFinDesign('centre'))).toBe(false);
    expect(finHasToe(defaultSingleFin())).toBe(false);
    expect(finHasToe(placeOnBase(defaultFinDesign('side', 'left'), 'us-box'))).toBe(false);
    expect(finHasToe(defaultFinDesign('side', 'left'))).toBe(true);
    expect(finHasToe(defaultFinDesign('quad-rear', 'left'))).toBe(true);
  });

  it('is a broken rule on a fin that has none', () => {
    expect(
      validateFinDesign({ ...defaultFinDesign('centre'), toe: 1 }).map((i) => i.message),
    ).toEqual(['A centre fin has no toe.']);
    const side = placeOnBase({ ...defaultFinDesign('side', 'left'), toe: 2 }, 'us-box');
    expect(side.toe).toBe(0); // moving onto a US box clears it
  });
});
