// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The flag-off bundle guard (docs/design/m2-editor.md §6, step 1): board2 and geom (~0.3 MB) are the
 * NURBS worker's, and nothing the editor loads with the engine off may carry them. The section store is
 * in the main chunk (it must exist when the engine turns on), so this is the check that it imports the
 * types of board2 only: after the build, no chunk but the worker and its synchronous-fallback core may
 * contain a string literal that only board2's code has (the validator's issue codes, which survive
 * minification, unlike names).
 *
 * Pure over (file name, text) pairs, so it is unit-tested without a build; the build runs
 * {@link assertNoNurbsCodeOutsideWorker} on `dist/assets`.
 */

/** String literals of board2's validator and builder: present in its code, in no other module. */
export const NURBS_CODE_MARKERS = [
  'notch-chord-angle',
  'section-out-of-bounds',
  'blend-overshoot',
  'outline-not-function',
] as const;

/** The only chunks that carry board2 and geom: the worker and the core its synchronous fallback loads. */
const NURBS_CODE_CHUNK = /^nurbs-(?:core|worker)-[^/]*\.js$/;

export interface Chunk {
  /** The file name, without its directory. */
  readonly file: string;
  readonly text: string;
}

/** The chunks (by file name) that hold board2's code although they are not the worker's. */
export function findNurbsCodeLeaks(chunks: readonly Chunk[]): string[] {
  return chunks
    .filter((c) => c.file.endsWith('.js') && !NURBS_CODE_CHUNK.test(c.file))
    .filter((c) => NURBS_CODE_MARKERS.some((m) => c.text.includes(m)))
    .map((c) => c.file);
}

/** Throws naming the chunks that carry board2's code outside the worker. */
export function assertNoNurbsCodeOutsideWorker(chunks: readonly Chunk[]): void {
  const leaks = findNurbsCodeLeaks(chunks);
  if (leaks.length > 0) {
    throw new Error(
      `board2 code reached chunks other than the NURBS worker's (the engine-off page would download it): ${leaks.join(', ')}`,
    );
  }
}
