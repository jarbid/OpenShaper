# Proposals — for approval

These came out of the quality pass but change what users see or do, or touch file
formats, geometry output, analytics or dependencies. None of them is implemented.
Each item lists what it is and why, rough effort, risk, and what users would notice.
References are against `99c3030`.

## Suggested order

1. ~~**Crashes and data loss first** — P1 (undo crash), P2 (stuck drag), P5 (blocked
   storage), P7 (malicious share link), P23 (.brd metadata dropped on import).~~ Done,
   each with a regression test that fails without the fix.
2. ~~**Everyday editing papercuts** — P3, P4, P10, P13, P15, P16.~~ Done.
3. ~~**CI safety net** — P35, P36, so the above stays fixed.~~ Done, with P44 and P45.
4. **Load-time wins that need a product decision** — P38 (analytics), then P39/P41
   after one cross-browser download check.
5. ~~**Format changes** — P24–P29: each needs a `divergences.md` entry and fixture work.~~ Done, with P31 and P42.

## Editor bugs (state and undo)

**P1 · ✅ Done (c09fe8a) — Stale selection after undo crashes the editor.** Add two stations near the nose,
select a point on the higher one, then undo twice. `ControlPointInspector.tsx:317` calls
`getTargetSpline` with an index that no longer exists, `edits.ts:55` throws, and the route
error boundary replaces the editor. Undoing an added outline point also leaves the
selection on a different knot, and a fin selection can outlive its fin.
Fix: validate or clear the selection and `selectedFin` in undo, redo and jumpTo.
Effort S · risk low · visible: crash gone, selection clears after such an undo.

**P2 · ✅ Done (07072de) — A drag interrupted by a view switch leaves the store "editing".** Pressing 2–6
mid-drag (or a station remount) unmounts `SplineEditor` without `endEdit`. Later edits
then merge into one undo step and the specs freeze until undo or load.
Fix: end the active edit on unmount. Effort S · risk low · visible: yes (the fix).

**P3 · ✅ Done (66cd737) — Clicking a point without moving it adds an empty "Edit" undo step and wipes
redo.** `beginEdit` runs on pointer-down (`SplineEditor.tsx:975`). Start it on the first
move, the way section drags already do. Effort S · risk low · visible: yes.

**P4 · ✅ Done (0b3f540) — Undo or Delete during a drag.** Undo clears `editing`, so each later move becomes
its own history step and can push real history out of the 200-step cap. Delete during a
drag leaves the drag writing to a stale index. Fix: ignore these (or end the drag first)
while editing. Effort S · risk low · visible: yes.

## Robustness against storage and untrusted input

**P5 · ✅ Done (d80862f) — Blocked or full storage crashes or blocks work.** The `bs.lengthUnit` read and
write in render is unguarded (`App.tsx:441,445`), so the editor crashes when storage is
blocked. The settings `save*` calls throw on quota and abort the export or settings save
(`App.tsx:521,1725,1741,1756`). Fix: guard every storage call, as the other modules
already do. Effort S · risk low · visible: yes (no crash, export still downloads).

**P6 · ✅ Done (51ecec6) — `.board.json` has no validation.** `'null'`, missing curves or `e: [null, "a"]`
throw a raw `TypeError` or load corrupt knots (`board-json.ts:241-260`). Fix: a structural
validator that raises `BoardJsonError`. Effort M · risk low · visible: clean error
message. Format unchanged.

**P7 · ✅ Done (de54f0f) — Unvalidated metadata from files and share links.** `metadata as BoardMeta`
(`App.tsx:194,864,893`, `file-io.ts:141`). `"model": 5` in a share link throws after load
but before the fragment is cleared, so the link re-fires on every reload. An unknown
`foamType` shows NaN weight. Fix: one `toBoardMeta(unknown)` at the boundary.
Effort S · risk low · visible: yes.

**P8 · ✅ Done (868a921) — A malformed share link stays in the address bar** when `decodeURIComponent` throws
(`share-bootstrap.ts:147`), where analytics can read it, against the privacy promise.
Fix: clear it in every path. Effort S · risk low · visible: the URL gets cleaned.

**P9 · ✅ Done (60608f4) — Worker failure leaves specs on "Loading…" forever** (no `onerror` in
`use-specs-worker.ts`; since Phase 2 it is the only worker without an error path). Fix: fall back to synchronous compute. Effort S · visible: yes.

## Fields and shortcuts

**P10 · ✅ Done (99c06b7) — Numeric length fields.** Focusing and leaving a field commits the _rounded_
display value (50.01234 → 50.01 plus an undo step). Esc doesn't revert (typing 300 then
Esc gives 30). "abc" parses to 0. Enter commits twice. Affects `ControlPointInspector`
(`CoordInput`, `HeaderCoordInput`) and `FinPanel`. Fix: one dirty-plus-revert field hook
and a parse that rejects non-numbers. Effort M · risk low · visible: yes.

**P11 · ✅ Done (7c0d9a6) — Ctrl+S skips the app's save path** (`use-keyboard-shortcuts.ts`). It records no
`save_board` event and doesn't refresh Open recent. Effort S · visible: recent list,
analytics.

**P12 · ✅ Done (287de58) — Sidebar overlay toggles never send `overlay_toggled`** (`Sidebar.tsx:998-1025`).
One overlay table and one toggle handler would fix it. Effort S · visible: analytics only.

**P13 · ✅ Done (5a59284) — Ctrl+Z inside a text field undoes the board** and blocks the browser's own text
undo. Global shortcuts also stay live behind open modals. Effort S · visible: yes.

**P14 · ✅ Done (147460d) — Units convention violations.** `ExportStepDialog.tsx:110` hardcodes mm;
`SectionPositionEditor` uses fixed decimals; the ft·in field steps by 0.1 instead of 1/16
(three step policies exist). Effort S · visible: yes.

## Mobile

**P15 · ✅ Done (fcd5f61) — The bottom sheet sticks mid-drag on `pointercancel`** (a system gesture or an
incoming call). It stays at a non-snap height with transitions off (`sheet.tsx:142`).
Effort S · visible: yes.

**P16 · ✅ Done (fcd5f61) — Rotating to landscape keeps the sheet at peek** (112 px of a 390 px screen); only
initial load closes it (`App.tsx:394`). Effort S · visible: yes.

**P17 · ✅ Done (0ae4084) — "Turn your phone sideways" shows in narrow desktop windows.** Require a coarse
pointer (`LandscapeHint.tsx:49`). Effort XS · visible: yes.

**P18 · ✅ Done (8bb6460) — Breakpoint overlap at exactly 640 px** (phone `max-width: 640px` vs Tailwind `sm`
`min-width: 640px`). Effort XS · visible: marginal.

**P19 · ✅ Done (28f17cd) — Canvas touch targets are below the 44 px floor.** Control points are about 28 px
and section markers ignore touch tolerance (10 px). Effort S · visible: yes.

**P20 · ✅ Done (7dbb350) — Touch hover path.** One finger moving over empty canvas runs hover and scrub,
re-rendering the app on every move. Skip it for touch, or batch it per frame.
Effort S · visible: the scrub line no longer follows a finger.

**P21 · ✅ Done (057d363) — Pane orientation (`turned`) can flip mid-gesture** on a nearly square phone pane.
Latch it at pointer-down. Effort S · visible: bug case only.

**P22 · ✅ Done (a0ec6a6) — Fins run ahead of the hull during a 3D drag.** Fins update synchronously, the hull
waits for the worker. Effort M · visible: the transient misalignment goes away.

## Files and formats (need `docs/specs/divergences.md` entries)

**P23 · ✅ Done (fccc491) — `.brd` import drops all metadata** (model, designer, surfer, comments, fin type
are parsed and then thrown away at `file-io.ts:111`). Effort XS · visible: yes. Format
unchanged.

**P24 · ✅ Done (4e3f459) — Non-ASCII `.brd` metadata is garbled.** Written as UTF-8, read as latin1
(`Café` → `CafÃ©`). Fix: write latin1 and transliterate the rest. Changes exported bytes.
Effort S · risk med.

**P25 · ✅ Done (4840ddb) — Newlines in `.brd` comments don't round-trip.** Written as `\n`, never unescaped
on read. Needs the legacy spec checked first. Effort S · risk med.

**P26 · ✅ Done (030037c) — Fin-type regex precedence bug.** `/\b5|five\b/` turns "Thruster 4.5" into
`5-fin`; "tri" matches "Triple stringer". Effort XS · visible on import.

**P27 · ✅ Done (64891a5) — Reader gaps.** `.srf`: NaN knots not rejected, silent 64 KB truncation, and no
warnings channel for dropped curves. `.brd`: `p50` values become NaN; empty sections are
accepted silently. `.s3d`: XML entities and CDATA not decoded, declared encoding ignored.
Effort M · visible: metadata and warnings.

**P28 · ✅ Done (24b31ae) — Sheet DXF writes `·` as UTF-8** into R12 (ANSI) text. Changes output. Effort XS.

**P29 · ✅ Done (dc35a91) — Binary STL** (about 5× smaller, faster). Changes the output format. Effort S.

**P30 · ✅ Done (e269602) — Object-URL revoke timing.** `download()` revokes the URL synchronously after
`click()`, which is fragile in Safari and Firefox. The multi-PDF loop can be blocked as
multiple downloads. Effort S · visible: downloads more reliable.

## Geometry (need golden or divergence handling)

**P31 · ✅ Done (af1f087) — `getMaxWidth` is `-Infinity` for a single-segment outline.** The widest point is
also missed in the last segment, because `maxY` skips it (a legacy quirk). This makes
the mesh coarse (`ringSteps` clamps to 12). Golden boards are unchanged; the box and
extreme-rocker characterization snapshots would change. Effort S · risk med.

**P32 · ✅ Done (b2e17d9) — Specs crash on a board with no real stations** (imported files only):
`cs[-1]` at `board.ts:255`. Return null/0 instead. Effort XS · visible on such files.

**P33 · ✅ Done (aa4e327) — 3D guide rings ignore the swallow-tail notch** (`guides.ts:32`). The overlay
crosses the notch. Mesh unaffected. Effort S.

## Accessibility and dialogs

**P34 · ✅ Done (c7796bf) — Dialogs have no `role="dialog"`, `aria-modal` or focus trap**, and Settings,
Import warnings and Construction have no Escape handling. A shared `<Modal>` would fix all
of them, together with Phase 2 item 15. Effort M · visible: keyboard and screen-reader
users.

## Process and dependencies

**P35 · ✅ Done (ecc7621) — Run the e2e and offline Playwright suites in CI.** Neither runs today, and
the offline suite is the only check of the precache/offline guarantees. Both configs
already handle `CI` (retries, `forbidOnly`). Effort S (one job with `playwright
install --with-deps chromium`) · risk low (CI minutes, some flake) · visible: no.

**P36 · ✅ Done (86dc5fd) — Real ESLint plus `prettier --check` in CI.** `pnpm lint` is an `echo` in every
package. The most valuable rules here: `react-hooks` (exhaustive deps — several effects
in App rely on reasoning instead), and `import/no-restricted-paths` to enforce the
"kernel/io/units never import React, DOM or three" layering, which today rests on
discipline alone. Several test files on `main` are not Prettier-clean. Effort M ·
risk low · visible: no.

**P37 · 🟡 Mostly done — Dependency majors**, each its own upgrade PR:

- ✅ vitest 2→5, which removes the duplicate vite 5, with vite 6→8 (#67)
- ✅ React 19 + fiber 9 + drei 10 (#68; costs ~24 KB gz on the landing page)
- ✅ three 0.171→0.186 (#69; sub-perceptual 3D shading differences, measured there)
- ✅ tailwind-merge 3, lucide 1.x (#66)
- ✅ TypeScript 6.0 (#70). **Blocked:** TypeScript 7 waits on typescript-eslint, whose
  peer range stops at `<6.1`.
- **Blocked:** react-router 7 waits on vite-react-ssg, which peers on react-router 6.

Effort M–L each · risk med–high · visible: possibly (rendering, routing).

**P42 · ✅ Closed, not a bug (1c66c49): the branch is unreachable, now pinned by a test — `getPreviousCrossSectionIndex` can index past the end** (`board.ts:211`): when
`pos` is beyond the last station it returns `crossSections.length`. Every current caller
clamps `pos` first, so nothing hits it today. A one-line guard (`length - 2`, as the
`next` variant does) would remove the trap, but it changes a legacy-ported function, so it
needs a golden check. Effort XS · risk low · visible: no.

**P43 · ✅ Done (119f016) — Investigate the phone profile's idle main-thread load** (~14 % busy with the 3D
view untouched, before and after the render-on-demand change). It isn't the render loop.
Worth a profile on a real device before guessing. Effort S · visible: battery.

## Moved here from the Phase 2 fix list

**P38 · Lazy-load posthog-js** (~300 KB raw / ~95 KB gz of the entry chunk on every
route; `analytics.ts:25`). Event names and properties would be unchanged, but what gets
captured would not: pageviews of routes visited before the chunk loads, uncaught errors
in that window (the handlers install at init) and `track()` calls queued meanwhile would
be lost or re-timestamped unless replayed with their original timestamps. Needs a
decision on whether that is acceptable, and a check against the dashboards. Effort M ·
risk med · visible: faster first load on every page; analytics data shape at the margins.

**P39 · Lazy-load the exporters** (PDF/DXF/STL/STEP, ~60–80 KB of `file-io`). Clipper
and the construction templates have to stay eager because the Build tab previews them
live. The downloads would then start after an `await`, which some browsers treat as
outside the click's user activation. Needs a cross-browser check (Safari, Firefox) of the
multi-file PDF path first. Effort S · risk med · visible: slightly faster `/app` load.

**P41 · STL/STEP export in a worker.** `exportStl` takes 1.9–2.7 s and builds a 45 MB
string; `exportStep` takes 1.2 s; both run synchronously on click and freeze the page
(the project's own rule 4). A worker gives byte-identical output, but the download then
starts after an `await`, with the same open user-activation question as P39. Do P39's
cross-browser check first, then this. Effort M · risk med · visible: no freeze during
export.

**P44 · ✅ Done (7cd2ee2) — Line-coverage reporting.** No coverage tool is installed, so coverage can only be
described, not measured. Adding `@vitest/coverage-v8` (devDependency) with a
`pnpm coverage` script would give per-package numbers, and an optional CI artifact.
Effort S · risk low · visible: no.

**P45 · ✅ Done (8442799) — Offline share-link e2e fails, on the baseline too.** `e2e-offline/offline.spec.ts`
"a shared link opens with no network at all" times out waiting for the "Open shared
board?" prompt. It fails identically on the pre-pass build. In this sandbox Chromium
is older than Playwright 1.60 pins, so it may be environmental. CI doesn't run this suite
(P35), so nobody would notice either way. Effort S to diagnose · visible: possibly
(offline share links).
