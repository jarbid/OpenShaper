import { expect, test, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * Export behavior — every format is free in the open-source build.
 *
 * These tests used to `goto('/')` and click bare `PDF` / `STL` / `DXF` buttons. That
 * was a different app: `/` is the marketing landing page now, and the export actions
 * live in the editor's Export menu at `/app`. The buttons had been gone long enough
 * that all four cases were failing on `main` — nothing noticed, because `ci.yml` runs
 * typecheck, test and build but never Playwright.
 *
 * The formats also stopped being one kind of thing. STL and DXF write a file straight
 * from the menu; STEP, PDF, rail bands, the spec sheet and the HWS template each open
 * a dialog first, because each has settings worth choosing before you commit. So the
 * menu is asserted as a whole, and only the two direct formats are driven to an actual
 * download here — a dialog's own options belong in a test about that dialog.
 */

/**
 * Open one of the editor's menubar menus and return its panel.
 *
 * The trigger carries `role="menuitem"`, not `button` — an explicit role wins over the
 * element — so it is reached through the menubar rather than by `getByRole('button')`.
 */
async function openMenu(page: Page, label: string) {
  await page.getByRole('menubar').getByRole('menuitem', { name: label, exact: true }).click();
  return page.getByRole('menu');
}

/**
 * A row in an open menu.
 *
 * A row with a keyboard shortcut renders it in a sibling span inside the same button,
 * so the accessible name of the save row is "Save Ctrl S" rather than "Save". Matching
 * on the leading label keeps these readable without pinning the shortcut text.
 */
const row = (menu: ReturnType<Page['getByRole']>, label: string) =>
  menu.getByRole('menuitem', {
    name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });

test.describe('Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app');
    await editorReady(page);
  });

  test('offers every format, none of them gated', async ({ page }) => {
    const menu = await openMenu(page, 'Export');

    // The free-software promise is the point of this assertion: a board is loaded, so
    // nothing in here may be disabled or hidden behind an upsell.
    for (const label of [
      'STL',
      'DXF (polyline)',
      'DXF (spline)',
      'STEP (surfaces)…',
      'PDF 1:1…',
      'Rail bands…',
      'Spec sheet…',
      'Hollow Wood Frame…',
    ]) {
      await expect(row(menu, label), `${label} should be offered`).toBeEnabled();
    }
  });

  for (const [label, extension] of [
    ['STL', '.stl'],
    ['DXF (polyline)', '.dxf'],
  ] as const) {
    test(`exports ${label} as a download`, async ({ page }) => {
      const menu = await openMenu(page, 'Export');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        row(menu, label).click(),
      ]);
      expect(download.suggestedFilename().toLowerCase()).toContain(extension);
    });
  }

  test('opens a dialog for the formats that have settings', async ({ page }) => {
    const menu = await openMenu(page, 'Export');
    await row(menu, 'PDF 1:1…').click();

    // The ellipsis in the label is the promise being checked: it opens something
    // rather than writing a file on the spot.
    //
    // Asserted on the panel's heading rather than `getByRole('dialog')`, because the
    // export dialogs do not carry that role — only the bottom sheet does. They are
    // modal overlays and arguably should, but adding it is an accessibility change
    // rather than a test fix, so it is noted and left alone here.
    await expect(page.getByRole('heading', { name: 'Export 1:1 PDF' })).toBeVisible();
  });

  test('saves the native .board.json document', async ({ page }) => {
    const menu = await openMenu(page, 'File');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row(menu, 'Save').click(),
    ]);
    // `.board`, not `.board.json`: the file is named after the model so saves pile up
    // as `my-fish.board` rather than `board (1)`, `board (2)` (`file-io.ts:75-85`).
    // The prose still calls the format ".board.json" in places, but the extension on
    // disk has been `.board` for a while and this expectation had not caught up.
    expect(download.suggestedFilename()).toMatch(/\.board$/);
  });
});
