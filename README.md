# OpenShaper

Free, open-source surfboard CAD that runs entirely in your browser — a from-scratch
modern rebuild of the legacy Java/Swing [BoardCAD-LE](https://github.com/ciditup/boardcad).
Design outlines, rocker, and cross-sections; see live volume, area and weight; preview
the board in 3D; and export STL / DXF / PDF — all client-side, nothing to install, no account.

**▶ Live: https://openshaper.com** — the app opens at [openshaper.com/app](https://openshaper.com/app).

A passion project for the shaping community. Built and shared under the GPL, the same
license as the BoardCAD it descends from.

## Features

- Outline, rocker, and cross-section editors driven by one shared board model
- Live specs: length, width, thickness, volume, plan-shape area, center of mass, weight
- 3D preview (Three.js) with a striped-reflection shading mode for fairness checks
- Compare against a "ghost" board; printable spec sheet
- Export **STL** (3D print / CAM), **DXF** (2D outline), and **PDF**, plus a native
  `.board.json` save — every format free
- Reads legacy `.brd` files

## Stack

- pnpm workspaces + Turborepo + Vite (static SPA — no server, no database)
- React 18 + TypeScript, Tailwind CSS
- Zustand (board document + command/undo)
- Canvas 2D editors; Three.js / react-three-fiber 3D
- Pure, immutable, framework-agnostic geometry kernel pinned to golden reference data
- Tauri 2 optional desktop shell wrapping the same web app

## Layout

```
apps/web        the product (React)
apps/desktop    Tauri native shell wrapping apps/web
packages/kernel pure geometry + board model (port of cadcore + board)
packages/io     file readers/writers (.brd in; .board.json/DXF/STL/PDF out)
packages/store  board document store, command/undo, derived-spec selectors
packages/render2d  canvas viewport + 2D editor draw layer
packages/render3d  three.js board mesh + scene
packages/units  metric/imperial + fraction formatting
packages/export STL/DXF/PDF/spec-sheet exporters
packages/ui     design-system components
docs/specs      extracted legacy behavior specs + golden reference data
```

## Site map

The static site is prerendered to real HTML at build time ([vite-react-ssg](https://github.com/Daydreamer-riri/vite-react-ssg)):

| Route                             | Page                                        |
| --------------------------------- | ------------------------------------------- |
| `/`                               | Marketing landing                           |
| `/app`                            | The design app (editor; client-only island) |
| `/about`                          | About / the maker's story                   |
| `/surfboard-design-guide`         | Guide: outline, rocker, rails, volume       |
| `/surfboard-construction-methods` | Guide: PU, EPS, hollow wood & more          |

Each content route ships a unique `<title>`, meta description, canonical, Open Graph and
JSON-LD; `robots.txt` and `sitemap.xml` are generated into `dist/` on build.

## Develop

```sh
pnpm install
pnpm dev          # run the web app (vite-react-ssg dev)
pnpm test         # all package tests (kernel golden tests, etc.)
pnpm typecheck
pnpm build        # prerendered static build to apps/web/dist
```

## Deploy (Cloudflare Pages)

The site is hosted on **Cloudflare Pages** at the `openshaper.com` apex domain.

- **Build command:** `pnpm build`
- **Build output directory:** `apps/web/dist`
- **Node version:** 20
- **Canonical/OG origin:** set the `VITE_SITE_URL` build env var (defaults to
  `https://openshaper.com`).

A GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) is kept as a fallback; the
build's `base` is `/` for a root domain and switches to `./` only under a Tauri build.

### One-time setup (manual)

1. Rename the GitHub repo to `openshaper` (updates the clone/remote URLs).
2. In Cloudflare Pages, create a project from the repo with the build settings above.
3. Add `openshaper.com` as a custom domain in the Pages project (Cloudflare manages DNS).
4. Replace the placeholder `apps/web/public/og-cover.svg` with a rasterized 1200×630
   `og-cover.png` if you want maximum social-scraper compatibility (then update the
   `OG_IMAGE` path in `apps/web/src/seo/site.ts`).

## Contributing

Issues and pull requests welcome — bug reports, board templates, file-format fixes,
and shaping-domain feedback especially. By contributing you agree your work is licensed
under the project's GPL-3.0-or-later.

## Support

OpenShaper is free and always will be — no accounts, no paywall. If it's useful to you
and you'd like to chip in toward its development, you can
[buy me a coffee](https://www.buymeacoffee.com/jaredg). It's entirely optional and supports
a solo passion project. 🙏

## License

OpenShaper is licensed under the **GNU General Public License v3.0 or later**
(GPL-3.0-or-later) — see [`LICENSE`](./LICENSE).

Its kernel is a behavioral port of **BoardCAD-LE** and is therefore a derivative work;
we release OpenShaper under the same copyleft to honor it. See [`NOTICE.md`](./NOTICE.md)
for attribution to the original BoardCAD authors. The BoardCAD-LE source is used as a
reference only and is not redistributed here.

Project orchestration and architecture conventions live in
[`.claude/CLAUDE.md`](.claude/CLAUDE.md).
