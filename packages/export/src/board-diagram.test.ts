import { describe, expect, it } from 'vitest';
import { boardDiagramSvg } from './board-diagram';
import { makeTestBoard } from './fixture.test-helper';

describe('boardDiagramSvg', () => {
  const board = makeTestBoard();

  it('returns an <svg> with plan, rocker and section line-work', () => {
    const svg = boardDiagramSvg(board);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('class="outline"');
    expect(svg).toContain('class="profile"');
    expect(svg).toContain('class="center"');
    expect(svg).toContain('TAIL');
    expect(svg).toContain('NOSE');
  });

  it('labels dimensions with the supplied formatter', () => {
    const svg = boardDiagramSvg(board, { fmt: (cm) => `${(cm / 2.54).toFixed(1)}in` });
    expect(svg).toContain('in</text>');
    expect(svg).not.toContain('cm</text>');
  });

  it('escapes formatter output to keep the SVG well-formed', () => {
    const svg = boardDiagramSvg(board, { fmt: () => '<bad>' });
    expect(svg).toContain('&lt;bad&gt;');
    expect(svg).not.toContain('<bad>');
  });
});
