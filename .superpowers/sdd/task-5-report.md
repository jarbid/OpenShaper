# Task 5 Report — Wire decision into Open / Open ghost + notice banner

## Date

2026-06-24

## Branch

`feat/import-s3dx-encrypted-brd`

## Files Changed

- `apps/web/src/App.tsx` — sole file modified (68 insertions, 12 deletions)

## What Was Done

### Imports added (top of App.tsx)

- Added `decideImport` to the existing `./file-io` import.
- Added `import { ImportWarningsDialog } from './ImportWarningsDialog'`.
- Added `import type { ImportWarning } from '@openshaper/io'`.

### New state (inside AppShell)

- `importNotice: ImportWarning[] | null` — holds info-only warnings for the persistent dismissible notice.
- `pendingImport: { fileName, dropped, info, commit } | null` — holds a data-loss import awaiting user confirmation.

### New helper `applyImport`

Added above `onOpenFile`. Calls `decideImport(warnings)`: if `'confirm'`, stages `pendingImport`; if `'load'`, calls `commit()` immediately and sets `importNotice` when there are info warnings.

### `onOpenFile` rewrite

`try` body now destructures `{ board, meta, warnings }` from `openBoardFile`, builds a `commit` closure containing all the original load/setMeta/recordRecent/setRecentBoards logic, then calls `applyImport(file.name, warnings, commit)`. Error path (`catch`) preserved unchanged.

### `onOpenGhost` rewrite

`try` body now destructures `{ board, warnings }` from `openBoardFile`, then calls `applyImport(file.name, warnings, () => setGhost(board))`. Error path preserved unchanged.

### New JSX in the return (after the existing `{toast && <Toast>}`)

1. `{pendingImport && <ImportWarningsDialog .../>}` — modal; Import anyway calls `commit()`, sets `importNotice`, clears `pendingImport`; Cancel clears `pendingImport` only (board not loaded).
2. `{importNotice && <Toast onClick={...}>}` — persistent (no auto-dismiss); click dismisses.

## Test Commands and Results

```
pnpm --filter @openshaper/web typecheck
```

Result: PASS — no TypeScript errors.

```
pnpm --filter @openshaper/web test
```

Result: PASS — 74 tests across 12 test files, 0 failures.

Test files passing:

- `App.test.tsx` (4 tests) — smoke test loads the bundled sample board (no warnings) silently, exactly as before.
- `ImportWarningsDialog.test.tsx` (2 tests) — component renders messages and wires both buttons.
- `file-io.test.ts` (3 tests) — `decideImport` all three cases.
- All other web test files (67 remaining tests).

## Commit

`7962884` — `feat(web): confirm on data-loss import, notice on non-destructive repairs`

## Adaptations

None required. The plan code matched the pre-existing codebase state exactly. Tasks 1–4 were already committed (commits `5421b97` and `386d273`) so Task 5 only needed `App.tsx`.

The Prettier post-edit hook reformatted each edited region after every `Edit` call (function argument list line-wrapping and metadata key alignment). The strategy of re-reading the affected region before each subsequent edit avoided any stale-string mismatches.

## Concerns

None. The implementation matches the plan spec verbatim; the smoke test confirmed the no-warning path is unchanged.

---

# Task 5 Addendum — App-level integration test for the data-loss import gate

## Date

2026-06-24

## Branch

`feat/import-s3dx-encrypted-brd`

## Files Added

- `apps/web/src/App.import-gate.test.tsx` — 3 new integration tests

## What Was Done

Added `apps/web/src/App.import-gate.test.tsx` covering the three assertions required by the design spec's Testing section:

1. **Dialog shown** — when `openBoardFile` resolves with a `severity: 'dropped'` warning, the `ImportWarningsDialog` is rendered and `boardStore.load` is NOT called.
2. **Cancel → no load** — clicking Cancel dismisses the dialog; `boardStore.load` is still not called.
3. **Import anyway → load** — clicking "Import anyway" calls `boardStore.load` with the parsed board exactly once, and the dialog is gone.

### Approach

- `vi.mock('./file-io', async (importActual) => ...)` keeps `decideImport` real (spreading the actual module) but replaces `openBoardFile` with a `vi.fn()`.
- `vi.mocked(fileIo.openBoardFile).mockResolvedValueOnce(...)` returns `{ board: sampleBoard, meta: {}, warnings: [{ severity: 'dropped', ... }] }`.
- `sampleBoard` is obtained via `parseBrd(sampleBrd)` (same approach as `use-settled-board.test.ts`).
- `vi.spyOn(boardStore.getState(), 'load')` tracks whether the board was actually loaded.
- The hidden `<input type="file">` is queried via `document.querySelector('input[type="file"]')` and triggered with `fireEvent.change`.

## Test Command and Results

```
pnpm --filter @openshaper/web test --reporter=verbose
```

Result: PASS — 77 tests across 13 test files, 0 failures.

New test file summary:

```
✓ src/App.import-gate.test.tsx (3 tests) 1811ms
  ✓ App import gate (dropped warning) > shows the ImportWarningsDialog and does NOT load when there is a dropped warning 663ms
  ✓ App import gate (dropped warning) > Cancel dismisses the dialog without loading 729ms
  ✓ App import gate (dropped warning) > "Import anyway" calls boardStore.load 417ms
```

All other test files also passed (74 pre-existing tests unchanged).

Typecheck: `pnpm --filter @openshaper/web typecheck` → PASS, no errors.
