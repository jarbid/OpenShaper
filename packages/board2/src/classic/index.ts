// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/classic`: the classic-board converter (the only part of
 * board2 that may import `@openshaper/kernel`; docs/design/m1-model.md §4).
 *
 * `convertClassic` turns a classic `BezierBoard` into a section-model `BoardDoc`
 * (outline, rocker and deck copied as Bézier chains, each slice normalised), or
 * refuses it with the reasons. The S6/S7 surface-fitting converter that lived here
 * is retired (git history).
 */
export { convertClassic } from './convert';
export type { ClassicConversion, ConversionReport, ConvertOptions } from './convert';
