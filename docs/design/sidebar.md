# The editor sidebar — tabs over an accordion

Status: **shipped**. Code: `apps/web/src/sidebar-sections.ts` (the data and the
reducers), `apps/web/src/Sidebar.tsx` (all the rendering),
`packages/ui/src/components/disclosure.tsx` (the collapsible primitive),
`apps/web/src/view-state.ts` (persistence).

## Problem

The sidebar was eleven panels in one `overflow-y-auto` column with nothing
collapsible. On a 1080p laptop about three were visible at a time, and which three
depended on where you last happened to scroll — so eight of eleven tools were below
the fold at all times. Tools were not discovered; they were stumbled upon. It was also
mounted permanently at 288px with no way to hide it, which is what
[#37](https://github.com/jarbid/OpenShaper/issues/37) asked about.

Collapsing the panels into an accordion made every tool _nameable_ without scrolling,
but only while they were all shut: the spec readout alone is nineteen rows, so opening
it filled the sidebar and pushed everything below it off-screen again. That traded
"scroll to find a tool" for "scroll past whichever tool is open".

## Shape

Four tabs down a permanent strip at the sidebar's edge. The tool list and the panel
content no longer compete for the same vertical space, so no open tool can displace the
list of tools. This is the **edge tab strip** / tool-window bar pattern —
[JetBrains tool windows](https://www.jetbrains.com/help/idea/tool-windows.html),
[Blender's sidebar tabs](https://developer.blender.org/docs/features/interface/human_interface_guidelines/sidebar_tabs/),
Visual Studio's auto-hide windows, Photoshop's collapsed docks.

```
┌────────┬────────────────────────┐
│ ▣ SPECS│ SPECS      📌 ⌃⌄  ›   │  ← pin · collapse-all · fold
│ ⤢ SHAPE│────────────────────────│
│ ⬚ BUILD│ ▶ NOSE      rocker 64 │
│ ◷ REF  │ ▼ OVERALL             │
│  1879  │    Length     1879.6  │
│  ×469  │    Volume      27.4 L │
│  ×59   │                        │
│  27.4L │                        │
├────────┴────────────────────────┤
│ ☕ Buy me a coffee              │
└─────────────────────────────────┘
  56px            256px
```

Three deliberate calls, each of which looked like a coin-flip and was not:

- **Captions are upright, not rotated.** Rotated labels are what Blender ships and what
  its own users have long asked it to stop shipping ([readable labels](https://devtalk.blender.org/t/optional-readable-labels-for-vertically-stacked-sidebar-categories/45657),
  [an icons PoC](https://devtalk.blender.org/t/ui-improvement-sidebar-icons-instead-of-text-labels-poc/12079)).
  The goal was tabs you can read at a glance; upright costs ~32px of width.
  The board's **readout** is the one thing that is rotated, because 56px cannot hold
  "1879.6 mm" upright — it truncated to "1879.6 m…" — while the strip has hundreds of
  pixels of spare height.
- **A view change never switches tabs.** The panel jumping from Build to Reference
  because you glanced at the outline would be the worst kind of surprise: the tab is the
  user's navigation, not the app's. The per-view rule only decides what starts open
  _inside_ a tab, and it never removes a section — switching view can shut a tool, never
  be the reason one cannot be found.
- **`pinnedTab` may equal `activeTab`.** Allowing that is what keeps pinning simple. An
  invariant that the two always differ forces an answer to "which tab becomes active
  when I pin the one I am in", and there is no good one. `shownTabs()` is the only place
  the two fields interact.

## Where to change things

| Want to…                                                            | Edit                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Add, remove, rename or reorder a **tab**                            | `SIDEBAR_TABS` in `sidebar-sections.ts`                           |
| Move a **tool** to another tab                                      | that section's `tab` in `SIDEBAR_SECTIONS`                        |
| Change which tools a **view** pre-opens                             | that section's `relevantTo`                                       |
| Change what starts open on a **first visit**                        | that section's `defaultOpen`, or `DEFAULT_SIDEBAR_STATE`          |
| Change a tab's **icon**                                             | `TAB_ICONS` in `Sidebar.tsx`                                      |
| Change the **strip width, tab height, panel width, pinned ceiling** | `SIZING` in `Sidebar.tsx`                                         |
| Change a shut section's **summary**                                 | the `summaries` map in `Sidebar.tsx`                              |
| Change the **spec bands** or their shut summaries                   | `SPEC_GROUPS` and `SpecsSection`                                  |
| Make the active tab **close on a second click**                     | `selectTab` — JetBrains does this; it was considered and left out |
| Open a tool from a **menu or palette command**                      | `revealSection`; Board ▸ Resize… in `App.tsx` is the example      |

Two constraints worth knowing before you tune anything:

- **`pointer-coarse:` variants are a floor, not a style.** 44px is the ergonomic minimum
  and `apps/web/e2e/tap-targets.spec.ts` enforces it. Shrink the fine-pointer size
  freely; leave the coarse one alone.
- **A shut section is unmounted, not hidden.** Several hold `useSyncExternalStore`
  subscriptions to the board store, and a hidden subtree keeps re-rendering on every drag
  of a control point. The cost is that transient local state inside a section does not
  survive a collapse.

## Persistence

`ViewState.sidebar` holds `{ collapsed, activeTab, pinnedTab, open[], touched[],
specGroups[] }` in the existing `bs.viewState` blob — **no version bump**, because every
field is optional and additive, so an older blob keeps its pane framing and camera pose
and simply picks up the default sidebar. Unknown tab, section or band ids are dropped
rather than trusted, and the filter re-imposes registry order, so a removed feature
cannot resurrect itself from a stale blob.

`touched` is the one subtle field: it records sections the user has opened or closed by
hand, which the per-view rule then never overrides again. It is persisted rather than
session-scoped on purpose — "I opened Fins, stop closing it" is a preference. The
consequence is that the automation decays as preferences accumulate, which is the right
shape for a default: it helps until you have an opinion, then gets out of the way.

## Testing

The reducers are pure and tested without React in `sidebar-sections.test.ts` — that is
why the tab table carries no icons. `Sidebar.test.tsx` drives the real wiring through
`<App />`. Two helpers exist because a tool is only in the DOM when its tab is active:
`openSection` in `src/test/sidebar.ts` (unit) and in `e2e/helpers.ts` (Playwright). Both
derive the owning tab from the registry, so moving a tool between tabs touches no spec.

Two regressions worth keeping tests for, both of which shipped once:

- The master collapse-all must mark its sections `touched`, or the next view change
  re-opens half of what was just collapsed and the button reads as broken.
- The support bar must sit outside every scroller. As the eleventh panel of a scroll it
  was, in practice, never on screen at all.

## Known limits

- **Clicking the active tab does nothing**; the chevron folds. JetBrains closes the panel
  on a second click and that would be a one-line change in `selectTab`.
- **One pinned tab.** A third panel leaves nothing readable in any of them.
- **No drag-to-reorder or tear-off**, and no keyboard shortcut to cycle tabs — the latter
  would need `shortcuts.ts`, `docs/registry.ts` and a `/docs/shortcuts` entry.
- **The analytics consent banner is fixed over the bottom of the page** and covers the
  support bar until it is answered. Pre-existing, not introduced here, but it is why the
  bar can look absent on a first visit.
