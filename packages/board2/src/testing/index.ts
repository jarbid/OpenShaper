// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/testing`: test-only fixtures (docs/design/board2.md
 * §11.1, §11.2). Never imported by the package's source (ESLint forbids it);
 * tests and benches only.
 */
export { flatField, quadraticField, stadiumBoard, stadiumFacts, stadiumPlan } from './stadium';
export type { StadiumFacts, StadiumOptions } from './stadium';
export { notchedBoard, notchedLoopFixture } from './notched';
export { offKnotLoop } from './off-knot';
export type { OffKnotLoopOptions } from './off-knot';
export { constantLaw, defaultLaws, sampleDoc } from './sample-doc';
export { bandArea, bandZFlux, flatBoardVolume, rowPlanArea } from './volume';
export type { FlatBoardVolume } from './volume';
