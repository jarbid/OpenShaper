// SPDX-License-Identifier: GPL-3.0-or-later
/** P28: DXF text is 8-bit in R12, so anything outside printable ASCII is escaped. */
import { describe, expect, it } from 'vitest';
import { BRAND_LINE } from './brand';
import { dxfText } from './dxf-text';
import { sheetToDxf } from './sheet-dxf';

describe('dxfText (P28)', () => {
  it('leaves printable ASCII alone and escapes the rest as \\U+XXXX', () => {
    expect(dxfText('Rib 3 x=45.0')).toBe('Rib 3 x=45.0');
    expect(dxfText('ft·in')).toBe('ft\\U+00B7in');
    expect(dxfText('Café')).toBe('Caf\\U+00E9');
    expect(dxfText('🏄')).toBe('\\U+D83C\\U+DFC4');
  });

  it('keeps a sheet DXF pure ASCII, labels and branding included', () => {
    const dxf = sheetToDxf({
      meta: { title: 'Fish · 5′8″', note: 'Board: Café' },
      parts: [
        {
          loops: [
            {
              pts: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 5 },
              ],
              closed: true,
            },
          ],
          labels: [{ at: { x: 1, y: 1 }, height: 1, text: 'Rib · 1' }],
        },
      ],
    } as unknown as Parameters<typeof sheetToDxf>[0]);
    expect([...dxf].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(dxf).toContain(dxfText(BRAND_LINE));
    expect(dxf).toContain('Rib \\U+00B7 1');
  });
});
