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
