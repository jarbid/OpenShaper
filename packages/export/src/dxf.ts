import { getLength, resolveFins, valueAt, type BezierBoard, type ResolvedFin } from '@openshaper/kernel'; // prettier-ignore
import {
  chainSegs,
  crossSectionBeziers,
  flattenBeziers,
  mapSeg,
  planOutlineBeziers,
  splineSegments,
  ySpan,
  ySpanX,
  type CurveSeg,
  type Pt,
} from './board-curves';
import { BRAND_LINE } from './brand';

/**
 * How curves are written: `'polyline'` flattens the exact beziers to a dense polyline
 * sampled along the curve (smooth, R12 — maximum CAM/viewer compatibility); `'spline'`
 * emits true cubic-bezier SPLINE entities (resolution-independent, requires R13+/AC1015,
 * not read by some simple tools).
 */
export type DxfCurveMode = 'polyline' | 'spline';

/** Options for {@link exportDxf}. */
export interface DxfOptions {
  /** Polyline samples per source spline (outline / rocker profiles). Default 200. */
  lengthSteps?: number;
  /** Profile samples per exported cross-section ring. Default 64. */
  ringSteps?: number;
  /** Number of cross-section profiles to draw, evenly spaced. Default 7. */
  crossSectionCount?: number;
  /** Curve representation: dense polylines (default) or true SPLINE entities. */
  curveMode?: DxfCurveMode;
  /**
   * Reference (ghost) board to overlay: its plan outline and rocker curves are
   * drawn dashed on the dedicated GHOST layer, tail-aligned with the main board,
   * so shapers can compare in their CNC tool. The layer is left visible (not
   * frozen — most viewers hide frozen layers); exclude GHOST in CAM.
   */
  ghostBoard?: BezierBoard;
}

const DEFAULT_LENGTH_STEPS = 200;
const DEFAULT_RING_STEPS = 64;
const DEFAULT_CS_COUNT = 7;

/** Drawing layers, each on its own logical band so a DXF viewer reads cleanly. */
const LAYERS = {
  OUTLINE: 7, // white
  ROCKER: 5, // blue
  CROSSSECTION: 3, // green
  CENTERLINE: 1, // red
  MARKERS: 2, // yellow
  LABELS: 8, // grey
  GHOST: 9, // light grey — reference board overlay
  FINS: 6, // magenta — fin footprints + box/plug router templates
} as const;
type Layer = keyof typeof LAYERS;

const num = (n: number): string => (Number.isFinite(n) ? n : 0).toFixed(6);

/** Emit an open/closed R12 POLYLINE on `layer`, optionally with a non-default line type. */
const polyline = (
  out: string[],
  pts: readonly Pt[],
  layer: Layer,
  opts: { closed?: boolean; lineType?: string } = {},
): void => {
  if (pts.length < 2) return;
  out.push('0', 'POLYLINE', '8', layer);
  if (opts.lineType) out.push('6', opts.lineType);
  out.push('66', '1', '70', opts.closed ? '1' : '0');
  for (const p of pts) {
    out.push('0', 'VERTEX', '8', layer);
    out.push('10', num(p.x), '20', num(p.y), '30', '0.0');
  }
  out.push('0', 'SEQEND');
};

/** Emit a LINE entity from `a` to `b` on `layer`, optionally with a line type. */
const line = (out: string[], a: Pt, b: Pt, layer: Layer, lineType?: string): void => {
  out.push('0', 'LINE', '8', layer);
  if (lineType) out.push('6', lineType);
  out.push('10', num(a.x), '20', num(a.y), '30', '0.0');
  out.push('11', num(b.x), '21', num(b.y), '31', '0.0');
};

/** Emit a TEXT label of height `h` anchored at (x, y) on `layer`. */
const text = (out: string[], x: number, y: number, h: number, str: string, layer: Layer): void => {
  out.push('0', 'TEXT', '8', layer);
  out.push('10', num(x), '20', num(y), '30', '0.0', '40', num(h), '1', str);
};

/** Emit a CIRCLE entity centered at (x, y) with radius `r` on `layer`. */
const circle = (out: string[], x: number, y: number, r: number, layer: Layer): void => {
  out.push('0', 'CIRCLE', '8', layer);
  out.push('10', num(x), '20', num(y), '30', '0.0', '40', num(r));
};

/** Samples per bezier segment so a `total`-point budget is spread across `nSegs`. */
const perSeg = (nSegs: number, total: number): number =>
  Math.max(8, Math.round(total / Math.max(1, nSegs)));

/**
 * Emit a cubic-bezier path as one DXF SPLINE entity (degree 3). `chained` must be a
 * continuous chain (see `chainSegs`); it is encoded as a clamped Bézier-knot B-spline:
 * control points p0,c1,c2,p3,c1,c2,p3,… with knot vector [0×4, 1×3, 2×3, …, n×4]. This
 * reproduces each cubic segment exactly. Needs DXF R13+ (AC1015 header).
 */
const spline = (
  out: string[],
  chained: readonly CurveSeg[],
  layer: Layer,
  opts: { closed?: boolean; lineType?: string } = {},
): void => {
  if (chained.length === 0) return;
  const ctrl: Pt[] = [chained[0]!.p0];
  for (const s of chained) ctrl.push(s.c1, s.c2, s.p3);
  const nSeg = chained.length;
  const knots: number[] = [0, 0, 0, 0];
  for (let i = 1; i < nSeg; i++) knots.push(i, i, i);
  knots.push(nSeg, nSeg, nSeg, nSeg);

  let flags = 8; // 8 = planar
  if (opts.closed) flags |= 1; // 1 = closed

  out.push('0', 'SPLINE', '100', 'AcDbEntity', '8', layer);
  if (opts.lineType) out.push('6', opts.lineType);
  out.push('100', 'AcDbSpline');
  out.push('70', String(flags), '71', '3', '72', String(knots.length), '73', String(ctrl.length), '74', '0'); // prettier-ignore
  out.push('42', '0.0000001', '43', '0.0000001', '44', '0.0000000001');
  for (const k of knots) out.push('40', num(k));
  for (const p of ctrl) out.push('10', num(p.x), '20', num(p.y), '30', '0.0');
};

/** Minimal HEADER declaring the DXF version + centimetre units (needed for SPLINE mode). */
const headerSection = (out: string[]): void => {
  out.push('0', 'SECTION', '2', 'HEADER');
  out.push('9', '$ACADVER', '1', 'AC1015'); // R2000 — first widely-read version supporting SPLINE
  out.push('9', '$INSUNITS', '70', '5'); // 5 = centimetres
  out.push('0', 'ENDSEC');
};

/**
 * Draw the resolved fins on the plan view (FINS layer): each fin's toed base
 * footprint plus the system box/plug router template at true scale and position —
 * the geometry a shaper routes into the blank. Glass-on fins (no box) show just the
 * footprint. Plan coords already match the outline band (x = length, y = lateral).
 */
const drawFins = (out: string[], fins: readonly ResolvedFin[]): void => {
  for (const f of fins) {
    const { fore, aft } = f.baseLine;
    line(out, aft, fore, 'FINS');
    if (f.box.kind !== 'shapes') continue;
    const cx = (fore.x + aft.x) / 2;
    const cy = (fore.y + aft.y) / 2;
    const dl = Math.hypot(fore.x - aft.x, fore.y - aft.y) || 1;
    const ax = (fore.x - aft.x) / dl;
    const ay = (fore.y - aft.y) / dl; // along (toward nose)
    const nx = -ay;
    const ny = ax; // normal
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
        polyline(out, [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)], 'FINS', {
          closed: true,
        });
      } else {
        circle(out, ox, oy, fp.shape.diameter / 2, 'FINS');
      }
    }
  }
};

/** The R12 TABLES section: line types (CONTINUOUS / CENTER / DASHED) + the named layers. */
const tablesSection = (out: string[]): void => {
  out.push('0', 'SECTION', '2', 'TABLES');

  // --- Line types ---
  out.push('0', 'TABLE', '2', 'LTYPE', '70', '3');
  out.push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0'); // prettier-ignore
  // Dash-dot centreline.
  out.push('0', 'LTYPE', '2', 'CENTER', '70', '0', '3', 'Center ____ _ ____', '72', '65', '73', '4', '40', '2.0'); // prettier-ignore
  out.push('49', '1.25', '49', '-0.25', '49', '0.25', '49', '-0.25');
  // Dashed rib station lines.
  out.push('0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed __ __ __', '72', '65', '73', '2', '40', '0.75'); // prettier-ignore
  out.push('49', '0.5', '49', '-0.25');
  out.push('0', 'ENDTAB');

  // --- Layers ---
  const names = Object.keys(LAYERS) as Layer[];
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(names.length));
  for (const name of names) {
    out.push('0', 'LAYER', '2', name, '70', '0', '62', String(LAYERS[name]), '6', 'CONTINUOUS');
  }
  out.push('0', 'ENDTAB');

  out.push('0', 'ENDSEC');
};

/**
 * Export the board as an ASCII (R12-style) DXF organised into labelled, vertically
 * stacked bands: a plan view (outline + stringer centreline + dashed rib-station
 * markers with x labels), the rocker profile (deck + bottom) below it, and a row of
 * true-scale cross-sections below that. Layers and line types are declared in a
 * TABLES section so a DXF viewer can toggle them. Units are centimetres.
 */
export const exportDxf = (board: BezierBoard, opts: DxfOptions = {}): string => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const ringSteps = Math.max(3, opts.ringSteps ?? DEFAULT_RING_STEPS);
  const csCount = Math.max(0, opts.crossSectionCount ?? DEFAULT_CS_COUNT);
  const mode = opts.curveMode ?? 'polyline';
  const length = getLength(board);
  const eps = Math.min(0.01, length / (lengthSteps * 4));

  // Draw a chain of exact bezier `segs` either as a true SPLINE or a dense, smooth
  // polyline (sampled along the curve so high-curvature tails don't facet).
  const curve = (
    segs: readonly CurveSeg[],
    layer: Layer,
    closed: boolean,
    lineType?: string,
  ): void => {
    if (mode === 'spline') {
      spline(out, chainSegs(segs, closed), layer, { closed, lineType });
    } else {
      polyline(out, flattenBeziers(segs, perSeg(segs.length, lengthSteps)), layer, {
        closed,
        lineType,
      });
    }
  };

  const out: string[] = [];
  out.push('999', 'DXF export from OpenShaper', '999', BRAND_LINE);
  if (mode === 'spline') headerSection(out);
  tablesSection(out);
  out.push('0', 'SECTION', '2', 'ENTITIES');

  // --- Plan view at origin: outline loop (both rails), spanning y = ±half-width. ---
  const outlineSegs = planOutlineBeziers(board);
  const outlinePts = flattenBeziers(outlineSegs, perSeg(outlineSegs.length, lengthSteps));
  const maxHalf = outlinePts.reduce((m, p) => Math.max(m, p.y), 0);
  curve(outlineSegs, 'OUTLINE', true);

  // Stringer centreline (full length) + dashed rib-station markers with x labels.
  line(out, { x: eps, y: 0 }, { x: length - eps, y: 0 }, 'CENTERLINE', 'CENTER');
  const labelH = Math.max(1, maxHalf * 0.12);
  for (let c = 0; c < csCount; c++) {
    const pos = eps + ((length - 2 * eps) * (c + 0.5)) / csCount;
    const half = valueAt(board.outline, pos);
    line(out, { x: pos, y: -half }, { x: pos, y: half }, 'MARKERS', 'DASHED');
    text(out, pos + labelH * 0.3, half + labelH * 0.4, labelH, `${pos.toFixed(1)}`, 'LABELS');
  }

  // Fin footprints + box/plug router templates on the plan view.
  drawFins(out, resolveFins(board));

  // --- Rocker profile band, stacked below the plan view. ---
  const gap = Math.max(4, maxHalf * 0.4);
  const bottomSegs = splineSegments(board.bottom);
  const deckSegs = splineSegments(board.deck);
  const bottomPts = flattenBeziers(bottomSegs, perSeg(bottomSegs.length, lengthSteps));
  const deckPts = flattenBeziers(deckSegs, perSeg(deckSegs.length, lengthSteps));
  const rocker = ySpan([...bottomPts, ...deckPts]);
  // Shift so the rocker band's top sits `gap` below the plan view's lowest point.
  const rockerShift = -maxHalf - gap - rocker.hi;
  const lift = (pts: Pt[]): Pt[] => pts.map((p) => ({ x: p.x, y: p.y + rockerShift }));
  const liftSeg = (s: CurveSeg): CurveSeg => mapSeg(s, (p) => ({ x: p.x, y: p.y + rockerShift }));
  curve(bottomSegs.map(liftSeg), 'ROCKER', false);
  curve(deckSegs.map(liftSeg), 'ROCKER', false);
  // Rocker baseline (rocker = 0) on the centreline layer.
  line(
    out,
    { x: eps, y: rockerShift },
    { x: length - eps, y: rockerShift },
    'CENTERLINE',
    'CENTER',
  );

  // --- Ghost reference overlay: dashed plan outline + rocker curves, tail-aligned
  // with the main board and sharing the rocker band's shift so the curves compare
  // directly. Reference-only geometry — everything lands on the GHOST layer.
  if (opts.ghostBoard) {
    const g = opts.ghostBoard;
    const dashed = { lineType: 'DASHED' };
    // Reference overlay is always a smooth dashed polyline (mode-independent).
    const gOutline = planOutlineBeziers(g);
    const gBottom = splineSegments(g.bottom);
    const gDeck = splineSegments(g.deck);
    polyline(out, flattenBeziers(gOutline, perSeg(gOutline.length, lengthSteps)), 'GHOST', { closed: true, ...dashed }); // prettier-ignore
    polyline(out, lift(flattenBeziers(gBottom, perSeg(gBottom.length, lengthSteps))), 'GHOST', dashed); // prettier-ignore
    polyline(out, lift(flattenBeziers(gDeck, perSeg(gDeck.length, lengthSteps))), 'GHOST', dashed);
  }

  // --- Cross-section band: a true-scale row laid out left-to-right below the rocker. ---
  const rockerBottom = rocker.lo + rockerShift;
  const csBandTop = rockerBottom - gap;
  let cursorX = 0;
  for (let c = 0; c < csCount; c++) {
    const pos = eps + ((length - 2 * eps) * (c + 0.5)) / csCount;
    const segs = crossSectionBeziers(board, pos);
    if (!segs) continue;
    const ringPts = flattenBeziers(segs, perSeg(segs.length, ringSteps));
    const sx = ySpanX(ringPts);
    const sy = ySpan(ringPts);
    const sectionW = sx.hi - sx.lo;
    const centerX = cursorX + sectionW / 2 - (sx.lo + sx.hi) / 2;
    // Hang the section from csBandTop (its top edge), centred on its own width.
    const shiftY = csBandTop - sy.hi;
    const place = (p: Pt): Pt => ({ x: p.x + centerX, y: p.y + shiftY });
    curve(
      segs.map((s) => mapSeg(s, place)),
      'CROSSSECTION',
      true,
    );
    // Centreline tick + station label.
    const tickX = cursorX + sectionW / 2;
    line(out, { x: tickX, y: csBandTop }, { x: tickX, y: csBandTop - labelH }, 'CENTERLINE'); // prettier-ignore
    text(out, sx.lo + centerX, csBandTop + labelH * 0.4, labelH, `x=${pos.toFixed(1)}`, 'LABELS');
    cursorX += sectionW + gap;
  }

  out.push('0', 'ENDSEC');
  out.push('0', 'EOF');
  return out.join('\n') + '\n';
};
