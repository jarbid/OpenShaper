# Notice & Attribution

OpenShaper is free software, licensed under the **GNU General Public License,
version 3 or (at your option) any later version** (GPL-3.0-or-later). The full
license text is in [`LICENSE`](./LICENSE).

## Derived from BoardCAD-LE

OpenShaper is a from-scratch modern rewrite — a TypeScript/WebGL re-imagining of
the geometry and board model — but its kernel is a **behavioral port of BoardCAD-LE**,
the open-source Java/Swing surfboard CAD application. Many kernel functions are pinned
to golden reference data extracted from BoardCAD-LE, which makes OpenShaper a
derivative work. We honor BoardCAD's copyleft by releasing OpenShaper under the same
license (GPL-3.0-or-later).

**BoardCAD / BoardCAD-LE** is © its authors and contributors, including:

- Jonas Hörnstein
- Ola Helenius
- Sven Wesley
- Håvard Nygård Jakobsen

Upstream project: https://github.com/ciditup/boardcad (BoardCAD), and the
BoardCAD-LE variant it derives from.

The BoardCAD-LE source is used **for reference only** and is **not redistributed**
in this repository.

## Third-party libraries

OpenShaper's web app bundles open-source libraries including React, Three.js,
@react-three/fiber + drei, Zustand, and Tailwind CSS, each under their own
(permissive) licenses. See the respective packages in `node_modules` for details.

## Vendored code

- **robust-predicates** 3.0.3 by Vladimir Agafonkin, released into the public
  domain under the [Unlicense](https://unlicense.org/), itself a port of
  Jonathan Richard Shewchuk's public-domain adaptive exact predicates
  ("Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric
  Predicates", 1997). Its `orient2d` and `incircle` are vendored, with their
  work buffers moved into factories, in
  `packages/geom/src/mesh/vendor/robust-predicates.ts`.
  Upstream: https://github.com/mourner/robust-predicates

## Test-only tools (never shipped)

- **occt-wasm** 5.3.5 (wrapper `MIT OR Apache-2.0`; the compiled WebAssembly is
  OpenCascade Technology, `LGPL-2.1-only`). A devDependency of `packages/geom`
  only, imported by `packages/geom/src/**/*.occt.test.ts` to check that our STEP
  files import as valid solids (`pnpm --filter @openshaper/geom test:occt`).
  It is not bundled, vendored or distributed with OpenShaper, and nothing in the
  web app or desktop shell can import it.
  Upstream: https://github.com/andymai/occt-wasm
