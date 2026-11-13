// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How closely a trim mesh's flat panel triangles follow the panels they stand for. Test-only.
 *
 * Each deck or bottom triangle is read at its centroid and its three edge midpoints: the
 * distance off the panel there is |panel height − the flat triangle's height|, the bottom with
 * its relief. A triangle's distance is the worst of its four. Triangles whose longest plan edge
 * is over `longFactor` times `spacing` are "long" and are counted apart from the rest, since a
 * triangle that spans far more than the grid is a sign of a bad triangulation rather than of the
 * grid.
 */
import { FACE } from '../solid';
import type { TrimMesh } from '../solid';

export interface FitStats {
  /** Panel triangles in the group. */
  readonly count: number;
  /** The longest plan edge in the group, cm. */
  readonly longestEdge: number;
  /** The worst and 99th-percentile distance off the panel, cm. */
  readonly worst: number;
  readonly p99: number;
  /** Where the worst is, in plan. */
  readonly at: readonly [number, number];
}

export interface PanelFit {
  readonly long: FitStats;
  readonly short: FitStats;
  /** Triangles with a corner on the band edge (the stitch, nearly all of it), and the rest. */
  readonly edge: FitStats;
  readonly inner: FitStats;
  /** All panel triangles together. */
  readonly all: FitStats;
}

const percentile = (sorted: Float64Array, q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** The panel triangles' fit to the panels; `spacing` is the panel grid (cm). */
export function panelFit(mesh: TrimMesh, spacing: number, longFactor = 2): PanelFit {
  const p = mesh.positions;
  const t = mesh.indices;
  const panels = mesh.panels;
  const r = new Float64Array(3);
  const height = (face: number, x: number, y: number): number => {
    if (face === FACE.deck) return panels.deck(x, y);
    let z = panels.bottom(x, y);
    if (panels.relief !== undefined) {
      panels.relief(x, y, r);
      z += r[0]!;
    }
    return z;
  };
  const group = () => ({ d: [] as number[], longest: 0, worst: 0, at: [0, 0] as [number, number] });
  const groups = [group(), group()];
  const sides = [group(), group()];
  // the band edge's places: each strip's first row
  const per = mesh.deckRows + mesh.tuckRows + 1;
  const key = (v: number): string => `${p[3 * v]},${p[3 * v + 1]},${p[3 * v + 2]}`;
  const rim = new Set<string>();
  for (let i = 0; i < mesh.loop.n; i++) {
    rim.add(key(per * i));
    rim.add(key(per * i + mesh.deckRows));
  }
  // barycentric weights of the centroid and the three edge midpoints
  const W: readonly (readonly [number, number, number])[] = [
    [1 / 3, 1 / 3, 1 / 3],
    [0.5, 0.5, 0],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
  ];
  for (let q = 0; q < t.length; q += 3) {
    const face = mesh.triFace[q / 3]!;
    if (face !== FACE.deck && face !== FACE.bottom) continue;
    const a = 3 * t[q]!;
    const b = 3 * t[q + 1]!;
    const c = 3 * t[q + 2]!;
    const l = (u: number, v: number): number => Math.hypot(p[v]! - p[u]!, p[v + 1]! - p[u + 1]!);
    const longest = Math.max(l(a, b), l(b, c), l(c, a));
    let worst = 0;
    let wx = 0;
    let wy = 0;
    for (const [ka, kb, kc] of W) {
      const x = ka * p[a]! + kb * p[b]! + kc * p[c]!;
      const y = ka * p[a + 1]! + kb * p[b + 1]! + kc * p[c + 1]!;
      const z = ka * p[a + 2]! + kb * p[b + 2]! + kc * p[c + 2]!;
      const d = Math.abs(height(face, x, y) - z);
      if (d > worst) {
        worst = d;
        wx = x;
        wy = y;
      }
    }
    const onRim = rim.has(key(t[q]!)) || rim.has(key(t[q + 1]!)) || rim.has(key(t[q + 2]!));
    for (const g of [groups[longest > longFactor * spacing ? 0 : 1]!, sides[onRim ? 0 : 1]!]) {
      g.d.push(worst);
      g.longest = Math.max(g.longest, longest);
      if (worst > g.worst) {
        g.worst = worst;
        g.at = [wx, wy];
      }
    }
  }
  const stats = (d: number[], longest: number, worst: number, at: [number, number]): FitStats => {
    const s = Float64Array.from(d).sort();
    return { count: d.length, longestEdge: longest, worst, p99: percentile(s, 0.99), at };
  };
  const [L, S] = groups as [(typeof groups)[0], (typeof groups)[0]];
  const all =
    L.worst > S.worst
      ? stats([...L.d, ...S.d], Math.max(L.longest, S.longest), L.worst, L.at)
      : stats([...L.d, ...S.d], Math.max(L.longest, S.longest), S.worst, S.at);
  return {
    long: stats(L.d, L.longest, L.worst, L.at),
    short: stats(S.d, S.longest, S.worst, S.at),
    edge: stats(sides[0]!.d, sides[0]!.longest, sides[0]!.worst, sides[0]!.at),
    inner: stats(sides[1]!.d, sides[1]!.longest, sides[1]!.worst, sides[1]!.at),
    all,
  };
}
