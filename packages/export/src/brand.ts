// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Subtle product credit printed in the non-cutting margin/metadata of every
 * export. Deliberately understated — and NEVER emitted as DXF geometry, where a
 * CNC could mistake text entities for cut paths (DXF gets it as a `999` comment).
 */
export const BRAND_LINE = 'Made with OpenShaper · openshaper.com';

/** A product's credit: its name, and the line written into an export's metadata. */
export interface Brand {
  product: string;
  line: string;
}

/** The board editor's credit, written into board exports. */
export const BOARD_BRAND: Brand = { product: 'OpenShaper', line: BRAND_LINE };

/** OpenFinShaper's credit, written into fin exports. */
export const FIN_BRAND: Brand = {
  product: 'OpenFinShaper',
  line: 'Made with OpenFinShaper · openfinshaper.com',
};
