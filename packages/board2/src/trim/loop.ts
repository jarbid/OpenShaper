// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A board's outline as a closed loop in plan (docs/design/trim-blend-plan.md).
 *
 * The loop is given as smooth pieces, counter-clockwise with the board on the left, and a
 * radius for the corner after each piece. Every corner is replaced by an arc of that radius,
 * so the loop that comes out is tangent-continuous all the way round: nothing downstream
 * ever meets a point or a sharp corner. It is then resampled, finely where it turns tightly,
 * and given what the rail needs at every sample: the inward normal, the distance along the
 * loop, and the local feature size.
 *
 * The local feature size at a point is the radius of the largest disc that touches the loop
 * there from the inside and holds no other part of it: the distance to the medial axis. A
 * rail band narrower than that cannot reach the band from the opposite edge, which is what
 * keeps tips, pins and notch walls valid whatever the designer asks for.
 */
import { TRIM } from '../params';

/** 0 is an outer rail, 1 is a tail end or a notch wall: a stretch that carries its own rail. */
export type PieceKind = 0 | 1;

export interface LoopPiece {
  /** `[x0, y0, x1, y1, …]`, dense enough to be read as the curve. */
  readonly pts: Float64Array;
  readonly kind: PieceKind;
}

export interface LoopDef {
  /** Counter-clockwise, each ending where the next begins; the last ends where the first begins. */
  readonly pieces: readonly LoopPiece[];
  /** Radius of the corner after piece `i`, cm. 0 where the pieces join smoothly. */
  readonly corners: readonly number[];
}

export interface Loop {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Unit normal pointing into the board. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  /** Distance along the loop, cm; `n + 1` entries, the last being the perimeter. */
  readonly s: Float64Array;
  /** Local feature size, cm. */
  readonly lfs: Float64Array;
  readonly kind: Uint8Array;
  /** Which stretch a sample belongs to: pieces and corner arcs, numbered in order. */
  readonly seg: Uint16Array;
  /** 0 on a piece, +1 on a convex corner's arc, -1 on a concave one's. */
  readonly corner: Int8Array;
  readonly segments: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const count = (p: Float64Array): number => p.length / 2;

/** Where segments `ab` and `cd` cross, as fractions along each, or `null`. */
function segmentMeet(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { t: number; u: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < TRIM.parallel) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

interface Corner {
  /** Segment of the incoming piece the arc leaves from, and how far along it. */
  readonly iA: number;
  readonly tA: number;
  /** Segment of the outgoing piece the arc arrives on, and how far along it. */
  readonly iB: number;
  readonly tB: number;
  readonly cx: number;
  readonly cy: number;
  /** +1 convex (centre inside the board), -1 concave. */
  readonly side: 1 | -1;
  readonly r: number;
}

/** Each vertex of `p` moved `d` to its left (negative: right). */
function offset(p: Float64Array, d: number): Float64Array {
  const n = count(p);
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const tx = p[2 * b]! - p[2 * a]!;
    const ty = p[2 * b + 1]! - p[2 * a + 1]!;
    const l = Math.hypot(tx, ty) || 1;
    out[2 * i] = p[2 * i]! - (d * ty) / l;
    out[2 * i + 1] = p[2 * i + 1]! + (d * tx) / l;
  }
  return out;
}

/**
 * The arc of radius `r` tangent to the end of `a` and the start of `b`, found by offsetting
 * both by `r` towards the arc's centre and crossing the offsets. `null` where the two join
 * smoothly, or where no arc of that radius fits.
 */
function findCorner(a: Float64Array, b: Float64Array, r: number): Corner | null {
  const na = count(a);
  const nb = count(b);
  if (r <= 0 || na < 2 || nb < 2) return null;
  const tax = a[2 * na - 2]! - a[2 * na - 4]!;
  const tay = a[2 * na - 1]! - a[2 * na - 3]!;
  const tbx = b[2]! - b[0]!;
  const tby = b[3]! - b[1]!;
  const turn = (tax * tby - tay * tbx) / (Math.hypot(tax, tay) * Math.hypot(tbx, tby) || 1);
  if (Math.abs(turn) < TRIM.cornerMinTurn) return null;
  const side = turn > 0 ? 1 : -1;
  const reach = TRIM.cornerReachRadii * r + TRIM.cornerReach;
  const nearA: number[] = [];
  const nearB: number[] = [];
  let acc = 0;
  for (let i = na - 1; i > 0 && acc < reach; i--) {
    acc += Math.hypot(a[2 * i]! - a[2 * i - 2]!, a[2 * i + 1]! - a[2 * i - 1]!);
    nearA.push(i - 1);
  }
  acc = 0;
  for (let i = 0; i < nb - 1 && acc < reach; i++) {
    acc += Math.hypot(b[2 * i + 2]! - b[2 * i]!, b[2 * i + 3]! - b[2 * i + 1]!);
    nearB.push(i);
  }
  const oa = offset(a, side * r);
  const ob = offset(b, side * r);
  for (const i of nearA) {
    for (const j of nearB) {
      const hit = segmentMeet(
        oa[2 * i]!,
        oa[2 * i + 1]!,
        oa[2 * i + 2]!,
        oa[2 * i + 3]!,
        ob[2 * j]!,
        ob[2 * j + 1]!,
        ob[2 * j + 2]!,
        ob[2 * j + 3]!,
      );
      if (hit !== null) {
        return {
          iA: i,
          tA: hit.t,
          iB: j,
          tB: hit.u,
          side,
          r,
          cx: lerp(oa[2 * i]!, oa[2 * i + 2]!, hit.t),
          cy: lerp(oa[2 * i + 1]!, oa[2 * i + 3]!, hit.t),
        };
      }
    }
  }
  return null;
}

interface Dense {
  readonly x: number[];
  readonly y: number[];
  readonly kind: number[];
  readonly seg: number[];
  readonly corner: number[];
}

/** The pieces joined into one closed polyline, every corner replaced by its arc. */
function stitch(def: LoopDef): Dense {
  const m = def.pieces.length;
  const corners: (Corner | null)[] = [];
  for (let k = 0; k < m; k++) {
    let r = def.corners[k] ?? 0;
    let found: Corner | null = null;
    const a = def.pieces[k]!.pts;
    const b = def.pieces[(k + 1) % m]!.pts;
    for (
      let tries = 0;
      tries < TRIM.cornerRetries && r > TRIM.cornerFloor && found === null;
      tries++
    ) {
      found = findCorner(a, b, r);
      if (found === null) r *= TRIM.cornerShrink;
    }
    corners.push(found);
  }
  const out: Dense = { x: [], y: [], kind: [], seg: [], corner: [] };
  const push = (x: number, y: number, kind: number, seg: number, corner: number): void => {
    out.x.push(x);
    out.y.push(y);
    out.kind.push(kind);
    out.seg.push(seg);
    out.corner.push(corner);
  };
  let seg = 0;
  for (let k = 0; k < m; k++) {
    const piece = def.pieces[k]!;
    const p = piece.pts;
    const before = corners[(k + m - 1) % m] ?? null;
    const after = corners[k] ?? null;
    const first = before === null ? 0 : before.iB + 1;
    const last = after === null ? count(p) - 2 : after.iA;
    if (before !== null) {
      const i = before.iB;
      push(
        lerp(p[2 * i]!, p[2 * i + 2]!, before.tB),
        lerp(p[2 * i + 1]!, p[2 * i + 3]!, before.tB),
        piece.kind,
        seg,
        0,
      );
    }
    for (let i = first; i <= last; i++) push(p[2 * i]!, p[2 * i + 1]!, piece.kind, seg, 0);
    if (after !== null) {
      const next = def.pieces[(k + 1) % m]!;
      const q = next.pts;
      const ax = lerp(p[2 * after.iA]!, p[2 * after.iA + 2]!, after.tA);
      const ay = lerp(p[2 * after.iA + 1]!, p[2 * after.iA + 3]!, after.tA);
      const bx = lerp(q[2 * after.iB]!, q[2 * after.iB + 2]!, after.tB);
      const by = lerp(q[2 * after.iB + 1]!, q[2 * after.iB + 3]!, after.tB);
      push(ax, ay, piece.kind, seg, 0);
      seg++;
      const a0 = Math.atan2(ay - after.cy, ax - after.cx);
      let a1 = Math.atan2(by - after.cy, bx - after.cx);
      if (after.side > 0) while (a1 < a0) a1 += 2 * Math.PI;
      else while (a1 > a0) a1 -= 2 * Math.PI;
      const steps = Math.max(TRIM.cornerSteps, Math.ceil(Math.abs(a1 - a0) / TRIM.cornerStep));
      for (let j = 1; j < steps; j++) {
        const an = lerp(a0, a1, j / steps);
        push(
          after.cx + after.r * Math.cos(an),
          after.cy + after.r * Math.sin(an),
          j < steps / 2 ? piece.kind : next.kind,
          seg,
          after.side,
        );
      }
    }
    seg++;
  }
  return out;
}

/** The dense polyline resampled: fine where it turns tightly, and graded so no corner is stepped over. */
function resample(d: Dense, spacingMax: number): Dense {
  const n = d.x.length;
  const acc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    acc[i + 1] = acc[i]! + Math.hypot(d.x[k]! - d.x[i]!, d.y[k]! - d.y[i]!);
  }
  const total = acc[n]!;
  const h = new Float64Array(n);
  const w = TRIM.radiusWindow;
  for (let i = 0; i < n; i++) {
    const a = (i + n - w) % n;
    const c = (i + w) % n;
    const ux = d.x[i]! - d.x[a]!;
    const uy = d.y[i]! - d.y[a]!;
    const vx = d.x[c]! - d.x[i]!;
    const vy = d.y[c]! - d.y[i]!;
    const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
    const radius =
      turn < TRIM.straightTurn
        ? TRIM.straightRadius
        : (0.5 * (Math.hypot(ux, uy) + Math.hypot(vx, vy))) / turn;
    h[i] = Math.min(spacingMax, Math.max(TRIM.spacingMin, TRIM.spacingPerRadius * radius));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 2 * n; i++) {
      const a = i % n;
      const b = (i + 1) % n;
      h[b] = Math.min(h[b]!, h[a]! + TRIM.spacingGrade * (acc[a + 1]! - acc[a]!));
    }
    for (let i = 2 * n; i > 0; i--) {
      const a = i % n;
      const b = (i + n - 1) % n;
      h[b] = Math.min(h[b]!, h[a]! + TRIM.spacingGrade * (acc[b + 1]! - acc[b]!));
    }
  }
  const out: Dense = { x: [], y: [], kind: [], seg: [], corner: [] };
  let s = 0;
  let i = 0;
  let last = spacingMax;
  while (s < total - 0.5 * last) {
    while (acc[i + 1]! < s) i++;
    const k = (i + 1) % n;
    const f = (s - acc[i]!) / Math.max(TRIM.tiny, acc[i + 1]! - acc[i]!);
    out.x.push(lerp(d.x[i]!, d.x[k]!, f));
    out.y.push(lerp(d.y[i]!, d.y[k]!, f));
    out.kind.push(d.kind[i]!);
    out.seg.push(d.seg[i]!);
    out.corner.push(d.corner[i]!);
    last = h[i]! + f * (h[k]! - h[i]!);
    s += last;
  }
  return out;
}

/** What `buildLoop` can be asked for besides the outline. */
export interface LoopOptions {
  /** The widest sample spacing, cm, in place of `TRIM.spacingMax`: a smaller one gives a finer loop. */
  readonly spacingMax?: number;
}

/** Builds the loop: corners rounded, resampled, with normals, arc length and local feature size. */
export function buildLoop(def: LoopDef, options: LoopOptions = {}): Loop {
  const d = resample(stitch(def), options.spacingMax ?? TRIM.spacingMax);
  const n = d.x.length;
  const x = Float64Array.from(d.x);
  const y = Float64Array.from(d.y);
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const s = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const c = (i + 1) % n;
    const hm = Math.hypot(x[i]! - x[a]!, y[i]! - y[a]!);
    const hp = Math.hypot(x[c]! - x[i]!, y[c]! - y[i]!);
    // weighted so the tangent stays second-order accurate where the spacing changes
    const tx = (hm / hp) * (x[c]! - x[i]!) + (hp / hm) * (x[i]! - x[a]!);
    const ty = (hm / hp) * (y[c]! - y[i]!) + (hp / hm) * (y[i]! - y[a]!);
    const l = Math.hypot(tx, ty);
    nx[i] = -ty / l;
    ny[i] = tx / l;
    s[i + 1] = s[i]! + hp;
  }
  const lfs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let size: number = TRIM.featureCap;
    for (let j = 0; j < n; j++) {
      const gap = Math.abs(j - i);
      if (gap < TRIM.featureSkip || gap > n - TRIM.featureSkip) continue;
      const dx = x[j]! - x[i]!;
      const dy = y[j]! - y[i]!;
      const inward = dx * nx[i]! + dy * ny[i]!;
      if (inward > TRIM.featureInside) size = Math.min(size, (dx * dx + dy * dy) / (2 * inward));
    }
    lfs[i] = size;
  }
  const seg = Uint16Array.from(d.seg);
  return {
    n,
    x,
    y,
    nx,
    ny,
    s,
    lfs,
    kind: Uint8Array.from(d.kind),
    seg,
    corner: Int8Array.from(d.corner),
    segments: n > 0 ? seg[n - 1]! + 1 : 0,
  };
}

/**
 * `v` smoothed along the loop by a Gaussian of width `sigma` cm, wrapping round. A rail law
 * that changes at a corner is smoothed this way, so the blend has no kink to carry.
 */
export function smoothAlong(loop: Loop, v: ArrayLike<number>, sigma: number): Float64Array {
  const n = loop.n;
  const out = new Float64Array(n);
  const per = loop.s[n]!;
  for (let i = 0; i < n; i++) {
    let w = 0;
    let a = 0;
    for (let k = -TRIM.smoothReach; k <= TRIM.smoothReach; k++) {
      const j = (((i + k) % n) + n) % n;
      let ds = Math.abs(loop.s[j]! - loop.s[i]!);
      if (ds > per / 2) ds = per - ds;
      if (ds > 3 * sigma) continue;
      const g = Math.exp(-0.5 * (ds / sigma) * (ds / sigma));
      w += g;
      a += g * v[j]!;
    }
    out[i] = a / w;
  }
  return out;
}
