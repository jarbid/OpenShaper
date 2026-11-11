// SPDX-License-Identifier: GPL-3.0-or-later
/** Saving a fin to a `.fin.json` file and opening one, for the fin designer's File buttons. */
import type { FinDesign, FinLaminate } from '@openshaper/kernel';
import { FinJsonError, readFinJson, writeFinJson } from '@openshaper/io';
import type { OutFile } from '../save-files';

/** A file name stem for the design: `fin-side-left`, `fin-centre`. */
export const finFileStem = (d: FinDesign): string =>
  `fin-${d.position}${d.hand ? `-${d.hand}` : ''}`;

/** What the fin designer writes: the design, or the fin for manufacture. */
export type FinFormat = 'fin' | 'step' | 'stl';

/** Each format's extension, which the save dialog shows after the name. */
export const FIN_EXT: Record<FinFormat, string> = { fin: '.fin.json', step: '.step', stl: '.stl' };

/** A file name for the design: `fin-side-left.fin.json`, `fin-centre.fin.json`. */
export const finFileName = (d: FinDesign): string => `${finFileStem(d)}${FIN_EXT.fin}`;

/**
 * The fins to write: the design, and with `pair` its mirror for the other side, for
 * fins that have one (side, quad-rear, canard). A centre fin is always one file.
 */
export const finsToWrite = (d: FinDesign, pair: boolean): FinDesign[] =>
  pair && d.hand ? [d, { ...d, hand: d.hand === 'left' ? 'right' : 'left' }] : [d];

/** The name each file is offered under: `fin-side-left`, or `fin-side-left-core` for a core. */
export const defaultStems = (d: FinDesign, pair: boolean, core = false): string[] =>
  finsToWrite(d, pair).map((f) => `${finFileStem(f)}${core ? '-core' : ''}`);

/** Options for the manufacturing formats. */
export interface FinExportOptions {
  /** The blade is the core to bag this laminate onto. */
  readonly laminate?: FinLaminate;
  /** Thickens the edges and tip in the files only, not the design (cm). */
  readonly minThickness?: number;
}

/**
 * The files for `d` in `format`, one per fin of {@link finsToWrite}, named `stems` (in
 * the same order) plus the format's extension. STEP (CNC) and STL (printing) are in mm;
 * their exporters are loaded on first use, so the page doesn't carry them. STEP fits its
 * surfaces on the main thread (about a second a fin), as the board's does.
 */
export async function finFiles(
  d: FinDesign,
  format: FinFormat,
  stems: readonly string[],
  pair = false,
  { laminate, minThickness }: FinExportOptions = {},
): Promise<OutFile[]> {
  const fins = finsToWrite(d, pair);
  const name = (i: number) => `${stems[i] ?? finFileStem(fins[i]!)}${FIN_EXT[format]}`;
  if (format === 'fin') {
    return fins.map((f, i) => ({ name: name(i), data: writeFinJson(f), type: 'application/json' }));
  }
  const { exportFinStep, exportFinStl } = await import('@openshaper/export');
  return fins.map((f, i) => {
    const opts = {
      name: stems[i] ?? finFileStem(f),
      ...(laminate ? { laminate } : {}),
      ...(minThickness === undefined ? {} : { minThickness }),
    };
    return format === 'step'
      ? { name: name(i), data: exportFinStep(f, opts), type: 'model/step' }
      : { name: name(i), data: exportFinStl(f, opts) as unknown as BlobPart, type: 'model/stl' };
  });
}

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
