import { boardDiagramSvg, specSheetHtml, type SpecSection } from '@openshaper/export';
import {
  FIN_SETUP_LABELS,
  FIN_SYSTEM_LABELS,
  type BezierBoard,
  type FinConfig,
} from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';
import type { BoardMeta } from './file-io';
import { fmtDimsHeadline, fmtLen, fmtVol, type LengthUnit } from './format';

/** 4 ft in cm — below this, the @24" rocker readouts are omitted (matches the sidebar). */
const MIN_LEN_FOR_24 = 121.92;

/** Compose the printable spec-sheet HTML (board info + grouped dimensions in `units`). */
export const specSheetHtmlFor = (
  board: BezierBoard,
  specs: BoardSpecs,
  meta: BoardMeta,
  units: LengthUnit,
  fins?: FinConfig,
): string => {
  const L = (cm: number): string => fmtLen(cm, units);
  const hasFins = !!fins && fins.setup !== 'none';
  const finText = hasFins
    ? `${FIN_SETUP_LABELS[fins.setup]} · ${FIN_SYSTEM_LABELS[fins.system]}`
    : '';

  const sections: SpecSection[] = [
    {
      title: 'Nose',
      rows: [
        ['Width @ 12"', L(specs.noseWidth)],
        ['Thickness @ 12"', L(specs.noseThickness)],
        ['Rocker', L(specs.noseRocker)],
        ['Rocker @ 12"', L(specs.noseRocker1)],
        ...(specs.length >= MIN_LEN_FOR_24
          ? ([['Rocker @ 24"', L(specs.noseRocker2)]] as [string, string][])
          : []),
      ],
    },
    {
      title: 'Center',
      rows: [
        ['Width', L(specs.maxWidth)],
        ['Wide point', L(specs.maxWidthPos)],
        ['Center width', L(specs.centerWidth)],
        ['Thickness', L(specs.thickness)],
        ['Max thickness', L(specs.maxThickness)],
      ],
    },
    {
      title: 'Tail',
      rows: [
        ['Width @ 12"', L(specs.tailWidth)],
        ['Thickness @ 12"', L(specs.tailThickness)],
        ['Rocker', L(specs.tailRocker)],
        ['Rocker @ 12"', L(specs.tailRocker1)],
        ...(specs.length >= MIN_LEN_FOR_24
          ? ([['Rocker @ 24"', L(specs.tailRocker2)]] as [string, string][])
          : []),
      ],
    },
    {
      title: 'Overall',
      rows: [
        ['Length', L(specs.length)],
        ['Length o/curve', L(specs.lengthOverCurve)],
        ['Max rocker', L(specs.maxRocker)],
        ['Volume', fmtVol(specs.volume)],
        ['Center of mass', L(specs.centerOfMass)],
        ...(hasFins ? ([['Fins', finText]] as [string, string][]) : []),
      ],
    },
  ];

  return specSheetHtml({
    title: meta.model || 'Surfboard',
    designer: meta.designer,
    date: new Date().toISOString().slice(0, 10),
    headline: `${fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units)} · ${fmtVol(specs.volume)}`,
    info: [
      ...(meta.surfer ? ([['Surfer', meta.surfer]] as [string, string][]) : []),
      ...(hasFins ? ([['Fins', finText]] as [string, string][]) : []),
      ...(meta.comments ? ([['Notes', meta.comments]] as [string, string][]) : []),
    ],
    sections,
    diagramSvg: boardDiagramSvg(board, { fmt: (cm) => fmtLen(cm, units) }),
  });
};

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
