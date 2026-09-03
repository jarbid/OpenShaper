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
  planOutlineHalfBeziers,
  planOutlineHalfLoop,
  planOutlineLoop,
  sampleProfile,
  splineSegments,
  ySpan,
  type Pt,
} from './board-curves';
import { buildPdf, type PageDoc } from './pdf-core';
import { orient, POINTS_PER_CM } from './paper';
import { buildDrawing, type Box, type DrawCtx } from './pdf-draw';
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
  /**
   * Print only one rail of the plan outline (a half template — half the paper), or the
   * full both-rails outline. `'left'` = +y rail, `'right'` = −y rail. Default `'full'`.
   */
  outlineHalf?: 'full' | 'left' | 'right';
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

/** A board part category, used to name per-part files. */
type PartCategory = 'outline' | 'rocker' | 'sections';

interface TaggedPart {
  category: PartCategory;
  drawing: PartDrawing;
}

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
  const d = buildDrawing(bb, MARGIN_CM, { title, note, calibration, inches }, draw);
  return { category, drawing: { title, ...d } };
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

/**
 * Keep only the fins on the printed rail for a half-outline export (near-side). A fin
 * that straddles the stringer (single box, centre of a 2+1) is within `CENTER_TOL` of
 * y=0 and is always kept; genuine side fins are kept only when their side matches.
 */
const finsForHalf = (
  fins: readonly ResolvedFin[],
  half: 'full' | 'left' | 'right',
): readonly ResolvedFin[] => {
  if (half === 'full') return fins;
  const CENTER_TOL = 1; // cm
  return fins.filter((f) => {
    const cy = (f.baseLine.fore.y + f.baseLine.aft.y) / 2;
    if (Math.abs(cy) <= CENTER_TOL) return true;
    return half === 'left' ? cy > 0 : cy < 0;
  });
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
    const side = opts.outlineHalf ?? 'full';
    const loop =
      side === 'full'
        ? planOutlineLoop(board, lengthSteps)
        : planOutlineHalfLoop(board, lengthSteps, side);
    const title =
      side === 'full'
        ? `${name} · Outline (1:1)`
        : `${name} · Outline ${side} half (1:1)`;
    parts.push(
      buildPart(
        'outline',
        title,
        note,
        bbox(loop),
        (ctx) => {
          if (side === 'full') {
            ctx.bezier(planOutlineBeziers(board), { closed: true, width: 0.8 });
          } else {
            ctx.bezier(planOutlineHalfBeziers(board, side), { width: 0.8 });
          }
          ctx.seg({ x: eps, y: 0 }, { x: length - eps, y: 0 }, { width: 0.3, gray: 0.55 });
          for (let i = 0; i < csCount; i++) {
            const pos = stationPos(i);
            const halfW = valueAt(board.outline, pos);
            const lo = side === 'left' ? 0 : -halfW;
            const hi = side === 'right' ? 0 : halfW;
            ctx.seg({ x: pos, y: lo }, { x: pos, y: hi }, { width: 0.3, dashed: true, gray: 0.55 }); // prettier-ignore
            const labelY = side === 'right' ? -halfW - 0.6 : halfW + 0.6;
            ctx.label({ x: pos + 0.4, y: labelY }, `${L(pos)} · w ${L(2 * halfW)}`, 7);
          }
          if (want('fins')) drawFins(ctx, finsForHalf(resolveFins(board), side));
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
