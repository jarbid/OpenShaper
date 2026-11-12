// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The trim kernel against the sketch it was ported from, and against the things it promises:
 * a closed mesh whatever the outline and the rails, bands that cannot cross, and corners of
 * the radius asked for.
 */
import { describe, expect, it } from 'vitest';
import { TRIM } from '../params';
import { buildLoop } from './loop';
import type { Loop } from './loop';
import { railLaws } from './rails';
import { buildTrimMesh, checkClosed, sliceX, withLeastThickness } from './solid';
import type { Panels, TrimMesh, TrimMeshOptions } from './solid';
import { DEMO_DEFAULTS, DEMO_RAILS, demoBoard } from './test-support/demo';
import type { DemoOptions, DemoTail } from './test-support/demo';

const GRID = 0.7;
/**
 * How closely two meshes of the same board agree on volume, litres. The sketch and this
 * kernel put every vertex in the same place but stitch the panels to the rail with different
 * triangulators, and the stitch triangles cut the curved panel differently: up to 0.006 L in
 * 30, most on a strongly domed deck.
 */
const VOLUME_AGREES = 0.015;
const TAILS: readonly DemoTail[] = ['fish', 'wings', 'asym'];
const HARSH: Pick<DemoOptions, 'cuts' | 'rails'> = {
  cuts: [0.3, 0.32, 0.6, 0.62],
  rails: [DEMO_RAILS.hard, DEMO_RAILS.chine, DEMO_RAILS.pinched],
};

/** What the sketch produced for the same boards (docs/design/trim-blend-workflow.md). */
const SKETCH: Record<
  DemoTail,
  { n: number; segments: number; perimeter: number; minBand: number; litres: number; harsh: number }
> = {
  fish: {
    n: 771,
    segments: 10,
    perimeter: 388.24,
    minBand: 0.4315,
    litres: 30.4648,
    harsh: 30.0103,
  },
  wings: {
    n: 777,
    segments: 18,
    perimeter: 378.603,
    minBand: 0.4353,
    litres: 30.2935,
    harsh: 29.8405,
  },
  asym: {
    n: 727,
    segments: 11,
    perimeter: 373.548,
    minBand: 0.574,
    litres: 30.3778,
    harsh: 29.9262,
  },
};

/** A slab's outline, 120 by 16 cm, straight sides and ends, every corner 1.5 cm. */
const slabLoop = (): Loop => {
  const d = 8;
  const side = new Float64Array(2 * 201);
  const edge = new Float64Array(2 * 41);
  const back = new Float64Array(2 * 201);
  const nose = new Float64Array(2 * 41);
  for (let i = 0; i <= 200; i++) {
    side[2 * i] = 120 - (120 * i) / 200;
    side[2 * i + 1] = d;
    back[2 * i] = (120 * i) / 200;
    back[2 * i + 1] = -d;
  }
  for (let i = 0; i <= 40; i++) {
    edge[2 * i] = 0;
    edge[2 * i + 1] = d - (2 * d * i) / 40;
    nose[2 * i] = 120;
    nose[2 * i + 1] = -d + (2 * d * i) / 40;
  }
  return buildLoop({
    pieces: [
      { pts: side, kind: 0 },
      { pts: edge, kind: 1 },
      { pts: back, kind: 0 },
      { pts: nose, kind: 1 },
    ],
    corners: [1.5, 1.5, 1.5, 1.5],
  });
};

const build = (tail: DemoTail, over: Partial<DemoOptions> = {}) => {
  const board = demoBoard(tail, { ...DEMO_DEFAULTS[tail], ...over });
  const mesh = buildTrimMesh(board.loop, board.laws, board.panels, GRID);
  return { ...board, mesh, check: checkClosed(mesh) };
};

describe('trim kernel: the port matches the sketch', () => {
  for (const tail of TAILS) {
    it(`${tail}: same loop, same bands, same volume`, () => {
      const ref = SKETCH[tail];
      const b = build(tail);
      expect(b.loop.n).toBe(ref.n);
      expect(b.loop.segments).toBe(ref.segments);
      expect(b.loop.s[b.loop.n]!).toBeCloseTo(ref.perimeter, 3);
      expect(Math.min(...b.laws.deckWidth)).toBeCloseTo(ref.minBand, 4);
      expect(b.check.openEdges).toBe(0);
      expect(Math.abs(b.check.volume / 1000 - ref.litres)).toBeLessThan(VOLUME_AGREES);
      expect(Math.abs(build(tail, HARSH).check.volume / 1000 - ref.harsh)).toBeLessThan(
        VOLUME_AGREES,
      );
    });
  }

  it("slices mid-board to the sketch's section", () => {
    const b = build('fish');
    const seg = sliceX(b.mesh, b.panels, 84);
    let yMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < seg.length; i += 5) {
      yMax = Math.max(yMax, seg[i]!, seg[i + 2]!);
      zMin = Math.min(zMin, seg[i + 1]!, seg[i + 3]!);
      zMax = Math.max(zMax, seg[i + 1]!, seg[i + 3]!);
    }
    expect(yMax).toBeCloseTo(26.59, 2);
    expect(zMin).toBeCloseTo(-0.268, 2);
    expect(zMax).toBeCloseTo(6.206, 2);
  });
});

describe('trim kernel: what a real board needs', () => {
  it('stays closed where the outline is exactly straight', () => {
    // a squash tail's edge is a straight line, so the band edge along it is collinear and the
    // triangulator drops those vertices; found on the first real boards through the kernel
    const loop = slabLoop();
    const laws = railLaws(loop, () => ({
      band: 2,
      hardness: 0.5,
      tuck: 1,
      tuckShape: 0.5,
      bottomEdge: 0,
      deckEdge: 0,
      apex: 0.4,
    }));
    const mesh = buildTrimMesh(loop, laws, { deck: () => 5, bottom: () => 0 }, GRID);
    const check = checkClosed(mesh);
    expect(check.openEdges).toBe(0);
    // a slab 120 by 16 by 5 with rounded corners and edges: a little under 9.6 litres
    expect(check.volume / 1000).toBeGreaterThan(9);
    expect(check.volume / 1000).toBeLessThan(9.6);
  });
});

describe('trim kernel: what it promises', () => {
  it('stays closed at the ends of every control', () => {
    const cases: [string, Partial<DemoOptions>][] = [
      ['no notch', { notch: 0 }],
      ['deep notch', { notch: 22 }],
      ['sharpest corners', { pin: 0.25, crotch: 0.12 }],
      ['roundest corners', { pin: 2.5, crotch: 2 }],
      ['blends at the tail', { cuts: [0.05, 0.07, 0.09, 0.11] }],
      ['blends at the nose', { cuts: [0.89, 0.91, 0.93, 0.95] }],
      ['blends squeezed together', { cuts: [0.4, 0.42, 0.44, 0.46] }],
      ['hard into chine into pinched', HARSH],
      [
        'boxy, pinched, boxy',
        {
          cuts: [0.2, 0.22, 0.7, 0.72],
          rails: [DEMO_RAILS.boxy, DEMO_RAILS.pinched, DEMO_RAILS.boxy],
        },
      ],
      ['soft everywhere', { rails: [DEMO_RAILS.soft, DEMO_RAILS.soft, DEMO_RAILS.soft] }],
    ];
    for (const tail of TAILS) {
      for (const [name, over] of cases) {
        const b = build(tail, over);
        expect(b.check.openEdges, `${tail}, ${name}`).toBe(0);
        expect(b.check.volume, `${tail}, ${name}`).toBeGreaterThan(25_000);
        expect(
          b.mesh.positions.every((v) => Number.isFinite(v)),
          `${tail}, ${name}`,
        ).toBe(true);
      }
    }
  });

  it('never lets a band reach the band from the opposite edge', () => {
    for (const tail of TAILS) {
      const b = build(tail, {
        rails: [DEMO_RAILS.pinched, DEMO_RAILS.pinched, DEMO_RAILS.pinched],
      });
      for (let i = 0; i < b.loop.n; i++) {
        expect(b.laws.deckWidth[i]!).toBeLessThanOrEqual(TRIM.bandHard * b.loop.lfs[i]! + 1e-12);
        expect(b.laws.tuckWidth[i]!).toBeLessThanOrEqual(TRIM.bandHard * b.loop.lfs[i]! + 1e-12);
      }
    }
  });

  it('rounds every corner to the radius asked for', () => {
    const { loop } = build('fish');
    // on a convex corner's arc the local feature size is the arc's own radius
    const radii = new Map<number, number[]>();
    for (let i = 0; i < loop.n; i++) {
      if (loop.corner[i] !== 1) continue;
      radii.set(loop.seg[i]!, [...(radii.get(loop.seg[i]!) ?? []), loop.lfs[i]!]);
    }
    const mid = [...radii.values()].map((r) => r[Math.floor(r.length / 2)]!).sort((a, b) => a - b);
    expect(mid).toHaveLength(3);
    expect(mid[0]!).toBeCloseTo(0.6, 1);
    expect(mid[1]!).toBeCloseTo(0.6, 1);
    expect(mid[2]!).toBeCloseTo(0.8, 1);
  });

  it('keeps the apex on the outline and the rail vertical there', () => {
    const { mesh, loop } = build('wings');
    const per = mesh.deckRows + mesh.tuckRows + 1;
    for (let i = 0; i < loop.n; i += 7) {
      const a = per * i + per - 1;
      expect(mesh.positions[3 * a]!).toBeCloseTo(loop.x[i]!, 4);
      expect(mesh.positions[3 * a + 1]!).toBeCloseTo(loop.y[i]!, 4);
      expect(mesh.normals[3 * a + 2]!).toBe(0);
    }
  });

  it('meets the panel tangent where the rail has no edge, and at an angle where it has one', () => {
    const { mesh, loop, laws } = build('fish');
    const per = mesh.deckRows + mesh.tuckRows + 1;
    const rimStart = loop.n * per;
    const angle = (a: number, b: number): number => {
      const n = mesh.normals;
      const dot =
        n[3 * a]! * n[3 * b]! + n[3 * a + 1]! * n[3 * b + 1]! + n[3 * a + 2]! * n[3 * b + 2]!;
      return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    };
    let deckWorst = 0;
    let edged = 0;
    for (let i = 0; i < loop.n; i++) {
      // deck: strip row 0 against the deck panel's own seam vertex; the deck has no edge anywhere
      deckWorst = Math.max(deckWorst, angle(per * i, rimStart + i));
      if (laws.bottomEdge[i]! > Math.tan((10 * Math.PI) / 180)) edged++;
    }
    expect(deckWorst).toBeLessThan(1);
    expect(edged).toBeGreaterThan(50);
  });
});

describe('trim kernel: a tip is never thinner than the floor', () => {
  // a plain rail on the slab's outline
  const slab = (panels: Panels, options: TrimMeshOptions = {}) => {
    const loop = slabLoop();
    const laws = railLaws(loop, () => ({
      band: 2,
      hardness: 0.5,
      tuck: 1,
      tuckShape: 0.5,
      bottomEdge: 0,
      deckEdge: 0,
      apex: 0.4,
    }));
    const mesh = buildTrimMesh(loop, laws, panels, GRID, options);
    return { mesh, check: checkClosed(mesh) };
  };
  const thinnestWall = (mesh: TrimMesh): number => {
    let w = Infinity;
    for (let i = 0; i < mesh.loop.n; i++) w = Math.min(w, mesh.wallTop[i]! - mesh.wallBottom[i]!);
    return w;
  };
  // half thickness 2.5 cm mid-length, falling to exactly 0 at the ends of the slab, x = 0 and 120
  const half = (x: number): number => 2.5 * (1 - ((x - 60) / 60) ** 2);
  const lens: Panels = { deck: (x) => half(x), bottom: (x) => -half(x) };
  // the same foil 4 cm shorter at each end, so the deck is under the bottom there
  const short = (x: number): number => 2.5 * (1 - ((x - 60) / 56) ** 2);
  const crossing: Panels = { deck: (x) => short(x), bottom: (x) => -short(x) };

  it('builds a lens whose foil ends in nothing as a closed solid with a ball at each tip', () => {
    const { mesh, check } = slab(lens);
    expect(check.openEdges).toBe(0);
    expect(mesh.positions.every((v) => Number.isFinite(v))).toBe(true);
    expect(check.volume).toBeGreaterThan(0);
    expect(thinnestWall(mesh)).toBeGreaterThanOrEqual(0.9 * TRIM.tipThickness);
  });

  it('opens a knife-edge wall to the least wall when the floor is off', () => {
    const { mesh, check } = slab(lens, { leastThickness: 0 });
    expect(check.openEdges).toBe(0);
    expect(mesh.positions.every((v) => Number.isFinite(v))).toBe(true);
    expect(thinnestWall(mesh)).toBeGreaterThanOrEqual(TRIM.wallMin * (1 - 1e-9));
  });

  it('builds panels that cross as a closed solid', () => {
    const { mesh, check } = slab(crossing);
    expect(check.openEdges).toBe(0);
    expect(mesh.positions.every((v) => Number.isFinite(v))).toBe(true);
    expect(check.volume).toBeGreaterThan(0);
    expect(thinnestWall(mesh)).toBeGreaterThanOrEqual(0.9 * TRIM.tipThickness);
  });

  it('leaves a thick board alone', () => {
    // the demo foil is at least 1.3 cm thick at the stringer; with the floor the fish gains
    // under 0.0001 L, so 0.001 L leaves room without hiding a real change
    const b = demoBoard('fish');
    const floor = checkClosed(buildTrimMesh(b.loop, b.laws, b.panels, GRID)).volume;
    const none = checkClosed(
      buildTrimMesh(b.loop, b.laws, b.panels, GRID, { leastThickness: 0 }),
    ).volume;
    expect(Math.abs(floor - none) / 1000).toBeLessThan(0.001);
  });

  it("holds a thickness to the floor, smoothly, about the panels' mean", () => {
    const T = TRIM.tipThickness;
    const flat = (mean: number, t: number): Panels => ({
      deck: () => mean + t / 2,
      bottom: () => mean - t / 2,
    });
    const after = (mean: number, t: number) => {
      const p = withLeastThickness(flat(mean, t), T);
      return { t: p.deck(0, 0) - p.bottom(0, 0), mean: 0.5 * (p.deck(0, 0) + p.bottom(0, 0)) };
    };
    expect(after(1.7, 0).t).toBeCloseTo(T, 12);
    expect(after(1.7, -0.3).t).toBeCloseTo(T, 12);
    expect(Math.abs(after(1.7, 4 * T).t - 4 * T)).toBeLessThan(T / 1000);
    let last = -Infinity;
    for (let k = -20; k <= 200; k++) {
      const r = after(-2.3, k * 0.02);
      expect(r.t).toBeGreaterThanOrEqual(last);
      expect(r.t).toBeGreaterThanOrEqual(T);
      expect(r.mean).toBeCloseTo(-2.3, 12);
      last = r.t;
    }
    // no overflow on a thickness far beyond any board, and no change when the floor is off
    expect(after(0, 1e200).t).toBe(1e200);
    const given = flat(0, 0);
    expect(withLeastThickness(given, 0)).toBe(given);
  });
});
