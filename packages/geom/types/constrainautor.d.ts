// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Typings for the dev-only differential oracle `@kninnug/constrainautor`
 * (design §12). The package's own `types` entry is its TypeScript source,
 * which does not compile under this repository's strict options
 * (`noUncheckedIndexedAccess`), so `tsconfig.json` maps the import here. Only
 * what the tests use is declared.
 */
declare module '@kninnug/constrainautor' {
  interface DelaunatorLike {
    coords: ArrayLike<number>;
    triangles: Uint32Array;
    halfedges: Int32Array;
  }
  export default class Constrainautor {
    constructor(del: DelaunatorLike, edges?: readonly [number, number][]);
    constrainOne(segP1: number, segP2: number): number;
    constrainAll(edges: readonly [number, number][]): this;
    isConstrained(edg: number): boolean;
  }
}
