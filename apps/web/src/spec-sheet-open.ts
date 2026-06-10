import { specSheetHtml } from '@openshaper/export';
import type { BoardSpecs } from '@openshaper/store';
import type { BoardMeta } from './file-io';
import { fmtLen, fmtVol, type LengthUnit } from './format';

/** Compose the printable spec-sheet HTML (board info + dimensions in `units`). */
export const specSheetHtmlFor = (specs: BoardSpecs, meta: BoardMeta, units: LengthUnit): string =>
  specSheetHtml({
    title: meta.model || 'Surfboard',
    designer: meta.designer,
    info: (['designer', 'model', 'surfer', 'comments'] as const)
      .map((k) => [k[0]!.toUpperCase() + k.slice(1), meta[k] ?? ''] as [string, string])
      .filter(([, v]) => v),
    rows: [
      ['Length', fmtLen(specs.length, units)],
      ['Width', fmtLen(specs.maxWidth, units)],
      ['Thickness', fmtLen(specs.thickness, units)],
      ['Wide point', fmtLen(specs.maxWidthPos, units)],
      ['Max rocker', fmtLen(specs.maxRocker, units)],
      ['Volume', fmtVol(specs.volume)],
      ['Center of mass', fmtLen(specs.centerOfMass, units)],
    ],
  });

/**
 * Open an HTML document in a new tab via a Blob URL, instead of writing into a
 * blank window with the deprecated `document.write`. Returns false when the
 * pop-up was blocked, so the caller can surface an error.
 */
export const openHtmlInNewTab = (html: string): boolean => {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) {
    URL.revokeObjectURL(url);
    return false;
  }
  // The blob must outlive the new tab's initial fetch; revoke well after that.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
};
