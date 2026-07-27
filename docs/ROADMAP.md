# Roadmap (where we are)

1. **Foundation** (done): monorepo, orchestration, golden-data harness.
2. **Kernel** (done): cadcore + board ported behind golden tests; io reads real `.brd`.
3. **Editors + 3D** (done): store/undo, 2D editors, QuadView, spec panel, three.js view.
4. **Export → SHIP** (done): STL/DXF/PDF export; static deploy via Cloudflare
   Workers (`openshaper.com`). Native save isn't wired yet — both web and desktop
   currently save via browser download.
5. **Templating** (in progress): hollow-wood-strip rail-band construction templates
   and the starter board-template library (Shortboard/Funboard/Longboard) are
   shipped; more construction templates, plugin support, and an AI shaping
   assistant remain.
