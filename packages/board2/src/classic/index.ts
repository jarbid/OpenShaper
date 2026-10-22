// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/classic`: the converter from the classic `BezierBoard`
 * and the deviation report against the classic engine
 * (docs/design/board2.md §9, §10). The only entry point of the package that
 * may import `@openshaper/kernel`, so the core model stays free of the classic
 * engine and an app can load this lazily.
 *
 * Step S6 adds the converter's named defaults (`DEFAULT_CONVERT_OPTIONS`);
 * its stages so far (sampling, plan loop, stringer lines, insets, deck and
 * bottom: `convert.ts`) stay internal until step S7 completes `convertClassic`.
 * Step S8 adds the deviation report.
 */
export { DEFAULT_CONVERT_OPTIONS } from './params';
export type {
  ClassicBoard,
  Conversion,
  ConversionReport,
  ConvertOptions,
  DeviationCause,
  DeviationOptions,
  DeviationReport,
  DistanceSamples,
  SpecDelta,
} from './types';
