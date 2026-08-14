# Roadmap (where we are)

1. **Foundation** (done): monorepo, orchestration, golden-data harness.
2. **Kernel** (done): cadcore + board ported behind golden tests; io reads real `.brd`.
3. **Editors + 3D** (done): store/undo, 2D editors, QuadView, spec panel, three.js view.
4. **Export → SHIP** (done): STL/DXF/PDF export; static deploy via Cloudflare
   Workers (`openshaper.com`).
5. **Templating** (done): hollow-wood-strip rail-band construction templates
   (offset-from-outline, developed flat, with kerf removal, cutting list, sheet
   nesting, PDF tiling, and nose/tail blocks); the starter board-template library
   (Shortboard/Funboard/Longboard); and fin support — a parametric `FinConfig`
   resolved against the live board shape, with glass-on / FCS-II / FCS-X2 / Futures
   box-and-plug footprints wired through 2D, 3D, export, and persistence.
6. **Interop + polish** (done): Shape3d `.s3dx` and encrypted `.brd` import behind
   structured import warnings (modal on data loss, notice on repair); concave-tail
   outlines through kernel, volume/area, tessellation, and every exporter;
   photo-trace with per-view images, 4-click calibration, and on-canvas transform;
   silent session restore (board, view state, camera); marketing/guide pages with an
   SEO pass; consent-gated anonymous analytics.

7. **Interop + reach** (next): make the browser-native bet pay off and stop designs
   being trapped in any one tool.
   1. **Offline (done).** The `/app` editor is a PWA: installable, fully usable with
      no network, with a branded fallback for the marketing pages (which stay
      network-served and are never precached). Instrument Sans is self-hosted so the
      editor makes no third-party request. A build-time guard fails CI if anything
      outside the editor's asset graph enters the precache.
      See `docs/design/offline.md`.
   2. **STEP export (done).** The board as a solid bounded by true B-spline
      surfaces (ISO 10303-21, AP214) — offsettable, shellable and machinable in
      Fusion / Rhino / SolidWorks / FreeCAD, and ~50x smaller than the equivalent
      STL. Open surface export is the wedge against proprietary lock-in.
      Not yet: concave (swallow / fish) tails, which need their own surfaces.
      See `docs/design/step-export.md`.

      > An earlier version of this line said legacy BoardCAD shipped STEP and we
      > dropped it. It did not — `docs/specs/ASSESSMENT.md` lists domain I as
      > `DxfExport`, `StlExport`, `GCodeDraw` and a dead `PdfDraw`. This was new
      > work, so the golden-data rule's porting phase never applied to it.

   3. **Share-by-URL** — encode a board into a link, no backend, no account.
   4. **i18n** — legacy shipped 6 locales (en, es, fr, nl, no, pt); we are English-only.

8. **CAM / G-code** (after phase 7): port the last big legacy domain — `MachineConfig`,
   `SurfaceSplitsToolpathGenerator`, cutters, holding systems, and the GCode/Atua
   writers (see `docs/specs/ASSESSMENT.md`, domain J). Today we emit DXF/STL cut files
   but nothing that drives a shaping machine directly.

## Unscheduled

- **AI shaping assistant** — nothing in-tree yet (see the `claude-api` skill).
- **More construction templates** — HWS is still the only one under
  `packages/export/src/construction/`.
- **Native save** — not wired. `src-tauri` pulls in no fs/dialog plugin, so both web
  and desktop still save via browser download.
- **Blank library + fit overlay** — check a design against real blanks before cutting.
  `brd-reader.ts` already parses `blankFile` / `blankPivot` / `blankTailPos` and
  nothing consumes them.
- **Named versions + diff** — versions beyond the undo stack, building on the
  reference-board ("ghost") comparison already shipped.

## Why this order

Phases 7–8 come out of an August 2026 market/UX review. Two findings drove it:
file-format lock-in is the most-evidenced pain in the shaper community, and our
closest open-source competitor (Super Shaper 9000, browser-based, `.s3dx`/`.brd`
interop, built because Shape3D and AKU have no Linux build) is chasing the same
ground. Offline leads because browser-native is our core advantage and connectivity
is its one failure mode.

Deliberately excluded: real-time multiplayer and any paid tier — both were rated
high-impact by the review, and both are ruled out by the project's non-negotiables
(all client-side, no server or accounts; every feature free). Parametric constraint
trees are excluded too: shapers work spatially, and direct manipulation already
suits the domain better.
