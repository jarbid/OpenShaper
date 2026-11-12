// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The trim kernel against the sketch it was ported from, and against the things it promises:
 * a closed mesh whatever the outline and the rails, bands that cannot cross, and corners of
 * the radius asked for.
 */
import { describe, expect, it } from 'vitest';
import { TRIM } from '../params';
import type { Chain, ChainKnot } from '../types';
import { buildLoft, loftPanels } from './loft';
import type { CurveAt } from './loft';
import { buildLoop } from './loop';
import type { Loop, LoopOptions } from './loop';
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
const slabLoop = (options?: LoopOptions): Loop => {
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
  return buildLoop(
    {
      pieces: [
        { pts: side, kind: 0 },
        { pts: edge, kind: 1 },
        { pts: back, kind: 0 },
        { pts: nose, kind: 1 },
      ],
      corners: [1.5, 1.5, 1.5, 1.5],
    },
    options,
  );
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

/** A chain through `n + 1` even points of f on [a, b], each span the cubic Hermite with slopes f′. */
const fnChain = (
  f: (x: number) => number,
  df: (x: number) => number,
  a: number,
  b: number,
  n: number,
): Chain => {
  const h = (b - a) / n;
  const knots: ChainKnot[] = [];
  for (let i = 0; i <= n; i++) {
    const x = a + i * h;
    const y = f(x);
    const s = df(x);
    knots.push({
      p: [x, y],
      in: [x - h / 3, y - (s * h) / 3],
      out: [x + h / 3, y + (s * h) / 3],
      smooth: true,
    });
  }
  return { knots };
};

/** Lofted panels over the slab: a domed deck over a bellied bottom, 3 to 5 cm thick. */
const slabPanels = () => {
  const L = 120;
  const rocker = fnChain(
    (x) => 0.0004 * (x - 60) ** 2,
    (x) => 0.0008 * (x - 60),
    0,
    L,
    12,
  );
  const deck = fnChain(
    (x) => 0.0004 * (x - 60) ** 2 + 3 + 2 * Math.sin((Math.PI * x) / L),
    (x) => 0.0008 * (x - 60) + ((2 * Math.PI) / L) * Math.cos((Math.PI * x) / L),
    0,
    L,
    12,
  );
  const xs = [10, 40, 80, 110];
  const top = buildLoft(
    xs.map(
      (x, i): CurveAt => ({
        x,
        curve: fnChain(
          (u) => 1 - (0.3 + 0.1 * i) * u * u,
          (u) => -2 * (0.3 + 0.1 * i) * u,
          0,
          1,
          6,
        ),
      }),
    ),
    600,
  );
  const bot = buildLoft(
    xs.map(
      (x, i): CurveAt => ({
        x,
        curve: fnChain(
          (u) => (0.08 - 0.03 * i) * u * u + 0.04 * i * u ** 4,
          (u) => 2 * (0.08 - 0.03 * i) * u + 0.16 * i * u ** 3,
          0,
          1,
          6,
        ),
      }),
    ),
    600,
  );
  const w = (): number => 8;
  return loftPanels({
    rocker,
    deck,
    halfWidth: [w, w],
    bottom: [bot, bot],
    top: [top, top],
    from: 0,
    to: L,
  });
};

const slabLaws = (loop: Loop) =>
  railLaws(loop, () => ({
    band: 2,
    hardness: 0.5,
    tuck: 1,
    tuckShape: 0.5,
    bottomEdge: 0,
    deckEdge: 0,
    apex: 0.4,
  }));

describe('trim kernel: panels that give their slopes', () => {
  it('builds the same surface from `both` as from the heights alone', () => {
    const loop = slabLoop();
    const laws = slabLaws(loop);
    const p = slabPanels();
    const withBoth = buildTrimMesh(loop, laws, p, GRID);
    const without = buildTrimMesh(loop, laws, { deck: p.deck, bottom: p.bottom }, GRID);
    expect(withBoth.positions.length).toBe(without.positions.length);
    expect(Array.from(withBoth.indices)).toEqual(Array.from(without.indices));
    // the two differ by the finite differences of the one path: its slope at a band edge is a
    // second-order one-sided difference, its normals central differences
    let dPos = 0;
    let dNrm = 0;
    for (let i = 0; i < withBoth.positions.length; i++) {
      dPos = Math.max(dPos, Math.abs(withBoth.positions[i]! - without.positions[i]!));
      dNrm = Math.max(dNrm, Math.abs(withBoth.normals[i]! - without.normals[i]!));
    }
    expect(dPos).toBeLessThan(1e-6);
    expect(dNrm).toBeLessThan(1e-4);
    const a = checkClosed(withBoth);
    const b = checkClosed(without);
    expect(a.openEdges).toBe(0);
    expect(b.openEdges).toBe(0);
    expect(Math.abs(a.volume - b.volume) / b.volume).toBeLessThan(1e-6);
  });

  it('keeps `both` through a thickness floor, and without one', () => {
    const p = slabPanels();
    expect(withLeastThickness(p, 0)).toBe(p);
    expect(withLeastThickness(p, 0.5).both).toBeTypeOf('function');
    expect(withLeastThickness({ deck: p.deck, bottom: p.bottom }, 0.5).both).toBeUndefined();
  });
});

describe('trim kernel: the thickness floor, cheaper', () => {
  const T = TRIM.tipThickness;
  const P = TRIM.tipSharpness;
  const flat = (t: number): Panels => ({ deck: () => t / 2, bottom: () => -t / 2 });
  const exact = (t: number): number => Math.pow(Math.pow(t, P) + Math.pow(T, P), 1 / P);
  const thickened = (t: number): number => {
    const q = withLeastThickness(flat(t), T);
    return q.deck(0, 0) - q.bottom(0, 0);
  };

  it('agrees with the exact form where the series stands in for it', () => {
    for (const [k, bound] of [
      [4, 1e-8],
      [6, 1e-9],
      [20, 1e-12],
    ] as const) {
      const t = k * T;
      expect(Math.abs(thickened(t) - exact(t)) / t, `t = ${k} T`).toBeLessThan(bound);
    }
  });

  it('is continuous across where the series takes over', () => {
    const t = TRIM.tipFar * T;
    const eps = 1e-9;
    // each height moves half the thickness, 5e-9 at most, plus the slope over the step
    const lo = withLeastThickness(flat(t - eps), T);
    const hi = withLeastThickness(flat(t + eps), T);
    expect(Math.abs(lo.deck(0, 0) - hi.deck(0, 0))).toBeLessThan(1e-8);
    expect(Math.abs(lo.bottom(0, 0) - hi.bottom(0, 0))).toBeLessThan(1e-8);
    // the slopes, too: the series' derivative is off the exact one by 15 (r^p / p)^2, 2.5e-8.
    // Panels whose thickness is v and whose thickness grows at unit rate along x give dt'/dt
    const out = new Float64Array(6);
    const slopes = [t - eps, t + eps].map((v) => {
      const rising = withLeastThickness(
        {
          deck: () => v / 2,
          bottom: () => -v / 2,
          both: (_x, _y, g) => g.set([v / 2, 0.5, 0, -v / 2, -0.5, 0]),
        },
        T,
      );
      rising.both!(0, 0, out);
      return out[1]! - out[4]!;
    });
    expect(Math.abs(slopes[0]! - slopes[1]!)).toBeLessThan(1e-7);
  });

  it('has gradients that are the derivatives of its own heights', () => {
    // t runs from below 0 through the exact form into the series, and varies across y too
    const deck = (x: number, y: number): number =>
      0.45 * x + 0.2 * Math.sin(0.7 * y) + 0.01 * x * y;
    const bottom = (x: number, y: number): number => 0.1 * Math.sin(0.3 * x) + 0.05 * y;
    const q = withLeastThickness(
      {
        deck,
        bottom,
        both: (x, y, out) => {
          out[0] = deck(x, y);
          out[1] = 0.45 + 0.01 * y;
          out[2] = 0.14 * Math.cos(0.7 * y) + 0.01 * x;
          out[3] = bottom(x, y);
          out[4] = 0.03 * Math.cos(0.3 * x);
          out[5] = 0.05;
        },
      },
      T,
    );
    const out = new Float64Array(6);
    const e = 1e-5;
    const far = TRIM.tipFar * T;
    let thin = 0;
    let thick = 0;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = ((i * 0.618034) % 1) * 12 - 0.2;
      const y = (((i * 0.414214) % 1) - 0.5) * 6;
      const t = deck(x, y) - bottom(x, y);
      // a step across where the series takes over would be read as a slope
      if (Math.abs(t - far) < 1e-3) continue;
      if (t < far) thin++;
      else thick++;
      q.both!(x, y, out);
      expect(out[0]).toBe(q.deck(x, y));
      expect(out[3]).toBe(q.bottom(x, y));
      for (const [k, f] of [
        [0, q.deck],
        [3, q.bottom],
      ] as const) {
        const dx = (f(x + e, y) - f(x - e, y)) / (2 * e);
        const dy = (f(x, y + e) - f(x, y - e)) / (2 * e);
        worst = Math.max(worst, Math.abs(dx - out[k + 1]!), Math.abs(dy - out[k + 2]!));
      }
    }
    expect(thin).toBeGreaterThan(50);
    expect(thick).toBeGreaterThan(50);
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('trim kernel: the loop spacing', () => {
  it('gives the default loop as before, and a finer one on request', () => {
    const base = slabLoop();
    expect(base.n).toBe(515);
    expect(base.s[base.n]!).toBeCloseTo(269.4108, 3);
    const same = slabLoop({ spacingMax: TRIM.spacingMax });
    expect(same.n).toBe(base.n);
    expect(Array.from(same.x)).toEqual(Array.from(base.x));
    const fine = slabLoop({ spacingMax: 0.2 });
    expect(fine.n).toBeGreaterThan(base.n);
    // both loops are polylines through points of the same outline, so their lengths differ by
    // the chord error of the coarser one: 3.7e-3 cm here
    expect(Math.abs(fine.s[fine.n]! - base.s[base.n]!)).toBeLessThan(1e-2);
  });
});
