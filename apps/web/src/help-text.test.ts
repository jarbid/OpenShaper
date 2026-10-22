// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The help-text table's own integrity: every entry says something, and every
 * "learn more" it implies lands on a real page and a real section of it.
 *
 * That every menu command *has* an entry is the find-it test's job
 * (`App.help-coverage.test.tsx`), which enumerates the menus the app renders.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_ROUTES } from './docs/registry';
import {
  commandHelp,
  docsHref,
  HELP_TEXT,
  isNew,
  NEW_FOR_DAYS,
  sectionHelp,
  toolbarHelp,
  type ToolbarHelpId,
} from './help-text';
import { SIDEBAR_SECTIONS } from './sidebar-sections';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, 'pages/docs');

/** Each docs route's page source, found by the `route="…"` it renders with. */
const pageSource = new Map<string, string>(
  readdirSync(pagesDir)
    .filter((f) => f.endsWith('.tsx'))
    .flatMap((f) => {
      const text = readFileSync(join(pagesDir, f), 'utf8');
      const route = /route="([^"]+)"/.exec(text)?.[1];
      return route ? [[route, text] as const] : [];
    }),
);

const entries = Object.entries(HELP_TEXT);

describe('the help-text table', () => {
  it('describes every entry in a sentence', () => {
    const blank = entries.filter(([, e]) => e.description.trim().length < 10).map(([id]) => id);
    expect(blank).toEqual([]);
  });

  it('points every entry at a route in DOCS_ROUTES', () => {
    const routes = new Set<string>(DOCS_ROUTES);
    const bad = entries
      .filter(([, e]) => !routes.has(e.route))
      .map(([id, e]) => `${id} → ${e.route}`);
    expect(bad).toEqual([]);
  });

  it('points every anchor at a section that exists on its page', () => {
    // Every route has a page to read anchors from; otherwise the next check passes vacuously.
    expect(DOCS_ROUTES.filter((r) => !pageSource.has(r))).toEqual([]);
    const missing = entries
      .filter(
        ([, e]) => e.anchor && !pageSource.get(e.route)!.includes(`<Section id="${e.anchor}"`),
      )
      .map(([id, e]) => `${id} → ${docsHref(e)}`);
    expect(missing).toEqual([]);
  });

  // The overview page covers a little of everything, so "learn more" landing on its
  // top says nothing about the command. Only the command that opens the docs may.
  it('points into a section of the overview, not at its top', () => {
    const vague = entries
      .filter(([id, e]) => e.route === '/docs' && !e.anchor && id !== 'Help/Documentation')
      .map(([id]) => id);
    expect(vague).toEqual([]);
  });

  it('dates new features as real ISO days', () => {
    const bad = entries
      .filter(([, e]) => e.addedOn !== undefined)
      .filter(
        ([, e]) => !/^\d{4}-\d{2}-\d{2}$/.test(e.addedOn!) || Number.isNaN(Date.parse(e.addedOn!)),
      )
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });

  it('has a ? link entry for every sidebar section', () => {
    expect(SIDEBAR_SECTIONS.filter((s) => !sectionHelp(s.id)).map((s) => s.id)).toEqual([]);
  });

  it('has an entry for every toolbar control that asks for one', () => {
    const ids: ToolbarHelpId[] = [
      'toolbar:menu',
      'toolbar:share',
      'toolbar:panels',
      'sidebar:pin',
      'sidebar:expand',
      'sidebar:fold',
    ];
    expect(ids.filter((id) => !toolbarHelp(id))).toEqual([]);
  });

  it('seeds the synonyms people search by', () => {
    const finds = (word: string, id: string) => HELP_TEXT[id]?.keywords?.includes(word);
    expect(finds('scale', 'Board/Resize…')).toBe(true);
    expect(finds('litres', 'View/Volume distribution')).toBe(true);
    expect(finds('liters', 'View/Volume distribution')).toBe(true);
    expect(finds('cross-section', 'Export/DXF (spline)')).toBe(true);
    expect(finds('slice', 'Export/DXF (spline)')).toBe(true);
    expect(finds('tuck', 'View/Apex height')).toBe(true);
    expect(finds('starter', 'File/New/*')).toBe(true);
    expect(finds('zebra', 'View/Curvature comb')).toBe(true);
    expect(finds('fairness', 'View/Curvature comb')).toBe(true);
  });
});

describe('commandHelp', () => {
  it('prefers the item’s own entry, then its group’s', () => {
    expect(commandHelp('Board', 'Resize…')).toBe(HELP_TEXT['Board/Resize…']);
    // A template is listed under File ▸ New; a recent board under Open recent.
    expect(commandHelp('File', 'Longboard', 'New')).toBe(HELP_TEXT['File/New/*']);
    expect(commandHelp('File', 'My board', 'Open recent')).toBe(HELP_TEXT['File/Open recent/*']);
    // Clear recent sits in the same group but has words of its own.
    expect(commandHelp('File', 'Clear recent', 'Open recent')).toBe(HELP_TEXT['File/Clear recent']);
    expect(commandHelp('File', 'Nonsense')).toBeUndefined();
    expect(commandHelp('Board', 'Nonsense', 'Interpolation')).toBeUndefined();
  });
});

describe('isNew', () => {
  const added = Date.parse('2026-10-10T00:00:00Z');
  const day = 86_400_000;

  it(`is true from the day a feature ships until ${NEW_FOR_DAYS} days later`, () => {
    expect(isNew('2026-10-10', added)).toBe(true);
    expect(isNew('2026-10-10', added + NEW_FOR_DAYS * day)).toBe(true);
    expect(isNew('2026-10-10', added + (NEW_FOR_DAYS + 1) * day)).toBe(false);
  });

  it('is false with no date, a bad date, or a date still in the future', () => {
    expect(isNew(undefined, added)).toBe(false);
    expect(isNew('soon', added)).toBe(false);
    expect(isNew('2026-10-10', added - day)).toBe(false);
  });
});
