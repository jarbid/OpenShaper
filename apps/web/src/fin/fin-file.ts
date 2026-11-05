// SPDX-License-Identifier: GPL-3.0-or-later
/** Saving a fin to a `.fin.json` file and opening one, for the fin designer's File buttons. */
import type { FinDesign, FinLaminate } from '@openshaper/kernel';
import { FinJsonError, readFinJson, writeFinJson } from '@openshaper/io';
import { download, MULTI_DOWNLOAD_GAP_MS } from '../file-io';

/** A file name stem for the design: `fin-side-left`, `fin-centre`. */
export const finFileStem = (d: FinDesign): string =>
  `fin-${d.position}${d.hand ? `-${d.hand}` : ''}`;

/** A file name for the design: `fin-side-left.fin.json`, `fin-centre.fin.json`. */
export const finFileName = (d: FinDesign): string => `${finFileStem(d)}.fin.json`;

/**
 * The fins to write: the design, and with `pair` its mirror for the other side, for
 * fins that have one (side, quad-rear, canard). A centre fin is always one file.
 */
export const finsToWrite = (d: FinDesign, pair: boolean): FinDesign[] =>
  pair && d.hand ? [d, { ...d, hand: d.hand === 'left' ? 'right' : 'left' }] : [d];

/** Run `write` for each fin, spaced so the browser keeps every download. */
const each = async (fins: FinDesign[], write: (d: FinDesign) => void | Promise<void>) => {
  for (let i = 0; i < fins.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, MULTI_DOWNLOAD_GAP_MS));
    await write(fins[i]!);
  }
};

/**
 * Export the design for manufacture and download it: STEP (CNC) or STL (printing),
 * both in mm; with `pair`, a left and a right fin, one file each. The exporters are loaded on first use, so the page doesn't carry them.
 * STEP fits its surfaces on the main thread (about a second), as the board's does.
 * With `laminate`, the blade is the core to bag that laminate onto, in `…-core` files.
 * `minThickness` (cm) thickens the edges and tip in the files only, not the design.
 */
export async function exportFin(
  d: FinDesign,
  format: 'step' | 'stl',
  pair = false,
  laminate?: FinLaminate,
  minThickness?: number,
): Promise<void> {
  const { exportFinStep, exportFinStl } = await import('@openshaper/export');
  await each(finsToWrite(d, pair), (f) => {
    const stem = `${finFileStem(f)}${laminate ? '-core' : ''}`;
    const opts = {
      name: stem,
      ...(laminate ? { laminate } : {}),
      ...(minThickness === undefined ? {} : { minThickness }),
    };
    if (format === 'step') {
      download(exportFinStep(f, opts), `${stem}.step`, 'model/step');
    } else {
      download(exportFinStl(f, opts) as unknown as BlobPart, `${stem}.stl`, 'model/stl');
    }
  });
}

/** Download the design as a `.fin.json` file; with `pair`, a left and a right one. */
export const downloadFin = (d: FinDesign, pair = false): Promise<void> =>
  each(finsToWrite(d, pair), (f) => download(writeFinJson(f), finFileName(f), 'application/json'));

/** What went wrong opening a file, said for the person opening it. */
const openProblem = (e: unknown): string => {
  if (!(e instanceof FinJsonError)) return "That file can't be opened as a fin.";
  const m = e.message;
  if (m.startsWith('Malformed fin: '))
    return `That file can't be opened as a fin: it is damaged (${m.slice('Malformed fin: '.length)}).`;
  if (m.startsWith('Fin version'))
    return "That file can't be opened as a fin: a newer OpenFinShaper saved it. Reload the page to update.";
  return "That file can't be opened as a fin: it isn't an OpenFinShaper fin file.";
};

/**
 * Read a chosen file as a fin design. Rejects with a message fit to show the user
 * ({@link openProblem}): what was damaged, or that it isn't a fin file.
 */
export async function readFinFile(file: Blob): Promise<FinDesign> {
  const text = await file.text();
  try {
    return readFinJson(text).design;
  } catch (e) {
    throw new Error(openProblem(e), { cause: e });
  }
}
