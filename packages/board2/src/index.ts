// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2`: the section-based board model of the NURBS engine
 * (docs/design/nurbs-plan.md, docs/design/m1-model.md). A board is its outline,
 * rocker and deck curves plus normalised cross-sections at stations, with bottom
 * features; the surface is evaluated straight from them (`createEvaluator`), with
 * exact first and second derivatives. Built on `@openshaper/geom` and nothing else.
 *
 * Every export is listed by name, and `index.test.ts` pins the runtime export
 * list. The grid mesh (`meshBoard`, docs/design/m1-model.md §3) turns a built board
 * into typed arrays; the classic converter lives in the separate entry point
 * `@openshaper/board2/classic`, the only part of this package that may import
 * `@openshaper/kernel`.
 */
export { boardDocToJson, reviveBoardDoc } from './doc';
export { BOARD2_ISSUE_CODES, board2Err, board2Ok, hasErrors } from './issues';
export { deriveLadders, meshBoard, meshProperties, meshVertex } from './mesh';
export type { BoardMesh, Ladders, MeshLayout, MeshOptions } from './mesh';
export { DEFAULT_BUILD } from './params';
export { MEASURE, buildBoard, createEvaluator } from './surface';
export type {
  BuildReport,
  BuiltBoard,
  BuiltSide,
  CompiledFeature,
  SurfaceEvaluator,
} from './surface';
export { resolveTail, validateBoard } from './validate';
export type {
  Board2Issue,
  Board2IssueCode,
  Board2Result,
  BoardDoc,
  BoardFormat,
  BoardMeta,
  BoardModel,
  BoardVersion,
  BottomFeature,
  BuildSettings,
  ChannelsFeature,
  Chain,
  ChainKnot,
  ConcaveFeature,
  EaseHandle,
  JsonValue,
  KeyedCurve,
  LawKey,
  Outline,
  Pair,
  Section,
  Station,
  Symmetry,
  TailSpec,
  VeeFeature,
} from './types';
