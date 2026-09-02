# Repository Guidelines

## Project Structure & Module Organization

OpenShaper is a pnpm/Turborepo monorepo. `apps/web` contains the React/Vite product; `apps/desktop` is its Tauri shell. Shared code lives under `packages/`: `kernel` for geometry, `io` for file formats, `store` for state and undo, `render2d`/`render3d` for views, `export` for generated formats, `units` for measurements, and `ui` for components. The root `worker/` is the Cloudflare analytics proxy. Tests are colocated as `*.test.ts` or `*.test.tsx`; browser flows are in `apps/web/e2e/`. Specifications and golden fixtures live in `docs/specs/`.

## Build, Test, and Development Commands

Use Node 20+ and pnpm 9.

- `pnpm install` installs all workspace dependencies.
- `pnpm dev` serves the web app at `http://localhost:5173`.
- `pnpm dev:desktop` starts the Tauri desktop shell.
- `pnpm typecheck` runs strict TypeScript checks.
- `pnpm test` runs workspace Vitest suites.
- `pnpm --filter @openshaper/web e2e` runs Playwright browser tests.
- `pnpm build` creates the static web build in `apps/web/dist`.
- `pnpm format` applies Prettier to supported files.

Before opening a PR, run `pnpm typecheck`, `pnpm test`, and `pnpm build`, matching CI.

## Coding Style & Naming Conventions

Code is strict TypeScript and ESM. Use two spaces, single quotes, semicolons, trailing commas, and a 100-column limit. Use `import type` for type-only imports. Prefer pure functions and immutable data in `packages/kernel`; it, `io`, and `units` must not depend on React, DOM APIs, or Three.js. PascalCase for components and types, camelCase for functions and variables, and kebab-case for non-component filenames.

## Testing Guidelines

Vitest covers unit/integration tests, Testing Library covers React, and Playwright covers end-to-end flows. Add colocated regression tests for behavior changes. Kernel geometry must remain golden-pinned: update `docs/specs/golden/`, state tolerances, and never loosen a tolerance merely to pass. Record intentional legacy divergences in `docs/specs/divergences.md`. No numeric coverage threshold is enforced.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits with scopes, for example `feat(export): add STEP output` or `fix(kernel,export): distribute ring points by arc length`. Keep commits focused and use imperative subjects. PRs should explain the problem and solution, link relevant issues, report verification commands, and include screenshots or recordings for visible UI changes. Attach representative board files and observed values for geometry or import defects. Contributions are GPL-3.0-or-later.

## Architecture & Safety

Treat `../boardcad-le` as read-only reference material and never modify it.
