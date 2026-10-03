// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A string as R12 DXF text: printable ASCII as is, everything else as AutoCAD's
 * `\U+XXXX` escape.
 *
 * R12 group values are 8-bit text in the drawing's code page, so a raw UTF-8 `·`
 * (from `BRAND_LINE`, a unit like `ft·in`, or a board name) reads back as two
 * garbage characters. The escape is what AutoCAD itself writes and what LibreCAD,
 * QCAD and ezdxf decode. Characters outside the BMP become their surrogate pair.
 */
export const dxfText = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x20 && c <= 0x7e ? s[i] : `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
};
