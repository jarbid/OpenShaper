import { describe, expect, it } from 'vitest';
import { exportPdf } from './pdf';
import { makeTestBoard } from './fixture.test-helper';

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe('exportPdf', () => {
  const board = makeTestBoard();

  it('produces bytes wrapped by %PDF- and %%EOF', () => {
    const pdf = exportPdf(board);
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(0);
    const text = decode(pdf);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('has a startxref offset that parses to a number within the file', () => {
    const pdf = exportPdf(board);
    const text = decode(pdf);
    const m = text.match(/startxref\s+(\d+)/);
    expect(m).not.toBeNull();
    const offset = Number(m![1]);
    expect(Number.isFinite(offset)).toBe(true);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(pdf.length);
    // The byte at the offset should begin the xref table.
    expect(text.slice(offset, offset + 4)).toBe('xref');
  });

  it('embeds the grouped spec block from kernel getters', () => {
    const pdf = exportPdf(board, { title: 'Spec Test' });
    const text = decode(pdf);
    expect(text).toContain('Spec Test');
    expect(text).toContain('NOSE @12"'); // column heading
    expect(text).toContain('CENTER');
    expect(text).toContain('TAIL @12"');
    expect(text).toContain('OVERALL');
    expect(text).toContain('Length');
    expect(text).toContain('Volume');
    expect(text).toContain('Wide pt');
    expect(text).toContain('Max rocker');
  });

  it('uses a caller-supplied headline when provided', () => {
    const text = decode(exportPdf(board, { headline: '6\'2" x 19 1/4" x 2 1/2" - 28.4 L' }));
    expect(text).toContain('19 1/4');
  });

  it('renders metadata and honours the units flag', () => {
    const pdf = exportPdf(board, {
      meta: { designer: 'Jane Shaper', surfer: 'Sam', comments: 'thin foiled rails' },
      units: 'in',
    });
    const text = decode(pdf);
    expect(text).toContain('Jane Shaper');
    expect(text).toContain('Sam');
    expect(text).toContain('thin foiled rails');
    expect(text).toContain('in'); // inch unit label present
  });

  it('falls back to the model name (then "Surfboard") for the title', () => {
    expect(decode(exportPdf(board, { meta: { model: 'Fish 5\'10"' } }))).toContain('Fish');
    expect(decode(exportPdf(board))).toContain('Surfboard');
  });

  it('xref entries match the declared object count', () => {
    const pdf = exportPdf(board);
    const text = decode(pdf);
    const size = Number(text.match(/\/Size (\d+)/)![1]);
    const entries = text.match(/^\d{10} \d{5} [fn] $/gm) ?? [];
    expect(entries.length).toBe(size);
  });
});
