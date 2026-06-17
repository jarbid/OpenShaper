// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fin model tests. This is a NEW, parametric model (not a port of the legacy 9-double
 * array — see docs/specs/divergences.md), so placement is pinned ANALYTICALLY here:
 * inset-from-rail coupling, surface coupling, toe geometry, tail-end detection. The
 * system box dimensions are pinned as a small golden so a hardware refit is deliberate.
 */
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_BOX,
  buildFinBladeMesh,
  board,
  crossSection,
  defaultFinConfig,
  finTemplate,
  getRockerAtPos,
  getWidthAtPos,
  knot,
  mirrorFinIndex,
  noFins,
  resolveFins,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from './index';

// A board with the TAIL clearly at x=0 (wider) and the nose tapering to a point at x=L.
function makeBoard(widthScale = 1): BezierBoard {
  const outline = splineFromKnots([
    knot(vec2(0, 14 * widthScale), vec2(-5, 14 * widthScale), vec2(20, 15 * widthScale), true),
    knot(vec2(100, 16 * widthScale), vec2(70, 16 * widthScale), vec2(130, 16 * widthScale), true),
    knot(vec2(200, 0), vec2(180, 0), vec2(210, 0), true),
  ]);
  const bottom = splineFromKnots([
    knot(vec2(0, 4), vec2(-5, 4), vec2(20, 3), true),
    knot(vec2(100, 0), vec2(70, 0), vec2(130, 0), true),
    knot(vec2(200, 9), vec2(180, 6), vec2(210, 9), true),
  ]);
  const deck = splineFromKnots([
    knot(vec2(0, 7), vec2(-5, 7), vec2(20, 8), true),
    knot(vec2(100, 12), vec2(70, 12), vec2(130, 12), true),
    knot(vec2(200, 9), vec2(180, 9), vec2(210, 9), true),
  ]);
  const dummy = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(0.1, 0), true),
    knot(vec2(0.1, 0.1), vec2(0.1, 0.05), vec2(0.1, 0.1), true),
  ]);
  return board(outline, bottom, deck, [crossSection(0, dummy), crossSection(200, dummy)]);
}

describe('defaultFinConfig', () => {
  it('builds the expected fin count per setup', () => {
    expect(defaultFinConfig('none', 'fcs-ii').fins).toHaveLength(0);
    expect(defaultFinConfig('single', 'fcs-ii').fins).toHaveLength(1);
    expect(defaultFinConfig('twin', 'fcs-ii').fins).toHaveLength(2);
    expect(defaultFinConfig('thruster', 'fcs-ii').fins).toHaveLength(3);
    expect(defaultFinConfig('quad', 'fcs-ii').fins).toHaveLength(4);
    expect(defaultFinConfig('2+1', 'fcs-ii').fins).toHaveLength(3);
    expect(defaultFinConfig('5-fin', 'fcs-ii').fins).toHaveLength(5);
  });

  it('thruster = 2 side fins (mirrored) + 1 center fin', () => {
    const { fins } = defaultFinConfig('thruster', 'futures');
    const sides = fins.filter((f) => f.side !== 0);
    const centers = fins.filter((f) => f.side === 0);
    expect(sides.map((f) => f.side).sort()).toEqual([-1, 1]);
    expect(centers).toHaveLength(1);
    expect(centers[0]!.insetFromRail).toBe(0);
  });

  it('defaults to symmetrical', () => {
    expect(defaultFinConfig('thruster', 'fcs-ii').symmetrical).toBe(true);
    expect(noFins().symmetrical).toBe(true);
  });

  it('assigns the blade profile per role (single → pivot, twin → raked, thruster sides → performance)', () => {
    expect(defaultFinConfig('single', 'fcs-ii').fins[0]!.profile).toBe('pivot');
    expect(defaultFinConfig('twin', 'fcs-ii').fins.every((f) => f.profile === 'raked')).toBe(true);
    const thruster = defaultFinConfig('thruster', 'fcs-ii').fins;
    expect(thruster.filter((f) => f.side !== 0).every((f) => f.profile === 'performance')).toBe(
      true,
    );
    expect(defaultFinConfig('2+1', 'fcs-ii').fins.find((f) => f.side === 0)!.profile).toBe('pivot');
  });

  it('mirrorFinIndex pairs adjacent opposite-side fins; center fins have no mirror', () => {
    const { fins } = defaultFinConfig('thruster', 'fcs-ii'); // [port, starboard, center]
    expect(mirrorFinIndex(fins, 0)).toBe(1);
    expect(mirrorFinIndex(fins, 1)).toBe(0);
    expect(mirrorFinIndex(fins, 2)).toBeNull(); // center
  });
});

describe('resolveFins', () => {
  it('returns nothing for the empty config', () => {
    expect(resolveFins(makeBoard(), noFins())).toEqual([]);
    expect(resolveFins(makeBoard())).toEqual([]); // board defaults to noFins()
  });

  it('places a center fin on the stringer at the trailing distance from the tail', () => {
    const b = makeBoard();
    const cfg = defaultFinConfig('single', 'futures');
    const [fin] = resolveFins(b, cfg);
    const spec = cfg.fins[0]!;
    expect(fin!.center.y).toBeCloseTo(0, 9);
    // Tail at x=0, nose at +x: trailing edge (aft, toward tail) sits at trailingFromTail.
    expect(fin!.baseLine.aft.x).toBeCloseTo(spec.trailingFromTail, 6);
    expect(fin!.surfaceZ).toBeCloseTo(getRockerAtPos(b, fin!.center.x), 9);
  });

  it('insets side fins from the rail edge, mirrored across the stringer', () => {
    const b = makeBoard();
    const cfg = defaultFinConfig('twin', 'fcs-ii');
    const fins = resolveFins(b, cfg);
    const port = fins.find((f) => f.side === -1)!;
    const star = fins.find((f) => f.side === 1)!;
    const railHalf = getWidthAtPos(b, star.center.x) / 2;
    expect(star.center.y).toBeCloseTo(railHalf - cfg.fins[0]!.insetFromRail, 6);
    expect(port.center.y).toBeCloseTo(-star.center.y, 6);
  });

  it('follows the outline: widening the plan-shape moves side fins outward', () => {
    const narrow = resolveFins(makeBoard(1), defaultFinConfig('twin', 'fcs-ii'));
    const wide = resolveFins(makeBoard(1.5), defaultFinConfig('twin', 'fcs-ii'));
    const ny = narrow.find((f) => f.side === 1)!.center.y;
    const wy = wide.find((f) => f.side === 1)!.center.y;
    expect(wy).toBeGreaterThan(ny);
  });

  it('toes side fins in: the fore (nose-side) end is nearer the stringer than the aft end', () => {
    const b = makeBoard();
    const [fin] = resolveFins(b, defaultFinConfig('twin', 'fcs-ii')); // starboard or port
    expect(Math.abs(fin!.baseLine.fore.y)).toBeLessThan(Math.abs(fin!.baseLine.aft.y));
  });

  it('detects the tail end regardless of x-orientation (mirrored board)', () => {
    const b = makeBoard();
    // Mirror x so the tail is now at the high-x end.
    const len = 200;
    const mirror = (s: BezierBoard['outline']) =>
      splineFromKnots(
        [...s.knots]
          .map((k) =>
            knot(
              vec2(len - k.end.x, k.end.y),
              vec2(len - k.tangentToNext.x, k.tangentToNext.y),
              vec2(len - k.tangentToPrev.x, k.tangentToPrev.y),
              k.continuous,
              k.other,
            ),
          )
          .reverse(),
      );
    const mb = board(mirror(b.outline), mirror(b.bottom), mirror(b.deck), b.crossSections);
    const cfg = defaultFinConfig('single', 'futures');
    const [fin] = resolveFins(mb, cfg);
    // Trailing edge should sit `trailingFromTail` from the (now high-x) tail.
    expect(len - fin!.center.x).toBeCloseTo(
      cfg.fins[0]!.trailingFromTail + cfg.fins[0]!.base / 2,
      4,
    );
  });
});

describe('SYSTEM_BOX (golden hardware dimensions, cm)', () => {
  const footprints = (sys: 'futures' | 'fcs-ii' | 'fcs-x2') => {
    const g = SYSTEM_BOX[sys];
    return g.kind === 'shapes' ? g.footprints : [];
  };

  it('glass-on routes nothing', () => {
    expect(SYSTEM_BOX['glass-on']).toEqual({ kind: 'none' });
  });

  it('Futures is one continuous box ≈ 4.5" × 5/16"', () => {
    const fp = footprints('futures');
    expect(fp).toHaveLength(1);
    expect(fp[0]!.shape).toEqual({ kind: 'rect', length: 4.5 * 2.54, width: 0.3125 * 2.54 });
  });

  it('FCS II is two slots (an "8") — a longer front slot + a shorter rear slot', () => {
    const fp = footprints('fcs-ii');
    expect(fp).toHaveLength(2);
    expect(fp.every((f) => f.shape.kind === 'rect')).toBe(true);
    const front = fp.find((f) => f.along > 0)!;
    const rear = fp.find((f) => f.along < 0)!;
    const len = (f: (typeof fp)[number]) => (f.shape.kind === 'rect' ? f.shape.length : 0);
    expect(len(front)).toBeGreaterThan(len(rear)); // front slot is longer
  });

  it('FCS x2 is two round plugs, ≈ 5/8" holes, ≈ 3" centre-to-centre (fixed)', () => {
    const fp = footprints('fcs-x2');
    expect(fp).toHaveLength(2);
    expect(fp.every((f) => f.shape.kind === 'circle')).toBe(true);
    const dia = fp[0]!.shape.kind === 'circle' ? fp[0]!.shape.diameter : 0;
    expect(dia).toBeCloseTo(0.625 * 2.54, 6);
    expect(Math.abs(fp[0]!.along - fp[1]!.along)).toBeCloseTo(3 * 2.54, 6); // 3" spacing
  });
});

describe('finTemplate', () => {
  it('spans the base and depth, raking the tip backward with sweep', () => {
    const flat = finTemplate(12, 11, 0);
    const raked = finTemplate(12, 11, 40);
    const tipFlat = flat.reduce((a, p) => (p.y > a.y ? p : a));
    const tipRaked = raked.reduce((a, p) => (p.y > a.y ? p : a));
    expect(tipFlat.y).toBeCloseTo(tipRaked.y, 6); // same depth
    expect(tipRaked.x).toBeLessThan(tipFlat.x); // raked tip moved toward the tail
    expect(Math.max(...flat.map((p) => p.y))).toBeCloseTo(11 * 0.97, 6);
  });

  it('the three profiles have distinct outlines: pivot is tallest, raked tip is furthest back', () => {
    const tipOf = (pts: ReturnType<typeof finTemplate>) =>
      pts.reduce((a, p) => (p.y > a.y ? p : a));
    const perf = finTemplate(12, 11, 0, 'performance');
    const pivot = finTemplate(12, 11, 0, 'pivot');
    const raked = finTemplate(12, 11, 0, 'raked');
    // pivot reaches full depth (tall, high tip); performance/raked stop short.
    expect(Math.max(...pivot.map((p) => p.y))).toBeGreaterThan(Math.max(...perf.map((p) => p.y)));
    // raked tip is swept furthest toward the tail (smallest x).
    expect(tipOf(raked).x).toBeLessThan(tipOf(perf).x);
    expect(tipOf(perf).x).toBeLessThan(tipOf(pivot).x);
  });
});

describe('buildFinBladeMesh', () => {
  it('produces a finite, non-empty solid with matching normals', () => {
    const [fin] = resolveFins(makeBoard(), defaultFinConfig('single', 'futures'));
    const mesh = buildFinBladeMesh(fin!);
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.indices.length % 3).toBe(0);
    expect([...mesh.positions].every(Number.isFinite)).toBe(true);
    // The blade hangs below the bottom surface (some vertex Z below surfaceZ).
    const minZ = Math.min(...[...mesh.positions].filter((_, i) => i % 3 === 2));
    expect(minZ).toBeLessThan(fin!.surfaceZ);
  });
});
