/**
 * Starting board templates — the three the legacy BoardCAD-LE shipped in its
 * "New Board" chooser (boardcad.DefaultBrds): Shortboard, Funboard, Longboard.
 * The exact legacy `.brd` data is bundled here so each template loads the real
 * board geometry (authentic outline / rocker / sections), not an approximation.
 * The shortboard is the same file as the default sample board.
 *
 * With the NURBS engine on, the chooser lists {@link NURBS_TEMPLATES} instead: the same three
 * boards already converted to the section model, plus a swallow-tail and a fish shortboard.
 */
import funboardBrd from './funboard.brd?raw';
import longboardBrd from './longboard.brd?raw';
import shortboardBrd from './sample-board.brd?raw';

export interface BoardTemplate {
  name: string;
  /** Raw legacy `.brd` content, parsed with parseBrd on selection. */
  brd: string;
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { name: 'Shortboard', brd: shortboardBrd },
  { name: 'Funboard', brd: funboardBrd },
  { name: 'Longboard', brd: longboardBrd },
];

export interface NurbsTemplate {
  name: string;
  /**
   * The template's `.board` text (a section document). Loaded on demand from a chunk of its own, so
   * the engine-off page carries none of the five and a template costs a request only when chosen.
   * Regenerate with `tools/make-nurbs-templates.ts`.
   */
  load: () => Promise<string>;
}

export const NURBS_TEMPLATES: NurbsTemplate[] = [
  {
    name: 'Shortboard',
    load: async () => (await import('./templates/shortboard.board?raw')).default,
  },
  { name: 'Funboard', load: async () => (await import('./templates/funboard.board?raw')).default },
  {
    name: 'Longboard',
    load: async () => (await import('./templates/longboard.board?raw')).default,
  },
  {
    name: 'Swallow shortboard',
    load: async () => (await import('./templates/swallow-shortboard.board?raw')).default,
  },
  {
    name: 'Fish shortboard',
    load: async () => (await import('./templates/fish-shortboard.board?raw')).default,
  },
];
