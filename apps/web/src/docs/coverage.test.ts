// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The mechanism that stops `/docs` going quietly stale.
 *
 * Documentation maintained by good intentions is wrong within two releases, so
 * this asserts coverage against the app's *own* definitions rather than a list
 * someone has to remember to update. Ship a new fin system, export format,
 * starter template or keyboard shortcut without a registry entry and this fails,
 * naming exactly what is missing.
 *
 * Same spirit as tools/precache-guard.ts: an invariant that fails the build
 * rather than a convention.
 *
 * Its limit, stated plainly: it proves an entry *exists*, never that the prose is
 * *accurate*. What it removes is silent omission, which is the failure mode that
 * actually happens.
 */
import { FIN_PROFILES_LIST, FIN_SETUPS, FIN_SYSTEMS } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS } from '../file-io';
import { SHORTCUTS } from '../shortcuts';
import { BOARD_TEMPLATES } from '../templates';
import { DOC_ENTRIES, DOCS_ROUTES, documentedIds, type FeatureKind } from './registry';

/**
 * Assert every id the app defines has a docs entry, and that the registry has no
 * entries for things that no longer exist (which would hide a rename).
 */
function expectDocumented(kind: FeatureKind, actual: readonly string[]) {
  const documented = documentedIds(kind);

  const missing = actual.filter((id) => !documented.has(id));
  expect(
    missing,
    `Undocumented ${kind}(s): ${missing.map((m) => `"${m}"`).join(', ')}. ` +
      `Add an entry to src/docs/registry.ts and write the section on the page it names.`,
  ).toEqual([]);

  const stale = [...documented].filter((id) => !actual.includes(id));
  expect(
    stale,
    `Registry documents ${kind}(s) the app no longer defines: ${stale
      .map((s) => `"${s}"`)
      .join(', ')}. Remove them, or fix the rename.`,
  ).toEqual([]);
}

describe('docs coverage', () => {
  it('documents every fin setup', () => {
    expectDocumented('fin-setup', FIN_SETUPS);
  });

  it('documents every fin system', () => {
    expectDocumented('fin-system', FIN_SYSTEMS);
  });

  it('documents every fin profile', () => {
    expectDocumented('fin-profile', FIN_PROFILES_LIST);
  });

  it('documents every export format', () => {
    expectDocumented('export-format', EXPORT_FORMATS);
  });

  it('documents every starter template', () => {
    expectDocumented(
      'board-template',
      BOARD_TEMPLATES.map((t) => t.name),
    );
  });

  it('documents every keyboard shortcut', () => {
    expectDocumented(
      'shortcut',
      SHORTCUTS.map((s) => s.id),
    );
  });
});

describe('the registry itself', () => {
  it('points every entry at a real docs route', () => {
    const routes = new Set<string>(DOCS_ROUTES);
    const bad = DOC_ENTRIES.filter((e) => !routes.has(e.route));
    expect(bad.map((b) => `${b.id} → ${b.route}`)).toEqual([]);
  });

  it('has no duplicate entries', () => {
    const keys = DOC_ENTRIES.map((e) => `${e.kind}:${e.id}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });
});
