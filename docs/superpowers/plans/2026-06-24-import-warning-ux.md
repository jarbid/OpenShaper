# Import-warning UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface importer repairs to the user — a blocking modal (Import anyway / Cancel) when a file import drops geometry, a dismissible banner for non-destructive repairs, and silence when the file is clean.

**Architecture:** Readers in `packages/io` already collect repair notes in a `warnings` array; we make those notes structured (`ImportWarning { severity: 'dropped' | 'info', message }`). `apps/web` reads the warnings after parsing (board parsed but not yet loaded), decides via a pure `decideImport` helper, and either shows a confirmation modal, loads + shows a notice banner, or loads silently.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax` — use `import type` for type-only imports), React, Vitest. UI primitives from `@openshaper/ui` (`Panel`, `PanelHeader`, `PanelTitle`, `PanelBody`, `Button`, `Toast`).

## Global Constraints

- TypeScript strict; `import type` for type-only imports (`verbatimModuleSyntax`).
- `packages/io` may import only `@openshaper/kernel` — no React/DOM. The new types live in `packages/io` and are pure.
- Tests colocated as `*.test.ts(x)`, run by Vitest.
- Run package tests with `pnpm --filter @openshaper/io test` and `pnpm --filter @openshaper/web test`; typecheck with `pnpm typecheck`.
- Work on the existing branch `feat/import-s3dx-encrypted-brd`. Commit after each task.
- Spec: `docs/superpowers/specs/2026-06-24-import-warning-ux-design.md`.

---

## File structure

- Create `packages/io/src/import-warning.ts` — the `ImportWarning` type (pure).
- Modify `packages/io/src/s3d-reader.ts` — `ParsedS3d.warnings` → `ImportWarning[]`; tag pushes.
- Modify `packages/io/src/brd-reader.ts` — `ParsedBrd.warnings` → `ImportWarning[]`; tag pushes.
- Modify `packages/io/src/index.ts` — export the type.
- Modify `apps/web/src/file-io.ts` — `openBoardFile` forwards warnings; add pure `decideImport`.
- Create `apps/web/src/ImportWarningsDialog.tsx` — confirmation modal.
- Modify `apps/web/src/App.tsx` — wire decision → modal / notice / silent load for `onOpenFile` + `onOpenGhost`.
- Tests: update existing reader tests to read `.message`; add `decideImport` and `ImportWarningsDialog` tests.

Note: `ParsedSrf` has no `warnings` field and SRF emits no repairs — leave it unchanged; its `openBoardFile` entry returns `warnings: []`.

---

## Task 1: Structured ImportWarning + Shape3d readers

**Files:**

- Create: `packages/io/src/import-warning.ts`
- Modify: `packages/io/src/s3d-reader.ts`
- Modify: `packages/io/src/index.ts`
- Test: `packages/io/src/s3d-reader.test.ts`, `packages/io/src/s3dx-reader.test.ts`

**Interfaces:**

- Produces: `ImportWarning { readonly severity: 'dropped' | 'info'; readonly message: string }`, `ImportWarningSeverity`. `ParsedS3d.warnings: ImportWarning[]` (and `ParsedS3dx` alias). The degenerate-cross-section drop is the only `'dropped'` entry; all others `'info'`.

- [ ] **Step 1: Create the type**

Create `packages/io/src/import-warning.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A non-fatal note emitted by a file reader when it repairs an imported board.
 * `severity` lets the UI decide how loud to be:
 *   - 'dropped' — geometry was REMOVED (data-loss). The UI confirms before load.
 *   - 'info'    — a non-destructive repair (fallback, synthesized/derived data,
 *                 clamp). The UI shows a dismissible notice.
 */
export type ImportWarningSeverity = 'dropped' | 'info';

export interface ImportWarning {
  readonly severity: ImportWarningSeverity;
  readonly message: string;
}
```

- [ ] **Step 2: Update the Shape3d tests to expect structured warnings (failing)**

In `packages/io/src/s3d-reader.test.ts`, the deck-warning assertion currently reads the string directly. Change it to read `.message`:

```ts
// was: expect(result.warnings.some((w) => /deck/i.test(w))).toBe(true);
expect(result.warnings.some((w) => /deck/i.test(w.message))).toBe(true);
```

In `packages/io/src/s3dx-reader.test.ts`, update the two string-matching assertions and strengthen the degenerate one to check severity:

```ts
// fallback warning (was /falling back/.test(w)):
expect(warnings.some((w) => /falling back/.test(w.message))).toBe(true);

// degenerate-section warning (was /degenerate cross-section/.test(w)):
expect(
  warnings.some((w) => w.severity === 'dropped' && /degenerate cross-section/.test(w.message)),
).toBe(true);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @openshaper/io test -- s3d`
Expected: FAIL — TypeScript/runtime error because `w` is a `string` (no `.message`/`.severity`).

- [ ] **Step 4: Make `s3d-reader.ts` emit `ImportWarning`**

In `packages/io/src/s3d-reader.ts`:

1. Add the import near the other `@openshaper/kernel` import:

```ts
import type { ImportWarning } from './import-warning';
```

2. Change the `ParsedS3d.warnings` field type:

```ts
  /** Non-fatal issues (e.g. missing Deck — synthetic curve generated). */
  readonly warnings: ImportWarning[];
```

3. Change the local accumulator:

```ts
const warnings: ImportWarning[] = [];
```

4. Wrap every existing `warnings.push('…')` / `warnings.push(\`…\`)`in this file as an`'info'` entry, e.g.:

```ts
warnings.push({
  severity: 'info',
  message:
    `No <${opts.outlineTag}> (apex outline) element — falling back to ` +
    `<${opts.outlineFallbackTag}>; outline width may be slightly narrower than nominal`,
});
```

Apply the same `{ severity: 'info', message: <original string> }` wrapping to ALL the other pushes (synthetic deck, `<${tag}> has no <Bezier3d> — skipped`, missing Control_points/Polygone3d, fewer than 2 Point3d, non-finite position, no knots).

5. The ONE exception — the degenerate-section drop — uses `'dropped'`:

```ts
if (sectionKnots.length < 3) {
  warnings.push({
    severity: 'dropped',
    message:
      `Cross-section at ${pos.toFixed(1)} cm has only ${sectionKnots.length} control point(s) — ` +
      'too few to form a valid profile, so it was removed.',
  });
  continue;
}
```

- [ ] **Step 5: Export the type from the io barrel**

In `packages/io/src/index.ts` add:

```ts
export type { ImportWarning, ImportWarningSeverity } from './import-warning';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @openshaper/io test -- s3d`
Expected: PASS (all s3d + s3dx tests).

- [ ] **Step 7: Commit**

```bash
git add packages/io/src/import-warning.ts packages/io/src/s3d-reader.ts packages/io/src/index.ts packages/io/src/s3d-reader.test.ts packages/io/src/s3dx-reader.test.ts
git commit -m "feat(io): structured ImportWarning for Shape3d readers"
```

---

## Task 2: Structured warnings in the .brd reader

**Files:**

- Modify: `packages/io/src/brd-reader.ts`
- Test: `packages/io/src/brd-reader.test.ts`

**Interfaces:**

- Consumes: `ImportWarning` from Task 1.
- Produces: `ParsedBrd.warnings: ImportWarning[]` (all entries `'info'` — the `.brd` reader removes nothing).

- [ ] **Step 1: Update the .brd test to read `.message` (failing)**

In `packages/io/src/brd-reader.test.ts`, the truncated-group assertion:

```ts
// was: expect(parsed.warnings.some((w) => /missing its closing|truncated/i.test(w))).toBe(true);
expect(parsed.warnings.some((w) => /missing its closing|truncated/i.test(w.message))).toBe(true);
```

The two `toEqual([])` assertions for funboard/longboard stay as-is (an empty array still equals `[]`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @openshaper/io test -- brd-reader`
Expected: FAIL — `w` is a string, no `.message`.

- [ ] **Step 3: Make `brd-reader.ts` emit `ImportWarning`**

In `packages/io/src/brd-reader.ts`:

1. Add the import beside the existing `legacy-crypto` import:

```ts
import type { ImportWarning } from './import-warning';
```

2. Change `ParsedBrd.warnings`:

```ts
  /** Non-fatal issues encountered (e.g. truncated trailing group). */
  readonly warnings: ImportWarning[];
```

3. Change the three helper signatures that thread the array — `readControlPoints`, `parseSpline`, `parseCrossSections` — replacing `warnings: string[]` with `warnings: ImportWarning[]`, and the local `const warnings: string[] = []` in `parseBrd` to `const warnings: ImportWarning[] = []`.

4. Wrap each `warnings.push('…')` in this file as `{ severity: 'info', message: <original string> }`, e.g.:

```ts
warnings.push({
  severity: 'info',
  message: `gps block near line ${cur.i + 1} not closed by ')'`,
});
```

(Do the same for the `cross-section at position … not closed` and the truncated `p35` group messages.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @openshaper/io test -- brd`
Expected: PASS. Also run `pnpm --filter @openshaper/io test` — all 86 io tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/io/src/brd-reader.ts packages/io/src/brd-reader.test.ts
git commit -m "feat(io): structured ImportWarning for .brd reader"
```

---

## Task 3: openBoardFile forwards warnings + pure decideImport

**Files:**

- Modify: `apps/web/src/file-io.ts`
- Test: `apps/web/src/file-io.test.ts` (create)

**Interfaces:**

- Consumes: `ImportWarning`, `parseBrdFile`, `parseS3d`, `parseS3dx`, `parseSrf`, `readBoardJson` from `@openshaper/io`.
- Produces:
  - `openBoardFile(file): Promise<{ board: BezierBoard; meta: BoardMeta; warnings: readonly ImportWarning[] }>`
  - `decideImport(warnings): { action: 'confirm' | 'load'; dropped: ImportWarning[]; info: ImportWarning[] }`

- [ ] **Step 1: Write the failing test for `decideImport`**

Create `apps/web/src/file-io.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideImport } from './file-io';
import type { ImportWarning } from '@openshaper/io';

const info: ImportWarning = { severity: 'info', message: 'fell back' };
const dropped: ImportWarning = { severity: 'dropped', message: 'removed a section' };

describe('decideImport', () => {
  it('loads silently when there are no warnings', () => {
    expect(decideImport([])).toEqual({ action: 'load', dropped: [], info: [] });
  });

  it('loads (no confirm) when warnings are only informational', () => {
    const d = decideImport([info]);
    expect(d.action).toBe('load');
    expect(d.info).toEqual([info]);
    expect(d.dropped).toEqual([]);
  });

  it('requires confirmation when anything was dropped', () => {
    const d = decideImport([info, dropped]);
    expect(d.action).toBe('confirm');
    expect(d.dropped).toEqual([dropped]);
    expect(d.info).toEqual([info]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @openshaper/web test -- file-io`
Expected: FAIL — `decideImport` is not exported.

- [ ] **Step 3: Implement `decideImport` and thread warnings through `openBoardFile`**

In `apps/web/src/file-io.ts`:

1. Add `type ImportWarning` to the `@openshaper/io` import.

2. Change `BoardFileReader` and every entry to also return `warnings`:

```ts
type BoardFileReader = (
  file: File,
) => Promise<{ board: BezierBoard; meta: BoardMeta; warnings: readonly ImportWarning[] }>;

const BOARD_FILE_READERS: Record<string, BoardFileReader> = {
  '.brd': async (file) => {
    const { board, warnings } = parseBrdFile(new Uint8Array(await file.arrayBuffer()));
    return { board, meta: {}, warnings };
  },
  '.s3d': async (file) => {
    const { board: b, metadata, warnings } = parseS3d(await file.text());
    return {
      board: b,
      meta: { model: metadata?.model, designer: metadata?.designer, comments: metadata?.comments },
      warnings,
    };
  },
  '.s3dx': async (file) => {
    const { board: b, metadata, warnings } = parseS3dx(await file.text());
    return {
      board: b,
      meta: { model: metadata?.model, designer: metadata?.designer, comments: metadata?.comments },
      warnings,
    };
  },
  '.srf': async (file) => {
    const result = parseSrf(await file.arrayBuffer());
    return {
      board: result.board,
      meta: { model: result.model, comments: result.comments },
      warnings: [],
    };
  },
};
```

3. Update `readBoardJsonFile` and `openBoardFile` return shapes:

```ts
const readBoardJsonFile: BoardFileReader = async (file) => {
  const { board, metadata } = readBoardJson(await file.text());
  return { board, meta: (metadata as BoardMeta) ?? {}, warnings: [] };
};

export async function openBoardFile(
  file: File,
): Promise<{ board: BezierBoard; meta: BoardMeta; warnings: readonly ImportWarning[] }> {
  const name = file.name.toLowerCase();
  const ext = Object.keys(BOARD_FILE_READERS).find((e) => name.endsWith(e));
  return ext ? BOARD_FILE_READERS[ext]!(file) : readBoardJsonFile(file);
}
```

4. Add the pure decision helper:

```ts
export interface ImportDecision {
  /** 'confirm' → show the blocking dialog first; 'load' → load now. */
  readonly action: 'confirm' | 'load';
  readonly dropped: ImportWarning[];
  readonly info: ImportWarning[];
}

/** Classify import warnings into a load decision (pure). */
export function decideImport(warnings: readonly ImportWarning[]): ImportDecision {
  const dropped = warnings.filter((w) => w.severity === 'dropped');
  const info = warnings.filter((w) => w.severity === 'info');
  return { action: dropped.length > 0 ? 'confirm' : 'load', dropped, info };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @openshaper/web test -- file-io`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/file-io.ts apps/web/src/file-io.test.ts
git commit -m "feat(web): openBoardFile forwards import warnings + decideImport"
```

---

## Task 4: ImportWarningsDialog component

**Files:**

- Create: `apps/web/src/ImportWarningsDialog.tsx`
- Test: `apps/web/src/ImportWarningsDialog.test.tsx`

**Interfaces:**

- Consumes: `ImportWarning` from `@openshaper/io`; `Panel`, `PanelHeader`, `PanelTitle`, `PanelBody`, `Button` from `@openshaper/ui`.
- Produces: `ImportWarningsDialog({ fileName, dropped, info, onImportAnyway, onCancel })` — modal listing `dropped` items first (emphasized) then `info`, with Cancel / Import anyway.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/ImportWarningsDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportWarningsDialog } from './ImportWarningsDialog';

const dropped = [{ severity: 'dropped' as const, message: 'removed a flat section at 113.9 cm' }];
const info = [{ severity: 'info' as const, message: 'outline fell back to Top1' }];

describe('<ImportWarningsDialog />', () => {
  it('lists dropped and info messages', () => {
    render(
      <ImportWarningsDialog
        fileName="Go fish.s3dx"
        dropped={dropped}
        info={info}
        onImportAnyway={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/removed a flat section/)).toBeTruthy();
    expect(screen.getByText(/fell back to Top1/)).toBeTruthy();
    expect(screen.getByText(/Go fish\.s3dx/)).toBeTruthy();
  });

  it('wires both buttons', () => {
    const onImportAnyway = vi.fn();
    const onCancel = vi.fn();
    render(
      <ImportWarningsDialog
        fileName="x.s3dx"
        dropped={dropped}
        info={[]}
        onImportAnyway={onImportAnyway}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /import anyway/i }));
    expect(onImportAnyway).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @openshaper/web test -- ImportWarningsDialog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/ImportWarningsDialog.tsx`:

```tsx
/**
 * Blocking confirmation shown when importing a file required REMOVING geometry
 * (a dropped cross-section). Lists what changed and lets the user proceed or
 * cancel (cancel = nothing loads, so they can fix the source in Shape3d).
 * Modeled on the SettingsDialog backdrop + Panel pattern.
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import type { ImportWarning } from '@openshaper/io';

export interface ImportWarningsDialogProps {
  fileName: string;
  /** Data-loss warnings (≥1 — that's why the dialog is shown). */
  dropped: ImportWarning[];
  /** Non-destructive notes shown for context. */
  info: ImportWarning[];
  onImportAnyway: () => void;
  onCancel: () => void;
}

export function ImportWarningsDialog({
  fileName,
  dropped,
  info,
  onImportAnyway,
  onCancel,
}: ImportWarningsDialogProps) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onCancel}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader>
          <PanelTitle>Import will change “{fileName}”</PanelTitle>
        </PanelHeader>

        <PanelBody className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This file can’t be imported as-is. The following will be changed — review before
            continuing, or cancel and fix the file in Shape3d.
          </p>

          <ul className="space-y-1">
            {dropped.map((w, i) => (
              <li key={`d${i}`} className="text-card-foreground">
                <span className="font-semibold text-[var(--primary)]">Removed: </span>
                {w.message}
              </li>
            ))}
            {info.map((w, i) => (
              <li key={`i${i}`} className="text-muted-foreground">
                {w.message}
              </li>
            ))}
          </ul>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onImportAnyway}>Import anyway</Button>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @openshaper/web test -- ImportWarningsDialog`
Expected: PASS. If `Button` has no default accessible name matching, confirm it renders its children as text (it does — children become the button label).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ImportWarningsDialog.tsx apps/web/src/ImportWarningsDialog.test.tsx
git commit -m "feat(web): ImportWarningsDialog confirmation modal"
```

---

## Task 5: Wire decision into Open… / Open ghost… + notice banner

**Files:**

- Modify: `apps/web/src/App.tsx`
- Test: manual (existing `App.test.tsx` smoke test must still pass — it loads the bundled sample, which has no warnings, so it loads silently).

**Interfaces:**

- Consumes: `openBoardFile`, `decideImport` (Task 3); `ImportWarningsDialog` (Task 4); `ImportWarning` from `@openshaper/io`; existing `Toast` from `@openshaper/ui`.

- [ ] **Step 1: Add state + imports**

In `apps/web/src/App.tsx`:

1. Add imports:

```ts
import { ImportWarningsDialog } from './ImportWarningsDialog';
import { openBoardFile, decideImport /* …existing… */ } from './file-io';
import type { ImportWarning } from '@openshaper/io';
```

2. Near the other `useState` hooks (beside `toast`), add:

```ts
// Info-only repairs: a persistent dismissible notice (not the 6s error toast).
const [importNotice, setImportNotice] = useState<ImportWarning[] | null>(null);
// Pending data-loss import awaiting user confirmation.
const [pendingImport, setPendingImport] = useState<{
  fileName: string;
  dropped: ImportWarning[];
  info: ImportWarning[];
  commit: () => void;
} | null>(null);
```

- [ ] **Step 2: Add a shared "apply decision" helper inside the component**

Add this helper (above `onOpenFile`):

```ts
/**
 * Given a parsed import's warnings + the action that actually loads it, either
 * load immediately (showing an info notice if any), or stage a confirmation
 * when geometry was dropped.
 */
const applyImport = (fileName: string, warnings: readonly ImportWarning[], commit: () => void) => {
  const { action, dropped, info } = decideImport(warnings);
  if (action === 'confirm') {
    setPendingImport({ fileName, dropped, info, commit });
    return;
  }
  commit();
  setImportNotice(info.length > 0 ? info : null);
};
```

- [ ] **Step 3: Route `onOpenFile` through `applyImport`**

Replace the body of the `try` in `onOpenFile` so it parses, builds a `commit` closure, and defers the load decision:

```ts
const { board, meta, warnings } = await openBoardFile(file);
const commit = () => {
  boardStore.getState().load(board);
  setMeta(meta);
  const baseName = file.name.replace(/\.(board\.json|json|brd|s3dx|s3d|srf)$/i, '');
  const metadata =
    meta && Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined;
  recordRecentBoard(baseName, writeBoardJson(board, metadata));
  setRecentBoards(getRecentBoards());
};
applyImport(file.name, warnings, commit);
```

- [ ] **Step 4: Route `onOpenGhost` through `applyImport`**

Replace the `try` body in `onOpenGhost`:

```ts
const { board, warnings } = await openBoardFile(file);
applyImport(file.name, warnings, () => setGhost(board));
```

- [ ] **Step 5: Render the dialog and the notice banner**

Near the existing `{toast && <Toast …>}` line, add:

```tsx
{
  pendingImport && (
    <ImportWarningsDialog
      fileName={pendingImport.fileName}
      dropped={pendingImport.dropped}
      info={pendingImport.info}
      onCancel={() => setPendingImport(null)}
      onImportAnyway={() => {
        pendingImport.commit();
        setImportNotice(pendingImport.info.length > 0 ? pendingImport.info : null);
        setPendingImport(null);
      }}
    />
  );
}
{
  importNotice && (
    <Toast onClick={() => setImportNotice(null)}>
      <span className="font-medium">Imported with changes:</span>{' '}
      {importNotice.map((w) => w.message).join(' · ')}
    </Toast>
  );
}
```

- [ ] **Step 6: Typecheck + run web tests**

Run: `pnpm --filter @openshaper/web typecheck && pnpm --filter @openshaper/web test`
Expected: PASS (App smoke test still loads the bundled sample silently — no warnings).

- [ ] **Step 7: Manual verification (dev server)**

Run: `pnpm dev`, then File → Open…:

- `Go fish.s3dx` → confirmation modal listing the removed mid-board section; **Cancel** leaves the current board untouched; reopening and **Import anyway** loads it and shows the "Imported with changes" notice.
- `5.10 … MLC ….s3dx` → no modal; loads with the "Imported with changes" notice (outline fallback).
- `MASTER TRUSTHER ….s3dx` → loads silently, no modal, no notice.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): confirm on data-loss import, notice on non-destructive repairs"
```

---

## Self-review

- **Spec coverage:** structured `ImportWarning` (Task 1/2) ✓; `openBoardFile` forwards warnings (Task 3) ✓; blocking modal on `dropped` with Import anyway / Cancel = nothing loads (Task 4/5) ✓; persistent dismissible notice for info-only (Task 5) ✓; applies to Open… + Open ghost… (Task 5) ✓; recents/templates untouched (no code needed — recents are pre-repaired `.board.json` → `[]`) ✓; no persisted changelog ✓; SRF unchanged ✓.
- **Type consistency:** `ImportWarning`/`ImportWarningSeverity` defined once (Task 1) and consumed by name everywhere; `decideImport` returns `{ action, dropped, info }` used verbatim in Task 5; `openBoardFile` return shape `{ board, meta, warnings }` consumed in Task 5.
- **Placeholder scan:** none — every step shows the actual code/commands.
