# Editor menu reorganization + cross-section header controls — design

**Date:** 2026-06-02
**Area:** `apps/web` editor shell, `packages/ui` design system, `apps/web` cross-section editor pane
**Status:** Approved design (pending user spec review)

## Problem

Two related rough edges in the editor chrome:

1. **The cross-section management controls live in the wrong place.** Add / Delete /
   Copy / Paste and the Prev/Next navigator sit in the global top toolbar and only
   appear when the active view is `quad` or `crossSection`. They are physically far
   from the cross-section window they act on, and they clutter the global toolbar with
   view-conditional buttons.

2. **The top toolbar is one flat, overcrowded row.** It crams the brand, five view
   tabs, the cross-section cluster, Undo/Redo, New/Open/Save/Ghost, three export
   buttons, Spec sheet, a units select, About, and Coffee into a single line with only
   ad-hoc separators. There is no grouping logic, and it overflows horizontally.

Legacy BoardCAD-LE organized the same surface as a classic menubar
(**File · Edit · View · Cross-sections · Board · Misc · Render · Help**). We want that
structure's clarity, modernized, while keeping OpenShaper's improvements (the sidebar
inspector replaces BoardCAD's modal Resize/Info/Fins/Weight dialogs, so those stay in
the sidebar — they are **not** pulled back into menus).

## Decisions (locked with the user)

- **Top toolbar → real menubar** (dropdowns) plus a second **view-tab row**.
- **Cross-section header gets the full cluster**: `‹ 1/5 ›` navigation **and** Add /
  Delete / Copy / Paste. The global toolbar shows **no** cross-section controls after
  this change. This applies to **both** the quad-view cross-section cell and the
  standalone Cross-section view.
- **No "Move" action.** Only the existing six controls are relocated (legacy parity for
  reposition is deferred).

## Design

### 1. New UI primitive: a dropdown menu (`packages/ui`)

There is no menu/popover primitive today and no Radix dependency. We add a small,
self-contained one (no new deps; `lucide-react` already present for the check glyph).

`packages/ui/src/components/menu.tsx` exports:

- **`MenuBar`** — a flex row (`role="menubar"`) that owns "which menu is open" so only
  one dropdown is open at a time, and clicking a sibling trigger switches to it.
- **`Menu`** — a trigger button (`role="menuitem"` w/ `aria-haspopup`/`aria-expanded`)
  plus an absolutely-positioned dropdown panel (`role="menu"`) that opens downward,
  left-aligned to the trigger. Because the bar is pinned to the top edge, no collision
  detection is needed.

It is **data-driven** via an `items` prop (a flat list — **no nested sub-flyouts**, to
keep positioning trivial). Item kinds:

```ts
type MenuItem =
  | { kind: 'action'; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
  | { kind: 'checkbox'; label: string; checked: boolean; onSelect: () => void } // also used for radio-style groups
  | { kind: 'label'; label: string } // non-interactive group caption
  | { kind: 'separator' };
```

Behavior: open on click; close on item select, `Escape`, or outside `pointerdown`
(global listener while open). Items are native `<button>`s, so Enter/Space activation is
free; `ArrowDown`/`ArrowUp` move focus within the open menu. Styling reuses existing
tokens (`bg-card`, `border-border`, `text-card-foreground`, hover `bg-accent`).

What would otherwise be sub-menus (board templates, export formats) render as a
**`label` caption + a group of `action` items** inside the parent menu — flat, no
flyouts.

Exported from `packages/ui/src/index.ts`.

> **Testing note:** the repo has no DOM test harness (`@testing-library/react` / jsdom
> are absent). This primitive is verified manually via the `run`/Playwright flow, not a
> component unit test. Any genuinely pure helper extracted during implementation gets a
> Vitest test; the interactive shell does not.

### 2. The editor top bar (`apps/web/src/App.tsx`)

Replace the single `<Toolbar>` with **two stacked rows**:

**Row 1 — menubar.** Brand link · `MenuBar` · spacer · Coffee button (kept as a
persistent CTA per the rebrand; not buried in a menu).

| Menu      | Items                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File**  | `New` (label) → one `action` per template; ─; `Open…`; `Save`; ─; `Load trace image…`; ─; `Export` (label) → STL / DXF / PDF; `Spec sheet…`                                                                       |
| **Edit**  | `Undo` (disabled when `!canUndo`); `Redo` (disabled when `!canRedo`)                                                                                                                                              |
| **View**  | `Overlays` (label) → Curvature comb / Center of mass / Volume distribution as **checkbox** items bound to `overlayToggles`; ─; `Units` (label) → each `LENGTH_UNITS` entry as a checkbox/radio bound to `unitKey` |
| **Board** | `Open ghost…` / `Clear ghost` (whichever applies); ─; `Interpolation` (label) → Control point / S-blend checkboxes bound to `board.interpolationType`                                                             |
| **Help**  | `About & guides` (→ `/about`); `Buy me a coffee` (→ `SUPPORT_URL`, when set)                                                                                                                                      |

The View-menu overlay toggles and the sidebar **Analysis** panel are two controls over
the **same** `overlayToggles` state in `AppShell` — a single source of truth, mirrored,
exactly as BoardCAD's View menu worked. The sidebar panels for Resize / Board info /
Fins / Weight / Control-point inspector stay put; that inspector model is the modern
replacement for BoardCAD's dialogs and is intentionally **not** duplicated into menus.

**Row 2 — view tabs.** The five `tab()` buttons (Quad / Outline / Rocker /
Cross-section / 3D), spacer, and the Units `<select>` on the right for quick access
(Units also appears in the View menu; same `unitKey` state).

The inline cross-section `<>…</>` block (App.tsx ~lines 398–447) is **deleted** from the
bar entirely.

### 3. Cross-section controls in the panel header

**`EditorPane` gains an optional `headerActions?: React.ReactNode`** prop
(`view-toolkit.tsx`), rendered right-aligned in `PanelHeader` (the header becomes
`flex items-center justify-between`, matching the existing 3D pane header pattern). When
absent, the header is unchanged.

**New `apps/web/src/CrossSectionControls.tsx`** — a compact, presentational cluster of
**icon buttons** (lucide: `ChevronLeft`, `ChevronRight`, `Plus`, `Trash2`, `Copy`,
`ClipboardPaste`) with the `n / total` index between the chevrons. Icons (not text) so
it fits the small quad-view cell as well as the large standalone view. Props are the
handlers/state already living in `AppShell`:

```ts
interface CrossSectionControlsProps {
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
```

Disabled states mirror today's toolbar (`index <= 1`, `index >= total`, `total <= 1`,
`!canPaste`). Each button keeps its `title` tooltip and existing keyboard-shortcut hint.

**Wiring in `App.tsx`:** build one `<CrossSectionControls …/>` element from the
existing `clampedCs`, `lastReal`, `setCsIndex`, `addSection`, `deleteSection`,
`copySection`, `pasteSection`, `csClipboard` values, and pass it as `headerActions` to
**both** cross-section `EditorPane`s (the quad cell and the full view). The pane title
shortens to `"Cross-section"` (the live index now lives in the control), so `csTitle` is
simplified accordingly.

## Components & boundaries

| Unit                          | Responsibility                                                   | Depends on              |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------- |
| `ui/menu.tsx`                 | Generic dropdown menubar; knows nothing about boards             | React, `cn`, lucide     |
| `CrossSectionControls.tsx`    | Presentational icon cluster; no store access                     | React, lucide           |
| `EditorPane` (`view-toolkit`) | Renders a pane; now slots `headerActions`                        | unchanged + new prop    |
| `AppShell` (`App.tsx`)        | Orchestrates state; builds menu `items` + the CS control element | store, ui, view-toolkit |

Each is understandable and changeable in isolation: `menu.tsx` is board-agnostic and
reusable; `CrossSectionControls` is pure props; `EditorPane`'s new prop is additive and
backward-compatible.

## Out of scope (YAGNI)

- Nested sub-menu flyouts (templates/exports are flat groups instead).
- A "Move/reposition cross-section" action.
- Moving Resize / Board info / Fins / Weight out of the sidebar.
- Keyboard mnemonics (`Alt+F` etc.) and full WAI-ARIA menu roving-tabindex beyond
  basic arrow/Escape support.
- Render/3D-specific menus (the 3D appearance controls already live in the pane header).

## Verification

- `pnpm typecheck` and `pnpm test` stay green (no kernel/golden changes).
- Manual run (`run` skill / Playwright): in **quad** and **Cross-section** views the
  header cluster adds/deletes/copies/pastes and navigates sections; the global bar no
  longer shows those controls; each menu opens/closes (click, Escape, outside-click),
  and checkbox items (overlays, units, interpolation) reflect and mutate state in sync
  with the sidebar.
