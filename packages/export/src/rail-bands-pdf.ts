// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail-bands sheet: what to pencil on the blank, and at what angle to set the
 * plane, at each station along the rail.
 *
 * Two kinds of page, and they must never be mistaken for one another:
 *
 * - **page 1** is a plan and rocker map of the stations plus a master table of every
 *   number in the set. It is a *diagram* — scaled to the sheet, and stamped NOT TO SCALE
 *   so nobody measures it;
 * - **each detail page** is the station's real cross-section at **true 1:1**, with the
 *   facets, their dimensions and their angles drawn on it. It carries a calibration
 *   ruler, and it is never scaled to fit — if the artwork will not fit the sheet the
 *   crop tightens, and failing that the page grows. A rail template printed at 96% is
 *   worse than no template.
 *
 * Dimensions follow the order the cuts happen in: band 1 measured off the squared
 * blank's corners, every later band measured on the face already cut. See
 * `@openshaper/kernel`'s `rail-facets.ts` for why, and for the geometry.
 *
 * ## Colour carries the band number
 *
 * Every mark, dimension and guide line for band 1 is blue, band 2 green, band 3 red, the
 * tuck magenta — the palette the printed reference cards use. That is what lets a shaper
 * follow one band from the curve running down the plan view, to its row in the table, to
 * the line drawn on the 1:1 page, without reading a word.
 */
import {
  getLength,
  getMaxWidth,
  outlineInsetPointAt,
  pointByTT,
  railFacetPlan,
  railFacetsAt,
  valueAt,
  type BezierBoard,
  type FacetLine,
  type RailFacetOptions,
  type RailAngleMode,
  type RailFacetWarning,
  type RailStationFacets,
} from '@openshaper/kernel';
import {
  flattenBeziers,
  planOutlineBeziers,
  sampleProfile,
  splineSegments,
  type Pt,
} from './board-curves';
import { BRAND_LINE } from './brand';
import { buildPdf, type PageDoc } from './pdf-core';
import { orient, PAPER_SIZES, POINTS_PER_CM, type Orientation, type PaperSize } from './paper';
import {
  buildDrawing,
  buildFixedPage,
  type Box,
  type DrawCtx,
  type Rgb,
  type TableCol,
} from './pdf-draw';
import type { PdfFile, PdfMeta } from './board-pdf';

export interface RailBandsPdfOptions {
  /** Display units for the printed labels. Default 'cm'. */
  units?: 'cm' | 'in';
  /**
   * Formatter for every printed length. The app injects the editor's own formatter so
   * inch users get `1 1/4"` rather than `1.25 in` — which is what a tape measure reads.
   */
  fmt?: (cm: number) => string;
  meta?: PdfMeta;
  /** Band count, angles, tuck angle, zone width. */
  facets?: RailFacetOptions;
  /**
   * Target station spacing, fitted to the banded length so stations land on both ends.
   * Default 30.48 cm = 12 in.
   */
  stationSpacingCm?: number;
  /** How much of each tip to leave alone. Default 20 cm. */
  endMarginCm?: number;
  paper?: PaperSize;
  orientation?: Orientation;
  /** Include the per-station 1:1 pages. Default true. */
  detailPages?: boolean;
  /** How much of the rail to show on a detail page, measured in from the rail. Default 12 cm. */
  detailCropCm?: number;
  /** Draw the designed section behind the facets. Default true. */
  ghostSection?: boolean;
  /** Print the 1:1 calibration ruler. Default true. */
  calibration?: boolean;
}

/**
 * A kernel geometry warning, or one raised by the page builder itself. Every
 * `RailFacetWarning` is assignable to this.
 */
export interface RailBandsWarning {
  readonly code: RailFacetWarning['code'] | 'page-oversized';
  readonly message: string;
  readonly position?: number;
  readonly facetIndex?: number;
}

export interface RailBandsPdfResult {
  file: PdfFile;
  warnings: readonly RailBandsWarning[];
}

const A4 = PAPER_SIZES[0]!;
const MARGIN_CM = 1.5;
const CM_TO_PT = POINTS_PER_CM;

const DEFAULT_CROP_CM = 12;
/** Most a plan view may take of the page height. */
const MAP_HEIGHT_CM = 5;

/** Room kept to the right of the rail plane for the vertical dimensions and their text. */
const DIM_GUTTER_CM = 3.2;

/** How each placement is named on the sheet, so a reprint can be told from its original. */
const PLACEMENT_LABELS: Record<RailAngleMode, string> = {
  balanced: 'balanced placement',
  'least-foam': 'least-foam placement',
  ladder: 'halving ladder',
};

// --- palette -------------------------------------------------------------------

/** Band colours, in cut order. Blue, green, red — as the printed reference cards use. */
const BAND_COLORS: readonly Rgb[] = [
  [0.13, 0.31, 0.78], // 1 blue
  [0.05, 0.55, 0.24], // 2 green
  [0.8, 0.13, 0.13], // 3 red
  [0.85, 0.45, 0.0], // 4 orange
  [0.45, 0.2, 0.62], // 5 purple
  [0.0, 0.5, 0.55], // 6 teal
];
const TUCK_COLOR: Rgb = [0.78, 0.1, 0.55];
/** The foam still standing proud of the finished shape. Pale enough to draw over. */
const LEFTOVER_TINT: Rgb = [0.98, 0.93, 0.62]; // magenta
const STATION_COLOR: Rgb = [0.13, 0.62, 0.75]; // cyan, for the centre lines
const APEX_COLOR: Rgb = [0.35, 0.35, 0.35];
const THICKNESS_COLOR: Rgb = [0.1, 0.1, 0.1];

const bandColor = (index1: number): Rgb => BAND_COLORS[(index1 - 1) % BAND_COLORS.length]!;

/** Station letters: A…Z, then AA, AB… */
const stationLetter = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

const fmtAngle = (f: FacetLine): string =>
  Math.abs(f.angle - f.targetAngle) > 0.5
    ? `${f.targetAngle}° (${f.angle.toFixed(1)}° actual)`
    : `${f.targetAngle}°`;

/** Content area of a sheet in cm, inside the margins. */
const contentSize = (paper: PaperSize): { w: number; h: number } => ({
  w: paper.wPt / CM_TO_PT - 2 * MARGIN_CM,
  h: paper.hPt / CM_TO_PT - 2 * MARGIN_CM,
});

const markOn = (f: FacetLine | undefined, kind: string): number | null => {
  const m = f?.marks.find((mk) => mk.ref.kind === kind);
  return m ? m.distance : null;
};

/**
 * How far in from the rail a station's drawing has to reach: far enough to show every
 * dimension's far end, since a dimension with one end off the page is worse than none.
 *
 * The shallowest band drives this, and it reaches further than intuition suggests — on
 * a real shortboard the 11.25° band lands about 5 1/4 in from the rail, because a
 * nearly-flat deck only meets a shallow tangent a long way inboard. That is what makes
 * these pages landscape by default.
 */
/**
 * How far in from the rail a station's drawing has to reach to show every dimension's
 * far end — before the paper gets a say.
 *
 * Fitted bands reach much further in than the halving ladder's: the innermost one can
 * land most of the way to the stringer, because that is where the foam is. Letting the
 * crop follow it would push every detail page past A4 on a wide board, and an oversized
 * sheet is a trap — the shaper reaches for "fit to page" and destroys the 1:1 the page
 * exists to carry. So this is what the page *wants*; `buildDetailPage` gives it what the
 * paper allows and breaks the dimensions that run off the end.
 */
const neededCrop = (st: RailStationFacets): number => {
  const innermost = Math.min(
    st.blank.railX,
    ...st.deckFacets.map((f) => f.cutTo.x),
    ...st.bottomFacets.map((f) => f.cutTo.x),
  );
  return Math.max(3, st.blank.railX - innermost + 1.2);
};

/**
 * The boundary of the foam left standing after every cut: down the cut faces from the
 * deck plane to the bottom plane, then back along the designed section.
 *
 * Same walk the kernel measures the leftover area with, so the tint on the page and the
 * percentage in the footer are describing one region, not two that nearly agree.
 */
const leftoverOutline = (st: RailStationFacets): Pt[] => {
  const { railX, deckY, bottomY } = st.blank;
  const cut: Pt[] = [{ x: 0, y: deckY }];
  const inner = st.deckFacets[st.deckFacets.length - 1];
  if (inner) {
    cut.push(inner.cutTo);
    for (let i = st.deckFacets.length - 1; i >= 0; i--) cut.push(st.deckFacets[i]!.cutFrom);
  } else {
    cut.push({ x: railX, y: deckY });
  }
  const tuck = st.bottomFacets[0];
  if (tuck) cut.push(tuck.cutFrom, tuck.cutTo);
  else cut.push({ x: railX, y: bottomY });

  // Back along the section, bottom to deck — but starting at the tuck's own mark, not at
  // the stringer. Foam inboard of that on the bottom is the concave's to remove, and
  // shading it would read as work the tuck was supposed to have done.
  const stopX = tuck ? tuck.cutTo.x : railX;
  const back: Pt[] = [];
  const n = 240;
  for (let i = 0; i <= n; i++) {
    const p = pointByTT(st.section.spline, i / n);
    if (back.length === 0 && p.x < stopX) continue;
    back.push(p);
  }
  return [...cut, ...back];
};

// --- the band lines running along the board -------------------------------------

/**
 * The band marks sampled densely along the board, so the map can show each as a
 * continuous line rather than a few points.
 *
 * These are the pencil lines the shaper actually draws down the length of the blank
 * before planing anything, so they are worth drawing properly: they taper toward both
 * tips, and seeing where one runs out is half of what the map is for.
 *
 * Which view a mark belongs on is not cosmetic. A deck mark is an inset from the
 * outline, so it lives on the plan; a rail mark is a height, so it lives on the rocker.
 * The tuck's mark is on the **underside** of the board, and drawing it on the top view
 * would invite reading it as something you can see and measure from up there — so it is
 * side-view only.
 */
interface BandTraces {
  /** Per band: the deck mark as a plan-view line (one rail; mirrored when drawn). */
  readonly deckPlan: Pt[][];
  /** Per band: the rail mark as a side-view line. Only band 1 has one. */
  readonly deckRocker: Pt[][];
  /** The tuck's height up the rail, side view only. */
  readonly tuckRocker: Pt[];
  /** Where the rail's widest point runs, side view. */
  readonly apexRocker: Pt[];
}

const SAMPLES = 48;

const EMPTY_TRACES: BandTraces = { deckPlan: [], deckRocker: [], tuckRocker: [], apexRocker: [] };

const traceBands = (
  board: BezierBoard,
  stations: readonly RailStationFacets[],
  facets: RailFacetOptions | undefined,
  bands: number,
): BandTraces => {
  const first = stations[0]!.position;
  const last = stations[stations.length - 1]!.position;
  const deckPlan: Pt[][] = Array.from({ length: bands }, () => []);
  const deckRocker: Pt[][] = Array.from({ length: bands }, () => []);
  const tuckRocker: Pt[] = [];
  const apexRocker: Pt[] = [];

  // Angles are fitted per station. Re-fitting at every sample along the way would be slow
  // and would make the traced line wobble as the grid optimum hops between half-degrees,
  // so each sample gets the angles interpolated from the two stations either side of it —
  // which is what a shaper does when they spring a batten through the marks.
  const anglesAt = (x: number): number[] => {
    let hi = stations.findIndex((st) => st.position >= x);
    if (hi < 0) hi = stations.length - 1;
    const lo = Math.max(0, hi - 1);
    const a = stations[lo]!;
    const b = stations[hi]!;
    const span = b.position - a.position;
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (x - a.position) / span)) : 0;
    const n = Math.min(a.deckFacets.length, b.deckFacets.length);
    return Array.from(
      { length: n },
      (_, k) =>
        a.deckFacets[k]!.targetAngle +
        (b.deckFacets[k]!.targetAngle - a.deckFacets[k]!.targetAngle) * t,
    );
  };

  for (let i = 0; i <= SAMPLES; i++) {
    const x = first + ((last - first) * i) / SAMPLES;
    const deckAngles = anglesAt(x);
    const st = deckAngles.length > 0 ? railFacetsAt(board, x, { ...facets, deckAngles }) : null;
    if (!st) continue;
    // Section-local y is measured from the bottom centreline, which sits on the rocker.
    const zOf = (sectionY: number): number => valueAt(board.bottom, x) + sectionY;

    apexRocker.push({ x, y: zOf(st.apex.y) });

    for (let b = 0; b < bands; b++) {
      const f = st.deckFacets[b];
      const inset = markOn(f, 'deckPlane');
      if (inset === null || !Number.isFinite(inset)) continue;
      const p = outlineInsetPointAt(board, x, inset);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) deckPlan[b]!.push({ x: p.x, y: p.y });
      const up = markOn(f, 'railPlane');
      if (up !== null) deckRocker[b]!.push({ x, y: zOf(st.blank.bottomY + up) });
    }

    const tuckUp = markOn(st.bottomFacets[0], 'railPlane');
    if (tuckUp !== null) tuckRocker.push({ x, y: zOf(st.blank.bottomY + tuckUp) });
  }
  return { deckPlan, deckRocker, tuckRocker, apexRocker };
};

// --- page 1: station map + master table ----------------------------------------

/** Column layout for the master table, which grows with the band count. */
const masterColumns = (bands: number): { cols: TableCol[]; head: string[] } => {
  const cols: TableCol[] = [
    { widthCm: 1.2, align: 'left' },
    { widthCm: 2.4, align: 'right' },
    { widthCm: 2.0, align: 'right' },
    { widthCm: 2.0, align: 'right' },
  ];
  const head = ['Stn', 'From tail', 'Width', 'Thick'];
  for (let i = 0; i < bands; i++) {
    if (i === 0) {
      head.push('B1 deck', 'B1 rail');
    } else {
      head.push(`B${i + 1} on B${i}`, `B${i + 1} deck`);
    }
    cols.push({ widthCm: 2.1, align: 'right' }, { widthCm: 2.1, align: 'right' });
  }
  head.push('Tuck up', 'Tuck in', 'Edge R');
  cols.push(
    { widthCm: 1.9, align: 'right' },
    { widthCm: 1.9, align: 'right' },
    { widthCm: 1.9, align: 'right' },
  );
  return { cols, head };
};

const masterRow = (
  st: RailStationFacets,
  letter: string,
  bands: number,
  L: (cm: number) => string,
  flagged: boolean,
): string[] => {
  const row = [
    letter + (flagged ? ' *' : ''),
    L(st.position),
    L(st.halfWidth * 2),
    L(st.blank.thickness),
  ];
  for (let i = 0; i < bands; i++) {
    const f = st.deckFacets[i];
    if (!f) {
      row.push('—', '—');
      continue;
    }
    if (i === 0) {
      row.push(L(markOn(f, 'deckPlane') ?? 0), L(markOn(f, 'railPlane') ?? 0));
    } else {
      row.push(L(markOn(f, 'facet') ?? 0), L(markOn(f, 'deckPlane') ?? 0));
    }
  }
  const tuck = st.bottomFacets[0];
  row.push(
    tuck ? L(markOn(tuck, 'railPlane') ?? 0) : '—',
    tuck ? L(markOn(tuck, 'bottomPlane') ?? 0) : '—',
    st.edgeRadius === null ? 'hard' : `≈ ${L(st.edgeRadius)}`,
  );
  return row;
};

interface MapLayout {
  scale: number;
  planCy: number;
  planH: number;
  rockerBase: number;
  minZ: number;
  bottomProfile: Pt[];
  deckProfile: Pt[];
  /** Where the whole map stops, so the table knows where it can start. */
  bottom: number;
}

/**
 * Work out where the plan and rocker sit, without drawing anything. Kept separate
 * because the table's row count depends on where the map ends, and a board's rocker
 * depth varies enough that guessing a fixed height wastes a third of the page on a
 * shortboard or overlaps the table on a longboard.
 */
const mapLayout = (board: BezierBoard, contentW: number, topY: number): MapLayout => {
  const length = getLength(board);
  const maxW = getMaxWidth(board);
  const scale = Math.min(contentW / length, MAP_HEIGHT_CM / maxW);
  const planH = maxW * scale;
  const planCy = topY - planH / 2;

  const eps = Math.min(0.01, length / 800);
  const bottomProfile = sampleProfile(board.bottom, eps, length - eps, 160);
  const deckProfile = sampleProfile(board.deck, eps, length - eps, 160);
  const zs = [...bottomProfile, ...deckProfile].map((p) => p.y);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const rockerBase = planCy - planH / 2 - 1.0 - (maxZ - minZ) * scale;

  return {
    scale,
    planCy,
    planH,
    rockerBase,
    minZ,
    bottomProfile,
    deckProfile,
    bottom: rockerBase - 1.1,
  };
};

/**
 * Plan above, rocker below, on one horizontal scale and one x origin, with a drafting
 * centreline dropped through both at every station. Aligning them is the point: the
 * shaper reads a station's position off the outline and its rail height off the rocker
 * without converting anything.
 */
const drawMap = (
  ctx: DrawCtx,
  board: BezierBoard,
  stations: readonly RailStationFacets[],
  traces: BandTraces,
  layout: MapLayout,
  L: (cm: number) => string,
): void => {
  const length = getLength(board);
  const { scale, planCy, planH, rockerBase, minZ, bottomProfile, deckProfile } = layout;

  const plan = (p: Pt): Pt => ({ x: p.x * scale, y: planCy + p.y * scale });
  const rock = (p: Pt): Pt => ({ x: p.x * scale, y: rockerBase + (p.y - minZ) * scale });

  // Station centrelines first, so the geometry reads on top of them.
  const lineTop = planCy + planH / 2 + 0.35;
  const lineBottom = rockerBase - 0.35;
  for (const st of stations) {
    ctx.seg(
      { x: st.position * scale, y: lineBottom },
      { x: st.position * scale, y: lineTop },
      { width: 0.3, dash: 'centre', color: STATION_COLOR },
    );
  }

  // --- plan ---
  ctx.poly(flattenBeziers(planOutlineBeziers(board), 16).map(plan), { closed: true, width: 0.7 });
  ctx.seg(plan({ x: 0, y: 0 }), plan({ x: length, y: 0 }), {
    width: 0.25,
    dash: 'centre',
    gray: 0.55,
  });

  // The band lines as the shaper would pencil them down the blank, mirrored either side.
  const traceOn = (pts: Pt[], map: (p: Pt) => Pt, color: Rgb, mirror: boolean): void => {
    if (pts.length < 2) return;
    ctx.poly(pts.map(map), { width: 0.45, dash: 'centre', color });
    if (mirror) ctx.poly(pts.map((p) => map({ x: p.x, y: -p.y })), { width: 0.45, dash: 'centre', color }); // prettier-ignore
  };
  traces.deckPlan.forEach((pts, i) => traceOn(pts, plan, bandColor(i + 1), true));

  // --- rocker ---
  ctx.poly(bottomProfile.map(rock), { width: 0.7 });
  ctx.poly(deckProfile.map(rock), { width: 0.7 });
  traceOn(traces.apexRocker, rock, APEX_COLOR, false);
  traces.deckRocker.forEach((pts, i) => traceOn(pts, rock, bandColor(i + 1), false));
  traceOn(traces.tuckRocker, rock, TUCK_COLOR, false);

  // --- station labels ---
  stations.forEach((st, i) => {
    const half = Math.abs(valueAt(board.outline, st.position));
    ctx.dot(plan({ x: st.position, y: half }), 0.06, 0.1);
    ctx.text({ x: st.position * scale, y: lineTop + 0.12 }, stationLetter(i), {
      sizePt: 8,
      gray: 0,
      align: 'center',
    });
    ctx.text({ x: st.position * scale, y: lineBottom - 0.42 }, L(st.position), {
      sizePt: 6,
      gray: 0.45,
      align: 'center',
    });
  });
};

/** A colour key, so the lines on the map and the rows in the table can be tied together. */
const drawLegend = (ctx: DrawCtx, x: number, y: number, bands: number, hasTuck: boolean): void => {
  let cx = x;
  const entry = (color: Rgb, label: string): void => {
    ctx.seg({ x: cx, y: y + 0.08 }, { x: cx + 0.7, y: y + 0.08 }, { width: 0.5, dash: 'centre', color }); // prettier-ignore
    ctx.text({ x: cx + 0.85, y }, label, { sizePt: 6.5, gray: 0.3 });
    cx += 0.85 + label.length * 0.115 + 0.55;
  };
  for (let i = 1; i <= bands; i++) entry(bandColor(i), `band ${i}`);
  if (hasTuck) entry(TUCK_COLOR, 'tuck');
  entry(APEX_COLOR, 'rail apex');
  entry(STATION_COLOR, 'station');
};

const buildOverviewPages = (
  board: BezierBoard,
  stations: readonly RailStationFacets[],
  traces: BandTraces,
  warnings: readonly RailFacetWarning[],
  bands: number,
  paper: PaperSize,
  title: string,
  note: string,
  subtitle: string,
  L: (cm: number) => string,
): PageDoc[] => {
  const { w: contentW, h: contentH } = contentSize(paper);
  const { cols, head } = masterColumns(bands);
  const flaggedAt = new Set(warnings.map((w) => w.position));

  const rows = stations.map((st, i) =>
    masterRow(st, stationLetter(i), bands, L, flaggedAt.has(st.position)),
  );
  const rowH = 0.48;
  const warnLines = [...new Set(warnings.map((w) => w.message))];
  const warnBlock = warnLines.length ? 1.2 + warnLines.length * 0.42 : 0;

  const layout = mapLayout(board, contentW, contentH - 2.0);
  const tableTop = layout.bottom - 0.9;
  const pages: PageDoc[] = [];
  const perPage = Math.max(1, Math.floor((tableTop - warnBlock - 0.6) / rowH) - 1);

  const notesBlock = (ctx: DrawCtx, y0: number): void => {
    let y = y0;
    ctx.text({ x: 0, y }, 'Notes', { sizePt: 8, gray: 0.15 });
    for (const line of warnLines) {
      y -= 0.42;
      ctx.text({ x: 0.4, y }, `* ${line}`, { sizePt: 7, gray: 0.35 });
    }
  };

  // Page 1 carries the map; any overflow rows continue on plain pages.
  pages.push(
    buildFixedPage(paper, MARGIN_CM, { x: 0, y: 0 }, { title, note, calibration: false }, (ctx) => {
      const slice = rows.slice(0, perPage);
      ctx.text({ x: 0, y: contentH - 0.9 }, subtitle, { sizePt: 8, gray: 0.35 });
      drawMap(ctx, board, stations, traces, layout, L);
      drawLegend(ctx, 0, layout.bottom, bands, traces.tuckRocker.length > 0);
      ctx.text(
        { x: contentW, y: layout.bottom },
        'NOT TO SCALE — measure the 1:1 pages, not this map',
        { sizePt: 7, gray: 0.45, align: 'right' },
      );
      const end = ctx.table(0, tableTop, cols, [head, ...slice], {
        sizePt: 7,
        rowHeightCm: rowH,
        headerRule: true,
      });
      if (slice.length >= rows.length && warnLines.length) notesBlock(ctx, end - 0.9);
    }),
  );
  const laterPerPage = Math.max(1, Math.floor((contentH - 2.4 - warnBlock) / rowH) - 1);
  for (let start = perPage; start < rows.length; start += laterPerPage) {
    const slice = rows.slice(start, start + laterPerPage);
    const isLast = start + laterPerPage >= rows.length;
    pages.push(
      buildFixedPage(
        paper,
        MARGIN_CM,
        { x: 0, y: 0 },
        { title: `${title} (continued)`, note, calibration: false },
        (ctx) => {
          const end = ctx.table(0, contentH - 1.4, cols, [head, ...slice], {
            sizePt: 7,
            rowHeightCm: rowH,
            headerRule: true,
          });
          if (isLast && warnLines.length) notesBlock(ctx, end - 0.9);
        },
      ),
    );
  }
  return pages;
};

// --- detail pages: one station, true 1:1 ---------------------------------------

/** Everything the detail page draws, in section coordinates. */
const drawStation = (
  ctx: DrawCtx,
  st: RailStationFacets,
  crop: Box,
  ghost: boolean,
  L: (cm: number) => string,
): void => {
  const { railX, deckY, bottomY } = st.blank;

  // 1. the designed section, behind everything — how much is left to blend away
  if (ghost) {
    ctx.clip(crop, () => {
      ctx.bezier(splineSegments(st.section.spline), { width: 0.4, gray: 0.72 });
    });
  }

  // 2. the squared blank: the two planes every band-1 mark is measured from
  ctx.seg({ x: crop.minX, y: deckY }, { x: railX, y: deckY }, { width: 0.4, dashed: true, gray: 0.5 }); // prettier-ignore
  ctx.seg({ x: crop.minX, y: bottomY }, { x: railX, y: bottomY }, { width: 0.4, dashed: true, gray: 0.5 }); // prettier-ignore
  ctx.seg({ x: railX, y: bottomY }, { x: railX, y: deckY }, { width: 0.4, dashed: true, gray: 0.5 }); // prettier-ignore
  for (const corner of [
    { x: railX, y: deckY },
    { x: railX, y: bottomY },
  ]) {
    ctx.tick(corner, 0, 0.5, { width: 0.4, gray: 0.2 });
    ctx.tick(corner, Math.PI / 2, 0.5, { width: 0.4, gray: 0.2 });
  }

  // 2b. the foam these cuts do not reach — the region between the last facet and the
  //     finished rail, which is exactly what the shaper sands away. Printing it is the
  //     honest version of the number in the footer: you can see where the work is.
  ctx.clip(crop, () => {
    ctx.poly(leftoverOutline(st), { fill: LEFTOVER_TINT, stroke: false });
  });

  // 3. the facets. Heavy where the face survives; thin where the next cut eats it back.
  for (const f of [...st.deckFacets, ...st.bottomFacets]) {
    const color = f.side === 'deck' ? bandColor(f.index) : TUCK_COLOR;
    ctx.seg(f.keepFrom, f.keepTo, { width: 0.9, color });
    if (f.keepTo.x !== f.cutTo.x || f.keepTo.y !== f.cutTo.y) {
      ctx.seg(f.keepTo, f.cutTo, { width: 0.3, color, dashed: true });
    }
    ctx.dot(f.touch, 0.045, 0, color);
    const mid = { x: (f.keepFrom.x + f.keepTo.x) / 2, y: (f.keepFrom.y + f.keepTo.y) / 2 };
    const away = f.side === 'deck' ? 0.32 : -0.32;
    ctx.text(
      { x: mid.x - 1.5, y: mid.y + away },
      `${f.side === 'deck' ? f.index : 'T'}  ${fmtAngle(f)}`,
      { sizePt: 7, color, knockout: true },
    );
  }

  // 4. band 1 off the blank corners; later bands off the face already cut
  //
  // Sign convention, because it is easy to get backwards and the result looks almost
  // plausible: `dim` offsets along (-uy, ux) for u pointing a→b. Deck marks run
  // rail→inboard, so u = (-1, 0) and a NEGATIVE offset lifts them clear of the deck.
  st.deckFacets.forEach((f, i) => {
    const color = bandColor(f.index);
    const deckMark = f.marks.find((m) => m.ref.kind === 'deckPlane');
    if (deckMark) {
      const off = -(0.9 + i * 0.75);
      // A mark that lands off the crop still gets its true number, drawn to a break.
      // It is a tape pull from the deck corner, not a traced line, so nothing is lost by
      // interrupting the drawing of it — and the page stays 1:1 where that matters.
      if (deckMark.at.x < crop.minX) {
        ctx.dimBroken(
          { x: railX, y: deckY },
          { x: deckMark.at.x, y: deckY },
          off,
          railX - crop.minX - 0.6,
          L(deckMark.distance),
          { color },
        );
      } else {
        ctx.dim(
          { x: railX, y: deckY },
          { x: deckMark.at.x, y: deckY },
          off,
          L(deckMark.distance),
          { color },
        );
      }
    }
    const chained = f.marks.find((m) => m.ref.kind === 'facet');
    if (chained && i > 0) {
      const prev = st.deckFacets[i - 1]!;
      const dir = Math.atan2(chained.at.y - prev.cutTo.y, chained.at.x - prev.cutTo.x);
      ctx.dimAlong(prev.cutTo, dir, chained.distance, 0.55, L(chained.distance), { color });
    }
    const railMark = i === 0 ? f.marks.find((m) => m.ref.kind === 'railPlane') : undefined;
    if (railMark) {
      // vertical dim: u = +y, so its perpendicular is −x; a negative offset puts it right
      ctx.dim(
        { x: railX, y: bottomY },
        { x: railX, y: railMark.at.y },
        -1.8,
        L(railMark.distance),
        {
          color,
        },
      );
    }
  });

  const tuck = st.bottomFacets[0];
  if (tuck) {
    const up = tuck.marks.find((m) => m.ref.kind === 'railPlane');
    const inn = tuck.marks.find((m) => m.ref.kind === 'bottomPlane');
    if (up) {
      ctx.dim({ x: railX, y: bottomY }, { x: railX, y: up.at.y }, -0.7, L(up.distance), {
        color: TUCK_COLOR,
      });
    }
    // rail→inboard again, so a POSITIVE offset drops this one below the bottom plane
    if (inn) {
      ctx.dim({ x: railX, y: bottomY }, { x: inn.at.x, y: bottomY }, 0.9, L(inn.distance), {
        color: TUCK_COLOR,
      });
    }
  }

  // 5. the overall thickness of the blank at this station, off to the inboard side where
  //    nothing else is drawn — the number every band mark is implicitly a fraction of.
  ctx.dim(
    { x: crop.minX + 0.5, y: bottomY },
    { x: crop.minX + 0.5, y: deckY },
    0,
    L(st.blank.thickness),
    { color: THICKNESS_COLOR, sizePt: 7.5 },
  );
};

const buildDetailPage = (
  st: RailStationFacets,
  letter: string,
  paper: PaperSize,
  opts: RailBandsPdfOptions,
  cropW: number,
  note: string,
  L: (cm: number) => string,
): PageDoc | { oversized: PageDoc } => {
  const { w: contentW, h: contentH } = contentSize(paper);
  const { railX, deckY, bottomY, thickness } = st.blank;
  const crop: Box = { minX: railX - cropW, minY: bottomY - 0.6, maxX: railX, maxY: deckY + 0.6 };

  const tableRows: string[][] = [['Cut', 'Angle', 'Mark', 'Measured from']];
  st.deckFacets.forEach((f) => {
    const deckMark = f.marks.find((m) => m.ref.kind === 'deckPlane');
    const railMark = f.marks.find((m) => m.ref.kind === 'railPlane');
    const chained = f.marks.find((m) => m.ref.kind === 'facet');
    if (railMark) {
      tableRows.push([`${f.index}`, fmtAngle(f), L(railMark.distance), 'up from the bottom corner']); // prettier-ignore
    }
    if (chained) {
      tableRows.push([`${f.index}`, fmtAngle(f), L(chained.distance), `along band ${f.index - 1}, from its deck edge`]); // prettier-ignore
    }
    if (deckMark) {
      tableRows.push(['', '', L(deckMark.distance), 'in from the deck corner']);
    }
  });
  const tuck = st.bottomFacets[0];
  if (tuck) {
    const up = tuck.marks.find((m) => m.ref.kind === 'railPlane');
    const inn = tuck.marks.find((m) => m.ref.kind === 'bottomPlane');
    if (up) tableRows.push(['Tuck', fmtAngle(tuck), L(up.distance), 'up from the bottom corner']);
    if (inn) tableRows.push(['', '', L(inn.distance), 'in from the bottom corner']);
  }

  // ---- vertical budget -------------------------------------------------------
  //
  // Laid out as a budget rather than fixed offsets, because every piece varies: the
  // section's thickness, the number of table rows, whether there is a radius note. With
  // fixed offsets a thick station simply pushed the footer off the bottom of the page
  // and printed it over the brand line.
  //
  // When it does not fit, prose is dropped before the page is allowed to grow. A sheet
  // even a few millimetres over A4 is a trap: the shaper reaches for "fit to page",
  // which silently destroys the one thing this page exists to carry. The cut order stays
  // whatever happens; the explanatory lines are also in /docs/export.
  const ROW_H = 0.43;
  const LINE_H = 0.4;
  const TOP_GAP = 1.9; // title to the deck plane
  const TUCK_GAP = 2.5; // bottom plane down past the tuck dimension
  const TABLE_GAP = 0.7;

  const allFooterLines = [
    `Cut in this order: ${[
      ...st.deckFacets.map((f) => `${f.index}`),
      ...(st.bottomFacets[0] ? ['tuck'] : []),
    ].join(' → ')}`,
    // Second, so it survives the shedding below on all but the tightest pages: it is the
    // one line that says how much work these cuts actually save.
    `These cuts take out ${(st.leftover.deck.removed * 100).toFixed(0)}% of the foam standing proud of the deck side. Deepest left to blend: ${L(st.leftover.deck.worstDepth)}.`,
    'Band 1 is marked on the squared blank. Every later band is marked on the face you just cut.',
    'Shaded area is what the cuts do not reach — the foam between the last facet and the finished rail.',
    ...(st.edgeRadius !== null
      ? [`Bottom edge finishes at about ${L(st.edgeRadius)} radius.`]
      : []),
  ];

  const tableH = tableRows.length * ROW_H;
  const heightFor = (lines: number): number =>
    TOP_GAP + thickness + TUCK_GAP + TABLE_GAP + tableH + 0.6 + lines * LINE_H + 0.3;

  let footerLines = allFooterLines;
  while (footerLines.length > 1 && heightFor(footerLines.length) > contentH) {
    footerLines = footerLines.slice(0, -1);
  }
  const neededH = heightFor(footerLines.length);

  const drawTopV = contentH - TOP_GAP;
  const originY = deckY - drawTopV;
  const originX = railX - cropW;
  const tableTopV = drawTopV - thickness - TUCK_GAP;

  const title = `${letter} · ${L(st.position)} from tail · 1:1`;
  const drawAll = (ctx: DrawCtx): void => {
    drawStation(ctx, st, crop, opts.ghostSection ?? true, L);
    // page-relative helpers, so the notes below do not depend on the section's height
    const pv = (v: number): number => originY + v;
    const pu = (u: number): number => originX + u;

    const end = ctx.table(
      pu(0),
      pv(tableTopV),
      [{ widthCm: 1.4 }, { widthCm: 3.4 }, { widthCm: 2.6, align: 'right' }, { widthCm: 8.0 }],
      tableRows,
      { sizePt: 7.5, rowHeightCm: ROW_H },
    );
    // Colour key down the Cut column, tying each row to its line on the drawing.
    let ry = pv(tableTopV) - ROW_H;
    const swatch = (y: number, color: Rgb): void =>
      ctx.seg({ x: pu(-0.35), y: y + 0.14 }, { x: pu(-0.1), y: y + 0.14 }, { width: 1.2, color });
    for (const f of st.deckFacets) {
      const rows = f.marks.length;
      for (let k = 0; k < rows; k++) swatch(ry - ROW_H * k, bandColor(f.index));
      ry -= ROW_H * rows;
    }
    if (st.bottomFacets[0]) {
      for (let k = 0; k < st.bottomFacets[0].marks.length; k++) swatch(ry - ROW_H * k, TUCK_COLOR);
    }

    let fy = end - 0.6;
    footerLines.forEach((line, i) => {
      ctx.text({ x: pu(0), y: fy }, line, { sizePt: i === 0 ? 8 : 7, gray: i === 0 ? 0.1 : 0.4 });
      fy -= LINE_H;
    });
  };

  const fits = cropW + DIM_GUTTER_CM <= contentW && neededH <= contentH;
  if (fits) {
    return buildFixedPage(
      paper,
      MARGIN_CM,
      { x: originX, y: originY },
      { title, note, calibration: opts.calibration ?? true, inches: opts.units === 'in' },
      drawAll,
    );
  }
  // Last resort: an oversized page. Still 1:1 — the sheet grows, the drawing does not shrink.
  const bb: Box = {
    minX: originX,
    minY: originY,
    maxX: originX + Math.max(contentW, cropW + DIM_GUTTER_CM),
    maxY: originY + Math.max(contentH, neededH),
  };
  const d = buildDrawing(
    bb,
    MARGIN_CM,
    { title, note, calibration: opts.calibration ?? true, inches: opts.units === 'in' },
    drawAll,
  );
  return { oversized: { width: d.widthPt, height: d.heightPt, content: d.content } };
};

// --- entry point ---------------------------------------------------------------

/**
 * Build the rail-bands PDF. Returns the file together with every warning the geometry
 * raised, so the caller can surface them in the UI as well as on the sheet.
 */
export const exportRailBandsPdf = (
  board: BezierBoard,
  opts: RailBandsPdfOptions = {},
): RailBandsPdfResult => {
  const inches = opts.units === 'in';
  const L =
    opts.fmt ?? ((cm: number): string => (inches ? `${(cm / 2.54).toFixed(2)} in` : `${cm.toFixed(1)} cm`)); // prettier-ignore

  const plan = railFacetPlan(board, {
    ...opts.facets,
    targetSpacingCm: opts.stationSpacingCm,
    endMarginCm: opts.endMarginCm,
  });
  const bands = Math.max(1, ...plan.stations.map((st) => st.deckFacets.length));
  const traces =
    plan.stations.length > 1 ? traceBands(board, plan.stations, opts.facets, bands) : EMPTY_TRACES;

  const name = opts.meta?.model || 'Surfboard';
  const title = `${name} · Rail bands`;
  // Angles are fitted per station, so quoting the tail station's would misdescribe the
  // board. Quote the widepoint — the section a rail is designed around — and say plainly
  // when the rest differ.
  const mid =
    plan.stations.find((st) => st.position >= plan.widePoint) ??
    plan.stations[plan.stations.length - 1];
  const angleList = (st: RailStationFacets | undefined): string =>
    st?.deckFacets.map((f) => `${f.targetAngle}°`).join(' / ') ?? '—';
  const angles = angleList(mid);
  const varies = plan.stations.some((st) => angleList(st) !== angles);
  const placement = PLACEMENT_LABELS[opts.facets?.angleMode ?? 'balanced'];
  const tuckAngle = plan.stations[0]?.bottomFacets[0]?.targetAngle;
  // Report the spacing the fit actually produced, not the target that was asked for —
  // the two differ by design, and the sheet is the thing being measured against.
  const xs = plan.stations.map((s) => s.position);
  const spacing =
    xs.length > 1 ? ` · stations about ${L((xs[xs.length - 1]! - xs[0]!) / (xs.length - 1))} apart` : ''; // prettier-ignore
  // Only claim a unit when we chose the formatting. With an injected formatter the app's
  // own unit is in play — it may well be millimetres — and every number already carries
  // its own suffix, so announcing "units cm" beside a figure in mm is just wrong.
  const unitNote = opts.fmt ? '' : ` · units ${inches ? 'in' : 'cm'}`;
  const subtitle = `${bands} deck band${bands === 1 ? '' : 's'}, ${placement} · ${angles}${varies ? ' at the widepoint, varying along the board' : ''}${tuckAngle ? ` · tuck ${tuckAngle}°` : ''}${spacing}${unitNote}`; // prettier-ignore
  const note = `${name} · rail bands — detail pages are 1:1, print at 100% scale · ${BRAND_LINE}`;

  // One crop for every detail page, sized by the station that reaches furthest in, so
  // the pages are directly comparable and the orientation is decided once — then capped
  // to what the sheet actually holds. Beyond the cap the marks are still dimensioned,
  // with a break in the line; growing the page instead would push a wide board past A4
  // and invite the "fit to page" that destroys 1:1.
  const wantCrop = Math.max(opts.detailCropCm ?? DEFAULT_CROP_CM, ...plan.stations.map(neededCrop));
  const tallest = Math.max(1, ...plan.stations.map((st) => st.blank.thickness));

  const overviewPaper = orient(opts.paper ?? A4, opts.orientation ?? 'auto', 1.4);
  const detailPaper = orient(
    opts.paper ?? A4,
    opts.orientation ?? 'auto',
    (wantCrop + DIM_GUTTER_CM) / (tallest + 3),
  );
  const cropW = Math.max(3, Math.min(wantCrop, contentSize(detailPaper).w - DIM_GUTTER_CM));

  const pages: PageDoc[] = buildOverviewPages(
    board,
    plan.stations,
    traces,
    plan.warnings,
    bands,
    overviewPaper,
    title,
    note,
    subtitle,
    L,
  );

  const warnings: RailBandsWarning[] = [...plan.warnings];
  if (opts.detailPages ?? true) {
    plan.stations.forEach((st, i) => {
      const page = buildDetailPage(st, stationLetter(i), detailPaper, opts, cropW, note, L);
      if ('oversized' in page) {
        pages.push(page.oversized);
        warnings.push({
          code: 'page-oversized',
          message:
            'a station needed more room than the chosen paper — that page is oversized, never scaled down',
          position: st.position,
        });
      } else {
        pages.push(page);
      }
    });
  }

  return {
    file: { name: 'rail-bands.pdf', bytes: buildPdf(pages) },
    warnings,
  };
};
