// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/testing`: test-only boards (docs/design/m1-model.md §6).
 * Never imported by the package's source (ESLint forbids it); tests and benches only.
 */
export {
  analyticBoard,
  analyticFacts,
  asymmetricBoard,
  fishBoard,
  swallowBoard,
  testBoards,
} from './boards';
export type { AnalyticFacts } from './boards';
export { chain, knot, section } from './boards';
export { chainPoint, chainZ, distanceToChain, distanceToPolyline, sampleChain } from './oracles';
