// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Export the board to a true **1:1** PDF — the *same geometry as the DXF*
 * (plan outline, rocker profile, cross-sections) but as actual-size pages a shaper
 * can print and trace. Each part (outline, rocker, one per cross-section) is drawn
 * **once** at full size; the result is delivered one of two ways:
 *
 * - **untiled** — one oversized page per part (sized to its bbox + margin), for a
 *   wide-format plotter; or
 * - **tiled** — each part sliced across a chosen paper size (A4 … A0, Letter,
 *   Tabloid, custom) with overlap+glue marks, cut marks, and tile/join labels (see
 *   {@link ./pdf-tile}).
 *
 * Output is packaged as a single combined PDF or one PDF per part. Curves are
 * sampled with the shared `board-curves` helpers, so they match the DXF exactly.
 */
import { getLength, resolveFins, valueAt, type BezierBoard, type ResolvedFin } from '@openshaper/kernel'; // prettier-ignore
import {
  bbox,
  crossSectionBeziers,
  crossSectionRing,
  planOutlineBeziers,
  planOutlineLoop,
  sampleProfile,
  splineSegments,
  ySpan,
  type CurveSeg,
  type Pt,
} from './board-curves';
import { buildPdf, esc, n, type PageDoc } from './pdf-core';
import { orient, POINTS_PER_CM } from './paper';
import { tileDrawing, type PartDrawing, type PdfTiling } from './pdf-tile';

/** Board metadata shown on exported PDFs (mirrors apps/web BoardMeta's text fields). */
export interface PdfMeta {
  designer?: string;
  model?: string;
  surfer?: string;
  comments?: string;
}

/** Which geometry parts to include in the export. All default to `true`. */
export interface PdfPartSelection {
  outline?: boolean;
  rocker?: boolean;
  crossSections?: boolean;
  /** Draw resolved fins (base footprint + box/plug templates) on the outline page. */
  fins?: boolean;
  /** Draw a 1:1 calibration ruler in the bottom margin of each part. */
  calibration?: boolean;
}

// PdfTiling lives with the tiler; re-exported here for back-compat.
export type { PdfTiling } from './pdf-tile';

/** Options for the 1:1 PDF export. */
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
  /** Geometry parts to include. Defaults to all parts on. */
  parts?: PdfPartSelection;
  /** Slice each part across a paper size; null = one oversized page per part. */
  tiling?: PdfTiling | null;
  /** Combine all parts into one PDF, or emit one PDF per part. Default 'combined'. */
  packaging?: 'combined' | 'per-part';
}

/** One downloadable file produced by the export. */
export interface PdfFile {
  /** Suggested file name, e.g. `board-1to1.pdf` or `board-1to1-outline.pdf`. */
  name: string;
  bytes: Uint8Array;
}

/** Result of {@link exportBoardPdf1to1Files}: one or more PDF files. */
export interface PdfExportResult {
  files: PdfFile[];
}

const CM_TO_PT = POINTS_PER_CM;
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
  /** Draw a path of exact cubic-bezier segments (smooth, resolution-independent). */
  bezier(segs: readonly CurveSeg[], opts?: DrawOpts): void;
  seg(a: Pt, b: Pt, opts?: DrawOpts): void;
  label(at: Pt, str: string, sizePt?: number, gray?: number): void;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A board part category, used to name per-part files. */
type PartCategory = 'outline' | 'rocker' | 'sections';

interface TaggedPart {
  category: PartCategory;
  drawing: PartDrawing;
}

/** Draw a 1:1 calibration ruler in the bottom-right margin so the shaper can verify 100% print. */
const drawCalibration = (c: string[], width: number, inches: boolean): void => {
  const sideCm = inches ? 2.54 * 2 : 5; // a 2 in / 5 cm reference length
  const side = sideCm * CM_TO_PT;
  const label = inches ? '2 in @100%' : '5 cm @100%';
  const yb = MARGIN_CM * CM_TO_PT * 0.55;
  const x1 = width - MARGIN_CM * CM_TO_PT;
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

/** Build one full-size part drawing sized to `bb` (cm), drawing via a cm-coordinate context. */
const buildPart = (
  category: PartCategory,
  title: string,
  note: string | undefined,
  bb: Box,
  draw: (ctx: DrawCtx) => void,
  calibration: boolean,
  inches: boolean,
): TaggedPart => {
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
    bezier(segs, opts = {}) {
      if (segs.length === 0) return;
      const g = opts.gray ?? 0;
      c.push(
        `${n(g)} ${n(g)} ${n(g)} RG`,
        `${n(opts.width ?? 0.5)} w`,
        opts.dashed ? '[4 3] 0 d' : '[] 0 d',
      );
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
  if (calibration) drawCalibration(c, width, inches);
  return {
    category,
    drawing: { title, widthPt: width, heightPt: height, content: c.join('\n') + '\n' },
  };
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

/** Assemble the selected full-size part drawings for `board`. */
const buildParts = (board: BezierBoard, opts: BoardPdf1to1Options): TaggedPart[] => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const ringSteps = Math.max(3, opts.ringSteps ?? DEFAULT_RING_STEPS);
  const csCount = Math.max(0, opts.crossSectionCount ?? DEFAULT_CS_COUNT);
  const inches = opts.units === 'in';
  const name = opts.meta?.model || 'Surfboard';
  const sel = opts.parts ?? {};
  const want = (key: keyof PdfPartSelection): boolean => sel[key] ?? true;
  const calibration = want('calibration');

  const length = getLength(board);
  const eps = Math.min(0.01, length / (lengthSteps * 4));
  const L = (cm: number): string =>
    inches ? `${(cm / 2.54).toFixed(2)} in` : `${cm.toFixed(1)} cm`;
  const note = `${name} · 1:1 — print at 100% scale · units ${inches ? 'in' : 'cm'} · openshaper.com`;
  const stationPos = (i: number): number => eps + ((length - 2 * eps) * (i + 0.5)) / csCount;

  const parts: TaggedPart[] = [];

  // --- Outline page: plan outline + stringer + rib stations + fins. ---
  if (want('outline')) {
    const loop = planOutlineLoop(board, lengthSteps);
    parts.push(
      buildPart(
        'outline',
        `${name} · Outline (1:1)`,
        note,
        bbox(loop),
        (ctx) => {
          ctx.bezier(planOutlineBeziers(board), { closed: true, width: 0.8 });
          ctx.seg({ x: eps, y: 0 }, { x: length - eps, y: 0 }, { width: 0.3, gray: 0.55 });
          for (let i = 0; i < csCount; i++) {
            const pos = stationPos(i);
            const half = valueAt(board.outline, pos);
            ctx.seg({ x: pos, y: -half }, { x: pos, y: half }, { width: 0.3, dashed: true, gray: 0.55 }); // prettier-ignore
            ctx.label({ x: pos + 0.4, y: half + 0.6 }, `${L(pos)} · w ${L(2 * half)}`, 7);
          }
          if (want('fins')) drawFins(ctx, resolveFins(board));
        },
        calibration,
        inches,
      ),
    );
  }

  // --- Rocker page: deck + bottom profiles + thickness ticks. ---
  if (want('rocker')) {
    const bottom = sampleProfile(board.bottom, eps, length - eps, lengthSteps);
    const deck = sampleProfile(board.deck, eps, length - eps, lengthSteps);
    parts.push(
      buildPart(
        'rocker',
        `${name} · Rocker (1:1)`,
        note,
        bbox([...bottom, ...deck]),
        (ctx) => {
          ctx.bezier(splineSegments(board.bottom), { width: 0.8 });
          ctx.bezier(splineSegments(board.deck), { width: 0.8 });
          for (let i = 0; i < csCount; i++) {
            const pos = stationPos(i);
            const b = valueAt(board.bottom, pos);
            const d = valueAt(board.deck, pos);
            ctx.seg({ x: pos, y: b }, { x: pos, y: d }, { width: 0.3, dashed: true, gray: 0.55 });
            ctx.label({ x: pos + 0.4, y: Math.max(b, d) + 0.4 }, `t ${L(Math.abs(d - b))}`, 7);
          }
        },
        calibration,
        inches,
      ),
    );
  }

  // --- One page per cross-section, true scale. ---
  if (want('crossSections')) {
    for (let i = 0; i < csCount; i++) {
      const pos = stationPos(i);
      const ring = crossSectionRing(board, pos, ringSteps);
      if (!ring) continue;
      parts.push(
        buildPart(
          'sections',
          `${name} · Section @ ${L(pos)} (1:1)`,
          note,
          bbox(ring),
          (ctx) => {
            ctx.bezier(crossSectionBeziers(board, pos) ?? [], { closed: true, width: 0.8 });
            const sy = ySpan(ring);
            ctx.seg(
              { x: 0, y: sy.lo },
              { x: 0, y: sy.hi },
              { width: 0.3, dashed: true, gray: 0.55 },
            );
          },
          calibration,
          inches,
        ),
      );
    }
  }

  return parts;
};

/** Short label shown on tiles for a part category. */
const CATEGORY_CODE: Record<PartCategory, string> = {
  outline: 'Outline',
  rocker: 'Rocker',
  sections: 'Section',
};

/** Turn a tagged part into its PageDocs — oversized (untiled) or sliced. */
const partToPages = (part: TaggedPart, tiling: PdfTiling | null | undefined): PageDoc[] => {
  const { drawing } = part;
  if (!tiling) {
    return [{ width: drawing.widthPt, height: drawing.heightPt, content: drawing.content }];
  }
  const aspect = drawing.heightPt > 0 ? drawing.widthPt / drawing.heightPt : 1;
  const paper = orient(tiling.paper, tiling.orientation, aspect);
  return tileDrawing(drawing, {
    paper,
    overlapPt: Math.max(0, tiling.overlapCm) * CM_TO_PT,
    cutMarks: tiling.cutMarks,
    labels: tiling.labels,
    partCode: CATEGORY_CODE[part.category],
  });
};

/**
 * Export the board's 1:1 geometry to one or more PDF files according to `opts`
 * (part selection, optional paper-size tiling, and combined/per-part packaging).
 */
export const exportBoardPdf1to1Files = (
  board: BezierBoard,
  opts: BoardPdf1to1Options = {},
): PdfExportResult => {
  const parts = buildParts(board, opts);
  const tiling = opts.tiling ?? null;

  if (opts.packaging === 'per-part') {
    // Group parts by category, one PDF file per category present.
    const order: PartCategory[] = ['outline', 'rocker', 'sections'];
    const files: PdfFile[] = [];
    for (const cat of order) {
      const group = parts.filter((p) => p.category === cat);
      if (group.length === 0) continue;
      const pages = group.flatMap((p) => partToPages(p, tiling));
      files.push({ name: `board-1to1-${cat}.pdf`, bytes: buildPdf(pages) });
    }
    return { files: files.length ? files : [{ name: 'board-1to1.pdf', bytes: buildPdf([]) }] };
  }

  // Combined: every part's pages in one PDF.
  const pages = parts.flatMap((p) => partToPages(p, tiling));
  return { files: [{ name: 'board-1to1.pdf', bytes: buildPdf(pages) }] };
};

/**
 * Back-compat: export the board as a single combined, untiled 1:1 PDF (one oversized
 * page per part). Prefer {@link exportBoardPdf1to1Files} for tiling / packaging.
 */
export const exportBoardPdf1to1 = (
  board: BezierBoard,
  opts: BoardPdf1to1Options = {},
): Uint8Array =>
  exportBoardPdf1to1Files(board, { ...opts, tiling: null, packaging: 'combined' }).files[0]!.bytes;
