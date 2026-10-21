// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/testing`: test-only fixtures (docs/design/board2.md
 * §11.1, §11.2). Never imported by the package's source (ESLint forbids it);
 * tests and benches only.
 */
export { flatField, stadiumBoard, stadiumFacts, stadiumPlan } from './stadium';
export type { StadiumFacts, StadiumOptions } from './stadium';
export { notchedLoopFixture } from './notched';
export { constantLaw, defaultLaws, sampleDoc } from './sample-doc';
