# Board Studio

Modern surfboard CAD/CAM — a from-scratch rebuild of the legacy Java/Swing
[BoardCAD-LE](../boardcad-le) (kept untouched as the reference spec source).

Runs in the browser and as a native desktop app (Tauri) from one codebase.
Freemium + Pro subscription. See [the plan](../../.claude/plans) and `docs/specs/`.

## Stack

- pnpm workspaces + Turborepo + Vite
- React 18 + TypeScript (UI), Tailwind + shadcn/ui (design system — to be added)
- Zustand + Immer (board document + undo), TanStack Query (server state)
- Canvas 2D editors, Three.js / react-three-fiber 3D
- Web Workers (Comlink); Rust→WASM for Phase-2 heavy paths (CAM, meshing, volume)
- Tauri 2 desktop shell; Supabase + Stripe (accounts/billing — Phase 2+)

## Layout

```
apps/web        the product (React)
apps/desktop    Tauri native shell wrapping apps/web
packages/kernel pure geometry + board model (port of cadcore + board)
packages/io     file readers/writers (.brd/.srf/.s3d in; .board.json/DXF/STL/GCode/PDF out)
packages/store  board document store, command/undo, derived-spec selectors
packages/render2d  canvas viewport + 2D editor draw layer
packages/render3d  three.js board mesh + scene
packages/units  metric/imperial + fraction formatting (port of UnitUtils)
packages/ui     design-system components
docs/specs      extracted legacy behavior specs + golden reference data
```

## Develop

```sh
pnpm install
pnpm test         # run all package tests (kernel golden tests, etc.)
pnpm dev          # run the web app (and any persistent dev tasks)
pnpm typecheck
pnpm build
```

## Project orchestration

This repo is built as a coordinated multi-agent Claude project. See
[`.claude/CLAUDE.md`](.claude/CLAUDE.md) for architecture conventions, the
golden-data testing rule, the sub-agent roster, and the model-delegation policy.
