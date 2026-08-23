// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The mechanism that stops the event catalogue going quietly stale.
 *
 * Same spirit as `docs/coverage.test.ts` and `tools/precache-guard.ts`: an
 * invariant that fails the build rather than a convention someone has to
 * remember. It exists because the catalogue in `docs/design/analytics.md` had
 * already drifted — `export_board` was missing the `rail-bands` format it had
 * been sending for a release, and `spec_sheet_opened` sat in the table with an
 * empty reason.
 *
 * That drift is worse than an undocumented function. An event nobody wrote down
 * is an event nobody builds an insight on, so the feature it measures reads as
 * unused rather than unmeasured — and the catalogue is also the thing
 * `/privacy` is answerable against. If we cannot say what we send, we cannot
 * honestly tell a visitor what we send.
 *
 * Both directions are checked. An event fired but not listed is the common
 * failure; an event listed but no longer fired hides a rename, and would leave a
 * dashboard tile quietly reading zero forever.
 *
 * Its limit, stated plainly, is the same as the docs test's: it proves a row
 * *exists*, never that the properties beside it are complete or the reason
 * beside it is true.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = resolve(here, '../../../docs/design/analytics.md');

/** Every `.ts`/`.tsx` under `src`, tests excluded — a test's events are not real. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Event names passed to `track()` as string literals.
 *
 * Literals only, deliberately. A computed event name would defeat this check
 * silently, so the `trackedNames` test below asserts there are none rather than
 * letting one slip past as "zero matches".
 */
function firedEvents(): { names: Set<string>; computed: string[] } {
  const names = new Set<string>();
  const computed: string[] = [];
  for (const file of sources(here)) {
    // `analytics.ts` is scanned like any other file — it fires `pwa_installed` itself —
    // but its own `export function track(event, …)` declaration is not a call site, so
    // the lookbehind steps over it.
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<!function\s)\btrack\(\s*(['"`])([^'"`]*)\1/g)) {
      names.add(m[2]!);
    }
    for (const m of text.matchAll(/(?<!function\s)\btrack\(\s*([^'"`\s)])/g)) {
      computed.push(`${file.slice(here.length + 1)}: track(${m[1]}…`);
    }
  }
  return { names, computed };
}

/**
 * Event names in the catalogue's table — the leading `` `code` `` of each row.
 *
 * Scoped to the `## Event catalogue` section. The document carries other tables in the
 * same shape (the project-level PostHog settings, for one), and reading the whole file
 * would report every config flag in them as a missing event.
 */
function cataloguedEvents(): Set<string> {
  const md = readFileSync(CATALOGUE, 'utf8');
  const start = md.indexOf('## Event catalogue');
  expect(start, 'docs/design/analytics.md has no "## Event catalogue" heading').toBeGreaterThan(-1);
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)) out.add(m[1]!);
  return out;
}

describe('analytics coverage', () => {
  it('documents every event the app sends', () => {
    const { names } = firedEvents();
    // A tree with no `track()` calls in it would pass everything below vacuously.
    expect(names.size).toBeGreaterThan(5);

    const catalogued = cataloguedEvents();
    const missing = [...names].filter((n) => !catalogued.has(n)).sort();
    expect(
      missing,
      `Event(s) sent but not in the catalogue: ${missing.map((m) => `"${m}"`).join(', ')}. ` +
        `Add a row to the table in docs/design/analytics.md saying what it carries and why.`,
    ).toEqual([]);
  });

  it('sends every event the catalogue lists', () => {
    const { names } = firedEvents();
    const stale = [...cataloguedEvents()].filter((n) => !names.has(n)).sort();
    expect(
      stale,
      `Catalogue lists event(s) the app no longer sends: ${stale.map((s) => `"${s}"`).join(', ')}. ` +
        `Remove the row, or fix the rename — a dashboard built on one of these reads zero forever.`,
    ).toEqual([]);
  });

  it('names every event with a literal, so this check cannot be evaded', () => {
    const { computed } = firedEvents();
    expect(
      computed,
      `track() called with a non-literal event name: ${computed.join('; ')}. ` +
        `The catalogue is checked by reading the source, so a computed name is invisible to it.`,
    ).toEqual([]);
  });
});
