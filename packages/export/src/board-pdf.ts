// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Export the board to a true **1:1** PDF — the *same geometry as the DXF*
 * (plan outline, rocker profile, cross-sections) but as actual-size pages a shaper
 * can print and trace. **One part per oversized page**: an outline page, a rocker
 * page, then one page per cross-section. No tiling — each page is sized to its own
 * bounding box plus a margin, so the user prints at 100% (poster/scale settings) and
 * every dimension comes out actual size. Curves are sampled with the shared
 * `board-curves` helpers, so they match the DXF exactly.
 */
import { getLength, resolveFins, valueAt, type BezierBoard, type ResolvedFin } from '@openshaper/kernel'; // prettier-ignore
import {
  bbox,
  crossSectionRing,
  planOutlineLoop,
  sampleProfile,
  ySpan,
  type Pt,
} from './board-curves';
import { buildPdf, esc, n, type PageDoc } from './pdf-core';

/** Board metadata shown on exported PDFs (mirrors apps/web BoardMeta's text fields). */
export interface PdfMeta {
  designer?: string;
  model?: string;
  surfer?: string;
  comments?: string;
}

/** Options for {@link exportBoardPdf1to1}. */
export interface BoardPdf1to1Options {
  /** Polyline samples for the outline / rocker profiles. Default 200. */
  lengthSteps?: number;
  /** Profile samples per cross-section ring. Default 64. */
  ringSteps?: number;
  /** Number of cross-sections (and rib-station markers), evenly spaced. Default 7. */
  crossSectionCount?: number;
  /** Display units for the printed labels. Default 'cm'. */
  units?: 'cm' | 'in';
  /** Board metadata; `model` titles the pages. */
  meta?: PdfMeta;
}

const CM_TO_PT = 72 / 2.54;
const MARGIN_CM = 2;

const DEFAULT_LENGTH_STEPS = 200;
const DEFAULT_RING_STEPS = 64;
const DEFAULT_CS_COUNT = 7;

interface DrawOpts {
  closed?: boolean;
  dashed?: boolean;
  width?: number;
  gray?: number;
}

interface DrawCtx {
  poly(pts: readonly Pt[], opts?: DrawOpts): void;
  seg(a: Pt, b: Pt, opts?: DrawOpts): void;
  label(at: Pt, str: string, sizePt?: number, gray?: number): void;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Build one 1:1 page sized to `bb` (cm), drawing via a cm-coordinate context. */
const makePage = (
  title: string,
  note: string | undefined,
  bb: Box,
  draw: (ctx: DrawCtx) => void,
): PageDoc => {
  const m = MARGIN_CM;
  const width = (bb.maxX - bb.minX + 2 * m) * CM_TO_PT;
  const height = (bb.maxY - bb.minY + 2 * m) * CM_TO_PT;
  const px = (x: number): number => (x - bb.minX + m) * CM_TO_PT;
  const py = (y: number): number => (y - bb.minY + m) * CM_TO_PT; // PDF y-up, same as cm

  const c: string[] = [];
  const ctx: DrawCtx = {
    poly(pts, opts = {}) {
      if (pts.length < 2) return;
      const g = opts.gray ?? 0;
      c.push(
        `${n(g)} ${n(g)} ${n(g)} RG`,
        `${n(opts.width ?? 0.5)} w`,
        opts.dashed ? '[4 3] 0 d' : '[] 0 d',
      );
      c.push(`${n(px(pts[0]!.x))} ${n(py(pts[0]!.y))} m`);
      for (let i = 1; i < pts.length; i++) c.push(`${n(px(pts[i]!.x))} ${n(py(pts[i]!.y))} l`);
      c.push(opts.closed ? 'h S' : 'S');
    },
    seg(a, b, opts = {}) {
      ctx.poly([a, b], opts);
    },
    label(at, str, sizePt = 8, gray = 0.35) {
      c.push(
        `${n(gray)} ${n(gray)} ${n(gray)} rg`,
        'BT',
        `/F1 ${n(sizePt)} Tf`,
        `${n(px(at.x))} ${n(py(at.y))} Td`,
        `(${esc(str)}) Tj`,
        'ET',
      );
    },
  };

  // Title in the top-left margin.
  c.push(
    '0 0 0 rg',
    'BT',
    '/F1 12 Tf',
    `${n(MARGIN_CM * CM_TO_PT)} ${n(height - 16)} Td`,
    `(${esc(title)}) Tj`,
    'ET',
  );
  draw(ctx);
  // Board-info + units note in the bottom margin.
  if (note) {
    c.push(
      '0.4 0.4 0.4 rg',
      'BT',
      '/F1 8 Tf',
      `${n(MARGIN_CM * CM_TO_PT)} ${n(MARGIN_CM * CM_TO_PT * 0.35)} Td`,
      `(${esc(note)}) Tj`,
      'ET',
    );
  }
  return { width, height, content: c.join('\n') + '\n' };
};

/** Draw resolved fins (toed base footprint + box/plug router templates) in plan coords. */
const drawFins = (ctx: DrawCtx, fins: readonly ResolvedFin[]): void => {
  for (const f of fins) {
    const { fore, aft } = f.baseLine;
    ctx.seg(aft, fore, { width: 0.6 });
    if (f.box.kind !== 'shapes') continue;
    const cx = (fore.x + aft.x) / 2;
    const cy = (fore.y + aft.y) / 2;
    const dl = Math.hypot(fore.x - aft.x, fore.y - aft.y) || 1;
    const ax = (fore.x - aft.x) / dl;
    const ay = (fore.y - aft.y) / dl;
    const nx = -ay;
    const ny = ax;
    for (const fp of f.box.footprints) {
      const ox = cx + ax * fp.along;
      const oy = cy + ay * fp.along;
      if (fp.shape.kind === 'rect') {
        const hl = fp.shape.length / 2;
        const hw = fp.shape.width / 2;
        const corner = (sa: number, sn: number): Pt => ({
          x: ox + ax * hl * sa + nx * hw * sn,
          y: oy + ay * hl * sa + ny * hw * sn,
        });
        ctx.poly([corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)], {
          closed: true,
          width: 0.5,
        });
      } else {
        const r = fp.shape.diameter / 2;
        const ring: Pt[] = [];
        for (let k = 0; k <= 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          ring.push({ x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r });
        }
        ctx.poly(ring, { closed: true, width: 0.5 });
      }
    }
  }
};

export const exportBoardPdf1to1 = (
  board: BezierBoard,
  opts: BoardPdf1to1Options = {},
): Uint8Array => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const ringSteps = Math.max(3, opts.ringSteps ?? DEFAULT_RING_STEPS);
  const csCount = Math.max(0, opts.crossSectionCount ?? DEFAULT_CS_COUNT);
  const inches = opts.units === 'in';
  const name = opts.meta?.model || 'Surfboard';

  const length = getLength(board);
  const eps = Math.min(0.01, length / (lengthSteps * 4));
  const L = (cm: number): string =>
    inches ? `${(cm / 2.54).toFixed(2)} in` : `${cm.toFixed(1)} cm`;
  const note = `${name} · 1:1 — print at 100% scale · units ${inches ? 'in' : 'cm'}`;
  const stationPos = (i: number): number => eps + ((length - 2 * eps) * (i + 0.5)) / csCount;

  const pages: PageDoc[] = [];

  // --- Outline page: plan outline + stringer + rib stations + fins. ---
  const loop = planOutlineLoop(board, lengthSteps);
  pages.push(
    makePage(`${name} · Outline (1:1)`, note, bbox(loop), (ctx) => {
      ctx.poly(loop, { closed: true, width: 0.8 });
      ctx.seg({ x: eps, y: 0 }, { x: length - eps, y: 0 }, { width: 0.3, gray: 0.55 });
      for (let i = 0; i < csCount; i++) {
        const pos = stationPos(i);
        const half = valueAt(board.outline, pos);
        ctx.seg({ x: pos, y: -half }, { x: pos, y: half }, { width: 0.3, dashed: true, gray: 0.55 }); // prettier-ignore
        ctx.label({ x: pos + 0.4, y: half + 0.6 }, `${L(pos)} · w ${L(2 * half)}`, 7);
      }
      drawFins(ctx, resolveFins(board));
    }),
  );

  // --- Rocker page: deck + bottom profiles + thickness ticks. ---
  const bottom = sampleProfile(board.bottom, eps, length - eps, lengthSteps);
  const deck = sampleProfile(board.deck, eps, length - eps, lengthSteps);
  pages.push(
    makePage(`${name} · Rocker (1:1)`, note, bbox([...bottom, ...deck]), (ctx) => {
      ctx.poly(bottom, { width: 0.8 });
      ctx.poly(deck, { width: 0.8 });
      for (let i = 0; i < csCount; i++) {
        const pos = stationPos(i);
        const b = valueAt(board.bottom, pos);
        const d = valueAt(board.deck, pos);
        ctx.seg({ x: pos, y: b }, { x: pos, y: d }, { width: 0.3, dashed: true, gray: 0.55 });
        ctx.label({ x: pos + 0.4, y: Math.max(b, d) + 0.4 }, `t ${L(Math.abs(d - b))}`, 7);
      }
    }),
  );

  // --- One page per cross-section, true scale. ---
  for (let i = 0; i < csCount; i++) {
    const pos = stationPos(i);
    const ring = crossSectionRing(board, pos, ringSteps);
    if (!ring) continue;
    pages.push(
      makePage(`${name} · Section @ ${L(pos)} (1:1)`, note, bbox(ring), (ctx) => {
        ctx.poly(ring, { closed: true, width: 0.8 });
        const sy = ySpan(ring);
        ctx.seg({ x: 0, y: sy.lo }, { x: 0, y: sy.hi }, { width: 0.3, dashed: true, gray: 0.55 });
      }),
    );
  }

  return buildPdf(pages);
};
