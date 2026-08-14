import { expect, test } from '@playwright/test';

/**
 * Export behavior — every format is free in the open-source build:
 *  - PDF, STL and DXF export each trigger a download.
 *  - The native .board.json save triggers a download too.
 */
test.describe('Export', () => {
  for (const fmt of ['PDF', 'STL', 'DXF'] as const) {
    test(`exports ${fmt} as a download`, async ({ page }) => {
      await page.goto('/');
      const button = page.getByRole('button', { name: fmt, exact: true });
      await expect(button).toBeEnabled();
      const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
      expect(download.suggestedFilename().toLowerCase()).toContain(fmt.toLowerCase());
    });
  }

  test('saves the native .board.json document', async ({ page }) => {
    await page.goto('/');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.board\.json$/);
  });
});
