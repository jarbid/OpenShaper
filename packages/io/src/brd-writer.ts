import {
  getCenterWidth,
  getLength,
  getLengthOverCurve,
  getThickness,
  type BezierBoard,
  type Knot,
  type Spline,
} from '@openshaper/kernel';

/**
 * Writer for the legacy BoardCAD-LE native `.brd` text format.
 *
 * Ported from `board.writers.BrdWriter` (Java). The output round-trips through our
 * own {@link parseBrd} and is loadable by BoardCAD-LE itself. The format is a
 * line-based key/value file: scalar metadata lines `pNN : value`, plus four
 * geometry fields carrying bezier control-point records:
 *
 *   - p32 outline   (half-width vs length)
 *   - p33 bottom    (rocker curve)        — legacy field naming is confusing;
 *   - p34 deck      (deck curve)            we map p33→bottom and p34→deck per BrdReader.
 *   - p35 cross-sections — each `(p36 <pos>` group holds a profile spline.
 *
 * Each control point is a `(cp [endX,endY,prevX,prevY,nextX,nextY] <cont> <other>)`
 * record (see `packages/kernel/src/knot.ts`).
 *
 * DELIBERATE DIVERGENCE (see docs/specs/divergences.md): we emit geometry plus the
 * identity metadata our model carries (dimensions, designer/model/surfer/comments,
 * fin type). The legacy CAM/machine scalar fields (cuts, cutter, speeds, pivots,
 * margins, …) and per-curve guide-point (`gps`) blocks are NOT written — the kernel
 * does not model them. `parseBrd` treats all of those as optional, so the file still
 * round-trips. Units are centimeters.
 */

/** Editable identity metadata that maps onto legacy `.brd` scalar fields. */
export interface BrdWriteMetadata {
  model?: string;
  designer?: string;
  surfer?: string;
  comments?: string;
  /** Legacy free-text fin setup name (p51). */
  finType?: string;
}

/** Version marker written to p7, mirroring the legacy string field. */
const BRD_WRITER_VERSION = 'V4.4';

/** Format a number the way Java's Double.toString does for the common cases. */
const num = (n: number): string => {
  if (Object.is(n, -0)) return '-0.0'; // preserve negative zero (Java emits "-0.0")
  return Number.isInteger(n) ? `${n}.0` : String(n);
};

/** A `pNN : value` scalar line; ids < 10 are zero-padded, matching legacy buildId. */
const idPrefix = (id: number): string => `p${id < 10 ? '0' : ''}${id} : `;

const numberLine = (id: number, value: number): string => `${idPrefix(id)}${num(value)}\n`;

/** A string field — skipped when empty (legacy behavior); newlines are escaped. */
const stringLine = (id: number, value: string | undefined): string => {
  if (!value) return '';
  return `${idPrefix(id)}${value.replace(/\n/g, '\\n')}\n`;
};

/** `(cp [eX,eY,prevX,prevY,nextX,nextY] <continuous> <other>)`. */
const knotLine = (k: Knot): string => {
  const c = [k.end, k.tangentToPrev, k.tangentToNext]
    .flatMap((p) => [num(p.x), num(p.y)])
    .join(',');
  return `(cp [${c}] ${k.continuous} ${k.other})\n`;
};

/** A `pNN : (\n` <cps> `)\n` curve group (outline/bottom/deck). */
const curveGroup = (id: number, spline: Spline): string => {
  let out = `${idPrefix(id)}(\n`;
  for (const k of spline.knots) out += knotLine(k);
  out += ')\n';
  return out;
};

/** Serialize a board to a legacy `.brd` document string. */
export const writeBrd = (b: BezierBoard, metadata?: BrdWriteMetadata): string => {
  let out = '';

  // Scalar metadata — derived dimensions and identity fields (legacy order).
  out += numberLine(1, getLength(b));
  out += numberLine(2, getLengthOverCurve(b));
  out += numberLine(3, getThickness(b));
  out += numberLine(4, getCenterWidth(b));
  out += stringLine(7, BRD_WRITER_VERSION);
  out += stringLine(45, metadata?.designer);
  out += stringLine(54, metadata?.model);
  out += stringLine(48, metadata?.surfer);
  out += stringLine(49, metadata?.comments);
  out += stringLine(51, metadata?.finType);

  // Geometry.
  out += curveGroup(32, b.outline);
  out += curveGroup(33, b.bottom);
  out += curveGroup(34, b.deck);

  // Cross-sections: p35 group of `(p36 <pos>` profile splines.
  out += `${idPrefix(35)}(\n`;
  for (const cs of b.crossSections) {
    out += `(p36 ${num(cs.position)}\n`;
    for (const k of cs.spline.knots) out += knotLine(k);
    out += ')\n';
  }
  out += ')\n';

  return out;
};
