// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/geom/testing`: test-only helpers shared with later packages
 * (design §6.21, decision 39). Nothing here ships through the main entry; it
 * grows with each build step (oracle solvers, analytic solids, STEP reader).
 */
export { checksum } from './checksum';
export { mulberry32 } from './prng';
export { randomClampedBasis, randomCurve, randomPeriodicBasis, randomSurface } from './random';
export type { RandomBasisOptions, RandomCurveOptions, RandomSurfaceOptions } from './random';
export { solveFairReference } from './reference-solver';
