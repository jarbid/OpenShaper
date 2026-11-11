// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Invented boards for the trim kernel's tests: three tails on one foil, with three rail
 * zones along the board. They are the boards of the sketch the kernel was ported from
 * (docs/design/trim-blend-workflow.md, "The sketch"), kept so the port can be pinned
 * against the numbers the sketch produced. Test-only.
 */
import { buildLoop, smoothAlong } from '../loop';
import type { Loop, LoopDef, LoopPiece, PieceKind } from '../loop';
import { railLaws } from '../rails';
import type { RailLaws } from '../rails';
import type { Panels } from '../solid';

export const DEMO_LENGTH = 168;
const L = DEMO_LENGTH;
const WIDE_X = 88;
const HALF_WIDTH = 26.6;

export type DemoTail = 'fish' | 'wings' | 'asym';

/** A rail as the sketch's sliders set it. `dome` is the share of thickness the deck loses by the rail. */
export interface DemoRail {
  readonly band: number;
  readonly hard: number;
  readonly tuck: number;
  readonly edge: number;
  readonly apex: number;
  readonly bedge: number;
  readonly dome: number;
}

export const DEMO_RAILS = {
  soft: { band: 4.6, hard: 0.48, tuck: 3.6, edge: 0.5, apex: 0.5, bedge: 0, dome: 0.5 },
  hard: { band: 3.4, hard: 0.5, tuck: 0.25, edge: 0.9, apex: 0.1, bedge: 0, dome: 0.45 },
  tucked: { band: 3.6, hard: 0.5, tuck: 2.3, edge: 0.5, apex: 0.42, bedge: 17, dome: 0.45 },
  chine: { band: 3.4, hard: 0.5, tuck: 2.4, edge: 0.12, apex: 0.42, bedge: 30, dome: 0.45 },
  r5050: { band: 4.8, hard: 0.45, tuck: 4.4, edge: 0.45, apex: 0.5, bedge: 0, dome: 0.55 },
  r8020: { band: 3.8, hard: 0.5, tuck: 1.6, edge: 0.5, apex: 0.2, bedge: 0, dome: 0.45 },
  boxy: { band: 2.2, hard: 0.62, tuck: 1.4, edge: 0.6, apex: 0.45, bedge: 0, dome: 0.22 },
  pinched: { band: 5.2, hard: 0.42, tuck: 2.6, edge: 0.45, apex: 0.35, bedge: 0, dome: 0.68 },
} as const satisfies Record<string, DemoRail>;

export interface DemoOptions {
  readonly notch: number;
  readonly pin: number;
  readonly crotch: number;
  /** The tail end and notch wall's own band width and hardness. */
  readonly tailBand: number;
  readonly tailHard: number;
  /** Where each zone ends and the next begins, as fractions of the length. */
  readonly cuts: readonly [number, number, number, number];
  readonly rails: readonly [DemoRail, DemoRail, DemoRail];
}

export const DEMO_DEFAULTS: Record<DemoTail, DemoOptions> = {
  fish: {
    notch: 14,
    pin: 0.6,
    crotch: 0.3,
    tailBand: 1.4,
    tailHard: 0.62,
    cuts: [0.26, 0.36, 0.6, 0.72],
    rails: [DEMO_RAILS.hard, DEMO_RAILS.tucked, DEMO_RAILS.r5050],
  },
  wings: {
    notch: 9,
    pin: 0.6,
    crotch: 0.3,
    tailBand: 1.4,
    tailHard: 0.62,
    cuts: [0.26, 0.36, 0.6, 0.72],
    rails: [DEMO_RAILS.hard, DEMO_RAILS.tucked, DEMO_RAILS.r5050],
  },
  asym: {
    notch: 8,
    pin: 0.6,
    crotch: 0.3,
    tailBand: 1.4,
    tailHard: 0.62,
    cuts: [0.26, 0.36, 0.6, 0.72],
    rails: [DEMO_RAILS.hard, DEMO_RAILS.tucked, DEMO_RAILS.r5050],
  },
};

type Pt = readonly [number, number];
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Float64Array {
  const out = new Float64Array(2 * (n + 1));
  for (let i = 0; i <= n; i++) {
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    const s = 1 - t;
    out[2 * i] =
      s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0];
    out[2 * i + 1] =
      s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1];
  }
  return out;
}
const line = (a: Pt, b: Pt, n: number): Float64Array =>
  cubic(
    a,
    [lerp(a[0], b[0], 1 / 3), lerp(a[1], b[1], 1 / 3)],
    [lerp(a[0], b[0], 2 / 3), lerp(a[1], b[1], 2 / 3)],
    b,
    n,
  );
function mirror(p: Float64Array): Float64Array {
  const n = p.length / 2;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)]!;
    out[2 * i + 1] = -p[2 * (n - 1 - i) + 1]!;
  }
  return out;
}
const dir = (deg: number): Pt => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const noseRail = (): Float64Array => {
  const d = dir(180 - 38);
  return cubic(
    [L, 0],
    [L + 24 * d[0], 24 * d[1]],
    [WIDE_X + 46, HALF_WIDTH],
    [WIDE_X, HALF_WIDTH],
    260,
  );
};
const tailRail = (end: Pt, deg: number, pull: number): Float64Array => {
  const d = dir(deg);
  return cubic(
    [WIDE_X, HALF_WIDTH],
    [WIDE_X - 44, HALF_WIDTH],
    [end[0] - pull * d[0], end[1] - pull * d[1]],
    end,
    260,
  );
};

/** A function of x tabulated every cm and read back with a C1 spline, so it puts no kink in the foil. */
function tabulate(tab: Float64Array): (x: number) => number {
  return (x) => {
    const f = Math.min(L - 1e-6, Math.max(0, x));
    const k = Math.floor(f);
    const t = f - k;
    const p0 = tab[Math.max(0, k - 1)]!;
    const p1 = tab[k]!;
    const p2 = tab[k + 1]!;
    const p3 = tab[Math.min(L, k + 2)]!;
    return (
      0.5 *
      (2 * p1 +
        (p2 - p0) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
    );
  };
}

const piece = (pts: Float64Array, kind: PieceKind): LoopPiece => ({ pts, kind });

function outline(tail: DemoTail, o: DemoOptions): LoopDef {
  const yp = 13.6;
  const d = Math.max(0, o.notch);
  const rightTail = tailRail([0, yp], 180 + 14, 40);
  const nose = 0.8;
  if (tail === 'fish') {
    const inner = line([0, yp], [d, 0], 120);
    return {
      pieces: [
        piece(noseRail(), 0),
        piece(rightTail, 0),
        piece(inner, 1),
        piece(mirror(inner), 1),
        piece(mirror(rightTail), 0),
        piece(mirror(noseRail()), 0),
      ],
      corners: [0, o.pin, o.crotch, o.pin, 0, nose],
    };
  }
  if (tail === 'wings') {
    const a: Pt = [34, 20.6];
    const b: Pt = [33.0, 19.0];
    const tip: Pt = [0, 12.2];
    const r1 = cubic(
      [WIDE_X, HALF_WIDTH],
      [WIDE_X - 30, HALF_WIDTH],
      [a[0] + 16 * Math.cos(0.3), a[1] + 16 * Math.sin(0.3)],
      a,
      200,
    );
    const step = line(a, b, 30);
    const r2 = cubic(
      b,
      [b[0] - 12 * Math.cos(0.26), b[1] - 12 * Math.sin(0.26)],
      [tip[0] + 10 * Math.cos(0.2), tip[1] + 10 * Math.sin(0.2)],
      tip,
      160,
    );
    const inner = line(tip, [Math.max(0, d * 0.62), 0], 100);
    const half = [
      piece(noseRail(), 0),
      piece(r1, 0),
      piece(step, 0),
      piece(r2, 0),
      piece(inner, 1),
    ];
    const other = half
      .slice()
      .reverse()
      .map((p) => piece(mirror(p.pts), p.kind));
    const wing = 0.7;
    return {
      pieces: [...half, ...other],
      corners: [0, wing, wing, o.pin, o.crotch, o.pin, wing, wing, 0, nose],
    };
  }
  // asymmetric: the +y side is short and squared off, the -y side runs long to a round end
  const xs = 6 + d * 0.55;
  const ypr = 15.2;
  return {
    pieces: [
      piece(noseRail(), 0),
      piece(tailRail([xs, ypr], 180 + 10, 34), 0),
      piece(line([xs, ypr], [xs, 0], 60), 1),
      piece(line([xs, 0], [1.2, 0], 40), 1),
      piece(cubic([1.2, 0], [0.4, -6], [4.2, -13.4], [9, -15.8], 120), 0),
      piece(
        cubic([9, -15.8], [22, -22.4], [WIDE_X - 40, -HALF_WIDTH], [WIDE_X, -HALF_WIDTH], 240),
        0,
      ),
      piece(mirror(noseRail()), 0),
    ],
    corners: [0, Math.max(o.pin, 0.3) * 2.2, o.crotch, o.pin * 1.6, 0, 0, nose],
  };
}

function railAt(o: DemoOptions, u: number): DemoRail & { readonly weights: readonly number[] } {
  const ramp = (a: number, b: number): number =>
    b - a < 1e-6 ? (u >= b ? 1 : 0) : smooth(a, b, u);
  const w1 = ramp(o.cuts[0], o.cuts[1]);
  const w2 = ramp(o.cuts[2], o.cuts[3]);
  const mix = (k: keyof DemoRail): number =>
    lerp(lerp(o.rails[0][k], o.rails[1][k], w1), o.rails[2][k], w2);
  return {
    band: mix('band'),
    hard: mix('hard'),
    tuck: mix('tuck'),
    edge: mix('edge'),
    apex: mix('apex'),
    bedge: mix('bedge'),
    dome: mix('dome'),
    weights: [1 - w1, w1 * (1 - w2), w1 * w2],
  };
}

export interface DemoBoard {
  readonly loop: Loop;
  readonly laws: RailLaws;
  readonly panels: Panels;
}

/** One of the sketch's boards: its loop, its rails and its foil. */
export function demoBoard(tail: DemoTail, o: DemoOptions = DEMO_DEFAULTS[tail]): DemoBoard {
  const loop = buildLoop(outline(tail, o));

  // the foil follows a smooth master rail and never the cut outline
  const master = [...noseRail(), ...tailRail([0, 13.6], 180 + 14, 40)];
  const mn = master.length / 2;
  const mx = (i: number): number => master[2 * (mn - 1 - i)]!;
  const my = (i: number): number => master[2 * (mn - 1 - i) + 1]!;
  const width = new Float64Array(L + 1);
  for (let k = 0, j = 0; k <= L; k++) {
    while (j < mn - 2 && mx(j + 1) < k) j++;
    const f = Math.min(1, Math.max(0, (k - mx(j)) / Math.max(1e-9, mx(j + 1) - mx(j))));
    width[k] = my(j) + f * (my(j + 1) - my(j));
  }
  const halfWidth = tabulate(width);
  const domeTab = new Float64Array(L + 1);
  for (let k = 0; k <= L; k++) domeTab[k] = railAt(o, k / L).dome;
  const dome = tabulate(domeTab);
  const rocker = (x: number): number =>
    x < 75 ? 3.6 * Math.pow((75 - x) / 75, 2.3) : 9.5 * Math.pow((x - 75) / (L - 75), 2.7);
  const thick = (x: number): number => {
    const u = Math.min(1, Math.max(0, x / L));
    const a = u < 0.47 ? u / 0.47 : (1 - u) / 0.53;
    const end = u < 0.47 ? 1.95 : 1.3;
    return end + (6.2 - end) * (1 - Math.pow(1 - a, 2.1));
  };
  const eta = (x: number, y: number): number =>
    Math.min(1.25, Math.abs(y) / Math.sqrt(Math.pow(halfWidth(x), 2) + 16));
  const panels: Panels = {
    deck: (x, y) => rocker(x) + thick(x) * (1 - dome(x) * Math.pow(eta(x, y), 2.4)),
    bottom: (x, y) => {
      const e = eta(x, y);
      const vee = 0.25 * (1 - smooth(0, 55, x));
      const concave = 0.35 * smooth(25, 70, x) * (1 - smooth(105, 150, x));
      return rocker(x) + (vee - concave) * e * e;
    },
  };

  // the outer rail takes its zone's rail; the tail end and notch wall keep their own, and
  // the two are blended round the corners between them
  const tailShare = smoothAlong(
    loop,
    Float64Array.from(loop.kind, (k) => (k === 1 ? 1 : 0)),
    0.9,
  );
  const rad = Math.PI / 180;
  const laws = railLaws(loop, (i) => {
    const b = tailShare[i]!;
    const r = railAt(o, Math.min(1, Math.max(0, loop.x[i]! / L)));
    return {
      band: lerp(r.band, o.tailBand, b),
      hardness: lerp(r.hard, o.tailHard, b),
      tuck: lerp(r.tuck, 0.22, b),
      tuckShape: lerp(r.edge, 0.9, b),
      bottomEdge: Math.atan(Math.tan(r.bedge * rad) * (1 - b)) / rad,
      deckEdge: 0,
      apex: lerp(r.apex, 0.26, b),
    };
  });
  return { loop, laws, panels };
}
