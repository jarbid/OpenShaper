// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2`: the v2 board model of the geometry overhaul (Phase 2,
 * docs/design/board2.md). A full-width board whose rail is a closed loop with a
 * law-driven rail band, and whose deck and bottom are height fields trimmed by
 * that band; built on `@openshaper/geom` and nothing else.
 *
 * Scaffold: the types only. Every export is listed by name (decision 31), and
 * `index.test.ts` pins the runtime export list, empty until step S1.
 *
 * The classic converter and the deviation report live in the separate entry
 * point `@openshaper/board2/classic`, the only part of this package that may
 * import `@openshaper/kernel` (§11.3).
 */
export type {
  BandRow,
  BandStation,
  Board2Format,
  Board2Issue,
  Board2IssueCode,
  Board2Result,
  Board2Version,
  BoardDoc,
  BoardFace,
  BoardMeta,
  BoardSpecs,
  BottomFeature,
  BuildParams,
  BuildReport,
  BuiltBoard,
  ChannelsFeature,
  ConcaveFeature,
  EaseHandle,
  HeightFieldJSON,
  JsonValue,
  KeyedCurve,
  LawCurve,
  LawKey,
  LawTolerance,
  OffsetBasisJSON,
  OffsetComponent,
  OffsetField,
  OffsetLayer,
  OffsetRow,
  Passthrough,
  PlanLoopJSON,
  RailLane,
  RailLawValues,
  RailLaws,
  StringerLines,
  Symmetry,
  TailSpec,
  VeeFeature,
} from './types';
