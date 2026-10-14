// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The editor's help text, as data.
 *
 * One table, keyed by what the help is attached to:
 *
 *  - **Menu commands** by the id `commandsFromMenus` gives them, `Menu/Label`
 *    (`Board/Resize…`). The command palette searches these and shows the
 *    description; `help-text.test.ts` fails when a menu item has no entry.
 *  - **Menu groups whose items are data** — starter templates, recent boards, units
 *    — by `Menu/Group/*`, the group being the menu's `label` row above them, up to
 *    the next separator. Keep a separator after such a group's data rows. A recent
 *    board is named after the board, so it cannot have an entry of its own.
 *  - **Toolbar controls** by `toolbar:<name>`: icon buttons, whose tooltip shows the
 *    description under the label while the Show tips setting is on.
 *  - **Sidebar sections** by `section:<SectionId>`: the `?` link on the header.
 *
 * Every entry names the `/docs` page that explains it, so "learn more" always has
 * somewhere to go. The tooltip itself never links (it is `aria-hidden` and takes no
 * pointer); the `?` links and the palette carry the route instead.
 *
 * Writing an entry: one plain sentence saying what the thing does, specific enough
 * to tell it apart from its neighbours. Keywords are the other words someone might
 * type for it — synonyms and the shaper's names for things, not the label again.
 * `addedOn` (ISO date) marks recent features; the palette badges them "New" for 60
 * days. No analytics are involved: the badge is a date comparison.
 */
import type { SectionId } from './sidebar-sections';
import type { DocsRoute } from './docs/registry';

export interface HelpEntry {
  /** One sentence, no marketing. Shown under a tooltip label and a palette result. */
  description: string;
  /** The `/docs` page that covers it. */
  route: DocsRoute;
  /** A `<Section id>` on that page, when one section is the answer. */
  anchor?: string;
  /** Synonyms the palette also matches. */
  keywords?: readonly string[];
  /** When it shipped, as `YYYY-MM-DD`. Drives the palette's "New" badge. */
  addedOn?: string;
}

/** Toolbar controls that carry help. */
export type ToolbarHelpId =
  | 'toolbar:menu'
  | 'toolbar:share'
  | 'toolbar:panels'
  | 'sidebar:pin'
  | 'sidebar:expand'
  | 'sidebar:fold';

/** The id a menu command has in the palette, and so in this table. */
export const commandHelpId = (menu: string, label: string) => `${menu}/${label}`;

/** The shared entry for every item listed under a menu's `group` label row. */
export const groupHelpId = (menu: string, group: string) => `${menu}/${group}/*`;

// Shared synonym sets, so a word means the same thing wherever it is seeded.
const SCALE = ['scale', 'resize', 'dimensions'];
const VOLUME = ['volume', 'litres', 'liters', 'float'];
const SLICE = ['slice', 'section', 'cross-section', 'station'];
const RAIL = ['rail', 'tuck', 'apex'];
const TEMPLATE = ['template', 'starter'];
const FAIRNESS = ['curvature', 'zebra', 'fairness', 'smoothness'];

export const HELP_TEXT: Readonly<Record<string, HelpEntry>> = {
  // --- File -------------------------------------------------------------------
  [groupHelpId('File', 'New')]: {
    description:
      'Replaces the current board with this starter template, ready to reshape (undoable).',
    route: '/docs/files',
    anchor: 'templates',
    keywords: [...TEMPLATE, 'new board', 'preset'],
  },
  'File/Open…': {
    description: 'Opens a board file from your device: OpenShaper, BoardCAD, Shape3D or SurfCAD.',
    route: '/docs/files',
    anchor: 'saving',
    keywords: ['load', 'import', 'brd', 's3dx', 'srf'],
  },
  'File/Save': {
    description: 'Downloads the board as an OpenShaper .board file you can open again later.',
    route: '/docs/files',
    anchor: 'saving',
    keywords: ['download', 'keep'],
  },
  'File/Share…': {
    description: 'Makes a link that opens a copy of this board in anyone’s browser.',
    route: '/docs/files',
    anchor: 'share',
    keywords: ['link', 'url', 'send'],
    addedOn: '2026-09-19',
  },
  [groupHelpId('File', 'Open recent')]: {
    description: 'Reopens a board you worked on recently, from this device’s storage.',
    route: '/docs/files',
    anchor: 'storage',
    keywords: ['recent', 'history', 'reopen'],
  },
  'File/Clear recent': {
    description: 'Empties the Open recent list; the boards themselves are not touched.',
    route: '/docs/files',
    anchor: 'storage',
  },
  'File/Load trace image…': {
    description: 'Puts a photo or scan behind the outline view so you can trace a shape from it.',
    route: '/docs/files',
    anchor: 'trace',
    keywords: ['photo', 'picture', 'background', 'copy shape'],
  },

  // --- Edit -------------------------------------------------------------------
  'Edit/Undo': {
    description: 'Takes back the last change to the board.',
    route: '/docs/editing',
    anchor: 'undo',
    keywords: ['revert', 'back'],
  },
  'Edit/Redo': {
    description: 'Puts back the change you last undid.',
    route: '/docs/editing',
    anchor: 'undo',
  },
  'Edit/Settings…': {
    description:
      'Opens settings for curve colours, point and line sizes, tips and editing behaviour.',
    route: '/docs',
    anchor: 'settings',
    keywords: ['preferences', 'options', 'colours', 'colors', 'tips'],
  },

  // --- View -------------------------------------------------------------------
  'View/Grid & guides': {
    description: 'Shows the scale grid and station lines behind the 2D views.',
    route: '/docs/specs',
    anchor: 'overlays',
    keywords: ['ruler', 'stations'],
  },
  'View/Curvature comb': {
    description:
      'Draws quills along each curve, longer where it bends tighter, to find flat spots.',
    route: '/docs/specs',
    anchor: 'overlays',
    keywords: [...FAIRNESS, 'flat spot', 'porcupine'],
  },
  'View/Center of mass': {
    description: 'Marks the board’s centre of mass in the outline and rocker views.',
    route: '/docs/specs',
    anchor: 'overlays',
    keywords: ['balance', 'centre of mass', 'cog', 'com'],
  },
  'View/Volume distribution': {
    description: 'Plots how the volume is spread along the board, showing where it carries float.',
    route: '/docs/specs',
    anchor: 'overlays',
    keywords: VOLUME,
  },
  'View/Apex height': {
    description: 'Draws the height of the rail apex as a dashed line in the rocker view.',
    route: '/docs/specs',
    anchor: 'overlays',
    keywords: [...RAIL, 'parting line', 'rail line'],
    addedOn: '2026-10-11',
  },
  'View/Tunni controls': {
    description: 'Shows a handle on each curve segment that adjusts both of its tangents together.',
    route: '/docs/editing',
    anchor: 'views',
    keywords: ['handles', 'tangents', 'balance'],
    addedOn: '2026-10-09',
  },
  'View/Fit view': {
    description: 'Zooms and pans the 2D view so the whole curve fits on screen.',
    route: '/docs/editing',
    anchor: 'views',
    keywords: ['zoom', 'reset view', 'frame'],
  },
  'View/Life-size (1:1)': {
    description: 'Zooms the 2D view to real size on screen, one centimetre per centimetre.',
    route: '/docs/editing',
    anchor: 'views',
    keywords: ['zoom', 'actual size', 'real size', '100%'],
  },
  [groupHelpId('View', 'Units')]: {
    description: 'Shows every length in this unit; the board itself is unchanged.',
    route: '/docs/specs',
    anchor: 'units',
    keywords: ['units', 'metric', 'imperial', 'inches', 'millimetres', 'fractions'],
  },

  // --- Board ------------------------------------------------------------------
  'Board/Resize…': {
    description: 'Scales the board to a new length, width and thickness, keeping its shape.',
    route: '/docs/specs',
    anchor: 'resize',
    keywords: [...SCALE, 'stretch', 'length', 'width', 'thickness'],
    addedOn: '2026-10-10',
  },
  'Board/Open ghost…': {
    description: 'Loads a second board, drawn dashed underneath, to compare yours against.',
    route: '/docs/specs',
    anchor: 'ghost',
    keywords: ['compare', 'reference', 'overlay', 'deviation'],
  },
  'Board/Clear ghost': {
    description: 'Removes the comparison board loaded with Open ghost.',
    route: '/docs/specs',
    anchor: 'ghost',
    keywords: ['compare', 'reference'],
  },
  'Board/Control point': {
    description: 'Computes volume and balance from cross-sections blended by their control points.',
    route: '/docs/specs',
    anchor: 'volume',
    keywords: ['interpolation', ...SLICE],
  },
  'Board/S-blend': {
    description:
      'Computes volume and balance with BoardCAD’s station-linear blend of cross-sections.',
    route: '/docs/specs',
    anchor: 'volume',
    keywords: ['interpolation', 'slinear', ...SLICE],
  },

  // --- Export -----------------------------------------------------------------
  'Export/STL': {
    description: 'Downloads the 3D surface as triangles, for 3D printing or rendering.',
    route: '/docs/export',
    anchor: 'formats',
    keywords: ['mesh', '3d print', 'triangles'],
  },
  'Export/DXF (polyline)': {
    description:
      'Downloads outline, rocker and cross-sections as short straight segments for CAD/CAM.',
    route: '/docs/export',
    anchor: 'formats',
    keywords: ['cad', 'cam', 'cnc', 'laser', 'drawing', ...SLICE],
  },
  'Export/DXF (spline)': {
    description: 'Downloads outline, rocker and cross-sections as true curves for CAD software.',
    route: '/docs/export',
    anchor: 'formats',
    keywords: ['cad', 'cam', 'cnc', 'curves', 'drawing', ...SLICE],
  },
  'Export/STEP (surfaces)…': {
    description: 'Downloads the hull as one solid of exact curved surfaces, for CAD and CNC.',
    route: '/docs/export',
    anchor: 'formats',
    keywords: ['cad', 'cam', 'cnc', 'solid', 'nurbs', 'machining'],
  },
  'Export/PDF 1:1…': {
    description: 'Prints full-size templates tiled across pages, with marks to join them.',
    route: '/docs/export',
    anchor: 'pdf',
    keywords: ['print', 'life-size', 'paper', ...TEMPLATE],
  },
  'Export/Rail bands…': {
    description: 'Lays out the rail strips of a hollow wooden board, flattened for cutting.',
    route: '/docs/export',
    anchor: 'rail-bands',
    keywords: ['hollow', 'wood', 'strips', 'rail'],
  },
  'Export/Spec sheet…': {
    description: 'Opens a printable one-page summary of the board’s dimensions and details.',
    route: '/docs/export',
    anchor: 'spec',
    keywords: ['print', 'summary', 'order', ...VOLUME],
  },
  'Export/Hollow Wood Frame…': {
    description: 'Makes cutting templates for the internal frame of a hollow wooden board.',
    route: '/docs/construction',
    keywords: ['hollow', 'wood', 'ribs', 'spine', 'laser', ...TEMPLATE],
  },
  'Export/Legacy .brd': {
    description: 'Downloads the board as a BoardCAD .brd file, to open in BoardCAD.',
    route: '/docs/files',
    anchor: 'saving',
    keywords: ['boardcad', 'brd', 'save as'],
  },

  // --- Help -------------------------------------------------------------------
  'Help/Documentation': {
    description: 'Opens the reference documentation for the editor.',
    route: '/docs',
    keywords: ['docs', 'manual', 'guide', 'help'],
  },
  'Help/Keyboard shortcuts': {
    description: 'Lists every keyboard shortcut in the editor.',
    route: '/docs/shortcuts',
    keywords: ['keys', 'hotkeys', 'keybindings'],
  },
  'Help/About & guides': {
    description: 'Opens the about page, with guides to surfboard design and construction.',
    route: '/docs',
    anchor: 'help',
    keywords: ['about', 'guides', 'learn'],
  },
  'Help/Buy me a coffee': {
    description: 'Opens the page where you can support OpenShaper’s development.',
    route: '/docs',
    anchor: 'help',
    keywords: ['donate', 'support'],
  },

  // --- Toolbar controls -------------------------------------------------------
  'toolbar:menu': {
    description: 'Searches every menu command by name or by what it does.',
    route: '/docs',
    anchor: 'help',
  },
  'toolbar:share': {
    description: 'Makes a link that opens a copy of this board in anyone’s browser.',
    route: '/docs/files',
    anchor: 'share',
  },
  'toolbar:panels': {
    description: 'Raises or lowers the sheet holding the specs and the board’s tools.',
    route: '/docs',
    anchor: 'layout',
  },
  'sidebar:pin': {
    description: 'Keeps this panel on screen while you work in another tab.',
    route: '/docs',
    anchor: 'layout',
  },
  'sidebar:expand': {
    description: 'Opens or shuts every section in this panel at once.',
    route: '/docs',
    anchor: 'layout',
  },
  'sidebar:fold': {
    description: 'Folds the panel away, leaving the tab strip and the headline dimensions.',
    route: '/docs',
    anchor: 'layout',
  },

  // --- Sidebar sections -------------------------------------------------------
  'section:specs': {
    description: 'Live dimensions, volume and areas of the board.',
    route: '/docs/specs',
    anchor: 'readout',
  },
  'section:resize': {
    description: 'Scales the board to a new length, width and thickness.',
    route: '/docs/specs',
    anchor: 'resize',
  },
  'section:controlPoint': {
    description: 'Exact position and tangents of the selected control point.',
    route: '/docs/editing',
    anchor: 'points',
  },
  'section:analysis': {
    description: 'Overlays that read the shape: comb, centre of mass, volume distribution.',
    route: '/docs/specs',
    anchor: 'overlays',
  },
  'section:boardInfo': {
    description: 'Designer, model, materials and notes saved with the board.',
    route: '/docs/files',
    anchor: 'saving',
  },
  'section:fins': {
    description: 'Fin setup, system and placement.',
    route: '/docs/fins',
  },
  'section:weight': {
    description: 'Estimated finished weight from the foam and glassing you choose.',
    route: '/docs/specs',
    anchor: 'weight',
  },
  'section:trace': {
    description: 'Images to trace a shape from, behind the outline and rocker views.',
    route: '/docs/files',
    anchor: 'trace',
  },
  'section:history': {
    description: 'Every change since the board was opened, to step back to.',
    route: '/docs/editing',
    anchor: 'undo',
  },
  'section:compare': {
    description: 'Your board’s numbers beside the ghost board’s, with the differences.',
    route: '/docs/specs',
    anchor: 'ghost',
  },
};

/**
 * Help for a menu command. Its own entry wins; an item under a data-driven group
 * (`File ▸ New`, `Open recent`, `View ▸ Units`) falls back to the group's.
 */
export function commandHelp(menu: string, label: string, group?: string): HelpEntry | undefined {
  return (
    HELP_TEXT[commandHelpId(menu, label)] ??
    (group === undefined ? undefined : HELP_TEXT[groupHelpId(menu, group)])
  );
}

/** Help for a sidebar section's `?` link. */
export const sectionHelp = (id: SectionId): HelpEntry | undefined => HELP_TEXT[`section:${id}`];

/** Help for a toolbar control's tooltip. */
export const toolbarHelp = (id: ToolbarHelpId): HelpEntry | undefined => HELP_TEXT[id];

/** Where an entry's "learn more" goes. */
export const docsHref = (e: Pick<HelpEntry, 'route' | 'anchor'>): string =>
  e.anchor ? `${e.route}#${e.anchor}` : e.route;

/** How long an entry counts as new. */
export const NEW_FOR_DAYS = 60;

/**
 * Whether `addedOn` is within {@link NEW_FOR_DAYS} of `now` (epoch ms). Takes the
 * clock as an argument so nothing that renders a badge depends on the real date.
 */
export function isNew(addedOn: string | undefined, now: number): boolean {
  if (!addedOn) return false;
  const added = Date.parse(`${addedOn}T00:00:00Z`);
  if (Number.isNaN(added)) return false;
  const age = now - added;
  return age >= 0 && age <= NEW_FOR_DAYS * 86_400_000;
}
