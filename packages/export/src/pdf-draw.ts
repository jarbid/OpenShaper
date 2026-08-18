// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A **centimetre-coordinate drawing context** over a PDF content stream, plus the two
 * page builders that use it: {@link buildDrawing} (page sized to the artwork) and
 * {@link buildFixedPage} (artwork placed on a chosen sheet).
 *
 * Everything here draws at **true 1:1** — one centimetre of board is
 * {@link POINTS_PER_CM} points on the page, always, with no fit-to-page anywhere. That
 * is the whole point of a printed shaping template: the shaper measures the paper.
 *
 * This started life inside `board-pdf.ts` and was lifted out unchanged so the rail-bands
 * sheet could draw the same way rather than grow a second dialect of the same operators.
 * `board-pdf.ts` still owns its part/tiling vocabulary; only the pen moved.
 */
import { esc, n, type PageDoc } from './pdf-core';
import { POINTS_PER_CM, type PaperSize } from './paper';
import type { CurveSeg, Pt } from './board-curves';

const CM_TO_PT = POINTS_PER_CM;

/** An RGB colour, components 0..1 — the PDF `rg`/`RG` operand order. */
export type Rgb = readonly [number, number, number];

/**
 * Line styles. `centre` is the dash-dot of a drafting centreline, which is how a
 * station reference line has to read: a shaper should never mistake it for an edge.
 */
export type DashStyle = 'solid' | 'dashed' | 'centre';

export interface DrawOpts {
  closed?: boolean;
  /**
   * Paint the enclosed area as well as (or instead of) stroking it. A grey level or an
   * RGB triple; `stroke: false` fills without an outline.
   */
  fill?: Rgb | number;
  /** Set false to fill only. Default true. */
  stroke?: boolean;
  /** Shorthand for `dash: 'dashed'`, kept because the 1:1 board PDF is written in it. */
  dashed?: boolean;
  dash?: DashStyle;
  width?: number;
  /** Grey level 0..1. Ignored when `color` is set. */
  gray?: number;
  color?: Rgb;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How a dimension is laid out. */
export interface DimOpts {
  /** Text size; defaults to 7 pt. */
  sizePt?: number;
  gray?: number;
  color?: Rgb;
  /** Extra room between the dimension line and its label (cm). */
  labelGapCm?: number;
}

/** How a run of text is placed and painted. */
export interface TextOpts {
  sizePt?: number;
  gray?: number;
  color?: Rgb;
  align?: 'left' | 'center' | 'right';
  /**
   * Paint an opaque box behind the text first. A dimension label almost always lands on
   * top of the geometry it is dimensioning, and an unreadable number on a shaping
   * template is worse than no number.
   */
  knockout?: boolean;
  /** Padding around a knocked-out label, in cm. Default 0.05 (0.5 mm). */
  knockoutPadCm?: number;
}

/** A table column: its width in cm and how its cells sit in it. */
export interface TableCol {
  widthCm: number;
  align?: 'left' | 'right' | 'center';
}

export interface TableOpts {
  sizePt?: number;
  rowHeightCm?: number;
  /** Draw a rule under the first row. Default true. */
  headerRule?: boolean;
  /** Draw a rule under every row. Default false. */
  rowRules?: boolean;
  gray?: number;
}

export interface DrawCtx {
  poly(pts: readonly Pt[], opts?: DrawOpts): void;
  /** Draw a path of exact cubic-bezier segments (smooth, resolution-independent). */
  bezier(segs: readonly CurveSeg[], opts?: DrawOpts): void;
  seg(a: Pt, b: Pt, opts?: DrawOpts): void;
  label(at: Pt, str: string, sizePt?: number, gray?: number): void;
  /** Label centred on `at`, rather than starting there. */
  labelCenter(at: Pt, str: string, sizePt?: number, gray?: number): void;
  /** Label ending at `at`. */
  labelRight(at: Pt, str: string, sizePt?: number, gray?: number): void;
  /** The general form: alignment, colour, and an optional opaque backing box. */
  text(at: Pt, str: string, opts?: TextOpts): void;
  rect(box: Box, opts?: DrawOpts): void;
  /** A filled disc — station markers, touch points. */
  dot(at: Pt, radiusCm: number, gray?: number, color?: Rgb): void;
  /** A filled arrowhead at `at`, pointing along `dirRad`. */
  arrow(at: Pt, dirRad: number, sizeCm?: number, gray?: number, color?: Rgb): void;
  /** A short witness stroke centred on `at`, perpendicular to nothing in particular. */
  tick(at: Pt, dirRad: number, lenCm: number, opts?: DrawOpts): void;
  /** A dimension between two points, its line offset perpendicular by `offsetCm`. */
  dim(a: Pt, b: Pt, offsetCm: number, text: string, opts?: DimOpts): void;
  /**
   * A dimension whose far end is off the sheet: drawn `shownCm` long from `a` toward `b`,
   * ended with a drafting break, and labelled with the true distance.
   *
   * The number is still exact — only the drawing of it is interrupted. That is the right
   * trade for a mark measured with a tape from the deck corner, and it keeps the page at
   * 1:1 for the rail, which is the part actually traced.
   */
  dimBroken(a: Pt, b: Pt, offsetCm: number, shownCm: number, text: string, opts?: DimOpts): void;
  /** A dimension of `distCm` from `origin` along `dirRad` — the chained-mark form. */
  dimAlong(
    origin: Pt,
    dirRad: number,
    distCm: number,
    offsetCm: number,
    text: string,
    opts?: DimOpts,
  ): void;
  /** Draw a table with its top-left at (x, yTop); returns the y its last row ended on. */
  table(
    x: number,
    yTop: number,
    cols: readonly TableCol[],
    rows: readonly (readonly string[])[],
    opts?: TableOpts,
  ): number;
  /** Run `body` with drawing clipped to `box`. */
  clip(box: Box, body: () => void): void;
}

/**
 * Helvetica advance widths average close to half the point size across the digits,
 * spaces and short words these sheets use. Only `/F1` is embedded and there is no
 * widths dictionary to consult, so centring is estimated — good enough for a label,
 * and never load-bearing for a measurement.
 */
const textWidthPt = (str: string, sizePt: number): number => str.length * sizePt * 0.5;

/** Stroke colour operand: an explicit colour wins, otherwise the grey level. */
const strokeOp = (opts: { gray?: number; color?: Rgb }): string => {
  const c = opts.color;
  if (c) return `${n(c[0])} ${n(c[1])} ${n(c[2])} RG`;
  const g = opts.gray ?? 0;
  return `${n(g)} ${n(g)} ${n(g)} RG`;
};

/** Fill colour operand, same rule. */
const fillOp = (opts: { gray?: number; color?: Rgb }): string => {
  const c = opts.color;
  if (c) return `${n(c[0])} ${n(c[1])} ${n(c[2])} rg`;
  const g = opts.gray ?? 0;
  return `${n(g)} ${n(g)} ${n(g)} rg`;
};

const dashOp = (opts: DrawOpts): string => {
  const style = opts.dash ?? (opts.dashed ? 'dashed' : 'solid');
  if (style === 'dashed') return '[4 3] 0 d';
  if (style === 'centre') return '[7 2 1.5 2] 0 d';
  return '[] 0 d';
};

/** Page geometry shared by both builders. */
interface Frame {
  widthPt: number;
  heightPt: number;
  /** cm → pt, x. */
  px: (x: number) => number;
  /** cm → pt, y (PDF is y-up, same as cm here). */
  py: (y: number) => number;
}

/** The content stream plus its page size, before it becomes a `PageDoc` or a `PartDrawing`. */
export interface Drawing {
  widthPt: number;
  heightPt: number;
  content: string;
}

/** Chrome drawn around the artwork by both builders, in the page margin. */
export interface DrawingChrome {
  /** Printed top-left at 12 pt black. */
  title?: string;
  /** Printed bottom-left at 8 pt grey — board name, scale, units, brand line. */
  note?: string;
  /** Draw a 1:1 calibration ruler in the bottom-right margin. */
  calibration?: boolean;
  /** Calibration ruler in inches rather than centimetres. */
  inches?: boolean;
}

/**
 * Draw a 1:1 calibration ruler in the bottom-right margin so the shaper can verify a
 * 100% print. A template that printed at 97% would otherwise look perfectly fine.
 */
export const drawCalibration = (
  c: string[],
  width: number,
  inches: boolean,
  marginCm: number,
): void => {
  const sideCm = inches ? 2.54 * 2 : 5; // a 2 in / 5 cm reference length
  const side = sideCm * CM_TO_PT;
  const label = inches ? '2 in @100%' : '5 cm @100%';
  const yb = marginCm * CM_TO_PT * 0.55;
  const x1 = width - marginCm * CM_TO_PT;
  const x0 = x1 - side;
  const tick = 4;
  c.push(
    '0 0 0 RG',
    '0.5 w',
    '[] 0 d',
    `${n(x0)} ${n(yb)} m`,
    `${n(x1)} ${n(yb)} l`,
    `${n(x0)} ${n(yb - tick)} m`,
    `${n(x0)} ${n(yb + tick)} l`,
    `${n(x1)} ${n(yb - tick)} m`,
    `${n(x1)} ${n(yb + tick)} l`,
    'S',
    '0.4 0.4 0.4 rg',
    'BT',
    '/F1 7 Tf',
    `${n(x0)} ${n(yb + tick + 2)} Td`,
    `(${esc(label)}) Tj`,
    'ET',
  );
};

/** Build a content stream on `frame`, wrapped in the standard title/note/ruler chrome. */
const compose = (
  frame: Frame,
  marginCm: number,
  chrome: DrawingChrome,
  draw: (ctx: DrawCtx) => void,
): Drawing => {
  const { widthPt: width, heightPt: height, px, py } = frame;
  const c: string[] = [];
  const ctx: DrawCtx = {
    poly(pts, opts = {}) {
      if (pts.length < 2) return;
      const stroke = opts.stroke ?? true;
      if (opts.fill !== undefined) {
        c.push(fillOp(typeof opts.fill === 'number' ? { gray: opts.fill } : { color: opts.fill }));
      }
      c.push(strokeOp(opts), `${n(opts.width ?? 0.5)} w`, dashOp(opts));
      c.push(`${n(px(pts[0]!.x))} ${n(py(pts[0]!.y))} m`);
      for (let i = 1; i < pts.length; i++) c.push(`${n(px(pts[i]!.x))} ${n(py(pts[i]!.y))} l`);
      // A fill always closes its own path, so `h` is only worth emitting for the stroke.
      if (opts.fill !== undefined) c.push(stroke ? 'b' : 'f');
      else c.push(opts.closed ? 'h S' : 'S');
    },
    bezier(segs, opts = {}) {
      if (segs.length === 0) return;
      c.push(strokeOp(opts), `${n(opts.width ?? 0.5)} w`, dashOp(opts));
      let cur = segs[0]!.p0;
      c.push(`${n(px(cur.x))} ${n(py(cur.y))} m`);
      for (const s of segs) {
        // Bridge any discontinuity between segments with a straight edge (tail/nose cut).
        if (s.p0.x !== cur.x || s.p0.y !== cur.y) c.push(`${n(px(s.p0.x))} ${n(py(s.p0.y))} l`);
        c.push(
          `${n(px(s.c1.x))} ${n(py(s.c1.y))} ${n(px(s.c2.x))} ${n(py(s.c2.y))} ${n(px(s.p3.x))} ${n(py(s.p3.y))} c`,
        );
        cur = s.p3;
      }
      c.push(opts.closed ? 'h S' : 'S');
    },
    seg(a, b, opts = {}) {
      ctx.poly([a, b], opts);
    },
    text(at, str, opts = {}) {
      if (str === '') return;
      const sizePt = opts.sizePt ?? 8;
      const w = textWidthPt(str, sizePt);
      const align = opts.align ?? 'left';
      const x0 = px(at.x) - (align === 'center' ? w / 2 : align === 'right' ? w : 0);
      const y0 = py(at.y);
      if (opts.knockout) {
        // Opaque white box first, so the label reads over whatever it crosses.
        const pad = (opts.knockoutPadCm ?? 0.05) * CM_TO_PT;
        c.push(
          '1 1 1 rg',
          `${n(x0 - pad)} ${n(y0 - sizePt * 0.25 - pad)} ${n(w + 2 * pad)} ${n(sizePt * 1.05 + 2 * pad)} re`,
          'f',
        );
      }
      c.push(
        fillOp({ gray: opts.gray ?? 0.35, color: opts.color }),
        'BT',
        `/F1 ${n(sizePt)} Tf`,
        `${n(x0)} ${n(y0)} Td`,
        `(${esc(str)}) Tj`,
        'ET',
      );
    },
    label(at, str, sizePt = 8, gray = 0.35) {
      ctx.text(at, str, { sizePt, gray });
    },
    labelCenter(at, str, sizePt = 8, gray = 0.35) {
      ctx.text(at, str, { sizePt, gray, align: 'center' });
    },
    labelRight(at, str, sizePt = 8, gray = 0.35) {
      ctx.text(at, str, { sizePt, gray, align: 'right' });
    },
    rect(box, opts = {}) {
      ctx.poly(
        [
          { x: box.minX, y: box.minY },
          { x: box.maxX, y: box.minY },
          { x: box.maxX, y: box.maxY },
          { x: box.minX, y: box.maxY },
        ],
        { ...opts, closed: true },
      );
    },
    dot(at, radiusCm, gray = 0, color) {
      const r = radiusCm * CM_TO_PT;
      const k = r * 0.5522847498307933;
      const x = px(at.x);
      const y = py(at.y);
      c.push(
        fillOp({ gray, color }),
        `${n(x + r)} ${n(y)} m`,
        `${n(x + r)} ${n(y + k)} ${n(x + k)} ${n(y + r)} ${n(x)} ${n(y + r)} c`,
        `${n(x - k)} ${n(y + r)} ${n(x - r)} ${n(y + k)} ${n(x - r)} ${n(y)} c`,
        `${n(x - r)} ${n(y - k)} ${n(x - k)} ${n(y - r)} ${n(x)} ${n(y - r)} c`,
        `${n(x + k)} ${n(y - r)} ${n(x + r)} ${n(y - k)} ${n(x + r)} ${n(y)} c`,
        'f',
      );
    },
    arrow(at, dirRad, sizeCm = 0.22, gray = 0, color) {
      // A slim isoceles triangle with its tip on `at`, pointing along dirRad.
      const s = sizeCm;
      const ux = Math.cos(dirRad);
      const uy = Math.sin(dirRad);
      const backX = at.x - ux * s;
      const backY = at.y - uy * s;
      const halfW = s * 0.32;
      const p1 = { x: backX - uy * halfW, y: backY + ux * halfW };
      const p2 = { x: backX + uy * halfW, y: backY - ux * halfW };
      c.push(
        fillOp({ gray, color }),
        `${n(px(at.x))} ${n(py(at.y))} m`,
        `${n(px(p1.x))} ${n(py(p1.y))} l`,
        `${n(px(p2.x))} ${n(py(p2.y))} l`,
        'h f',
      );
    },
    tick(at, dirRad, lenCm, opts = {}) {
      const dx = (Math.cos(dirRad) * lenCm) / 2;
      const dy = (Math.sin(dirRad) * lenCm) / 2;
      ctx.seg({ x: at.x - dx, y: at.y - dy }, { x: at.x + dx, y: at.y + dy }, opts);
    },
    dim(a, b, offsetCm, text, opts = {}) {
      const sizePt = opts.sizePt ?? 7;
      const gray = opts.gray ?? 0.2;
      const color = opts.color;
      const pen = { gray, color };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) return;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const nx = -uy;
      const ny = ux;
      const A = { x: a.x + nx * offsetCm, y: a.y + ny * offsetCm };
      const B = { x: b.x + nx * offsetCm, y: b.y + ny * offsetCm };
      // Witness lines run from the measured points a little past the dimension line.
      const over = offsetCm >= 0 ? 0.12 : -0.12;
      ctx.seg(a, { x: A.x + nx * over, y: A.y + ny * over }, { width: 0.3, ...pen });
      ctx.seg(b, { x: B.x + nx * over, y: B.y + ny * over }, { width: 0.3, ...pen });
      ctx.seg(A, B, { width: 0.35, ...pen });
      // Under about 12 mm the heads collide, so they swap to the outside and point in.
      const tight = len < 1.2;
      const head = Math.min(0.22, len * 0.35);
      const dir = Math.atan2(uy, ux);
      if (tight) {
        const outA = { x: A.x - ux * head * 1.6, y: A.y - uy * head * 1.6 };
        const outB = { x: B.x + ux * head * 1.6, y: B.y + uy * head * 1.6 };
        ctx.seg(outA, A, { width: 0.35, ...pen });
        ctx.seg(B, outB, { width: 0.35, ...pen });
        ctx.arrow(A, dir, head, gray, color);
        ctx.arrow(B, dir + Math.PI, head, gray, color);
      } else {
        ctx.arrow(A, dir + Math.PI, head, gray, color);
        ctx.arrow(B, dir, head, gray, color);
      }
      const gap = opts.labelGapCm ?? 0.14;
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const side = offsetCm >= 0 ? 1 : -1;
      const at = tight
        ? { x: B.x + ux * head * 2 + nx * gap * side, y: B.y + uy * head * 2 + ny * gap * side }
        : { x: mid.x + nx * gap * side, y: mid.y + ny * gap * side };
      // Always knocked out: a dimension label lands on the geometry more often than not.
      ctx.text(at, text, {
        sizePt,
        gray,
        color,
        align: tight ? 'left' : 'center',
        knockout: true,
      });
    },
    dimBroken(a, b, offsetCm, shownCm, text, opts = {}) {
      const sizePt = opts.sizePt ?? 7;
      const gray = opts.gray ?? 0.2;
      const color = opts.color;
      const pen = { gray, color };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) return;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const nx = -uy;
      const ny = ux;
      const shown = Math.min(shownCm, len);
      const A = { x: a.x + nx * offsetCm, y: a.y + ny * offsetCm };
      const B = { x: A.x + ux * shown, y: A.y + uy * shown };
      const over = offsetCm >= 0 ? 0.12 : -0.12;
      ctx.seg(a, { x: A.x + nx * over, y: A.y + ny * over }, { width: 0.3, ...pen });
      ctx.seg(A, B, { width: 0.35, ...pen });
      ctx.arrow(A, Math.atan2(uy, ux) + Math.PI, 0.22, gray, color);
      // The break: a short zigzag across the cut end, the drafting sign for "continues".
      const z = 0.16;
      ctx.poly(
        [
          { x: B.x - ux * z * 1.6 + nx * z, y: B.y - uy * z * 1.6 + ny * z },
          { x: B.x - ux * z * 0.4 - nx * z, y: B.y - uy * z * 0.4 - ny * z },
          { x: B.x + ux * z * 0.4 + nx * z, y: B.y + uy * z * 0.4 + ny * z },
          { x: B.x + ux * z * 1.6 - nx * z, y: B.y + uy * z * 1.6 - ny * z },
        ],
        { width: 0.35, ...pen },
      );
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const lift = (opts.labelGapCm ?? 0.1) + sizePt * 0.012;
      ctx.text({ x: mid.x + nx * lift, y: mid.y + ny * lift }, text, {
        sizePt,
        gray,
        color,
        align: 'center',
        knockout: true,
      });
    },
    dimAlong(origin, dirRad, distCm, offsetCm, text, opts = {}) {
      ctx.dim(
        origin,
        { x: origin.x + Math.cos(dirRad) * distCm, y: origin.y + Math.sin(dirRad) * distCm },
        offsetCm,
        text,
        opts,
      );
    },
    table(x, yTop, cols, rows, opts = {}) {
      const sizePt = opts.sizePt ?? 7;
      const rowH = opts.rowHeightCm ?? (sizePt / CM_TO_PT) * 1.9;
      const gray = opts.gray ?? 0.15;
      const totalW = cols.reduce((sum, col) => sum + col.widthCm, 0);
      let y = yTop;
      rows.forEach((row, r) => {
        y -= rowH;
        let cx = x;
        cols.forEach((col, i) => {
          const cell = row[i] ?? '';
          const baseY = y + rowH * 0.3;
          const align = col.align ?? 'left';
          if (align === 'right')
            ctx.labelRight({ x: cx + col.widthCm - 0.1, y: baseY }, cell, sizePt, gray);
          else if (align === 'center')
            ctx.labelCenter({ x: cx + col.widthCm / 2, y: baseY }, cell, sizePt, gray);
          else ctx.label({ x: cx + 0.1, y: baseY }, cell, sizePt, gray);
          cx += col.widthCm;
        });
        const ruled = (r === 0 && (opts.headerRule ?? true)) || opts.rowRules;
        if (ruled) {
          ctx.seg({ x, y }, { x: x + totalW, y }, { width: 0.3, gray: 0.6 });
        }
      });
      return y;
    },
    clip(box, body) {
      c.push(
        'q',
        `${n(px(box.minX))} ${n(py(box.minY))} ${n((box.maxX - box.minX) * CM_TO_PT)} ${n((box.maxY - box.minY) * CM_TO_PT)} re`,
        'W n',
      );
      body();
      c.push('Q');
    },
  };

  // Title in the top-left margin.
  if (chrome.title !== undefined) {
    c.push(
      '0 0 0 rg',
      'BT',
      '/F1 12 Tf',
      `${n(marginCm * CM_TO_PT)} ${n(height - 16)} Td`,
      `(${esc(chrome.title)}) Tj`,
      'ET',
    );
  }
  draw(ctx);
  // Board-info + units note in the bottom margin.
  if (chrome.note) {
    c.push(
      '0.4 0.4 0.4 rg',
      'BT',
      '/F1 8 Tf',
      `${n(marginCm * CM_TO_PT)} ${n(marginCm * CM_TO_PT * 0.35)} Td`,
      `(${esc(chrome.note)}) Tj`,
      'ET',
    );
  }
  if (chrome.calibration) drawCalibration(c, width, chrome.inches ?? false, marginCm);
  return { widthPt: width, heightPt: height, content: c.join('\n') + '\n' };
};

/**
 * Build a drawing on a page sized to fit `bb` (cm) plus `marginCm` on every side — an
 * oversized sheet for a wide-format plotter, or the input to the tiler.
 */
export const buildDrawing = (
  bb: Box,
  marginCm: number,
  chrome: DrawingChrome,
  draw: (ctx: DrawCtx) => void,
): Drawing =>
  compose(
    {
      widthPt: (bb.maxX - bb.minX + 2 * marginCm) * CM_TO_PT,
      heightPt: (bb.maxY - bb.minY + 2 * marginCm) * CM_TO_PT,
      px: (x) => (x - bb.minX + marginCm) * CM_TO_PT,
      py: (y) => (y - bb.minY + marginCm) * CM_TO_PT, // PDF y-up, same as cm
    },
    marginCm,
    chrome,
    draw,
  );

/**
 * Build a page on a fixed `paper` size, with the cm-space point `originCm` placed at the
 * bottom-left of the content area. Still 1:1 — artwork that does not fit runs off the
 * sheet rather than being scaled, and callers are expected to crop instead.
 */
export const buildFixedPage = (
  paper: PaperSize,
  marginCm: number,
  originCm: Pt,
  chrome: DrawingChrome,
  draw: (ctx: DrawCtx) => void,
): PageDoc => {
  const d = compose(
    {
      widthPt: paper.wPt,
      heightPt: paper.hPt,
      px: (x) => (x - originCm.x + marginCm) * CM_TO_PT,
      py: (y) => (y - originCm.y + marginCm) * CM_TO_PT,
    },
    marginCm,
    chrome,
    draw,
  );
  return { width: d.widthPt, height: d.heightPt, content: d.content };
};
