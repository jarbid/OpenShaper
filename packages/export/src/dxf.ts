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

interface Pt {
  readonly x: number;
  readonly y: number;
}

const num = (n: number): string => (Number.isFinite(n) ? n : 0).toFixed(6);

/** Emit a closed/open R12 POLYLINE entity (group codes mirror the legacy DxfExport). */
const polyline = (out: string[], pts: readonly Pt[], closed = false): void => {
  if (pts.length < 2) return;
  out.push('0', 'POLYLINE', '8', '0', '66', '1');
  out.push('70', closed ? '1' : '0');
  for (const p of pts) {
    out.push('0', 'VERTEX', '8', '0');
    out.push('10', num(p.x), '20', num(p.y), '30', '0.0');
  }
  out.push('0', 'SEQEND');
};

/** Vertical extent of a ring's points (used to stack cross-sections in the DXF). */
const getThicknessSpan = (pts: readonly Pt[]): number => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return Number.isFinite(hi - lo) ? hi - lo : 0;
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

/**
 * Export the board as an ASCII (R12-style) DXF: the plan-view outline (both
 * mirrored rails), the deck and bottom rocker profiles (side view), and a set of
 * evenly-spaced cross-section profiles. All as POLYLINE entities in the ENTITIES
 * section. Units are centimetres (the board's native units).
 */
export const exportDxf = (board: BezierBoard, opts: DxfOptions = {}): string => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const ringSteps = Math.max(3, opts.ringSteps ?? DEFAULT_RING_STEPS);
  const csCount = Math.max(0, opts.crossSectionCount ?? DEFAULT_CS_COUNT);
  const length = getLength(board);
  const eps = Math.min(0.01, length / (lengthSteps * 4));

  const out: string[] = [];
  out.push('999', 'DXF export from OpenShaper');
  out.push('0', 'SECTION', '2', 'ENTITIES');

  // --- Plan-view outline: half-width vs length, both rails as one closed loop. ---
  const halfTop: Pt[] = [];
  for (let i = 0; i <= lengthSteps; i++) {
    const x = eps + ((length - 2 * eps) * i) / lengthSteps;
    halfTop.push({ x, y: valueAt(board.outline, x) });
  }
  const outlineLoop: Pt[] = [...halfTop];
  for (let i = halfTop.length - 1; i >= 0; i--) {
    const p = halfTop[i]!;
    outlineLoop.push({ x: p.x, y: -p.y });
  }
  polyline(out, outlineLoop, true);

  // --- Side-view rocker profiles (offset in -y so they sit below the plan view). ---
  const sideOffset = -(valueAt(board.outline, eps) + 1);
  const liftProfile = (pts: Pt[]): Pt[] => pts.map((p) => ({ x: p.x, y: p.y + sideOffset }));
  polyline(out, liftProfile(sampleProfile(board.bottom, eps, length - eps, lengthSteps)));
  polyline(out, liftProfile(sampleProfile(board.deck, eps, length - eps, lengthSteps)));

  // --- Cross-section profiles (mirrored), drawn at their station x for placement. ---
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
    // Offset to the right of the board so sections don't overlap the plan view,
    // and stack each section vertically so they don't overlap each other.
    const csX = length + 5;
    const csY = sideOffset - c * (getThicknessSpan(ring) + 2);
    polyline(
      out,
      ring.map((p) => ({ x: p.x + csX, y: p.y + csY })),
      true,
    );
  }

  out.push('0', 'ENDSEC');
  out.push('0', 'EOF');
  return out.join('\n') + '\n';
};
