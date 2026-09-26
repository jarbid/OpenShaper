import { expect, test, type Page } from '@playwright/test';

/**
 * Export behaviour — every format is free in the open-source build. Each one is
 * reached the way a user reaches it, through the editor's menus:
 *  - STL and both DXFs download straight from the Export menu.
 *  - PDF 1:1 opens its settings dialog first; the download comes from its button.
 *  - The native board document saves from File → Save.
 */

/** The sample board has loaded once the Specs volume readout ("27.4L") shows. */
async function openEditor(page: Page) {
  await page.goto('/app');
  await expect(page.getByText(/\d+\.\dL/).first()).toBeVisible();
}

const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });

test.describe('Export', () => {
  for (const [item, suffix] of [
    ['STL', '.stl'],
    ['DXF (polyline)', '.dxf'],
    ['DXF (spline)', '-spline.dxf'],
  ] as const) {
    test(`exports ${item} as a download`, async ({ page }) => {
      await openEditor(page);
      await menu(page, 'Export').click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('menuitem', { name: item, exact: true }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(new RegExp(`${suffix.replace('.', '\\.')}$`));
    });
  }

  test('exports a 1:1 PDF from its settings dialog', async ({ page }) => {
    await openEditor(page);
    // Deliberately the first-visit case: the consent banner is up and unanswered. It
    // used to sit over this dialog's footer on a 1280×720 screen, covering Export.
    // `toBeInViewport`, not `toBeVisible`: it slides in after a delay, and an
    // off-screen element already counts as visible.
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toBeInViewport({
      ratio: 1,
    });
    await menu(page, 'Export').click();
    await page.getByRole('menuitem', { name: 'PDF 1:1…', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-1to1\.pdf$/);
  });

  test('saves the native board document', async ({ page }) => {
    await openEditor(page);
    await menu(page, 'File').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: /^Save\b/ }).click(),
    ]);
    // Named after the board's model; the sample has none, so it falls back to `board`.
    expect(download.suggestedFilename()).toBe('board.board');
  });
});
