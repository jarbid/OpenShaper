// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Vector files for the fin designer (owner request): SVG and EPS paths read as cubic
 * Béziers, then made into a profile, a foil, or a ghost's lines. Every point and handle
 * in the file is kept. Coordinates come out in cm, x to the right and y up, as drawn.
 *
 * A file holding several paths gives its largest for a profile or foil, as an icon's
 * eyes or a stray mark aren't the shape; a ghost shows them all.
 */
import { knot, splineFromKnots, vec2, type FinSection, type Spline } from '@openshaper/kernel';

interface P {
  readonly x: number;
  readonly y: number;
}
/** A cubic: start, handle, handle, end. */
type Seg = readonly [P, P, P, P];

export interface VectorPath {
  readonly segs: readonly Seg[];
  readonly closed: boolean;
}

export type VectorFacing = 'left' | 'right';

/** A file that can't be used, with the reason to show. */
export class VectorError extends Error {}

/** The affine map x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** `m` applied after `n`. */
const compose = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, p: P): P => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});

const line = (a: P, b: P): Seg => [
  a,
  { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
  { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 },
  b,
];
const same = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

/** Collects subpaths as a file draws them. */
class Pen {
  readonly paths: VectorPath[] = [];
  private segs: Seg[] = [];
  private start: P = { x: 0, y: 0 };
  at: P = { x: 0, y: 0 };

  move(p: P): void {
    this.finish(false);
    this.start = p;
    this.at = p;
  }
  line(p: P): void {
    if (!same(this.at, p)) this.segs.push(line(this.at, p));
    this.at = p;
  }
  curve(a: P, b: P, p: P): void {
    this.segs.push([this.at, a, b, p]);
    this.at = p;
  }
  close(): void {
    if (!same(this.at, this.start)) this.segs.push(line(this.at, this.start));
    this.at = this.start;
    this.finish(true);
  }
  finish(closed: boolean): void {
    if (this.segs.length) this.paths.push({ segs: this.segs, closed });
    this.segs = [];
  }
}

// ---- SVG path data ----------------------------------------------------------------

/** One arc as cubics (the SVG implementation notes' endpoint conversion). */
const arc = (
  pen: Pen,
  r0x: number,
  r0y: number,
  deg: number,
  large: boolean,
  sweep: boolean,
  to: P,
) => {
  const from = pen.at;
  if (same(from, to)) return;
  let rx = Math.abs(r0x);
  let ry = Math.abs(r0y);
  if (!rx || !ry) return pen.line(to);
  const phi = (deg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const grow = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (grow > 1) {
    rx *= Math.sqrt(grow);
    ry *= Math.sqrt(grow);
  }
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / (den || 1)));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const a0 = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx);
  let span = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - a0;
  if (sweep && span < 0) span += 2 * Math.PI;
  if (!sweep && span > 0) span -= 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2) - 1e-9));
  const step = span / n;
  const t = (4 / 3) * Math.tan(step / 4);
  const point = (a: number, ox = 0, oy = 0): P => {
    const ux = rx * (Math.cos(a) + ox);
    const uy = ry * (Math.sin(a) + oy);
    return { x: cos * ux - sin * uy + cx, y: sin * ux + cos * uy + cy };
  };
  for (let i = 0; i < n; i++) {
    const a = a0 + i * step;
    const b = a + step;
    pen.curve(
      point(a, -t * Math.sin(a), t * Math.cos(a)),
      point(b, t * Math.sin(b), -t * Math.cos(b)),
      i === n - 1 ? to : point(b),
    );
  }
};

/** The `d` of an SVG path, as subpaths. */
export const parsePathData = (d: string): VectorPath[] => {
  const pen = new Pen();
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const more = () => {
    skip();
    return i < d.length && /[-+.\d]/.test(d[i]!);
  };
  const num = (): number => {
    skip();
    const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(d.slice(i, i + 40));
    if (!m) throw new VectorError('This SVG has a path it can’t read.');
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): boolean => {
    skip();
    return d[i++] === '1';
  };
  let cmd = '';
  let handle: P | null = null; // the last curve's second handle, for S and T
  let quad = false;
  while (true) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i]!)) cmd = d[i++]!;
    else if (!cmd) throw new VectorError('This SVG has a path it can’t read.');
    const rel = cmd === cmd.toLowerCase();
    const point = (): P => {
      const x = num();
      const y = num();
      return rel ? { x: pen.at.x + x, y: pen.at.y + y } : { x, y };
    };
    const c = cmd.toUpperCase();
    let next: P | null = null;
    let nextQuad = false;
    if (c === 'Z') {
      pen.close();
      cmd = '';
    } else if (c === 'M') {
      pen.move(point());
      cmd = rel ? 'l' : 'L';
    } else if (c === 'L') pen.line(point());
    else if (c === 'H') {
      const v = num();
      pen.line({ x: rel ? pen.at.x + v : v, y: pen.at.y });
    } else if (c === 'V') {
      const v = num();
      pen.line({ x: pen.at.x, y: rel ? pen.at.y + v : v });
    } else if (c === 'C') {
      const a = point();
      const b = point();
      pen.curve(a, b, point());
      next = b;
    } else if (c === 'S') {
      const a =
        handle && !quad ? { x: 2 * pen.at.x - handle.x, y: 2 * pen.at.y - handle.y } : pen.at;
      const b = point();
      pen.curve(a, b, point());
      next = b;
    } else if (c === 'Q' || c === 'T') {
      const from = pen.at;
      const q: P =
        c === 'Q'
          ? point()
          : handle && quad
            ? { x: 2 * from.x - handle.x, y: 2 * from.y - handle.y }
            : from;
      const p = point();
      pen.curve(
        { x: from.x + ((q.x - from.x) * 2) / 3, y: from.y + ((q.y - from.y) * 2) / 3 },
        { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 },
        p,
      );
      next = q;
      nextQuad = true;
    } else if (c === 'A') {
      const rx = num();
      const ry = num();
      const deg = num();
      const large = flag();
      const sweep = flag();
      arc(pen, rx, ry, deg, large, sweep, point());
    } else throw new VectorError(`This SVG uses a path command it can’t read (${cmd}).`);
    handle = next;
    quad = nextQuad;
    if (c !== 'Z' && !more() && i < d.length && !/[a-zA-Z]/.test(d[i]!)) break;
  }
  pen.finish(false);
  return pen.paths;
};

// ---- SVG files ---------------------------------------------------------------------

const CM_PER = { mm: 0.1, cm: 1, in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6, px: 2.54 / 96 } as const;

/** An SVG length in cm; null for none, or a percentage. */
const lengthCm = (v: string | null): number | null => {
  const m = v ? /^\s*([\d.eE+-]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(v) : null;
  return m ? Number(m[1]) * CM_PER[(m[2] ?? 'px') as keyof typeof CM_PER] : null;
};

const nums = (s: string | null): number[] =>
  (s ?? '').match(/[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g)?.map(Number) ?? [];

const parseTransform = (s: string | null): Matrix => {
  let m = IDENTITY;
  for (const [, name, args] of (s ?? '').matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const a = nums(args!);
    const r = ((a[0] ?? 0) * Math.PI) / 180;
    let t: Matrix = IDENTITY;
    if (name === 'matrix' && a.length === 6) t = a as unknown as Matrix;
    else if (name === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (name === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (name === 'skewX') t = [1, 0, Math.tan(r), 1, 0, 0];
    else if (name === 'skewY') t = [1, Math.tan(r), 0, 1, 0, 0];
    else if (name === 'rotate') {
      t = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
      if (a.length === 3) {
        t = compose([1, 0, 0, 1, a[1]!, a[2]!], compose(t, [1, 0, 0, 1, -a[1]!, -a[2]!]));
      }
    }
    m = compose(m, t);
  }
  return m;
};

/** The element as path data, if it is a shape. */
const shapeData = (e: Element): string | null => {
  const n = (k: string) => Number(e.getAttribute(k) ?? 0);
  switch (e.localName) {
    case 'path':
      return e.getAttribute('d');
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const v = nums(e.getAttribute('points'));
      if (v.length < 4) return null;
      const pts = Array.from(
        { length: Math.floor(v.length / 2) },
        (_, i) => `${v[2 * i]} ${v[2 * i + 1]}`,
      );
      return `M${pts.join('L')}${e.localName === 'polygon' ? 'Z' : ''}`;
    }
    case 'rect':
      return `M${n('x')} ${n('y')}h${n('width')}v${n('height')}h${-n('width')}Z`;
    case 'circle':
    case 'ellipse': {
      const rx = e.localName === 'circle' ? n('r') : n('rx');
      const ry = e.localName === 'circle' ? n('r') : n('ry');
      const [cx, cy] = [n('cx'), n('cy')];
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    default:
      return null;
  }
};

const SKIPPED = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'title']);

export const parseSvg = (text: string): VectorPath[] => {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') {
    throw new VectorError('This isn’t a readable SVG file.');
  }
  const box = nums(root.getAttribute('viewBox'));
  const width = lengthCm(root.getAttribute('width'));
  const unit = box.length === 4 && width && box[2]! > 0 ? width / box[2]! : CM_PER.px;
  // To cm with y up: only the shape matters, so the file's own origin is kept.
  const out: VectorPath[] = [];
  const walk = (e: Element, parent: Matrix) => {
    if (SKIPPED.has(e.localName) || e.getAttribute('display') === 'none') return;
    const m = compose(parent, parseTransform(e.getAttribute('transform')));
    const data = shapeData(e);
    if (data) {
      for (const p of parsePathData(data)) {
        out.push({
          closed: p.closed,
          segs: p.segs.map((s) => s.map((q) => apply(m, q)) as unknown as Seg),
        });
      }
    }
    for (const c of Array.from(e.children)) walk(c, m);
  };
  walk(root, [unit, 0, 0, -unit, 0, 0]);
  return out;
};

// ---- EPS files ---------------------------------------------------------------------

/** PostScript as tokens: comments, strings and procedure bodies left out. */
const psTokens = (text: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c) || c === '[' || c === ']') i++;
    else if (c === '%') while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    else if (c === '(') {
      let depth = 0;
      do {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      } while (depth > 0 && i < text.length);
    } else if (c === '{') {
      let depth = 0;
      do {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      } while (depth > 0 && i < text.length);
    } else if (c === '<' || c === '>' || c === '}' || c === ')') i++;
    else {
      const start = i;
      while (i < text.length && !/[\s[\]{}()<>%]/.test(text[i]!)) i++;
      out.push(text.slice(start, i));
    }
  }
  return out;
};

/** The paths an EPS file paints: its moves, lines and curves, and any scaling of them. */
export const parseEps = (text: string): VectorPath[] => {
  if (!text.startsWith('%!') && !/^\s*%!/.test(text)) {
    throw new VectorError('This isn’t a readable EPS file.');
  }
  const unit = 2.54 / 72;
  let ctm: Matrix = [unit, 0, 0, unit, 0, 0];
  const saved: Matrix[] = [];
  let pen = new Pen();
  const painted: VectorPath[] = [];
  const stack: number[] = [];
  let user: P = { x: 0, y: 0 };
  const take = (n: number) => stack.splice(Math.max(0, stack.length - n), n);
  const device = (p: P) => apply(ctm, p);
  const moveTo = (p: P) => {
    user = p;
    pen.move(device(p));
  };
  const lineTo = (p: P) => {
    user = p;
    pen.line(device(p));
  };
  const curveTo = (a: P, b: P, p: P) => {
    user = p;
    pen.curve(device(a), device(b), device(p));
  };
  const rel = (x: number, y: number): P => ({ x: user.x + x, y: user.y + y });
  const paint = () => {
    pen.finish(false);
    painted.push(...pen.paths);
    pen = new Pen();
  };
  for (const t of psTokens(text)) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) {
      stack.push(Number(t));
      continue;
    }
    switch (t) {
      case 'moveto':
      case 'm': {
        const [x, y] = take(2);
        moveTo({ x: x!, y: y! });
        break;
      }
      case 'lineto':
      case 'l':
      case 'L': {
        const [x, y] = take(2);
        lineTo({ x: x!, y: y! });
        break;
      }
      case 'curveto':
      case 'c':
      case 'C': {
        const [a, b, c, e, x, y] = take(6);
        curveTo({ x: a!, y: b! }, { x: c!, y: e! }, { x: x!, y: y! });
        break;
      }
      case 'v':
      case 'V': {
        const [c, e, x, y] = take(4);
        curveTo(user, { x: c!, y: e! }, { x: x!, y: y! });
        break;
      }
      case 'y':
      case 'Y': {
        const [a, b, x, y] = take(4);
        curveTo({ x: a!, y: b! }, { x: x!, y: y! }, { x: x!, y: y! });
        break;
      }
      case 'rmoveto': {
        const [x, y] = take(2);
        moveTo(rel(x!, y!));
        break;
      }
      case 'rlineto': {
        const [x, y] = take(2);
        lineTo(rel(x!, y!));
        break;
      }
      case 'rcurveto': {
        const [a, b, c, e, x, y] = take(6);
        curveTo(rel(a!, b!), rel(c!, e!), rel(x!, y!));
        break;
      }
      case 'closepath':
      case 'h':
      case 'H':
        pen.close();
        break;
      case 'cm':
      case 'concat':
        ctm = compose(ctm, take(6) as unknown as Matrix);
        break;
      case 'translate': {
        const [x, y] = take(2);
        ctm = compose(ctm, [1, 0, 0, 1, x!, y!]);
        break;
      }
      case 'scale': {
        const [x, y] = take(2);
        ctm = compose(ctm, [x!, 0, 0, y!, 0, 0]);
        break;
      }
      case 'rotate': {
        const r = (take(1)[0]! * Math.PI) / 180;
        ctm = compose(ctm, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        break;
      }
      case 'q':
      case 'gsave':
        saved.push(ctm);
        break;
      case 'Q':
      case 'grestore':
        ctm = saved.pop() ?? ctm;
        break;
      case 'f':
      case 'F':
      case 'f*':
      case 'fill':
      case 'eofill':
      case 'S':
      case 's':
      case 'stroke':
      case 'B':
      case 'b':
      case 'B*':
      case 'b*':
        paint();
        break;
      case 'n':
      case 'N':
      case 'newpath':
        // A path that clips rather than paints.
        pen = new Pen();
        break;
      default:
        stack.length = 0;
    }
  }
  pen.finish(false);
  return painted.length ? painted : pen.paths;
};

/** The paths in a vector file, by its name and contents. */
export const parseVector = (name: string, text: string): VectorPath[] => {
  const eps = /\.(eps|ai|ps)$/i.test(name) || /^\s*%!/.test(text);
  const paths = eps ? parseEps(text) : parseSvg(text);
  if (paths.length === 0) {
    throw new VectorError(
      eps
        ? 'No paths found in this EPS. Save it uncompressed, with text outlined.'
        : 'No paths found in this SVG.',
    );
  }
  return paths;
};

// ---- Shapes ------------------------------------------------------------------------

const mapPath = (p: VectorPath, f: (q: P) => P): VectorPath => ({
  closed: p.closed,
  segs: p.segs.map((s) => s.map(f) as unknown as Seg),
});
const reversed = (segs: readonly Seg[]): Seg[] =>
  [...segs].reverse().map((s) => [s[3], s[2], s[1], s[0]] as const);
const anchors = (segs: readonly Seg[]) => [segs[0]![0], ...segs.map((s) => s[3])];

/** Facing left, as the views have them: a right-facing drawing mirrored. */
const facingLeft = (p: VectorPath, facing: VectorFacing): VectorPath =>
  facing === 'right' ? mapPath(p, (q) => ({ x: -q.x, y: q.y })) : p;

const boundsOf = (segs: readonly Seg[]) => {
  const pts = segs.flat();
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
};

const largest = (paths: readonly VectorPath[]): VectorPath => {
  const size = (p: VectorPath) => {
    const b = boundsOf(p.segs);
    return (b.maxX - b.minX) * (b.maxY - b.minY);
  };
  return paths.reduce((a, c) => (size(c) > size(a) ? c : a));
};

/** A handle within this of its knot is no handle (cm, or chords). */
const NO_HANDLE = 1e-7;
/** Handles lining up to within this (rad) make a smooth point. */
const SMOOTH = (3 * Math.PI) / 180;

/** A chain of cubics as a spline, every point and handle kept. */
const splineOf = (segs: readonly Seg[]): Spline => {
  const knots = anchors(segs).map((p, i) => {
    const prev = i > 0 ? segs[i - 1]![2] : p;
    const next = i < segs.length ? segs[i]![1] : p;
    const ax = p.x - prev.x;
    const ay = p.y - prev.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const smooth =
      i > 0 &&
      i < segs.length &&
      Math.hypot(ax, ay) > NO_HANDLE &&
      Math.hypot(bx, by) > NO_HANDLE &&
      Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) < SMOOTH;
    return knot(vec2(p.x, p.y), vec2(prev.x, prev.y), vec2(next.x, next.y), smooth);
  });
  return splineFromKnots(knots);
};

/** How near the base an end must be, as a share of the shape's height. */
const BASE_NEAR = 0.05;

/**
 * The drawing as the profile: leading-edge root first, the two ends on y = 0. A closed
 * shape's base (its lowest run of segments) is left out, the tab top being the base.
 * Facing left in the view is toward +x, the outline's nose.
 */
export const vectorOutline = (
  paths: readonly VectorPath[],
  facing: VectorFacing,
  scale = 1,
): Spline => {
  // The views draw the profile's +x (the nose) to the left, so a left-facing drawing is
  // mirrored into the outline's frame, and a right-facing one already matches it.
  const p = mapPath(
    facing === 'left' ? facingLeft(largest(paths), 'right') : largest(paths),
    (q) => ({
      x: q.x * scale,
      y: q.y * scale,
    }),
  );
  const { minY, maxY } = boundsOf(p.segs);
  const near = (q: P) => q.y - minY <= BASE_NEAR * (maxY - minY);
  let chain: Seg[];
  if (p.closed) {
    const n = p.segs.length;
    const low = p.segs.map((s) => near(s[0]) && near(s[3]));
    if (!low.some(Boolean)) {
      throw new VectorError(
        'Couldn’t find the base of this outline: it needs a line along the bottom.',
      );
    }
    if (low.every(Boolean)) throw new VectorError('This outline has no height.');
    // Start just after the lowest run.
    let start = 0;
    while (!(low[(start + n - 1) % n] && !low[start])) start++;
    const ring = Array.from({ length: n }, (_, i) => p.segs[(start + i) % n]!);
    chain = ring.slice(
      0,
      ring.findIndex((_, i) => low[(start + i) % n]),
    );
  } else {
    chain = [...p.segs];
    if (!near(chain[0]![0]) || !near(chain[chain.length - 1]![3])) {
      throw new VectorError('Both ends of this outline must be at the bottom, on the base.');
    }
  }
  if (chain[0]![0].x < chain[chain.length - 1]![3].x) chain = reversed(chain);
  // On the base: the lower end sets the level, and each end is set exactly on it, its
  // handle moving with it.
  const y0 = Math.min(chain[0]![0].y, chain[chain.length - 1]![3].y);
  const lifted = chain.map((s) => s.map((q) => ({ x: q.x, y: q.y - y0 })) as unknown as Seg);
  const a = lifted[0]!;
  lifted[0] = [{ x: a[0].x, y: 0 }, { x: a[1].x, y: a[1].y - a[0].y }, a[2], a[3]];
  const b = lifted[lifted.length - 1]!;
  lifted[lifted.length - 1] = [b[0], b[1], { x: b[2].x, y: b[2].y - b[3].y }, { x: b[3].x, y: 0 }];
  return splineOf(lifted);
};

/** The depth and base length (cm) a drawing would import at, at full size; null if it can't. */
export const vectorOutlineSize = (
  paths: readonly VectorPath[],
): { depth: number; base: number } | null => {
  try {
    const k = vectorOutline(paths, 'right').knots;
    const ys = vectorLines([largest(paths)], 'right', false)[0]!.map((q) => q.y);
    return {
      depth: Math.max(...ys) - Math.min(...ys),
      base: Math.abs(k[0]!.end.x - k[k.length - 1]!.end.x),
    };
  } catch {
    return null;
  }
};

const split = (s: Seg, t: number): [Seg, Seg] => {
  const mix = (a: P, b: P): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ab = mix(s[0], s[1]);
  const bc = mix(s[1], s[2]);
  const cd = mix(s[2], s[3]);
  const abc = mix(ab, bc);
  const bcd = mix(bc, cd);
  const m = mix(abc, bcd);
  return [
    [s[0], ab, abc, m],
    [m, bcd, cd, s[3]],
  ];
};

/** The ts in (0, 1) where a segment's x turns. */
const xTurns = (s: Seg): number[] => {
  const [p0, p1, p2, p3] = s.map((q) => q.x) as [number, number, number, number];
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  if (Math.abs(a) < 1e-14)
    return Math.abs(b) < 1e-14 ? [] : [-c / b].filter((t) => t > 1e-6 && t < 1 - 1e-6);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const r = Math.sqrt(disc);
  return [(-b - r) / (2 * a), (-b + r) / (2 * a)]
    .filter((t) => t > 1e-6 && t < 1 - 1e-6)
    .sort((u, v) => u - v);
};

/** A ring cut at every x turn, so the leading and trailing edges are points of it. */
const cutAtTurns = (segs: readonly Seg[]): Seg[] =>
  segs.flatMap((s) => {
    const out: Seg[] = [];
    let rest = s;
    let done = 0;
    for (const t of xTurns(s)) {
      const [a, b] = split(rest, (t - done) / (1 - done));
      out.push(a);
      rest = b;
      done = t;
    }
    return [...out, rest];
  });

const anchorAtX = (segs: readonly Seg[], most: 1 | -1): number => {
  let best = 0;
  segs.forEach((s, i) => {
    if ((s[0].x - segs[best]![0].x) * most > 0) best = i;
  });
  return best;
};

/** Chain `a` on a chord from its first point (0, 0) to its last (1, 0), both exactly. */
const onChord = (chain: readonly Seg[], le: P, te: P): Seg[] => {
  const dx = te.x - le.x;
  const dy = te.y - le.y;
  const c2 = dx * dx + dy * dy || 1;
  const put = (q: P): P => ({
    x: ((q.x - le.x) * dx + (q.y - le.y) * dy) / c2,
    y: (-(q.x - le.x) * dy + (q.y - le.y) * dx) / c2,
  });
  const out = chain.map((s) => s.map(put) as unknown as Seg);
  const f = out[0]!;
  out[0] = [{ x: 0, y: 0 }, f[1], f[2], f[3]];
  const l = out[out.length - 1]!;
  out[out.length - 1] = [l[0], l[1], l[2], { x: 1, y: 0 }];
  return out;
};

const flat = (): Spline => splineOf([line({ x: 0, y: 0 }, { x: 1, y: 0 })]);

const meanY = (segs: readonly Seg[]) =>
  anchors(segs).reduce((t, q) => t + q.y, 0) / (segs.length + 1);

/**
 * The drawing as a foil: leading edge at x 0, trailing edge at x 1, the upper face the
 * outside. A closed shape is cut at its leading and trailing edges into two faces; an open
 * one is the outside face over a flat inside. A centre fin's is symmetric: its outside
 * face, mirrored.
 */
export const vectorFoil = (
  paths: readonly VectorPath[],
  facing: VectorFacing,
  symmetric: boolean,
): FinSection => {
  const p = facingLeft(largest(paths), facing);
  if (p.closed) {
    // Square to the chord first, so the edges found are the foil's, not a tilted one's.
    const rough = cutAtTurns(p.segs);
    const a = rough[anchorAtX(rough, -1)]![0];
    const b = rough[anchorAtX(rough, 1)]![0];
    const tilt = Math.atan2(b.y - a.y, b.x - a.x);
    const [c, s] = [Math.cos(-tilt), Math.sin(-tilt)];
    const level = cutAtTurns(
      mapPath(p, (q) => ({ x: c * q.x - s * q.y, y: s * q.x + c * q.y })).segs,
    );
    const n = level.length;
    const iL = anchorAtX(level, -1);
    const iT = anchorAtX(level, 1);
    const ring = Array.from({ length: n }, (_, i) => level[(iL + i) % n]!);
    const cut = (iT - iL + n) % n;
    const one = ring.slice(0, cut);
    const two = reversed(ring.slice(cut));
    if (!one.length || !two.length) throw new VectorError('Couldn’t find this foil’s two faces.');
    const le = ring[0]![0];
    const te = ring[cut]![0];
    const upper = meanY(one) >= meanY(two) ? one : two;
    const lower = upper === one ? two : one;
    return {
      outside: splineOf(onChord(upper, le, te)),
      inside: symmetric ? null : splineOf(onChord(lower, le, te)),
    };
  }
  let chain = [...p.segs];
  if (chain[0]![0].x > chain[chain.length - 1]![3].x) chain = reversed(chain);
  const le = chain[0]![0];
  const te = chain[chain.length - 1]![3];
  let face = onChord(chain, le, te);
  if (meanY(face) < 0)
    face = face.map((s) => s.map((q) => ({ x: q.x, y: -q.y })) as unknown as Seg);
  return { outside: splineOf(face), inside: symmetric ? null : flat() };
};

/** Polylines of every path (cm, or chords), facing left. */
export const vectorLines = (
  paths: readonly VectorPath[],
  facing: VectorFacing,
  mirrorForProfile: boolean,
): P[][] =>
  paths.map((path) => {
    const p = facingLeft(path, facing);
    const flip = mirrorForProfile ? -1 : 1;
    const out: P[] = [{ x: flip * p.segs[0]![0].x, y: p.segs[0]![0].y }];
    for (const s of p.segs) {
      for (let k = 1; k <= 24; k++) {
        const t = k / 24;
        const u = 1 - t;
        const at = (a: number, b: number, c: number, d: number) =>
          u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
        out.push({
          x: flip * at(s[0].x, s[1].x, s[2].x, s[3].x),
          y: at(s[0].y, s[1].y, s[2].y, s[3].y),
        });
      }
    }
    return out;
  });
