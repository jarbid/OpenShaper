// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board as a closed mesh: two trimmed panels and the rail between them
 * (docs/design/trim-blend-plan.md).
 *
 * The deck and the bottom are height fields over the plan. They know nothing of the outline,
 * so nothing in them has to bend to reach it. The outline trims them: at each of its samples
 * a deck blend runs from the deck, a band width in, down to the apex on the outline, and a
 * tuck runs from the bottom up to the same apex. Both end vertical there, so the apex is the
 * widest point and the plan silhouette is the outline as drawn.
 *
 * Above the apex the board is one height over the plan and below it another, so the surface
 * cannot fold over itself. The strips and the panels share their seam vertices' positions,
 * so the mesh is closed by construction; `checkClosed` says so, or says where it is not.
 */
import earcut from 'earcut';
import { TRIM } from '../params';
import type { Loop } from './loop';
import type { RailLaws } from './rails';

/** A deck and a bottom, each a height over the plan, defined out past the outline. */
export interface Panels {
  deck(x: number, y: number): number;
  bottom(x: number, y: number): number;
}

/**
 * Panels no thinner than `least` (cm). At each point the thickness `t = deck - bottom` becomes
 * `(t^p + least^p)^(1/p)`, or `least` where the panels touch or cross, spread evenly about
 * their mean, which does not move. The change is smooth, so it puts no crease in a panel, and
 * it is negligible where the board is a few times `least` thick. A tip then ends in a ball in
 * thickness as the loop already makes it one in plan. `least <= 0` returns the panels as given.
 */
export function withLeastThickness(
  panels: Panels,
  least: number,
  sharpness: number = TRIM.tipSharpness,
): Panels {
  if (!(least > 0)) return panels;
  // the power is taken of a ratio no larger than 1, so it cannot overflow
  const thicken = (t: number): number => {
    if (!(t > 0)) return least;
    const big = Math.max(t, least);
    const small = Math.min(t, least);
    return big * Math.pow(1 + Math.pow(small / big, sharpness), 1 / sharpness);
  };
  const at = (x: number, y: number): [number, number] => {
    const d = panels.deck(x, y);
    const b = panels.bottom(x, y);
    return [0.5 * (d + b), 0.5 * thicken(d - b)];
  };
  return {
    deck: (x, y) => {
      const [m, h] = at(x, y);
      return m + h;
    },
    bottom: (x, y) => {
      const [m, h] = at(x, y);
      return m - h;
    },
  };
}

/** Which face a vertex or a triangle belongs to. The tuck's faces are the deck blend's plus `tuck`. */
export const FACE = { deck: 0, bottom: 1, rail: 2, tail: 3, corner: 4, tuck: 3 } as const;

export interface TrimMesh {
  readonly positions: Float32Array;
  /** Exact surface normals, not averaged from the triangles. */
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexFace: Uint8Array;
  readonly triFace: Uint8Array;
  readonly loop: Loop;
  /** Rows across the deck blend and the tuck. Sample `i`'s strip vertices start at `i * (deckRows + tuckRows + 1)`: deck rows, tuck rows, then the apex. */
  readonly deckRows: number;
  readonly tuckRows: number;
  /** At each loop sample: where the deck's and the bottom's own tangents meet the outline wall, and the apex between them. */
  readonly wallTop: Float64Array;
  readonly wallBottom: Float64Array;
  readonly apex: Float64Array;
  /** The panels the mesh was built on: the caller's, held to the least thickness. Slice with these. */
  readonly panels: Panels;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** One side of the rail at one loop sample: where its blend leaves the panel and where it is going. */
interface BandEdge {
  readonly qx: number;
  readonly qy: number;
  readonly z: number;
  /** Shoulder height on the wall: the panel's tangent, raised or lowered by the edge. */
  shoulder: number;
  /** Height where the panel's own tangent meets the wall. */
  readonly tangent: number;
}

/**
 * Puts back the rim vertices a triangulation left out.
 *
 * The triangulator drops a vertex that is exactly in line with its neighbours, and on a real
 * board that happens: a squash tail's edge is straight, so the band edge along it is too. The
 * strip still uses those vertices, and the panel would be open along them. Each run of
 * dropped vertices lies on the edge of exactly one triangle, between the kept vertices either
 * side; that triangle is split into a fan through them. `t` indexes the rim's `m` vertices
 * first, in loop order.
 */
function restoreRim(t: number[], m: number): number[] {
  const used = new Uint8Array(m);
  for (const v of t) if (v < m) used[v] = 1;
  let any = false;
  for (let i = 0; i < m; i++) any ||= used[i] === 0;
  if (!any) return t;
  const out = t.slice();
  for (let start = 0; start < m; start++) {
    // the first dropped vertex of a run: its predecessor is kept
    if (used[start] !== 0 || used[(start + m - 1) % m] === 0) continue;
    const run: number[] = [];
    for (let i = start; used[i] === 0; i = (i + 1) % m) run.push(i);
    const u = (start + m - 1) % m;
    const w = (run[run.length - 1]! + 1) % m;
    for (let q = 0; q < out.length; q += 3) {
      const a = out[q]!;
      const b = out[q + 1]!;
      const c = out[q + 2]!;
      // which corner is opposite the edge u-w, and which way round the triangle runs it
      let x = -1;
      let forward = true;
      for (const [p, r, o] of [
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ] as const) {
        if (p === u && r === w) x = o;
        else if (p === w && r === u) {
          x = o;
          forward = false;
        }
      }
      if (x < 0) continue;
      const chain = forward ? [u, ...run, w] : [w, ...run.slice().reverse(), u];
      out[q] = chain[0]!;
      out[q + 1] = chain[1]!;
      out[q + 2] = x;
      for (let k = 1; k + 1 < chain.length; k++) out.push(chain[k]!, chain[k + 1]!, x);
      break;
    }
  }
  return out;
}

/** How finely the mesh is cut. */
export interface TrimMeshOptions {
  /** Rows across the deck blend and across the tuck. More rows follow a blend's curve more closely. */
  readonly deckRows?: number;
  readonly tuckRows?: number;
  /** The least thickness (cm) the panels are held to (`withLeastThickness`); 0 builds on the panels as given. */
  readonly leastThickness?: number;
}

/** Builds the mesh. `grid` is the panels' node spacing, cm. */
export function buildTrimMesh(
  loop: Loop,
  laws: RailLaws,
  given: Panels,
  grid: number,
  options: TrimMeshOptions = {},
): TrimMesh {
  const panels = withLeastThickness(given, options.leastThickness ?? TRIM.tipThickness);
  const n = loop.n;
  const nt = options.deckRows ?? TRIM.deckRows;
  const nb = options.tuckRows ?? TRIM.tuckRows;
  const pos: number[] = [];
  const nrm: number[] = [];
  const vface: number[] = [];
  const tri: number[] = [];
  const tface: number[] = [];
  const add = (x: number, y: number, z: number, f: number, a = 0, b = 0, c = 0): number => {
    pos.push(x, y, z);
    nrm.push(a, b, c);
    vface.push(f);
    return pos.length / 3 - 1;
  };
  const fieldNormal = (
    surf: (x: number, y: number) => number,
    sign: number,
    x: number,
    y: number,
  ): [number, number, number] => {
    const e = TRIM.normalStep;
    const dx = (surf(x + e, y) - surf(x - e, y)) / (2 * e);
    const dy = (surf(x, y + e) - surf(x, y - e)) / (2 * e);
    const l = Math.hypot(dx, dy, 1);
    return [(-sign * dx) / l, (-sign * dy) / l, sign / l];
  };

  // ---- the two strips ----
  const per = nt + nb + 1;
  const deckEdges: BandEdge[] = [];
  const tuckEdges: BandEdge[] = [];
  const wallTop = new Float64Array(n);
  const wallBottom = new Float64Array(n);
  const apex = new Float64Array(n);
  const bandEdge = (surf: (x: number, y: number) => number, i: number, width: number): BandEdge => {
    const e = TRIM.slopeStep;
    const qx = loop.x[i]! + width * loop.nx[i]!;
    const qy = loop.y[i]! + width * loop.ny[i]!;
    const z = surf(qx, qy);
    // the slope is read from the panel side only: past the band edge the panel has given way
    // to the rail, and a panel need not exist there at all
    const z1 = surf(qx + e * loop.nx[i]!, qy + e * loop.ny[i]!);
    const z2 = surf(qx + 2 * e * loop.nx[i]!, qy + 2 * e * loop.ny[i]!);
    const slope = (3 * z - 4 * z1 + z2) / (2 * e);
    const tangent = z + width * slope;
    return { qx, qy, z, tangent, shoulder: tangent };
  };
  for (let i = 0; i < n; i++) {
    let d = bandEdge(panels.deck, i, laws.deckWidth[i]!);
    let b = bandEdge(panels.bottom, i, laws.tuckWidth[i]!);
    const a = laws.apex[i]!;
    const za = b.tangent + a * (d.tangent - b.tangent);
    // A wall shorter than `wallMin`, or a negative one where the tangents cross, is opened to
    // `wallMin` about the apex. The blends then no longer leave their panels tangent here.
    // That is accepted: it happens only where the board is a knife edge, and there a blend
    // that cannot stand on a wall would fold the rail through itself.
    if (d.tangent - b.tangent < TRIM.wallMin) {
      const top = za + (1 - a) * TRIM.wallMin;
      const bottom = za - a * TRIM.wallMin;
      d = { ...d, tangent: top, shoulder: top };
      b = { ...b, tangent: bottom, shoulder: bottom };
    }
    // an edge leaves its panel at an angle, so its shoulder slides along the wall towards the apex, never past it
    d.shoulder = Math.max(
      d.tangent - laws.deckWidth[i]! * laws.deckEdge[i]!,
      za + TRIM.edgeShort * (d.tangent - za),
    );
    b.shoulder = Math.min(
      b.tangent + laws.tuckWidth[i]! * laws.bottomEdge[i]!,
      za - TRIM.edgeShort * (za - b.tangent),
    );
    deckEdges.push(d);
    tuckEdges.push(b);
    wallTop[i] = d.tangent;
    wallBottom[i] = b.tangent;
    apex[i] = za;
    const f = loop.corner[i] !== 0 ? FACE.corner : loop.kind[i] === 1 ? FACE.tail : FACE.rail;
    const strip = (h: BandEdge, rho: number, rows: number, face: number): void => {
      const w = rho / (1 - rho);
      for (let j = 0; j < rows; j++) {
        const t = j / rows;
        const s = 1 - t;
        const den = s * s + 2 * w * s * t + t * t;
        const k0 = (s * s) / den;
        const k1 = (2 * w * s * t) / den;
        const k2 = (t * t) / den;
        add(
          k0 * h.qx + (k1 + k2) * loop.x[i]!,
          k0 * h.qy + (k1 + k2) * loop.y[i]!,
          k0 * h.z + k1 * h.shoulder + k2 * za,
          face,
        );
      }
    };
    strip(d, laws.deckRho[i]!, nt, f);
    strip(b, laws.tuckRho[i]!, nb, f + FACE.tuck);
    add(loop.x[i]!, loop.y[i]!, za, f);
  }
  const deckAt = (i: number, j: number): number => per * i + j;
  const tuckAt = (i: number, j: number): number => per * i + nt + j;
  const apexAt = (i: number): number => per * i + nt + nb;

  // exact normals: across a strip, the conic's own start direction on its first row and its
  // neighbours after that; along it, the neighbouring samples; horizontal at the apex
  const setNormal = (id: number, x: number, y: number, z: number): void => {
    nrm[3 * id] = x;
    nrm[3 * id + 1] = y;
    nrm[3 * id + 2] = z;
  };
  for (let i = 0; i < n; i++) {
    const im = (i + n - 1) % n;
    const ip = (i + 1) % n;
    const ox = -loop.nx[i]!;
    const oy = -loop.ny[i]!;
    setNormal(apexAt(i), ox, oy, 0);
    for (const side of [0, 1] as const) {
      const rows = side === 0 ? nt : nb;
      const at = side === 0 ? deckAt : tuckAt;
      const h = side === 0 ? deckEdges[i]! : tuckEdges[i]!;
      const sign = side === 0 ? 1 : -1;
      for (let j = 0; j < rows; j++) {
        const a = at(ip, j);
        const b = at(im, j);
        const ax = pos[3 * a]! - pos[3 * b]!;
        const ay = pos[3 * a + 1]! - pos[3 * b + 1]!;
        const az = pos[3 * a + 2]! - pos[3 * b + 2]!;
        let bx: number;
        let by: number;
        let bz: number;
        if (j === 0) {
          bx = loop.x[i]! - h.qx;
          by = loop.y[i]! - h.qy;
          bz = h.shoulder - h.z;
        } else {
          const c = j + 1 < rows ? at(i, j + 1) : apexAt(i);
          const d = at(i, j - 1);
          bx = pos[3 * c]! - pos[3 * d]!;
          by = pos[3 * c + 1]! - pos[3 * d + 1]!;
          bz = pos[3 * c + 2]! - pos[3 * d + 2]!;
        }
        const cx = ay * bz - az * by;
        const cy = az * bx - ax * bz;
        const cz = ax * by - ay * bx;
        const l = Math.hypot(cx, cy, cz) || 1;
        const flip = cx * ox + cy * oy + cz * sign < 0 ? -1 : 1;
        setNormal(at(i, j), (flip * cx) / l, (flip * cy) / l, (flip * cz) / l);
      }
    }
  }
  const quad = (a: number, b: number, c: number, d: number, up: boolean, f: number): void => {
    if (up) tri.push(a, c, b, b, c, d);
    else tri.push(a, b, c, b, d, c);
    tface.push(f, f);
  };
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    for (let j = 0; j < nt; j++) {
      const last = j + 1 === nt;
      quad(
        deckAt(i, j),
        deckAt(k, j),
        last ? apexAt(i) : deckAt(i, j + 1),
        last ? apexAt(k) : deckAt(k, j + 1),
        true,
        vface[deckAt(i, 0)]!,
      );
    }
    for (let j = 0; j < nb; j++) {
      const last = j + 1 === nb;
      quad(
        tuckAt(i, j),
        tuckAt(k, j),
        last ? apexAt(i) : tuckAt(i, j + 1),
        last ? apexAt(k) : tuckAt(k, j + 1),
        false,
        vface[tuckAt(i, 0)]!,
      );
    }
  }

  // ---- the two panels: a grid inside the band edge, stitched to the band edge's own places ----
  const panel = (
    edges: readonly BandEdge[],
    surf: (x: number, y: number) => number,
    face: number,
    down: boolean,
  ): void => {
    const sign = down ? -1 : 1;
    // the panel gets its own seam vertices, in the strip's places, with the panel's normals:
    // a rail that leaves at an edge then shades as a crease
    const rim = edges.map((e) => {
      const q = fieldNormal(surf, sign, e.qx, e.qy);
      return add(e.qx, e.qy, e.z, face, q[0], q[1], q[2]);
    });
    const m = rim.length;
    const X = (i: number): number => pos[3 * rim[i]!]!;
    const Y = (i: number): number => pos[3 * rim[i]! + 1]!;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < m; i++) {
      x0 = Math.min(x0, X(i));
      x1 = Math.max(x1, X(i));
      y0 = Math.min(y0, Y(i));
      y1 = Math.max(y1, Y(i));
    }
    const h = grid;
    const nx = Math.ceil((x1 - x0) / h) + 2;
    const ny = Math.ceil((y1 - y0) / h) + 2;
    const gx = (i: number): number => x0 + (i - 0.5) * h;
    const gy = (j: number): number => y0 + (j - 0.5) * h;
    const inside = new Uint8Array((nx + 1) * (ny + 1));
    const blocked = new Uint8Array(nx * ny);
    for (let j = 0; j <= ny; j++) {
      const y = gy(j);
      const xs: number[] = [];
      for (let i = 0; i < m; i++) {
        const k = (i + 1) % m;
        const ya = Y(i);
        const yb = Y(k);
        if (ya > y !== yb > y) xs.push(X(i) + ((y - ya) / (yb - ya)) * (X(k) - X(i)));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        for (
          let i = Math.max(0, Math.ceil((xs[q]! - x0) / h + 0.5));
          i <= nx && gx(i) < xs[q + 1]!;
          i++
        ) {
          inside[j * (nx + 1) + i] = 1;
        }
      }
    }
    for (let i = 0; i < m; i++) {
      const k = (i + 1) % m;
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(X(k) - X(i), Y(k) - Y(i)) / (h * TRIM.blockStep)),
      );
      for (let q = 0; q <= steps; q++) {
        const cx = Math.floor((lerp(X(i), X(k), q / steps) - x0) / h + 0.5);
        const cy = Math.floor((lerp(Y(i), Y(k), q / steps) - y0) / h + 0.5);
        for (let a = -1; a <= 1; a++) {
          for (let b = -1; b <= 1; b++) {
            const ii = cx + a;
            const jj = cy + b;
            if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) blocked[jj * nx + ii] = 1;
          }
        }
      }
    }
    const keep = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        keep[j * nx + i] =
          blocked[j * nx + i] === 0 &&
          inside[a] === 1 &&
          inside[a + 1] === 1 &&
          inside[a + nx + 1] === 1 &&
          inside[a + nx + 2] === 1
            ? 1
            : 0;
      }
    }
    const kept = (i: number, j: number): boolean =>
      i >= 0 && j >= 0 && i < nx && j < ny && keep[j * nx + i] === 1;
    // two kept cells that touch only at a corner would give that corner two boundaries
    for (let pass = 0, changed = true; changed && pass < TRIM.pinchPasses; pass++) {
      changed = false;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = kept(i, j);
          const b = kept(i + 1, j);
          const c = kept(i, j + 1);
          const d = kept(i + 1, j + 1);
          if (a && d && !b && !c) {
            keep[j * nx + i] = 0;
            changed = true;
          } else if (b && c && !a && !d) {
            keep[j * nx + i + 1] = 0;
            changed = true;
          }
        }
      }
    }
    const vid = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
    const jitter = (i: number, j: number, k: number): number => {
      const q = Math.sin(i * 12.9898 + j * 78.233 + k * 37.719) * 43758.5453;
      return (q - Math.floor(q) - 0.5) * TRIM.gridJitter * h;
    };
    const node = (i: number, j: number): number => {
      const a = j * (nx + 1) + i;
      if (vid[a]! < 0) {
        const x = gx(i) + jitter(i, j, 1);
        const y = gy(j) + jitter(i, j, 2);
        const q = fieldNormal(surf, sign, x, y);
        vid[a] = add(x, y, surf(x, y), face, q[0], q[1], q[2]);
      }
      return vid[a]!;
    };
    const next = new Map<number, number>();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!kept(i, j)) continue;
        const a = node(i, j);
        const b = node(i + 1, j);
        const c = node(i, j + 1);
        const d = node(i + 1, j + 1);
        if (down) tri.push(a, c, b, b, c, d);
        else tri.push(a, b, c, b, d, c);
        tface.push(face, face);
        if (!kept(i, j - 1)) next.set(a, b);
        if (!kept(i + 1, j)) next.set(b, d);
        if (!kept(i, j + 1)) next.set(d, c);
        if (!kept(i - 1, j)) next.set(c, a);
      }
    }
    const rings: number[][] = [];
    const seen = new Set<number>();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const ring: number[] = [];
      let c: number | undefined = start;
      while (c !== undefined && !seen.has(c)) {
        seen.add(c);
        ring.push(c);
        c = next.get(c);
      }
      if (ring.length > 2) rings.push(ring);
    }
    // the gap between the band edge and the kept cells, triangulated on exactly those vertices
    const ids = rim.slice();
    const flat: number[] = [];
    const holes: number[] = [];
    for (let i = 0; i < m; i++) flat.push(X(i), Y(i));
    for (const ring of rings) {
      holes.push(ids.length);
      for (const v of ring) {
        ids.push(v);
        flat.push(pos[3 * v]!, pos[3 * v + 1]!);
      }
    }
    const t = restoreRim(earcut(flat, holes, 2), m);
    let area = 0;
    for (let q = 0; q < t.length; q += 3) {
      const a = ids[t[q]!]!;
      const b = ids[t[q + 1]!]!;
      const c = ids[t[q + 2]!]!;
      area +=
        (pos[3 * b]! - pos[3 * a]!) * (pos[3 * c + 1]! - pos[3 * a + 1]!) -
        (pos[3 * b + 1]! - pos[3 * a + 1]!) * (pos[3 * c]! - pos[3 * a]!);
    }
    // the triangulator winds every triangle the same way, so the winding is decided once
    const asIs = area > 0 !== down;
    for (let q = 0; q < t.length; q += 3) {
      const a = ids[t[q]!]!;
      const b = ids[t[q + 1]!]!;
      const c = ids[t[q + 2]!]!;
      if (asIs) tri.push(a, b, c);
      else tri.push(a, c, b);
      tface.push(face);
    }
  };
  panel(deckEdges, panels.deck, FACE.deck, false);
  panel(tuckEdges, panels.bottom, FACE.bottom, true);

  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    indices: Uint32Array.from(tri),
    vertexFace: Uint8Array.from(vface),
    triFace: Uint8Array.from(tface),
    loop,
    deckRows: nt,
    tuckRows: nb,
    wallTop,
    wallBottom,
    apex,
    panels,
  };
}

/**
 * Whether the mesh is a closed, consistently wound solid, and its volume in cubic cm.
 * `openEdges` counts edges that are not used exactly once in each direction; vertices in
 * exactly the same place count as one, since a seam has a vertex on each side of it.
 */
export function checkClosed(mesh: TrimMesh): { openEdges: number; volume: number } {
  const t = mesh.indices;
  const p = mesh.positions;
  const nv = p.length / 3;
  const place = new Map<string, number>();
  const id = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const key = `${p[3 * i]!},${p[3 * i + 1]!},${p[3 * i + 2]!}`;
    const first = place.get(key);
    if (first === undefined) {
      place.set(key, i);
      id[i] = i;
    } else {
      id[i] = first;
    }
  }
  const edges = new Map<number, number>();
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]!;
    const b = t[i + 1]!;
    const c = t[i + 2]!;
    const ia = id[a]!;
    const ib = id[b]!;
    const ic = id[c]!;
    for (const key of [ia * nv + ib, ib * nv + ic, ic * nv + ia]) {
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    volume +=
      (p[3 * a]! * (p[3 * b + 1]! * p[3 * c + 2]! - p[3 * b + 2]! * p[3 * c + 1]!) -
        p[3 * a + 1]! * (p[3 * b]! * p[3 * c + 2]! - p[3 * b + 2]! * p[3 * c]!) +
        p[3 * a + 2]! * (p[3 * b]! * p[3 * c + 1]! - p[3 * b + 1]! * p[3 * c]!)) /
      6;
  }
  let openEdges = 0;
  for (const [key, uses] of edges) {
    const u = Math.floor(key / nv);
    const v = key - u * nv;
    if (uses !== 1 || edges.get(v * nv + u) !== 1) openEdges++;
  }
  return { openEdges, volume };
}

/**
 * The cross-section at `x = x0` as unordered segments, five numbers each:
 * `y1, z1, y2, z2, face`. The strips are cut from the mesh. The panels are read straight
 * from their height fields between the band edges, so the section is exact where the panel
 * mesh is coarse.
 */
export function sliceX(mesh: TrimMesh, panels: Panels, x0: number): Float64Array {
  const t = mesh.indices;
  const p = mesh.positions;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const f = mesh.triFace[i / 3]!;
    if (f < FACE.rail) continue;
    const hit: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = t[i + e]!;
      const b = t[i + ((e + 1) % 3)]!;
      const xa = p[3 * a]! - x0;
      const xb = p[3 * b]! - x0;
      if (xa > 0 !== xb > 0) {
        const g = xa / (xa - xb);
        hit.push(lerp(p[3 * a + 1]!, p[3 * b + 1]!, g), lerp(p[3 * a + 2]!, p[3 * b + 2]!, g));
      }
    }
    if (hit.length === 4) out.push(hit[0]!, hit[1]!, hit[2]!, hit[3]!, f);
  }
  const per = mesh.deckRows + mesh.tuckRows + 1;
  const n = mesh.loop.n;
  const sides: readonly [number, (x: number, y: number) => number, number][] = [
    [0, panels.deck, FACE.deck],
    [mesh.deckRows, panels.bottom, FACE.bottom],
  ];
  for (const [row, surf, f] of sides) {
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = 3 * (per * i + row);
      const b = 3 * (per * ((i + 1) % n) + row);
      const xa = p[a]! - x0;
      const xb = p[b]! - x0;
      if (xa > 0 !== xb > 0) ys.push(lerp(p[a + 1]!, p[b + 1]!, xa / (xa - xb)));
    }
    ys.sort((u, v) => u - v);
    for (let q = 0; q + 1 < ys.length; q += 2) {
      const steps = Math.max(TRIM.sliceMin, Math.ceil((ys[q + 1]! - ys[q]!) / TRIM.sliceStep));
      for (let k = 0; k < steps; k++) {
        const ya = lerp(ys[q]!, ys[q + 1]!, k / steps);
        const yb = lerp(ys[q]!, ys[q + 1]!, (k + 1) / steps);
        out.push(ya, surf(x0, ya), yb, surf(x0, yb), f);
      }
    }
  }
  return Float64Array.from(out);
}
