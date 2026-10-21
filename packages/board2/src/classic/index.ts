// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/classic`: the converter from the classic `BezierBoard`
 * and the deviation report against the classic engine
 * (docs/design/board2.md §9, §10). The only entry point of the package that
 * may import `@openshaper/kernel`, so the core model stays free of the classic
 * engine and an app can load this lazily.
 *
 * Scaffold: the types only (steps S6 to S8 add the functions).
 */
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
