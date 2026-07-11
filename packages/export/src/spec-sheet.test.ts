import { describe, expect, it } from 'vitest';
import { specSheetHtml } from './spec-sheet';

describe('specSheetHtml', () => {
  const doc = {
    title: 'Pintail 6\'2"',
    designer: 'Ada',
    headline: '6\'2" × 19¼" × 2½" · 32.5 L',
    info: [['Surfer', 'Grace']] as const,
    sections: [
      { title: 'Overall', rows: [['Length', '187.96 cm'] as const, ['Volume', '32.5 l'] as const] },
    ],
  };

  it('produces a self-contained HTML document with the heading, headline, and rows', () => {
    const html = specSheetHtml(doc);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Spec Sheet');
    expect(html).toContain('by Ada');
    expect(html).toContain('6\'2" × 19¼" × 2½" · 32.5 L');
    expect(html).toContain('<span class="chip"><b>Surfer</b>Grace</span>');
    expect(html).toContain('<h2>Overall</h2>');
    expect(html).toContain('<span class="l">Length</span><span class="v">187.96 cm</span>');
    expect(html).toContain('<span class="l">Volume</span><span class="v">32.5 l</span>');
  });

  it('credits openshaper.com in the footer', () => {
    expect(specSheetHtml(doc)).toContain('openshaper.com');
  });

  it('embeds a trusted diagram SVG without escaping it', () => {
    const html = specSheetHtml({ ...doc, diagramSvg: '<svg><path d="M0 0"/></svg>' });
    expect(html).toContain('<svg><path d="M0 0"/></svg>');
    expect(html).toContain('Plan · Rocker · Sections'); // drawing title block
  });

  it('includes a print stylesheet that flips to white/ink', () => {
    expect(specSheetHtml(doc)).toContain('@media print');
  });

  it('escapes HTML-significant characters in interpolated text', () => {
    const html = specSheetHtml({
      title: 'A & B <C>',
      info: [['Note', '<script>x</script>']],
      sections: [{ title: 'Misc', rows: [['Width & depth', '> 20']] }],
    });
    expect(html).toContain('A &amp; B &lt;C&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('Width &amp; depth');
    expect(html).not.toContain('<script>x</script>');
  });

  it('falls back to a default heading when the title is empty', () => {
    const html = specSheetHtml({ title: '', info: [], sections: [] });
    expect(html).toContain('Surfboard — Spec Sheet');
  });
});
