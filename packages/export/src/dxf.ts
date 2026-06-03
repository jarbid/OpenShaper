import {
  getInterpolatedCrossSection,
  getLength,
  pointByTT,
  valueAt,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';

/** Options for {@link exportDxf}. */
export interface DxfOptions {
  /** Polyline samples per source spline (outline / rocker profiles). Default 200. */
  lengthSteps?: number;
  /** Profile samples per exported cross-section ring. Default 64. */
  ringSteps?: number;
  /** Number of cross-section profiles to draw, evenly spaced. Default 7. */
  crossSectionCount?: number;
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
} as const;
type Layer = keyof typeof LAYERS;

interface Pt {
  readonly x: number;
  readonly y: number;
}

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

/** Vertical extent of a set of points (used to place the cross-section band). */
const ySpan = (pts: readonly Pt[]): { lo: number; hi: number } => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return Number.isFinite(hi - lo) ? { lo, hi } : { lo: 0, hi: 0 };
};

/** Horizontal extent of a set of points. */
const ySpanX = (pts: readonly Pt[]): { lo: number; hi: number } => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  return Number.isFinite(hi - lo) ? { lo, hi } : { lo: 0, hi: 0 };
};

/** Sample a spline's y(x) over [x0, x1] into a polyline. */
const sampleProfile = (s: Spline, x0: number, x1: number, steps: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    pts.push({ x, y: valueAt(s, x) });
  }
  return pts;
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
  const length = getLength(board);
  const eps = Math.min(0.01, length / (lengthSteps * 4));

  const out: string[] = [];
  out.push('999', 'DXF export from OpenShaper');
  tablesSection(out);
  out.push('0', 'SECTION', '2', 'ENTITIES');

  // --- Plan view at origin: outline loop (both rails), spanning y = ±half-width. ---
  const halfTop: Pt[] = [];
  for (let i = 0; i <= lengthSteps; i++) {
    const x = eps + ((length - 2 * eps) * i) / lengthSteps;
    halfTop.push({ x, y: valueAt(board.outline, x) });
  }
  const maxHalf = halfTop.reduce((m, p) => Math.max(m, p.y), 0);
  const outlineLoop: Pt[] = [...halfTop];
  for (let i = halfTop.length - 1; i >= 0; i--) {
    const p = halfTop[i]!;
    outlineLoop.push({ x: p.x, y: -p.y });
  }
  polyline(out, outlineLoop, 'OUTLINE', { closed: true });

  // Stringer centreline (full length) + dashed rib-station markers with x labels.
  line(out, { x: eps, y: 0 }, { x: length - eps, y: 0 }, 'CENTERLINE', 'CENTER');
  const labelH = Math.max(1, maxHalf * 0.12);
  for (let c = 0; c < csCount; c++) {
    const pos = eps + ((length - 2 * eps) * (c + 0.5)) / csCount;
    const half = valueAt(board.outline, pos);
    line(out, { x: pos, y: -half }, { x: pos, y: half }, 'MARKERS', 'DASHED');
    text(out, pos + labelH * 0.3, half + labelH * 0.4, labelH, `${pos.toFixed(1)}`, 'LABELS');
  }

  // --- Rocker profile band, stacked below the plan view. ---
  const gap = Math.max(4, maxHalf * 0.4);
  const bottom = sampleProfile(board.bottom, eps, length - eps, lengthSteps);
  const deck = sampleProfile(board.deck, eps, length - eps, lengthSteps);
  const rocker = ySpan([...bottom, ...deck]);
  // Shift so the rocker band's top sits `gap` below the plan view's lowest point.
  const rockerShift = -maxHalf - gap - rocker.hi;
  const lift = (pts: Pt[]): Pt[] => pts.map((p) => ({ x: p.x, y: p.y + rockerShift }));
  polyline(out, lift(bottom), 'ROCKER');
  polyline(out, lift(deck), 'ROCKER');
  // Rocker baseline (rocker = 0) on the centreline layer.
  line(
    out,
    { x: eps, y: rockerShift },
    { x: length - eps, y: rockerShift },
    'CENTERLINE',
    'CENTER',
  );

  // --- Cross-section band: a true-scale row laid out left-to-right below the rocker. ---
  const rockerBottom = rocker.lo + rockerShift;
  const csBandTop = rockerBottom - gap;
  let cursorX = 0;
  for (let c = 0; c < csCount; c++) {
    const pos = eps + ((length - 2 * eps) * (c + 0.5)) / csCount;
    const cs = getInterpolatedCrossSection(board, pos);
    if (!cs) continue;
    const ring: Pt[] = [];
    for (let r = ringSteps; r >= 0; r--) {
      const p = pointByTT(cs.spline, r / ringSteps);
      ring.push({ x: -p.x, y: p.y });
    }
    for (let r = 0; r <= ringSteps; r++) {
      const p = pointByTT(cs.spline, r / ringSteps);
      ring.push({ x: p.x, y: p.y });
    }
    const sx = ySpanX(ring);
    const sy = ySpan(ring);
    const sectionW = sx.hi - sx.lo;
    const centerX = cursorX + sectionW / 2 - (sx.lo + sx.hi) / 2;
    // Hang the section from csBandTop (its top edge), centred on its own width.
    const shiftY = csBandTop - sy.hi;
    const placed = ring.map((p) => ({ x: p.x + centerX, y: p.y + shiftY }));
    polyline(out, placed, 'CROSSSECTION', { closed: true });
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
