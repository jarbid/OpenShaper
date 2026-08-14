// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fitted hull, against the loft it is fitted to.
 *
 * Four layers, because no single one of them is convincing on its own:
 *
 *  1. **Analytic exactness** — a prism must come out a prism, the seam must be
 *     exactly on the stringer, the mirror must be exact.
 *  2. **Density still buys accuracy**, so refinement is a lever at all. Note this
 *     is deliberately NOT a fourth-order claim: the lofted hull is piecewise
 *     linear around the ring, so it is only C0 and no cubic can converge on it at
 *     fourth order. The genuine order test lives in `bspline-surface.test.ts`,
 *     against smooth analytic data where the claim is meaningful.
 *  3. **Deviation** against `loftPoint`, to a tolerance derived from physical and
 *     numerical limits rather than picked to pass.
 *  4. **Volume** against the mesh — global and topology-sensitive, so it catches a
 *     transposed control net, a flipped patch or a missing cap, none of which a
 *     pointwise probe near the fit nodes would notice.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength } from './board';
import { fitBoardSurface, surfaceStations } from './board-surface';
import { evalSurface, surfaceNormal, type BSplineSurface } from './bspline-surface';
import { loftPoint, loftSection, type Vert3 } from './loft';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { boxBoard, curvyBoard } from './test-support/synthetic-boards';
import type { BezierBoard } from './board';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

// --- deviation, measured in the station plane ---

/**
 * Distance from a fitted point to the lofted hull.
 *
 * The fitted surface's x depends only on u (every data row is planar at constant
 * x, and interpolation preserves that), so a probe lands exactly on some station
 * plane and the comparison reduces to a point-to-curve distance IN that plane.
 * That removes both kinds of parameterization slip — along the length and around
 * the ring — which a naive `|S(u,v) - loftPoint(x, v)|` would report as geometric
 * error and inflate by an order of magnitude.
 */
const REF_SAMPLES = 700;

const deviationAt = (board: BezierBoard, p: Vert3): number => {
  const section = loftSection(board, p.x);
  if (!section) return 0;
  const y = Math.abs(p.y); // the reference ring is the +Y half
  let best = Infinity;
  let prev = loftPoint(section, 0);
  for (let i = 1; i <= REF_SAMPLES; i++) {
    const cur = loftPoint(section, i / REF_SAMPLES);
    // distance from (y, p.z) to the segment prev→cur in the (lateral, height) plane
    const ax = prev.x;
    const az = prev.y + section.rocker;
    const bx = cur.x;
    const bz = cur.y + section.rocker;
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((y - ax) * dx + (p.z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(y - (ax + t * dx), p.z - (az + t * dz)));
    prev = cur;
  }
  return best;
};

/**
 * Worst deviation over an interior parameter sweep (nodes excluded — they are
 * exact). `uMargin` skips that fraction of the parameter range at each end.
 */
const worstDeviation = (
  board: BezierBoard,
  s: BSplineSurface,
  nu = 41,
  nv = 41,
  uMargin = 0,
): number => {
  let worst = 0;
  for (let i = 0; i < nu; i++) {
    const u = uMargin + ((1 - 2 * uMargin) * (i + 0.5)) / nu;
    for (let j = 0; j < nv; j++) {
      const v = (j + 0.5) / nv;
      worst = Math.max(worst, deviationAt(board, evalSurface(s, u, v)));
    }
  }
  return worst;
};

// --- volume, by triangulating the fitted solid the same way the mesh is measured ---

const signedVolume = (tris: readonly [Vert3, Vert3, Vert3][]): number => {
  let sum = 0;
  for (const [a, b, c] of tris) {
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    sum += (a.x * nx + a.y * ny + a.z * nz) / 6;
  }
  return sum;
};

/** Close the fitted patches into a solid and triangulate it. */
const fittedSolid = (m: ReturnType<typeof fitBoardSurface>, n = 140): [Vert3, Vert3, Vert3][] => {
  const tris: [Vert3, Vert3, Vert3][] = [];
  const sample = (s: BSplineSurface) =>
    Array.from({ length: n + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => evalSurface(s, i / n, j / n)),
    );
  const P = sample(m.plus);
  const M = sample(m.minus);
  // Mirroring flips handedness, so the -Y patch has to be wound the other way or
  // the two halves cancel and the solid measures zero. (That is exactly the
  // `same_sense = .F.` the STEP writer needs on that face.)
  for (const [g, flip] of [
    [P, false],
    [M, true],
  ] as const) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = g[i]![j]!;
        const b = g[i + 1]![j]!;
        const c = g[i]![j + 1]!;
        const d = g[i + 1]![j + 1]!;
        tris.push(flip ? [a, c, b] : [a, b, c]);
        tris.push(flip ? [c, d, b] : [c, b, d]);
      }
    }
  }
  // Caps: the closed loop is the +Y column down and the -Y column back.
  for (const i of [0, n]) {
    const loop = [...Array.from({ length: n + 1 }, (_, j) => P[i]![j]!)];
    for (let j = n - 1; j >= 1; j--) loop.push(M[i]![j]!);
    const cx = loop.reduce((a, p) => a + p.x, 0) / loop.length;
    const cy = loop.reduce((a, p) => a + p.y, 0) / loop.length;
    const cz = loop.reduce((a, p) => a + p.z, 0) / loop.length;
    const hub = { x: cx, y: cy, z: cz };
    for (let k = 0; k < loop.length; k++) {
      tris.push([hub, loop[k]!, loop[(k + 1) % loop.length]!]);
    }
  }
  return tris;
};

const meshVolume = (board: BezierBoard): number => {
  const mesh = tessellateBoard(board, { targetFaceSize: 0.2 });
  const tris: [Vert3, Vert3, Vert3][] = [];
  const at = (i: number): Vert3 => ({
    x: mesh.positions[i * 3]!,
    y: mesh.positions[i * 3 + 1]!,
    z: mesh.positions[i * 3 + 2]!,
  });
  for (let t = 0; t < mesh.indices.length; t += 3) {
    tris.push([at(mesh.indices[t]!), at(mesh.indices[t + 1]!), at(mesh.indices[t + 2]!)]);
  }
  return Math.abs(signedVolume(tris));
};

describe('surfaceStations', () => {
  const board = loadBoard('shortboard');
  const { stations, breaks, span } = surfaceStations(board);

  it('spans the solid length, ascending', () => {
    expect(stations[0]).toBe(span[0]);
    expect(stations[stations.length - 1]).toBe(span[1]);
    for (let i = 1; i < stations.length; i++) {
      expect(stations[i]!).toBeGreaterThan(stations[i - 1]!);
    }
  });

  it('trims only the sliver where the board is thinner than MIN_DIM', () => {
    // The trim exists to keep `loftSection`'s floor out of the fit; it must not
    // cost length a shaper would notice. Measured: 30 µm on this board.
    const lost = span[0] + (getLength(board) - span[1]);
    expect(lost).toBeLessThan(0.05);
  });

  it('lands a row exactly on every real cross-section, and marks it a crease', () => {
    const real = board.crossSections.slice(1, -1).map((cs) => cs.position);
    for (const x of real) {
      if (x <= 0 || x >= getLength(board)) continue;
      expect(stations.some((s) => Math.abs(s - x) < 1e-9)).toBe(true);
    }
    for (const b of breaks) {
      expect(real.some((x) => Math.abs(stations[b]! - x) < 1e-9)).toBe(true);
    }
  });

  it('gives every strip enough rows to carry a cubic', () => {
    const bounds = [0, ...breaks, stations.length - 1];
    for (let s = 0; s < bounds.length - 1; s++) {
      expect(bounds[s + 1]! - bounds[s]! + 1).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('fitBoardSurface: analytic exactness', () => {
  it('fits a prism as a prism', () => {
    const board = boxBoard({ length: 100, halfWidth: 20, thickness: 5 });
    const m = fitBoardSurface(board, { lengthRows: 30, ringCols: 24 });
    for (const v of [0.15, 0.5, 0.85]) {
      const ref = evalSurface(m.plus, 0.5, v);
      for (let k = 0; k <= 20; k++) {
        const p = evalSurface(m.plus, k / 20, v);
        expect(Math.abs(p.y - ref.y)).toBeLessThan(1e-9);
        expect(Math.abs(p.z - ref.z)).toBeLessThan(1e-9);
      }
    }
  });

  it('puts the whole seam exactly on the stringer', () => {
    // Not "close to zero": the two hull patches must share the seam by identity so
    // the STEP shell is watertight by construction rather than by tolerance.
    const m = fitBoardSurface(loadBoard('funboard'), { lengthRows: 40, ringCols: 24 });
    for (const row of m.plus.ctrl) {
      // `=== 0` rather than `toBe(0)`: the solve can yield -0, which is the same
      // point and formats identically, but fails an Object.is comparison.
      expect(row[0]!.y === 0).toBe(true);
      expect(row[row.length - 1]!.y === 0).toBe(true);
    }
  });

  it('mirrors exactly', () => {
    const m = fitBoardSurface(loadBoard('shortboard'), { lengthRows: 40, ringCols: 24 });
    m.plus.ctrl.forEach((row, i) =>
      row.forEach((p, j) => {
        const q = m.minus.ctrl[i]![j]!;
        expect(q.x).toBe(p.x);
        expect(q.y).toBe(-p.y);
        expect(q.z).toBe(p.z);
      }),
    );
    expect(m.minus.uKnots).toBe(m.plus.uKnots);
  });

  it('depends x only on u, which is what the deviation measure relies on', () => {
    const m = fitBoardSurface(loadBoard('shortboard'), { lengthRows: 30, ringCols: 20 });
    for (const u of [0.1, 0.44, 0.77]) {
      const ref = evalSurface(m.plus, u, 0).x;
      for (const v of [0.2, 0.5, 0.9, 1]) {
        expect(Math.abs(evalSurface(m.plus, u, v).x - ref)).toBeLessThan(1e-9);
      }
    }
  });

  it('orients its natural normal inward on the +Y half', () => {
    // u runs along +x and v from bottom to deck, so S_u x S_v points into the
    // board on the +Y patch. The STEP writer must therefore emit that face with
    // same_sense = .F.; pinning it here stops a silent inside-out solid.
    const m = fitBoardSurface(loadBoard('shortboard'), { lengthRows: 30, ringCols: 24 });
    const n = surfaceNormal(m.plus, 0.5, 0.5);
    expect(n).not.toBeNull();
    expect(n!.y).toBeLessThan(0);
  });

  it('flags which ends are true points', () => {
    const pointed = fitBoardSurface(curvyBoard(), { lengthRows: 24, ringCols: 20 });
    expect(pointed.end0.pointed).toBe(true);
    expect(pointed.end1.pointed).toBe(true);
    const blunt = fitBoardSurface(boxBoard(), { lengthRows: 24, ringCols: 20 });
    expect(blunt.end0.pointed).toBe(false);
    expect(blunt.end1.pointed).toBe(false);
    expect(blunt.end0.dir).toBe(-1);
    expect(blunt.end1.dir).toBe(1);
  });
});

describe('fitBoardSurface: convergence', () => {
  // Vary only the ring density with refinement off, so this measures the fit
  // itself rather than the refinement heuristic. The rail apex is the sharpest
  // thing on the board, so v dominates the error and scales cleanly, whereas row
  // counts are quantised by the forced station/knot rows. A cubic interpolant is
  // O(h^4), so halving h should cut the error ~16x; 8 leaves room for the strips.
  // Deliberately NOT a fourth-order claim. The lofted hull is piecewise linear
  // around the ring — `loftPoint` interpolates an arc-length table — so the target
  // is only C0 in v and no cubic can converge on it at fourth order. (Measured:
  // the ratio is about 2 per doubling, i.e. first order, which is what a C0 target
  // gives.) The genuine O(h^4) claim is tested in `bspline-surface.test.ts` against
  // a smooth analytic curve; what matters here is that density still buys accuracy
  // monotonically, so refinement is a lever at all.
  //
  // Measured away from the last 10% at each end: the nose and tail turn through
  // ninety degrees of outline in a couple of centimetres, so their error is set by
  // how rows happen to straddle that turn and swamps the signal. The tips are
  // covered instead by the deviation bound below.
  const board = loadBoard('funboard');
  const errAt = (cols: number) =>
    worstDeviation(
      board,
      fitBoardSurface(board, { lengthRows: 320, ringCols: cols, tolerance: 0 }).plus,
      25,
      41,
      0.1,
    );

  it('improves steadily as the ring density doubles', () => {
    const e1 = errAt(12);
    const e2 = errAt(24);
    const e3 = errAt(48);
    expect(e1 / e2).toBeGreaterThan(1.5);
    expect(e2 / e3).toBeGreaterThan(1.5);
  });
});

describe('fitBoardSurface: deviation from the loft', () => {
  /**
   * The fit aims at `DEFAULT_TOLERANCE` (0.005 cm) and reaches it on most boards;
   * this asserts the weaker bound it reaches on ALL of them, measured
   * independently of the refiner's own metric.
   *
   * 0.015 cm (0.15 mm), derived rather than tuned:
   *
   * - Physical ceiling: a CNC blank cutter finishes at 0.1–0.5 mm, hand sanding
   *   removes at least 1 mm, and EPS/PU blank stock varies by ±1 mm. 0.15 mm is at
   *   the finest of those and 7x below the rest.
   * - Numerical floor: the lofted surface is itself only defined to about 5 µm —
   *   `pointAtArcFraction` interpolates linearly between `ARC_TABLE_SAMPLES = 64`
   *   samples per Bezier segment, so its chord error is (h²/8)·κ, roughly 4e-4 cm
   *   on a 2 cm rail-apex segment at κ = 3.3 /cm. No fit can beat that.
   *
   * What is left at 0.15 mm is confined to the last centimetre of a pointed tip,
   * where the outline turns through ninety degrees and refinement bottoms out
   * against MIN_INTERVAL. Measured at this revision: shortboard 0.0032, funboard
   * 0.0040, longboard 0.0121, curvy 0.0027, box 0.0018 cm.
   */
  const TOL = 0.015;

  for (const name of ['shortboard', 'funboard', 'longboard']) {
    it(`stays within ${TOL} cm of the loft: ${name}`, () => {
      const board = loadBoard(name);
      const m = fitBoardSurface(board);
      expect(worstDeviation(board, m.plus)).toBeLessThan(TOL);
    });
  }

  it('stays within tolerance on a curvy synthetic board too', () => {
    const board = curvyBoard();
    expect(worstDeviation(board, fitBoardSurface(board).plus)).toBeLessThan(TOL);
  });

  it('self-reports a deviation of the right order', () => {
    // `deviation` is a sampled estimate, not a bound: the refiner probes a coarser
    // grid than this test does, so a finer sweep finds worse. Measured on the
    // funboard, the gap is about 3x. Pinning an order-of-magnitude agreement keeps
    // the number meaningful without pretending it is a guarantee — the guarantee is
    // the independent bound asserted above.
    const board = loadBoard('funboard');
    const m = fitBoardSurface(board);
    const independent = worstDeviation(board, m.plus);
    expect(independent).toBeLessThan(Math.max(m.deviation * 10, 0.005));
    expect(m.deviation).toBeLessThanOrEqual(independent * 1.001);
  });

  it('refines only when it helps, and never returns worse than the base fit', () => {
    const board = loadBoard('longboard');
    const base = fitBoardSurface(board, { tolerance: 0 });
    const refined = fitBoardSurface(board);
    expect(worstDeviation(board, refined.plus)).toBeLessThanOrEqual(
      worstDeviation(board, base.plus),
    );
  });
});

describe('fitBoardSurface: volume against the mesh', () => {
  /**
   * A topological check, not a metric one.
   *
   * Its value is that it is global: a transposed control net, an unmirrored half,
   * a patch wound the wrong way or a missing cap each move this by tens of percent
   * — the un-flipped mirror this test caught during development read as a 99.9%
   * error — and none of them move a pointwise probe near the fit nodes.
   *
   * 1.5% rather than something tighter because the two solids are different
   * discretisations of the same shape: the mesh is inscribed flat facets, the
   * fitted solid a smooth interpolant sampled on its own grid, and the residual
   * ~0.6% is that difference rather than a defect in either. Tightening it would
   * be measuring the test's sampling, not the surface.
   */
  for (const name of ['shortboard', 'funboard', 'longboard']) {
    it(`encloses the same volume as the mesh: ${name}`, () => {
      const board = loadBoard(name);
      const fitted = Math.abs(signedVolume(fittedSolid(fitBoardSurface(board))));
      const mesh = meshVolume(board);
      expect(Math.abs(fitted - mesh) / mesh).toBeLessThan(0.015);
    });
  }

  it('would notice a patch wound the wrong way', () => {
    // Guards the guard: if the winding convention were wrong the halves would
    // cancel, so this must not quietly pass.
    const board = loadBoard('shortboard');
    const m = fitBoardSurface(board);
    const tris = fittedSolid(m, 48);
    const flipped = tris.map(
      ([a, b, c], i) => (i % 4 < 2 ? [a, c, b] : [a, b, c]) as [Vert3, Vert3, Vert3],
    );
    expect(Math.abs(signedVolume(flipped))).toBeLessThan(Math.abs(signedVolume(tris)) * 0.5);
  });
});
