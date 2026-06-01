# Contributing to OpenShaper

Thanks for your interest! OpenShaper is a free, open-source surfboard CAD for the
shaping community. Bug reports, board templates, file-format fixes, and shaping-domain
feedback are all especially welcome.

## Ground rules

- **License.** OpenShaper is **GPL-3.0-or-later**. By contributing, you agree your
  work is licensed under the same terms. See [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md).
- **Never modify `../boardcad-le`.** The legacy Java BoardCAD-LE is read-only reference
  used to mine behavior and golden data — it is not part of this repo and is never edited.
- **Keep the kernel pure.** `packages/kernel` (and `io`, `units`) must not import React,
  the DOM, or Three.js. Geometry/board math is framework-agnostic, side-effect-free, and
  immutable. State lives in `packages/store`, not in globals.
- **No backend, no paywall.** The app is a fully client-side static SPA. Every feature is
  free; please don't add accounts, servers, or tier gates.

## Getting started

```sh
pnpm install
pnpm dev          # run the web app at http://localhost:5173
pnpm test         # all package tests (kernel golden tests must pass)
pnpm typecheck
pnpm build        # static build to apps/web/dist
```

Requires Node 20+ and pnpm 9.

## Before you open a PR

1. `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass.
2. **Kernel changes are golden-pinned.** Any ported geometry/board function must match the
   legacy reference within a stated tolerance — add or update a fixture in
   `docs/specs/golden/` and a colocated `*.test.ts`. A port isn't "done" until it matches.
3. Keep changes focused; match the style and comment density of the surrounding code.
4. TypeScript strict + ESM; use `import type` for type-only imports.

## Project layout

See [`README.md`](./README.md) for the package map and
[`.claude/CLAUDE.md`](./.claude/CLAUDE.md) for architecture conventions (the layering rules,
the golden-data testing rule, and the non-negotiable principles).

## Reporting bugs

Open a GitHub issue with steps to reproduce, what you expected, and what happened. If it's a
geometry/spec discrepancy, attach the `.brd` or `.board.json` and the numbers you saw — that
makes it easy to turn into a regression test.
