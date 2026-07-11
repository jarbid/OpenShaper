// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render a {@link TemplateSheet} to ASCII (R12) DXF. Parts are stacked top-to-
 * bottom, each centred on a common axis (nose rib at the top, tail at the bottom).
 * Layers: CUT (through-cuts incl. slots), CUTINNER (lightening holes), MARK
 * (centrelines / station lines, dashed), LABEL (text).
 *
 * Output unit follows the caller's {@link SheetUnit} (default `mm`, the de-facto
 * CAM / laser unit). The sheet model is centimetres, so every coordinate is scaled
 * by the unit factor on the way out, and the file declares `$INSUNITS` so importers
 * don't guess and land the parts at the wrong scale.
 */
import { BRAND_LINE } from './brand';
import { columnLayout } from './construction/geom';
import type { Loop, Part, Pt, TemplateSheet } from './construction/types';
import { SHEET_UNIT, type SheetUnit } from './construction/units';

const LAYERS = {
  CUT: 5, // blue
  CUTINNER: 4, // cyan
  MARK: 3, // green
  LABEL: 8, // grey
} as const;
type Layer = keyof typeof LAYERS;

const GAP = 5; // cm between parts (scaled to the output unit)

export interface DxfSheetOptions {
  /** Output unit. Default `mm`. */
  unit?: SheetUnit;
}

const polyline = (
  out: string[],
  pts: readonly Pt[],
  layer: Layer,
  closed: boolean,
  num: (cm: number) => string,
): void => {
  if (pts.length < 2) return;
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0');
  for (const p of pts) {
    out.push('0', 'VERTEX', '8', layer, '10', num(p.x), '20', num(p.y), '30', '0.0');
  }
  out.push('0', 'SEQEND');
};

const text = (out: string[], p: Pt, h: number, str: string, num: (cm: number) => string): void => {
  out.push(
    '0',
    'TEXT',
    '8',
    'LABEL',
    '10',
    num(p.x),
    '20',
    num(p.y),
    '30',
    '0.0',
    '40',
    num(h),
    '1',
    str,
  );
};

/** R12 HEADER declaring the drawing's insertion units ($INSUNITS). */
const headerSection = (out: string[], dxfCode: number): void => {
  out.push('0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(dxfCode), '0', 'ENDSEC');
};

const loopLayer = (l: Loop): Layer =>
  l.kind === 'cut' ? 'CUT' : l.kind === 'cutInner' ? 'CUTINNER' : 'MARK';

const tablesSection = (out: string[]): void => {
  out.push('0', 'SECTION', '2', 'TABLES');
  const names = Object.keys(LAYERS) as Layer[];
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(names.length));
  for (const name of names) {
    out.push('0', 'LAYER', '2', name, '70', '0', '62', String(LAYERS[name]), '6', 'CONTINUOUS');
  }
  out.push('0', 'ENDTAB', '0', 'ENDSEC');
};

const drawPart = (out: string[], part: Part, num: (cm: number) => string): void => {
  for (const l of part.loops) polyline(out, l.pts, loopLayer(l), l.closed, num);
  for (const lbl of part.labels ?? []) text(out, lbl.at, lbl.height, lbl.text, num);
};

export const sheetToDxf = (sheet: TemplateSheet, opts: DxfSheetOptions = {}): string => {
  const unit: SheetUnit = opts.unit ?? 'mm';
  const { factor, dxfCode } = SHEET_UNIT[unit];
  const num = (cm: number): string => (Number.isFinite(cm) ? cm * factor : 0).toFixed(4);

  const parts = columnLayout(sheet.parts, GAP);
  // Comment-only branding: never geometry a CNC could try to cut.
  const out: string[] = [
    '999',
    `OpenShaper template: ${sheet.meta?.title ?? ''}`,
    '999',
    BRAND_LINE,
  ];
  headerSection(out, dxfCode);
  tablesSection(out);
  out.push('0', 'SECTION', '2', 'ENTITIES');
  for (const part of parts) drawPart(out, part, num);
  // Board-info + units note at the bottom-left of the layout.
  const note = sheet.meta?.note;
  if (note) {
    let minX = Infinity;
    let minY = Infinity;
    for (const part of parts)
      for (const l of part.loops)
        for (const p of l.pts) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
        }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      text(out, { x: minX, y: minY - GAP }, 0.5, note, num);
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
};
