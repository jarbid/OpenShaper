---
description: Review an open PR — what's new, UI/UX gaps, and whether the code can be simpler (KISS). Read-only; writes a plan.
argument-hint: '[pr-number]'
---

Review an open pull request and answer three questions: **what's new**, **is this a gap in
our UI/UX**, and **can the code be simpler**.

This command is **read-only**. It ends with a written review and a plan. It does not edit
code, post to GitHub, commit, or push. If the user wants any of that, they will ask next.

## 1. Pick the PR

`$1` if given. Otherwise list the open PRs (`mcp__github__list_pull_requests`, state `open`)
and take the only one. If there is more than one, print the list and stop — never guess which
one was meant.

## 2. Read the diff locally, not through the API

```sh
git fetch origin pull/<N>/head:pr-<N>
git diff --stat main...pr-<N>
git diff main...pr-<N> -- <paths>
```

`pull_request_read` with `get_files` blows past the tool-result limit on any real PR (66k
characters for a 24-file one), and the `pull/<N>/head` ref works even when the PR's head lives
on a fork — which contributor PRs here do. Fetch the ref; read the diff in slices.

Then read the PR body for the author's own account of the change, and `git log main..pr-<N>`
for how it was built.

## 3. Ground the review before judging it

Read `AGENTS.md` and `.claude/CLAUDE.md`, plus `apps/web/CLAUDE.md` when the diff touches
`apps/web`. Label every finding as one of two kinds and never blur them:

- **Rule** — it violates something this repo has written down. Cite the file that says so.
- **Taste** — your judgement. Say so, and say why it is worth the author's time anyway.

The written rules with teeth:

- **Layering.** `kernel`, `io`, `units` import no React, no DOM, no Three.js. The kernel is
  pure, immutable, side-effect-free; no `getInstance()` singletons; state lives in `store`.
- **Golden-pinned geometry.** Kernel changes match `docs/specs/golden/` within a stated
  tolerance. A tolerance is never loosened to make a change pass; a deliberate divergence is
  recorded in `docs/specs/divergences.md`.
- **Edits are pure functions** in `packages/store/src/edits.ts`, landed through
  `commit(next, label)` so undo works — not command classes, not direct mutation.
- **Display units** (`apps/web/CLAUDE.md`). No literal `mm`/`cm`/`in` in JSX, no `.toFixed()`
  on a raw cm value. Use the `apps/web/src/format.ts` helpers; a new component that shows or
  edits a length takes a `units: LengthUnit` prop. Volume is always litres.
- **Shortcuts are data.** Chords are defined once in `apps/web/src/shortcuts.ts` — never in
  the key handler, never re-typed into a tooltip or the docs page.
- **Features are documented.** A new fin setup, export format, template or shortcut needs an
  entry in `apps/web/src/docs/registry.ts` _and_ a real section on the page it names.
  `coverage.test.ts` only proves the entry exists; you check whether the prose is true.
- **No blocking UI.** Heavy compute goes to a worker (`apps/web/src/use-specs-worker.ts` is
  the pattern); the render layer updates incrementally.
- **All client-side.** No accounts, no backend, no paywall, ever.
- **Style.** Strict TS, ESM, `import type`, 100 columns, colocated `*.test.ts(x)`.

## 4. Answer the three questions, in these sections

### `## What's new`

The change in a shaper's terms, not the diff's. What can someone do after this PR that they
could not before, and how do they get to it? Walking the files one by one is a failed answer.
Call out anything real in the diff that the PR body does not mention.

### `## UI/UX gap`

Both directions, and say which:

- **Does it fill one?** Was this genuinely missing from the editor, and does the new surface
  area earn its place — or does it duplicate a path that already exists?
- **Does it open one?** Check: consistency with how the editor already behaves;
  discoverability (would anyone find this without reading the diff?); a keyboard path, defined
  in `shortcuts.ts`; a `/docs` entry whose prose is actually accurate; display-unit
  conventions; and the edges — empty selection, first and last point, undo/redo, switching
  units mid-edit.

### `## KISS`

Name the simpler thing that should exist instead. Look for: an abstraction with one caller;
state that could be derived; a helper that duplicates something already in `packages/kernel`,
`packages/store/src/edits.ts`, `packages/render2d`, or `apps/web/src/format.ts` — grep before
calling anything new; a special case that falls out of the general one; naming that hides what
the code does. Each finding names a file, a line, and the smaller alternative.

## 5. Keep the review itself simple

- Rank by consequence, not by how easy it was to spot. A shipped UX gap outranks a nit.
- At most seven findings. If there are genuinely more, _that_ is the finding.
- No finding without a concrete alternative. "This could be cleaner" is not a review.
- An empty section is a real answer. "No UI/UX gap found" beats padding.
- Do not restate the PR description back as analysis.
- Judge the diff as written, not what the author might have meant.

## 6. Finish

Write the review to a plan file, list what you did **not** verify (tests you did not run, the
app you did not launch), and stop.
