# Import-warning UX — design

## Context

The Shape3d/`.brd` importer repairs real-world files as it reads them: it drops
degenerate cross-sections, falls back the outline (`curveDefTop2` → `curveDefTop1`),
synthesizes a missing deck, converts a `StringerMeasurement` thickness deck to
absolute, and clamps curves single-valued in x. Each repair already pushes a string
into a `warnings[]` array on the parse result — but the web UI
(`apps/web/src/file-io.ts` → `App.tsx onOpenFile`) **discards it and silently loads
the repaired board.**

The problem: a silently dropped "degenerate" cross-section could, in principle, be
something the user cared about. Silent geometry changes erode trust. The user should
see what changed — and for data-losing changes, decide before the board loads.

Goal: surface import repairs to the user. Block (with a choice) when a repair loses
data; otherwise inform without interrupting.

## Decisions (from brainstorming)

1. **Data-loss → blocking modal; everything else → non-blocking notice.** Only a
   _dropped_ item (currently: a degenerate cross-section) is treated as data-loss.
2. **Modal**: lists what will change, buttons **Import anyway** / **Cancel**.
3. **Notice**: a persistent, dismissible banner (not the existing 6-second toast) for
   info-only imports.
4. **Load paths**: `Open…` and `Open ghost…`. Recent-boards reload needs nothing —
   recents are stored as already-repaired `.board.json`, so they carry zero warnings.
   Templates are clean.
5. **No persisted changelog** — the import-time surfacing is enough (YAGNI).
6. Implemented on the existing `feat/import-s3dx-encrypted-brd` branch.

## Data model (`packages/io`)

Introduce a structured warning shared by the readers the web app consumes:

```ts
export type ImportWarningSeverity = 'dropped' | 'info';
export interface ImportWarning {
  readonly severity: ImportWarningSeverity;
  readonly message: string;
}
```

- `'dropped'` — something was removed from the user's geometry (data-loss). Currently
  only the degenerate cross-section drop in `s3d-reader.ts`.
- `'info'` — a non-destructive repair: outline `curveDefTop2`→`curveDefTop1` fallback,
  synthesized deck, `StringerMeasurement` conversion, monotonic-x clamp, truncated-`p35`
  recovery, etc. (Conversions/clamps that change nothing the user would miss may stay
  unwarned as today; only emit a warning when the user-visible result changed.)

Change `warnings: string[]` → `warnings: readonly ImportWarning[]` on `ParsedBrd`,
`ParsedS3d`, `ParsedS3dx` (alias), and `ParsedSrf`. All currently-emitted warnings
become `{ severity: 'info', message }` except the degenerate-section drop, which is
`{ severity: 'dropped', message }`. Export `ImportWarning`/`ImportWarningSeverity`
from `packages/io/src/index.ts`.

Update the reader tests that match warning text (e.g. `warnings.some(w => /…/.test(w))`)
to read `w.message`, and add a check that the dropped-section warning carries
`severity: 'dropped'`.

## Flow (`apps/web`)

`file-io.ts`:

- `openBoardFile` returns `{ board, meta, warnings: readonly ImportWarning[] }`.
  Each reader entry forwards its warnings; the `.board.json` fallback returns `[]`.

`App.tsx` `onOpenFile` and `onOpenGhost`:

- Parsing happens first; the board is **not yet loaded into the store** when warnings
  are inspected. (The repair already occurred inside the pure parse, but nothing has
  reached `boardStore` / the ghost state.)
- If `warnings` contains any `severity === 'dropped'`: open `ImportWarningsDialog`
  with the full warning list.
  - **Import anyway** → load the board (`boardStore.load` / `setGhost`); if any
    `info` warnings remain, also show the banner.
  - **Cancel** → discard the parsed result; nothing loads; no store change.
- Else if `warnings` has only `info` entries → load the board and show the banner.
- Else (no warnings) → load silently, exactly as today.
- The existing `try/catch` → `showError` path is unchanged (hard parse failures still
  toast an error).

Because the parse is synchronous-after-`await` and pure, "Cancel" is simply _not
calling_ `load`. To keep `onOpenFile`/`onOpenGhost` readable, factor the
"parse → decide → maybe load" sequence so both call sites share it (a small helper
that takes the parsed result + a `load` callback).

## Components

- **`ImportWarningsDialog`** (`apps/web/src/` alongside the other dialogs, or
  `packages/ui` if it stays generic) — a modal built on the same primitive used by
  `SettingsDialog` / the PDF export dialog. Title: _"This file needs repairs to
  import"_. Body: list with the `dropped` items first (emphasized) then `info` items,
  each showing its `message`. Footer: **Cancel** (secondary) / **Import anyway**
  (primary). Escape / backdrop = Cancel.
- **Import notice banner** — a persistent, dismissible banner for info-only imports.
  Reuse the `Toast` visual treatment but without the 6 s auto-dismiss, or a small
  inline banner component. Lists the `info` messages; user dismisses explicitly.

Both are dumb/presentational: they take the warning list + callbacks and render. No
parsing or store logic inside them.

## Error handling

- Hard parse errors (`BrdParseError`, `S3dParseError`, password-protected, etc.)
  continue to throw and surface via the existing `showError` toast — they are not
  `ImportWarning`s.
- `Cancel` leaves the app exactly as it was before the file pick (no board swap, no
  recent-list entry).

## Testing

- **io**: the degenerate-section warning has `severity: 'dropped'`; fallback /
  synthetic-deck / stringer warnings are `'info'`. Existing string-match assertions
  updated to `.message`.
- **web**:
  - `openBoardFile` forwards warnings (dropped vs info).
  - `onOpenFile` with a `dropped` warning opens the dialog; **Cancel** does **not**
    call `boardStore.load`; **Import anyway** loads.
  - Info-only import loads and shows the banner.
  - `ImportWarningsDialog` renders dropped + info messages and wires both buttons.

## Out of scope

- Persisting a per-board changelog of repairs.
- Per-issue keep/repair choices (a degenerate section cannot be safely kept — it
  breaks the 3D loft and the thickness-settle pass).
- Re-export / "fix in place" tooling.
