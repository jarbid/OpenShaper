# Editor Menubar + Cross-Section Header Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the editor's flat top toolbar with a real dropdown menubar + a view-tab row, and move the cross-section management controls (`‹ 1/5 ›`, Add/Delete/Copy/Paste) out of the toolbar into the cross-section pane header (both quad view and the standalone view).

**Architecture:** Add a small dependency-free `Menu`/`MenuBar` primitive to `packages/ui`. Add a presentational `CrossSectionControls` icon cluster to `apps/web` and slot it into `EditorPane` via a new optional `headerActions` prop. Rebuild the top bar in `App.tsx` from data-driven menu arrays; delete the inline cross-section block.

**Tech Stack:** React 18, TypeScript (strict, `verbatimModuleSyntax`), Tailwind v4 (shadcn-style tokens), `lucide-react` icons, Vitest. No Radix, no DOM test harness (`@testing-library`/jsdom absent) — interactive shell is verified via typecheck + build + manual run.

---

## File Structure

| File                                    | Responsibility                                                      | Created/Modified |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------- |
| `packages/ui/src/components/menu.tsx`   | Generic `MenuBar` + `Menu` dropdown; board-agnostic                 | Create           |
| `packages/ui/src/index.ts`              | Export `MenuBar`, `Menu`, `MenuItem`                                | Modify           |
| `apps/web/src/CrossSectionControls.tsx` | Presentational icon cluster (pure props)                            | Create           |
| `apps/web/src/view-toolkit.tsx`         | `EditorPane` gains `headerActions` slot                             | Modify           |
| `apps/web/src/App.tsx`                  | Build menu arrays + CS control element; replace top bar; wire panes | Modify           |

---

### Task 1: `Menu` / `MenuBar` primitive in `packages/ui`

**Files:**

- Create: `packages/ui/src/components/menu.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Create the menu component**

Create `packages/ui/src/components/menu.tsx` with exactly this content:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

/** One row in a dropdown menu. `checkbox` is also used for radio-style groups. */
export type MenuItem =
  | { kind: 'action'; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
  | { kind: 'checkbox'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

interface MenuBarCtx {
  openId: string | null;
  open: (id: string | null) => void;
}
const MenuBarContext = createContext<MenuBarCtx | null>(null);

/** Application menubar: keeps at most one child `Menu` open; Escape / outside-click close. */
export function MenuBar({ className, children }: { className?: string; children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openId === null) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  return (
    <MenuBarContext.Provider value={{ openId, open: setOpenId }}>
      <div ref={ref} role="menubar" className={cn('flex items-center gap-0.5', className)}>
        {children}
      </div>
    </MenuBarContext.Provider>
  );
}

/** A single labeled dropdown in the menubar, rendered from a flat `items` list. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const ctx = useContext(MenuBarContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = ctx?.openId === id;

  // Move focus to the first enabled item when the menu opens (keyboard users).
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    btns[(next + btns.length) % btns.length]?.focus();
  };

  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => ctx?.open(open ? null : id)}
        onPointerEnter={() => ctx && ctx.openId !== null && ctx.open(id)}
        className={cn(
          'h-8 rounded-md px-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground',
          open && 'bg-accent text-accent-foreground',
        )}
      >
        {label}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          onKeyDown={onKeyDown}
          className="absolute left-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
        >
          {items.map((item, idx) => {
            if (item.kind === 'separator')
              return <div key={idx} role="separator" className="my-1 h-px bg-border" />;
            if (item.kind === 'label')
              return (
                <div
                  key={idx}
                  className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {item.label}
                </div>
              );
            const isCheckbox = item.kind === 'checkbox';
            return (
              <button
                key={idx}
                type="button"
                role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={isCheckbox ? item.checked : undefined}
                disabled={item.kind === 'action' && item.disabled}
                onClick={() => {
                  item.onSelect();
                  ctx?.open(null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex w-4 shrink-0 justify-center">
                  {isCheckbox && item.checked && <Check className="size-3.5" />}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.kind === 'action' && item.shortcut && (
                  <span className="text-xs text-muted-foreground">{item.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Export from the package index**

In `packages/ui/src/index.ts`, add after the `toolbar` export line:

```ts
export { MenuBar, Menu, type MenuItem } from './components/menu';
```

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @openshaper/ui typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/menu.tsx packages/ui/src/index.ts
git commit -m "feat(ui): add dependency-free MenuBar/Menu dropdown primitive"
```

---

### Task 2: `CrossSectionControls` icon cluster

**Files:**

- Create: `apps/web/src/CrossSectionControls.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/CrossSectionControls.tsx` with exactly this content:

```tsx
import { Button } from '@openshaper/ui';
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, Plus, Trash2 } from 'lucide-react';

export interface CrossSectionControlsProps {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onAdd: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
}

/**
 * Compact cross-section management cluster for the cross-section pane header (quad +
 * standalone). Icon buttons keep it small enough for the quad-view cell. Mirrors the
 * legacy BoardCAD-LE Cross-sections menu: navigate, add, delete, copy, paste.
 */
export function CrossSectionControls({
  index,
  total,
  onPrev,
  onNext,
  onAdd,
  onDelete,
  onCopy,
  onPaste,
  canPaste,
}: CrossSectionControlsProps) {
  const icon = 'h-7 w-7 p-0';
  return (
    <div className="flex items-center gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={index <= 1}
        onClick={onPrev}
        title="Previous cross-section ( [ )"
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-10 px-0.5 text-center text-xs tabular-nums text-muted-foreground">
        {index}/{total}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={index >= total}
        onClick={onNext}
        title="Next cross-section ( ] )"
      >
        <ChevronRight />
      </Button>
      <span className="mx-0.5 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        onClick={onAdd}
        title="Add a cross-section here"
      >
        <Plus />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={total <= 1}
        onClick={onDelete}
        title="Delete this cross-section"
      >
        <Trash2 />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        onClick={onCopy}
        title="Copy this cross-section"
      >
        <Copy />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={!canPaste}
        onClick={onPaste}
        title="Paste the copied cross-section shape here"
      >
        <ClipboardPaste />
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @openshaper/web typecheck`
Expected: PASS (component compiles; not yet imported, which is fine).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/CrossSectionControls.tsx
git commit -m "feat(web): add CrossSectionControls icon cluster for the x-sec header"
```

---

### Task 3: `EditorPane` gains a `headerActions` slot

**Files:**

- Modify: `apps/web/src/view-toolkit.tsx` (the `EditorPane` function, ~lines 244-290)

- [ ] **Step 1: Add the prop and render it in the header**

In `apps/web/src/view-toolkit.tsx`, replace the entire `EditorPane` function (from `export function EditorPane({` through its closing `}`) with:

```tsx
export function EditorPane({
  title,
  kind,
  csIndex,
  units,
  sectionMarkers,
  onPickSection,
  overlays,
  ghostSplines,
  background,
  headerActions,
}: {
  title: string;
  kind: EditorKind;
  csIndex: number;
  units: LengthUnit;
  sectionMarkers?: SectionMarker[];
  onPickSection?: (index: number) => void;
  overlays?: EditorOverlays;
  ghostSplines?: Spline[];
  background?: React.ComponentProps<typeof SplineEditor>['background'];
  headerActions?: React.ReactNode;
}) {
  // Stable across re-renders so the editor's target set (and the SplineEditor
  // re-fit/draw effects keyed on it) only changes when the pane actually changes.
  const p = useMemo(() => paneProps(kind, csIndex), [kind, csIndex]);
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader
        className={headerActions ? 'flex items-center justify-between gap-2' : undefined}
      >
        <PanelTitle>{title}</PanelTitle>
        {headerActions}
      </PanelHeader>
      <PanelBody className="min-h-0 flex-1 p-0">
        <SplineEditor
          key={p.key}
          store={boardStore}
          targets={p.targets}
          mirrorY={p.mirrorY}
          mirrorX={p.mirrorX}
          sectionMarkers={kind === 'outline' ? sectionMarkers : undefined}
          onPickSection={kind === 'outline' ? onPickSection : undefined}
          readout={makeReadout(kind, units)}
          overlays={overlays}
          ghostSplines={ghostSplines}
          background={kind === 'outline' ? background : undefined}
        />
      </PanelBody>
    </Panel>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @openshaper/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/view-toolkit.tsx
git commit -m "feat(web): give EditorPane an optional headerActions slot"
```

---

### Task 4: Rebuild the top bar in `App.tsx`

**Files:**

- Modify: `apps/web/src/App.tsx`

This task has several edits to one file. Do them in order.

- [ ] **Step 1: Update the `@openshaper/ui` import + add new imports**

In `apps/web/src/App.tsx`, replace the `@openshaper/ui` import block:

```tsx
import {
  Button,
  buttonVariants,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Toolbar,
  ToolbarSeparator,
} from '@openshaper/ui';
```

with:

```tsx
import {
  Button,
  buttonVariants,
  Menu,
  MenuBar,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  ToolbarSeparator,
  type MenuItem,
} from '@openshaper/ui';
```

Then add this import next to the other local component imports (e.g. just below the `import { Brandmark } from './components/marks';` line):

```tsx
import { CrossSectionControls } from './CrossSectionControls';
```

- [ ] **Step 2: Delete the now-unused `ExportButton` component**

In `apps/web/src/App.tsx`, delete the entire `ExportButton` function (the block starting `/** Export button — every format is free. */` and the `function ExportButton(...) { ... }` through its closing `}`). It is replaced by the File-menu export items.

- [ ] **Step 3: Typecheck to confirm the failing state**

Run: `pnpm --filter @openshaper/web typecheck`
Expected: FAIL — errors about `Toolbar` not imported (still used in JSX) and `ExportButton` not defined (still used in JSX). This confirms the next steps are needed.

- [ ] **Step 4: Build menu arrays + the cross-section control element**

In `apps/web/src/App.tsx`, find the line:

```tsx
const csTitle = `Cross-section ${clampedCs} / ${lastReal}`;
```

Replace that single line with the following block (the index now lives in the header control, so the title is static):

```tsx
const csTitle = 'Cross-section';

const csControls = (
  <CrossSectionControls
    index={clampedCs}
    total={lastReal}
    onPrev={() => setCsIndex(clampedCs - 1)}
    onNext={() => setCsIndex(clampedCs + 1)}
    onAdd={addSection}
    onDelete={deleteSection}
    onCopy={copySection}
    onPaste={pasteSection}
    canPaste={!!csClipboard}
  />
);

const interp = board?.interpolationType ?? 'controlPoint';

const fileMenu: MenuItem[] = [
  { kind: 'label', label: 'New' },
  ...BOARD_TEMPLATES.map((t) => ({
    kind: 'action' as const,
    label: t.name,
    onSelect: () => newFromTemplate(t.name),
  })),
  { kind: 'separator' },
  { kind: 'action', label: 'Open…', onSelect: () => fileInput.current?.click() },
  {
    kind: 'action',
    label: 'Save',
    shortcut: 'Ctrl S',
    disabled: !board,
    onSelect: () => board && downloadBoard(board, meta),
  },
  { kind: 'separator' },
  { kind: 'action', label: 'Load trace image…', onSelect: () => traceInput.current?.click() },
  { kind: 'separator' },
  { kind: 'label', label: 'Export' },
  ...(['stl', 'dxf', 'pdf'] as ExportFormat[]).map((f) => ({
    kind: 'action' as const,
    label: f.toUpperCase(),
    disabled: !board,
    onSelect: () => board && exportBoard(board as Parameters<typeof exportBoard>[0], f),
  })),
  { kind: 'action', label: 'Spec sheet…', disabled: !specs, onSelect: openSpecSheet },
];

const editMenu: MenuItem[] = [
  {
    kind: 'action',
    label: 'Undo',
    shortcut: 'Ctrl Z',
    disabled: !canUndo,
    onSelect: () => boardStore.getState().undo(),
  },
  {
    kind: 'action',
    label: 'Redo',
    shortcut: 'Ctrl Y',
    disabled: !canRedo,
    onSelect: () => boardStore.getState().redo(),
  },
];

const viewMenu: MenuItem[] = [
  { kind: 'label', label: 'Overlays' },
  {
    kind: 'checkbox',
    label: 'Curvature comb',
    checked: overlayToggles.comb,
    onSelect: () => setOverlayToggles((s) => ({ ...s, comb: !s.comb })),
  },
  {
    kind: 'checkbox',
    label: 'Center of mass',
    checked: overlayToggles.com,
    onSelect: () => setOverlayToggles((s) => ({ ...s, com: !s.com })),
  },
  {
    kind: 'checkbox',
    label: 'Volume distribution',
    checked: overlayToggles.dist,
    onSelect: () => setOverlayToggles((s) => ({ ...s, dist: !s.dist })),
  },
  { kind: 'separator' },
  { kind: 'label', label: 'Units' },
  ...LENGTH_UNITS.map((u) => ({
    kind: 'checkbox' as const,
    label: u.label,
    checked: unitKey === u.key,
    onSelect: () => setUnitKey(u.key),
  })),
];

const boardMenu: MenuItem[] = [
  ghost
    ? { kind: 'action', label: 'Clear ghost', onSelect: () => setGhost(null) }
    : { kind: 'action', label: 'Open ghost…', onSelect: () => ghostInput.current?.click() },
  { kind: 'separator' },
  { kind: 'label', label: 'Interpolation' },
  {
    kind: 'checkbox',
    label: 'Control point',
    checked: interp === 'controlPoint',
    onSelect: () => boardStore.getState().setInterpolationType('controlPoint'),
  },
  {
    kind: 'checkbox',
    label: 'S-blend',
    checked: interp === 'sLinear',
    onSelect: () => boardStore.getState().setInterpolationType('sLinear'),
  },
];

const helpMenu: MenuItem[] = [
  {
    kind: 'action',
    label: 'About & guides',
    onSelect: () => {
      window.location.href = '/about';
    },
  },
  ...(SUPPORT_URL
    ? [
        {
          kind: 'action' as const,
          label: 'Buy me a coffee',
          onSelect: () => window.open(SUPPORT_URL, '_blank', 'noopener'),
        },
      ]
    : []),
];
```

- [ ] **Step 5: Replace the `<Toolbar>…</Toolbar>` block with the two-row bar**

In `apps/web/src/App.tsx`, replace the entire `<Toolbar className="overflow-x-auto"> … </Toolbar>` element (it begins at `<Toolbar className="overflow-x-auto">` and ends at the matching `</Toolbar>`) with:

```tsx
<div className="flex flex-col border-b border-border bg-card text-card-foreground">
  {/* Row 1 — application menubar */}
  <div className="flex h-11 items-center gap-2 px-2">
    <a
      href="/"
      className="group flex items-center gap-2 px-1.5 font-semibold transition-colors hover:text-primary"
      title="OpenShaper home"
    >
      <Brandmark className="h-6 w-6 transition-transform duration-300 group-hover:rotate-3" />
      <span>
        Open<span className="text-primary">Shaper</span>
      </span>
    </a>
    <ToolbarSeparator />
    <MenuBar>
      <Menu label="File" items={fileMenu} />
      <Menu label="Edit" items={editMenu} />
      <Menu label="View" items={viewMenu} />
      <Menu label="Board" items={boardMenu} />
      <Menu label="Help" items={helpMenu} />
    </MenuBar>
    <div className="flex-1" />
    {SUPPORT_URL && (
      <a
        href={SUPPORT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} text-primary hover:text-primary`}
        title="Buy me a coffee — OpenShaper is free & open-source"
      >
        <CoffeeIcon className="size-4" />
        Coffee
      </a>
    )}
  </div>

  {/* Row 2 — view tabs */}
  <div className="flex h-11 items-center gap-1 border-t border-border px-2">
    {tab('quad', 'Quad')}
    {tab('outline', 'Outline')}
    {tab('rocker', 'Rocker')}
    {tab('crossSection', 'Cross-section')}
    {tab('3d', '3D')}
    <div className="flex-1" />
    <select
      value={unitKey}
      onChange={(e) => setUnitKey(e.target.value)}
      title="Display units"
      className="h-8 rounded-md border border-border bg-transparent px-2 text-sm"
    >
      {LENGTH_UNITS.map((u) => (
        <option key={u.key} value={u.key}>
          {u.label}
        </option>
      ))}
    </select>
  </div>

  {/* Hidden file inputs (the trace input lives in the Sidebar, sharing traceInput). */}
  <input
    ref={fileInput}
    type="file"
    accept=".board.json,.json,.brd"
    className="hidden"
    onChange={onOpenFile}
  />
  <input
    ref={ghostInput}
    type="file"
    accept=".board.json,.json,.brd"
    className="hidden"
    onChange={onOpenGhost}
  />
</div>
```

> Note: the old toolbar contained the `fileInput` and `ghostInput` hidden `<input>`s — they are re-added above. Do **not** add a `traceInput` `<input>` here; the Sidebar already renders one bound to the same `traceInput` ref, and duplicating it would break the ref.

- [ ] **Step 6: Pass `csControls` into the quad cross-section pane**

In the quad-view grid, find the cross-section `EditorPane` (the one with `kind="crossSection"`, `title={csTitle}`) and add the `headerActions` prop:

```tsx
<EditorPane
  title={csTitle}
  kind="crossSection"
  csIndex={clampedCs}
  units={units}
  overlays={overlaysFor('crossSection')}
  ghostSplines={ghostSplinesFor('crossSection')}
  headerActions={csControls}
/>
```

- [ ] **Step 7: Pass `csControls` into the standalone view pane**

Find the final single-pane `EditorPane` (the `else` branch that uses `kind={view}`) and add a conditional `headerActions` prop so it appears only for the cross-section view:

```tsx
<EditorPane
  title={view === 'outline' ? 'Outline' : view === 'rocker' ? 'Rocker (deck + bottom)' : csTitle}
  kind={view}
  csIndex={clampedCs}
  units={units}
  sectionMarkers={sectionMarkers}
  onPickSection={setCsIndex}
  overlays={overlaysFor(view)}
  ghostSplines={ghostSplinesFor(view)}
  background={traceBg}
  headerActions={view === 'crossSection' ? csControls : undefined}
/>
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @openshaper/web typecheck`
Expected: PASS — `Toolbar`/`ExportButton` no longer referenced; all menu wiring typed.

- [ ] **Step 9: Build the web app**

Run: `pnpm --filter @openshaper/web build`
Expected: build succeeds with no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): menubar top bar + move cross-section controls to pane header"
```

---

### Task 5: Full verification + manual run

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test + typecheck suite**

Run: `pnpm typecheck && pnpm test`
Expected: both PASS (kernel golden tests unaffected; no new tests required — the changes are presentational and there is no DOM test harness).

- [ ] **Step 2: Manual verification**

Run: `pnpm dev`, open the app, and confirm:

- The top bar shows two rows: **brand · File Edit View Board Help · Coffee**, then **Quad Outline Rocker Cross-section 3D · units**.
- Each menu opens on click and closes on: selecting an item, pressing `Escape`, and clicking outside. Hovering across triggers while one is open switches menus.
- **File:** templates create a new board; Open/Save/Load trace image/Export STL·DXF·PDF/Spec sheet all work; disabled items grey out when there is no board.
- **View:** the three overlay checkboxes mirror the sidebar **Analysis** panel (toggling one updates the other); Units items show a check on the active unit and change display units.
- **Board:** Open ghost…/Clear ghost toggles the ghost; Interpolation shows a check on the active mode and switches it.
- **Help:** About & guides navigates to `/about`; Buy me a coffee opens the support URL.
- In **Quad** view and the **Cross-section** view, the cross-section pane header shows `‹ n/total ›` + Add/Delete/Copy/Paste icons; they navigate/add/delete/copy/paste, with the same disabled states as before. The global bar no longer shows any cross-section controls.
- The `[` / `]` keyboard shortcuts still page cross-sections.

- [ ] **Step 3: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "fix(web): polish menubar/x-sec header per manual verification"
```

(Skip if nothing changed.)

---

## Self-Review Notes

- **Spec coverage:** Menubar (File/Edit/View/Board/Help) → Task 4; cross-section header cluster in quad + standalone → Tasks 2–4; `headerActions` slot → Task 3; menu primitive → Task 1; overlays/units/interpolation mirrored over shared state → Task 4 menu arrays; "no Move action" honored (only the six controls relocated). Coffee kept as a persistent button; About in Help — matches design.
- **No DOM tests:** consistent with the spec's testing note; verification is typecheck + build + manual run.
- **Type consistency:** `MenuItem` kinds (`action`/`checkbox`/`label`/`separator`) are identical in Task 1 and the Task 4 arrays; `CrossSectionControlsProps` field names match the Task 4 call site (`index`, `total`, `onPrev/onNext/onAdd/onDelete/onCopy/onPaste`, `canPaste`); `EditorPane`'s new `headerActions?: React.ReactNode` matches both call sites.
- **traceInput caveat** called out in Task 4 Step 5 to avoid a double-bound ref regression.
