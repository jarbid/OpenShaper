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

## Remaining

- **AI shaping assistant** — nothing in-tree yet (see the `claude-api` skill).
- **More construction templates** — HWS is still the only one under
  `packages/export/src/construction/`.
- **Native save** — not wired. `src-tauri` pulls in no fs/dialog plugin, so both web
  and desktop still save via browser download.
- **CAM / G-code output** — a legacy capability (see `docs/specs/ASSESSMENT.md`);
  today only DXF/STL cut files exist.
