// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the documentation covers.
 *
 * This is the join between the app's features and `/docs`. Every entry claims
 * that a feature is documented on a particular page; `coverage.test.ts` then
 * checks that claim against the app's own definitions — the fin unions, the
 * export formats, the shortcut table, the starter templates — and fails when
 * something ships without an entry.
 *
 * What it buys: a feature can no longer be added *silently* undocumented. What it
 * does not buy: any guarantee the prose is correct. See `.claude/CLAUDE.md`.
 *
 * Adding a feature? Add its id here and write the section on the named page.
 */

export const DOCS_ROUTES = [
  '/docs',
  '/docs/editing',
  '/docs/specs',
  '/docs/fins',
  '/docs/construction',
  '/docs/export',
  '/docs/files',
  '/docs/offline',
  '/docs/shortcuts',
] as const;

export type DocsRoute = (typeof DOCS_ROUTES)[number];

/** Feature kinds the coverage test knows how to enumerate from source. */
export type FeatureKind =
  | 'fin-setup'
  | 'fin-system'
  | 'fin-profile'
  | 'export-format'
  | 'board-template'
  | 'rail-preset'
  | 'shortcut';

export interface DocEntry {
  /**
   * Identifier as the app defines it — a `FinSetup` value, an `ExportFormat`, a
   * template name, a shortcut id. Must match exactly; that's the whole point.
   */
  id: string;
  kind: FeatureKind;
  /** Where it is documented. */
  route: DocsRoute;
}

const entries = <K extends FeatureKind>(kind: K, route: DocsRoute, ids: readonly string[]) =>
  ids.map((id): DocEntry => ({ id, kind, route }));

export const DOC_ENTRIES: readonly DocEntry[] = [
  ...entries('fin-setup', '/docs/fins', [
    'none',
    'single',
    'twin',
    'thruster',
    'quad',
    '2+1',
    '5-fin',
  ]),
  ...entries('fin-system', '/docs/fins', ['glass-on', 'fcs-ii', 'fcs-x2', 'futures']),
  ...entries('fin-profile', '/docs/fins', ['thruster', 'single', 'noserider', 'keel']),
  ...entries('export-format', '/docs/export', [
    'stl',
    'step',
    'dxf',
    'dxf-spline',
    'pdf-1to1',
    'rail-bands',
  ]),
  ...entries('board-template', '/docs/files', ['Shortboard', 'Funboard', 'Longboard']),
  // Spelled out rather than imported from the kernel on purpose: the registry is an
  // independent claim that the coverage test diffs against `RAIL_PRESETS`. Import the
  // array here and the assertion becomes `x === x`.
  ...entries('rail-preset', '/docs/editing', [
    '50-50-soft',
    '60-40-tucked',
    '70-30-tucked',
    '80-20-hard',
    'boxy',
    'pinched',
    'egg',
    'knifey',
  ]),
  ...entries('shortcut', '/docs/shortcuts', [
    'undo',
    'redo',
    'redo-alt',
    'delete-point',
    'save',
    'command-palette',
    'cross-section-prev',
    'cross-section-next',
    'view-1',
    'view-2',
    'view-3',
    'view-4',
    'view-5',
  ]),
];

/** Ids documented for a given feature kind. */
export function documentedIds(kind: FeatureKind): Set<string> {
  return new Set(DOC_ENTRIES.filter((e) => e.kind === kind).map((e) => e.id));
}
