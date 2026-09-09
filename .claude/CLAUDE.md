# OpenShaper — Project Guide

OpenShaper is a modern surfboard CAD/CAM app: a from-scratch rebuild of the legacy
Java/Swing **BoardCAD-LE** (`../boardcad-le`, kept **untouched** as the reference spec
source). It runs in the browser (static SPA) and as a Tauri desktop app from one codebase.
It is a **free, open-source** project licensed **GPL-3.0-or-later** — the same copyleft as
the BoardCAD it descends from (see `LICENSE` / `NOTICE.md`). No accounts, no backend, no
paywall: everything runs client-side.

> **Never modify `../boardcad-le`.** It is read-only reference. Mine it for behavior;
> port the behavior here.

## Instruction priority and scope

- This file is the project-wide source of truth. Follow a more-specific `CLAUDE.md`
  for files below its directory; use `AGENTS.md` for generic repository guidance.
- Resolve conflicts by specificity, then by the instruction that best preserves
  existing behavior and user intent. Ask only when the choice materially changes
  the design or scope.
- Read only the files and history needed for the task. Prefer targeted `rg`/`glob`
  searches and narrow file ranges over repository-wide dumps. Do not inspect
  generated output, dependencies, or unrelated plans unless the task requires it.

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
packages/export PDF/DXF/STL exporters + construction/print templates    depends on: kernel
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
     See `docs/specs/golden/README.md` for fixture layout, regeneration commands,
     and tolerance notes.
3. **Parameterize what the legacy hard-coded.** No magic tolerances or fixed integration
   resolutions (legacy `VOLUME_X_SPLITS=10`). Volume/area use adaptive refinement.
4. **UI never blocks.** Heavy compute (volume, meshing, CAM) runs in Web Workers; the
   render layer uses dirty-region/incremental updates, never full-scene regeneration.
   The `useSpecsWorker` hook (`apps/web/src/use-specs-worker.ts`) is the concrete
   pattern: it posts monotonically-increasing-id requests to a module worker, drops
   stale responses, and falls back to synchronous compute when `Worker` is undefined
   (tests / prerender). See `docs/design/specs-worker.md` for the full write-up.
5. **All client-side.** No server, database, or auth — the app is a static SPA that ships
   to any free static host. Every feature is free; never add a paywall or tier gate.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev                                      # web app at http://localhost:5173
pnpm dev:desktop                              # Tauri shell
pnpm typecheck                                # all workspace TypeScript checks
pnpm test                                     # all Vitest suites
pnpm build                                    # production web build
pnpm lint                                     # currently placeholder scripts in packages

# Targeted checks
pnpm --filter @openshaper/kernel test
pnpm --filter @openshaper/web test
pnpm --filter @openshaper/web e2e
pnpm --filter @openshaper/web e2e:offline
```

CI runs `pnpm typecheck`, `pnpm test`, and `pnpm build` after
`pnpm install --frozen-lockfile`. Match that gate for changes intended for a PR.

## Conventions

- TypeScript strict, ESM, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Pure functions over classes in the kernel; `Vec2` (`packages/kernel/src/vec2.ts`)
  replaces the legacy `java.awt.geom.Point2D`.
- Tests colocated as `*.test.ts`, run by Vitest.
- Commit only when asked; never touch `../boardcad-le`.
- New board edits are plain pure functions in `packages/store/src/edits.ts` (not
  command classes); wire them through the store's `commit(next, label)` to land on
  the past/future undo stack.
- Use Prettier conventions when editing. The repository currently has no
  auto-formatting hook; use `pnpm exec prettier --write <files>` when formatting
  specific files, or `pnpm format` for the whole repository.

## Efficient implementation

- Start by identifying the smallest affected package, entry point, and existing
  test. Trace the call path before broadening the search.
- Reuse existing helpers and patterns; search before adding a utility, abstraction,
  dependency, or parallel implementation.
- Keep edits surgical. Do not refactor adjacent code, rename unrelated symbols, or
  rewrite whole files unless it directly reduces risk or duplication.
- Use the smallest relevant test command first. Escalate to typecheck, build, or
  E2E only when the changed surface warrants it or a targeted check exposes an
  integration issue.
- Keep tool output bounded (`--stat`, `--name-only`, focused selectors, or a
  limited result count). Do not paste or summarize unchanged files in the final
  response.
- Stop investigating once the requirement is understood, implemented, and covered
  by the relevant verification. Do not pursue speculative improvements.

## Change and verification workflow

- Inspect the relevant package, tests, and existing patterns before editing; keep
  changes scoped to the requested behavior.
- For kernel, I/O, units, or store changes, add or update colocated regression
  tests and run the affected package tests. Preserve golden fixtures and stated
  tolerances.
- For web behavior changes, run the affected Vitest tests; use `e2e` or
  `e2e:offline` when the browser, routing, service worker, or prerendered output
  is involved.
- Run `pnpm typecheck` for TypeScript changes and `pnpm build` for changes that
  affect package boundaries, Vite/SSG configuration, exports, or deployment.
- Do not claim a check passed unless it was run. Report blocked checks and their
  cause explicitly.

See `apps/web/CLAUDE.md` for the display-units convention (loads automatically when
working under `apps/web`).

## Model delegation

| Use **Opus** for                                                                            | Use **Sonnet** for                            | Use **Haiku** for                                     |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Architecture decisions; geometry algorithm correctness; the kernel port; adversarial review | Feature implementation, UI, I/O, store, tests | Scaffolding, boilerplate, mechanical codegen, renames |

## User-facing features must be documented

`/docs` (`apps/web/src/pages/docs/`) is the reference documentation for the editor.
Adding a fin setup or system, an export format, a starter template or a keyboard
shortcut requires an entry in `apps/web/src/docs/registry.ts` and a section on the
page it names — `apps/web/src/docs/coverage.test.ts` enumerates the app's own
definitions and **fails the build** otherwise.

Its limit, stated plainly: the test proves an entry _exists_, never that the prose
is _accurate_. It can be satisfied with a heading and a filler sentence. What it
removes is silent omission — features shipping while nobody remembers docs exist.

Two related rules:

- Keyboard shortcuts live in `apps/web/src/shortcuts.ts`, not in the key handler.
  The handler, the tooltips and `/docs/shortcuts` all read that table, so a chord
  is defined once.
- Docs pages are precached by the service worker (unlike the marketing pages), so
  they stay readable offline. `apps/web/tools/precache-guard.ts` enforces both
  directions.

Current project status/roadmap: see `docs/ROADMAP.md`.
