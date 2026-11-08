/**
 * Reference points on the way out: the 1:1 PDF dialog offers them only when the board
 * has some, the PDF carries them only when that option is on, and a .brd export
 * reports the section points it could not hold.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefPoint } from '@openshaper/kernel';
import { parseBrd } from '@openshaper/io';
import { ExportPdf1to1Dialog } from './ExportPdf1to1Dialog';
import { downloadBrd, downloadPdf1to1 } from './file-io';
import { LENGTH_UNITS } from './format';
import { DEFAULT_PDF1TO1 } from './pdf-export-settings';
import sampleBrd from './sample-board.brd?raw';

const { board } = parseBrd(sampleBrd);
const cm = LENGTH_UNITS.find((u) => u.key === 'cm')!;
const outlinePoint: RefPoint = { id: 'r1', plane: 'outline', x: 60, y: 25, label: 'wide' };
const orphan: RefPoint = { id: 'r2', plane: 'section', station: 61.3, x: 10, y: 3 };

/** Text of every PDF the export downloaded. */
const capturedPdfs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  capturedPdfs.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    void blob.arrayBuffer().then((buf) => {
      capturedPdfs.push(String.fromCharCode(...new Uint8Array(buf)));
    });
    return 'blob:test';
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('1:1 PDF dialog', () => {
  const mount = (hasReferencePoints: boolean) =>
    render(
      <ExportPdf1to1Dialog
        units={cm}
        settings={DEFAULT_PDF1TO1}
        onExport={() => {}}
        onClose={() => {}}
        hasReferencePoints={hasReferencePoints}
      />,
    );

  it('offers reference points only when the board has some', () => {
    mount(false);
    expect(screen.queryByText('Reference points')).toBeNull();
    document.body.innerHTML = '';
    mount(true);
    expect(screen.getByText('Reference points')).toBeTruthy();
  });
});

describe('downloadPdf1to1', () => {
  const settings = { ...DEFAULT_PDF1TO1, slice: false, crossSections: false };
  const pdfText = async () => {
    await vi.runAllTimersAsync();
    return capturedPdfs.join('');
  };

  it('marks the points when the option is on', async () => {
    downloadPdf1to1(board, settings, {}, cm, [outlinePoint]);
    expect(await pdfText()).toContain('wide · 60.0 cm');
  });

  it('leaves them off when the option is off', async () => {
    downloadPdf1to1(board, { ...settings, referencePoints: false }, {}, cm, [outlinePoint]);
    const text = await pdfText();
    expect(text).toContain('%PDF-');
    expect(text).not.toContain('wide · 60.0 cm');
  });
});

describe('downloadBrd', () => {
  it('reports section points with no cross-section at their station', () => {
    expect(downloadBrd(board, {}, [outlinePoint, orphan])).toBe(1);
    expect(downloadBrd(board, {}, [outlinePoint])).toBe(0);
  });
});
