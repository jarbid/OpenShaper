import { expect, test } from '@playwright/test';
import { editorReady } from './helpers';

for (const view of ['Outline', 'Rocker', 'Cross-section']) {
  test(`Tunni controls can be toggled from the ${view} context menu`, async ({ page }) => {
    await page.goto('/app');
    await editorReady(page);
    await page.getByRole('button', { name: view, exact: true }).click();
    const canvas = page.locator('canvas').first();
    const open = () => canvas.click({ button: 'right', position: { x: 10, y: 10 } });
    await open();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Show Tunni controls' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toBeHidden();
    await page.mouse.move(0, 0);
    const screenshotPath = test.info().outputPath('tunni-controls.png');
    await canvas.screenshot({ path: screenshotPath });
    await test.info().attach(`${view}-tunni-controls`, {
      path: screenshotPath,
      contentType: 'image/png',
    });
    await open();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await open();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
}
