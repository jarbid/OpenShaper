# OpenShaper — Project Guide

OpenShaper is a modern surfboard CAD/CAM app: a from-scratch rebuild of the legacy
Java/Swing **BoardCAD-LE** (`../boardcad-le`, kept **untouched** as the reference spec
source). It runs in the browser (static SPA) and as a Tauri desktop app from one codebase.
It is a **free, open-source** project licensed **GPL-3.0-or-later** — the same copyleft as
the BoardCAD it descends from (see `LICENSE` / `NOTICE.md`). No accounts, no backend, no
paywall: everything runs client-side.

> **Never modify `../boardcad-le`.** It is read-only reference. Mine it for behavior;
> port the behavior here.

## Architecture

Monorepo (pnpm + Turborepo). Strict layering — dependencies point **inward** toward the
pure kernel; nothing in `kernel`/`io`/`units` may import React, the DOM, or Three.js.

```
apps/web        React product UI            depends on: ui, store, render2d, render3d, units, kernel
apps/desktop    Tauri shell over apps/web
packages/kernel PURE geometry + board model (no UI, no AWT, immutable)   <- the core
packages/io     file readers/writers                                     depends on: kernel
packages/units  metric/imperial + fractions                             (pure)
packages/store  board document store, command/undo, selectors           depends on: kernel
packages/render2d  canvas viewport + 2D editor draw                      depends on: kernel, store
packages/render3d  three.js board mesh + scene                          depends on: kernel
packages/ui     design-system components                                 (React)
docs/specs      extracted legacy specs + golden reference data
```

### Non-negotiable principles (these fix the legacy's core problems)

1. **Pure kernel.** Geometry/board math is framework-agnostic, side-effect-free, and
   immutable. No `getInstance()` singletons (the legacy `BoardCAD.getInstance()` pattern
   is banned). State lives in `store`, not in globals.
2. **Golden-data testing rule (two phases).** Every ported kernel function is pinned
   to a fixture derived from the legacy app (`docs/specs/golden/`).
   - **Porting phase:** while a subsystem is being ported, legacy output is the only
     oracle — the port isn't "done" until it matches within a stated tolerance.
   - **Ported phase:** once trusted, fixtures are characterization tests guarding
     against _accidental_ drift. They may be deliberately superseded to improve on a
     legacy quirk, but only with (a) a better oracle (analytic cases / convergence
     tests), (b) a regenerated fixture, and (c) an entry in
     `docs/specs/divergences.md` recording what now differs from BoardCAD-LE, why,
     and by how much. Never weaken a tolerance just to make a change pass.
3. **Parameterize what the legacy hard-coded.** No magic tolerances or fixed integration
   resolutions (legacy `VOLUME_X_SPLITS=10`). Volume/area use adaptive refinement.
4. **UI never blocks.** Heavy compute (volume, meshing, CAM) runs in Web Workers; the
   render layer uses dirty-region/incremental updates, never full-scene regeneration.
5. **All client-side.** No server, database, or auth — the app is a static SPA that ships
   to any free static host. Every feature is free; never add a paywall or tier gate.

## Commands

```sh
pnpm install
pnpm test         # turbo: all package tests (kernel golden tests must pass)
pnpm typecheck
pnpm dev          # web app dev server
pnpm build
pnpm --filter @openshaper/kernel test:watch   # focus one package
```

pnpm is provided via the user's npm global prefix (`%APPDATA%\npm`), not corepack
(corepack needs admin on this machine).

## Conventions

- TypeScript strict, ESM, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Pure functions over classes in the kernel; `Vec2` (`packages/kernel/src/vec2.ts`)
  replaces the legacy `java.awt.geom.Point2D`.
- Tests colocated as `*.test.ts`, run by Vitest.
- Commit only when asked; never touch `../boardcad-le`.

### Display units follow the editor's unit selector (no hardcoded units)

Internal geometry is always **centimetres**. Whenever a UI element shows or edits a
**length**, it MUST render in the editor's globally-selected length unit — the one set
by the toolbar dropdown (`mm / cm / in / ft·in`, persisted to `localStorage
'bs.lengthUnit'`). Switching the dropdown re-renders everything; no length is ever shown
in a fixed unit.

- The active unit is a `LengthUnit` (`apps/web/src/format.ts`), resolved in `App.tsx` as
  `units = lengthUnitByKey(unitKey)` and threaded as a `units: LengthUnit` prop to every
  consumer (`EditorPane`, `ControlPointInspector`, `ConstructionPanel`, spec readouts, …).
- Never write a literal `mm`/`cm`/`in` suffix or call `.toFixed()` on a raw cm value in
  JSX. Use the `format.ts` helpers: `fmtLen` (display), `cmToUnitNumber` + `unitDecimals`
  - `unitSuffix` (editable fields), `parseLen` (input → cm), `fmtDimsHeadline` (headline).
    File exports map via `exportUnitFor`.
- New components that display/edit a length take a `units: LengthUnit` prop — they do not
  read the unit themselves or assume a default. Dimensionless fields (counts, fractions)
  stay unitless.
- Exception by design: **volume** is always litres (`fmtVol`), matching legacy.

## Sub-agents & model delegation

Specialized agents live in `.claude/agents/`. Route work by the policy below.

| Use **Opus** for                                                                                  | Use **Sonnet** for                            | Use **Haiku** for                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Architecture decisions; geometry & CAM algorithm correctness; the kernel port; adversarial review | Feature implementation, UI, I/O, store, tests | Scaffolding, boilerplate, mechanical codegen, renames |

Agents: `legacy-spec-extractor`, `kernel-engineer`, `store-engineer`, `render-engineer`,
`ux-engineer`, `io-engineer`, `cam-engineer` (Phase 2), `test-engineer`,
`architecture-critic`. Each agent's file states its model and scope.

## Skills to use

- `code-modernization:modernize-assess` / `:modernize-map` — legacy inventory & topology
- `code-modernization:modernize-extract-rules` — mine formulas into testable specs (feeds golden data)
- `code-modernization:modernize-reimagine` — drives the multi-agent greenfield rebuild
- `claude-api` — Phase-3 AI shaping assistant (with prompt caching)
- `verify` / `run` / `code-review` / `simplify` — per-PR quality loop

## Roadmap (where we are)

1. **Foundation** (in progress): monorepo, orchestration, modernize-assess/map, golden data.
2. **Kernel**: port cadcore + board behind golden tests; io reads real `.brd`.
3. **Editors + 3D**: store/undo, 2D editors, QuadView, spec panel, three.js view.
4. **Export → SHIP** (done): STL/DXF/PDF + native save; static deploy to GitHub Pages.
5. **Phase 2 CAM**: Rust/WASM kernel, toolpaths, GCode/Atua export, machine view.
6. **Phase 3**: print/templating, board-template library, plugins, AI assistant.
