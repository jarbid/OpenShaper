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

  it('embeds the spec block from kernel getters', () => {
    const pdf = exportPdf(board, { title: 'Spec Test' });
    const text = decode(pdf);
    expect(text).toContain('Spec Test');
    expect(text).toContain('Length:');
    expect(text).toContain('Volume:');
  });

  it('xref entries match the declared object count', () => {
    const pdf = exportPdf(board);
    const text = decode(pdf);
    const size = Number(text.match(/\/Size (\d+)/)![1]);
    const entries = text.match(/^\d{10} \d{5} [fn] $/gm) ?? [];
    expect(entries.length).toBe(size);
  });
});
