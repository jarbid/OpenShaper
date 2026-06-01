# BoardCAD-LE — Modernization Assessment

_Discovery phase for the OpenShaper rebuild. Source of record: `../boardcad-le`
(read-only). Tooling note: `scc`/`cloc`/`lizard` are not installed on this machine; LOC was
measured with `find`+`wc` and complexity with decision-keyword counts. Figures are
reproducible via the commands in this repo's history._

## Executive Summary

BoardCAD-LE is a mature single-developer desktop surfboard CAD/CAM application: **~51,400
lines of Java (~36,600 code) across 165 files**, plus ~6,900 lines of i18n properties. It is
functionally rich (bezier outline/rocker/cross-section editing, live Java3D view, volume/spec
calculation, multi-format I/O, CNC toolpath generation, construction-template printing) but
architecturally legacy: a `BoardCAD` god-object singleton referenced by 72 files, the math
kernel reaching up into Swing, AWT `Graphics2D` rendering with full repaints, fixed-resolution
numerical integration, and untrusted-file parsers with XXE and unbounded-allocation flaws.
**Headline recommendation: Rebuild** (not refactor) on a modern web+desktop stack, mining the
legacy for exact behavior and pinning the port to golden data — which is the OpenShaper plan
already underway.

## System Inventory

| Metric | Value |
|---|---|
| Java files | 165 |
| Total Java lines | 51,418 |
| Code lines (approx) | 36,643 |
| Comment lines (approx) | 3,830 |
| Blank lines | 10,945 |
| i18n properties | 8 files / 6,926 lines (en, es, fr, nl, no, pt) |
| Largest files | `MenuBar.java` 3,575 · `BoardCAD.java` 2,985 · `PrintHollowWoodTemplates.java` 2,822 · `BezierBoardDrawUtil.java` 2,705 |
| Highest decision-keyword density | `BoardCAD.java` (320) · `BezierBoardDrawUtil.java` (298) · `SurfaceSplitsToolpathGenerator.java` (238) |

**Technology fingerprint**
- **Language/runtime:** Java (Gradle toolchain pinned to Java 25; build runs on installed JDK 21). `build.gradle`, `settings.gradle`, Gradle wrapper present.
- **UI:** Swing throughout; look-and-feel via FlatLaf / Darklaf / Radiance (`build.gradle:57-64`).
- **3D:** Java3D-on-JOGL (`org.jogamp.java3d`, `org.jogamp.jogl`, `org.jogamp.vecmath`).
- **Other libs:** `javassist`, `org.reflections:0.9.12`, `org.ujmp:ujmp-complete:0.3.0` (matrix math for bezier fitting).
- **Data stores:** none (file-based). Native `.brd` (text, optional weak encryption) + `.brdx` XML stub; imports `.srf` (binary), `.s3d`/`.s3dx` (XML). Exports DXF/STL/GCode (and a dead PDF path).
- **Integration points:** filesystem only (desktop app, no network server); a JAR plugin loader (`plugins/` runtime dir, no in-tree plugins); CNC G-code/cut-file output.
- **Tests:** none found (no JUnit/test sources) — a key risk the golden-data strategy addresses.

## Architecture-at-a-Glance

11 functional domains (see `ARCHITECTURE.mmd` for the dependency diagram):

| Domain | Key files | Responsibility |
|---|---|---|
| A. Math Kernel (`cadcore`) | `BezierSpline`, `BezierCurve`, `BezierKnot`, `BezierFit`, `VecMath`, `MathUtils`, `UnitUtils` | Bezier math, surface interpolation, vector/unit math — the stable core |
| B. Board Model + I/O (`board`, readers/writers) | `BezierBoard` (1,812 LOC), `BrdReader/Writer`, `SrfReader`, `S3dReader/S3dxReader` | In-memory surfboard model + persistence/import |
| C. Commands / Undo (`boardcad.commands`) | `BrdCommandHistory`, `BrdEditCommand` (720), ~20 commands | Command-pattern editing with undo/redo |
| D. Swing GUI Core (`boardcad.gui.jdk`) | `BoardCAD` (hub singleton), `MenuBar`, `BoardEdit`, `QuadView`, `BezierBoardDrawUtil`, dialogs | Main window, 2D editors, drawing utils, wiring |
| E. GUI Actions (`...jdk.actions`) | 25 `*Action.java` | Swing action adapters for menus/toolbars/keys |
| F. Plugin Framework (`...jdk.plugin`) | `AbstractPlugin(Handler)` | Runtime JAR plugin discovery (no in-tree plugins) |
| G. 3D Visualization | `ThreeDView`, `Brd3DModelGenerator`, `Machine3DView` | Java3D tessellation + orbit rendering |
| H. Print / Templates (`boardcad.print`) | `PrintHollowWoodTemplates`, `PrintSandwichTemplates`, `PrintSpecSheet`, `PrintBrd` | Spec sheets + full-scale construction templates |
| I. Export (`boardcad.export`) | `DxfExport`, `StlExport`, `GCodeDraw`, `PdfDraw` (dead) | Geometry export |
| J. CAM / CNC (`boardcam` + sub-pkgs) | `MachineConfig`, `SurfaceSplitsToolpathGenerator` (1,915), cutters, holding systems, GCode/Atua writers | Toolpath generation to cut a blank |
| K. Settings & i18n | `BoardCADSettings`, `Settings`, `LanguageResource` (imported 96×) | Observable settings registry + localized strings |

**Coupling hotspots:** `BoardCAD` (D) is a god-object hub directly wiring C, G, H, I, J, F;
Commands (C) imports `boardcad.gui.jdk` 33×; and the kernel back-edge
`cadcore/BezierBoardCrossSection.java` → `board.BezierBoard` + `gui.jdk.BezierBoardDrawUtil`
violates the foundation layer (blocks clean kernel extraction — exactly what the OpenShaper
pure-`kernel` package fixes).

## Production Runtime Profile

No telemetry/APM available for this desktop app — step skipped. Operational risk is inferred
from static complexity instead: the CAM toolpath generators (J) and 3D model regeneration (G)
are the heaviest compute paths and the first candidates for the Phase-2 Rust/WASM offload.

## Technical Debt (top 10, ranked by remediation value)

1. **`BoardCAD` god-object singleton** referenced by 72 files (`gui/jdk/BoardCAD.java`) — no GUI/domain layering. → Replace with an explicit document store (OpenShaper `packages/store`).
2. **Kernel→GUI back-edge** (`cadcore/BezierBoardCrossSection.java` imports `gui.jdk.BezierBoardDrawUtil`) — math can't be reused headless. → Pure `kernel` with zero UI imports.
3. **God classes**: `MenuBar` 3,575, `BoardCAD` 2,985, `BezierBoardDrawUtil` 2,705 lines mixing construction/business logic/painting. → Decompose by concern (actions, draw layer, viewport).
4. **Full-repaint 2D rendering** (`BoardEdit`/`BezierBoardDrawUtil` AWT `paintComponent`) on every edit. → Dirty-region canvas rendering (`packages/render2d`).
5. **Full 3D mesh regeneration** per edit (`Brd3DModelGenerator`/`FasterBrd3DModelGenerator`). → Incremental mesh updates (`packages/render3d`).
6. **Hard-coded numerical resolution & tolerances** (`VOLUME_X_SPLITS=10`, `VOLUME_Y_SPLITS=30`, `POS_TOLERANCE=0.003`, etc.). → Parameterized options + adaptive refinement.
7. **Silent `catch(Exception)` in parsers** (`BrdReader`, `SrfReader`) hides corrupt-file errors. → Validate-on-read, fail loudly with actionable messages.
8. **Fixed-size arrays** (`mFins[9]` in `BezierBoard`; `byte[500]` header buffer in `SrfReader`). → Dynamic collections + bounds checks.
9. **Dead code**: `boardcad/export/PdfDraw.java` defined but never referenced; `BrdXmlReader` empty stub. → Drop; PDF re-implemented cleanly in `packages/io`.
10. **Outdated/abandoned deps**: `reflections:0.9.12` (used only to list LAF classes), `ujmp:0.3.0` (2015). → Replace reflections with a static list; reimplement the small matrix subset for bezier-fit.

## Security Findings (CWE-tagged)

| # | Finding | CWE | Severity | Evidence |
|---|---|---|---|---|
| SEC-001 | XXE in S3D XML reader (defaulted `DocumentBuilderFactory`) | CWE-611 | High | `src/board/readers/S3dReader.java:39-43` |
| SEC-002 | XXE in S3DX XML reader | CWE-611 | High | `src/board/readers/S3dxReader.java:39-46` |
| SEC-006 | Untrusted JAR plugin load via reflection → RCE | CWE-470/94 | High (if dir writable) | `src/boardcad/gui/jdk/plugin/AbstractPluginHandler.java:46-67` |
| SEC-003 | Hardcoded decryption keys + static PBE salt | CWE-798/321 | Medium | `src/board/readers/BrdReader.java:41,44,90` |
| SEC-004 | Weak crypto: PBEWithMD5AndDES, 20 iterations | CWE-327 | Medium | `src/board/readers/BrdReader.java:87-89` |
| SEC-005 | Committed signing key (`newkey`) + `all-permissions` manifest | CWE-798/312 | Medium | `boardcad-le/newkey`, `boardcad-le/manifest:4-5` |
| SEC-008 | Unbounded array write / huge alloc in SRF parser | CWE-787/789 | Medium | `src/board/readers/SrfReader.java:41-67,104-108` |
| SEC-009 | Missing input validation across `.brd` text parsing | CWE-20/129 | Low/Med | `src/board/readers/BrdReader.java:139,591,622` |
| SEC-010 | Embedded file paths (`blankFile`) used to open/write files | CWE-22 | Low | `src/board/readers/BrdReader.java:189-192`; `boardcam/MachineConfig.java:245-251` |
| SEC-007 | Reflection classpath scan pulls old `reflections` lib | CWE-1104 | Low | `src/boardcad/settings/BoardCADSettings.java:223-224` |
| SEC-011 | Outdated/EOL dependencies (`reflections`, `ujmp`, JOGL forks) | CWE-1104/1035 | Low | `build.gradle:57-67` |

**Rebuild implication:** OpenShaper's `packages/io` must harden every importer — disable XXE,
bound all allocations against remaining buffer size, validate fields, and treat embedded paths
as untrusted. The weak `.brd` "encryption" is cosmetic; support read-only legacy import, do not
reproduce it as a security control.

## Documentation Gaps (top 5)

1. **No tests and no spec** for the bezier surface-interpolation math (control-point vs S-linear) — behavior lives only in code.
2. **`.brd`/`.srf`/`.s3d` formats are undocumented** — field IDs (`p01`…), encryption variants, and binary layout must be reverse-engineered (the `legacy-spec-extractor` job).
3. **Volume/area/CoM algorithms** (fixed-split Simpson integration) have no written derivation or accuracy statement.
4. **CAM toolpath strategies** (surface-splits state machine, holding-system offsets) are uncommented and class-name-only.
5. **Plugin contract** (`AbstractPlugin`/`AbstractPluginHandler`) has no documentation and no example plugin.

## Effort Estimation

COCOMO-II basic, nominal scale factors, on code SLOC: `PM = 2.94 × KSLOC^1.10`.

- KSLOC = 36.6 → **≈ 154 person-months** (full from-scratch-equivalent baseline).
- On total SLOC (51.4 KSLOC): ≈ 224 PM (upper bound).

**Range: ~150–225 person-months equivalent** of functionality. The OpenShaper plan reduces
calendar time well below this by: (a) AI-assisted porting of the well-bounded kernel, (b)
reusing modern libraries for 3D/printing/PDF/DXF that the legacy hand-rolled, and (c) shipping
a design-first MVP before CAM. Key cost drivers: the bezier surface math, CAM toolpath
generators, and achieving file-format parity with golden tests.

## Recommended Modernization Pattern

**Rebuild.** The domain logic (bezier surfboard math) is durable and worth preserving exactly,
but the implementation is fused to Swing/Java3D/AWT and a god-object singleton with no tests —
a Refactor/Replatform would carry the architecture forward. Rearchitecting in place is blocked
by the kernel→GUI back-edge and the absence of tests. A clean **Rebuild** on a web+desktop
stack, with behavior mined into golden specs and pinned by regression tests (the OpenShaper
plan), captures the valuable math while shedding every legacy constraint and opening the
freemium/Pro monetization path.
