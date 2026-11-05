import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { editorReady, openSection } from './helpers';

const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });

/** A spot inside the board in the outline view, clear of the curve and its points. */
const SPOT = { x: 0.5, y: 0.55 };

async function openOutline(page: Page) {
  // A page before the editor, so a browser Back would leave it: the point-stepping
  // chord (Alt+arrow) doubles as Back/Forward in Chrome on Windows and Linux.
  await page.goto('/');
  await page.goto('/app');
  await editorReady(page);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const position = { x: box.width * SPOT.x, y: box.height * SPOT.y };
  return { canvas, position };
}

test('a reference point is added, selected, stepped and saved with the board', async ({ page }) => {
  const { canvas, position } = await openOutline(page);
  const editor = page.getByLabel('Reference point editor');

  await canvas.click({ button: 'right', position });
  await page.getByRole('menuitem', { name: 'Add reference point' }).click();
  await expect(editor).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await canvas.click({ position });
  await expect(editor).toBeVisible();

  // Stepping with one point selects it again; it must not navigate the browser.
  const url = page.url();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowRight');
  expect(page.url()).toBe(url);
  await expect(editor).toBeVisible();

  await page.getByLabel('Reference point label').fill('wide point');
  await page.getByLabel('Reference point label').press('Enter');

  await menu(page, 'File').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Save\b/ }).click(),
  ]);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(saved.referencePoints).toEqual([
    expect.objectContaining({ plane: 'outline', label: 'wide point' }),
  ]);

  // The autosaved session brings it back after a reload.
  await page.waitForTimeout(1500);
  await page.reload();
  await editorReady(page);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await canvas.click({ position });
  await expect(editor).toBeVisible();
  await expect(page.getByLabel('Reference point label')).toHaveValue('wide point');

  await page.keyboard.press('Delete');
  await expect(editor).toBeHidden();
  await canvas.click({ position });
  await expect(editor).toBeHidden();
});

test('locked points do not drag; unlocked ones do', async ({ page }) => {
  const { canvas, position } = await openOutline(page);
  await canvas.click({ button: 'right', position });
  await page.getByRole('menuitem', { name: 'Add reference point' }).click();
  const x = page.getByLabel('Reference point X');
  const before = await x.inputValue();

  const box = (await canvas.boundingBox())!;
  const dragBy = async () => {
    await page.mouse.move(box.x + position.x, box.y + position.y);
    await page.mouse.down();
    await page.mouse.move(box.x + position.x + 40, box.y + position.y, { steps: 4 });
    await page.mouse.up();
  };

  await dragBy();
  await expect(x).toHaveValue(before);

  await menu(page, 'View').click();
  await page.getByRole('menuitemcheckbox', { name: 'Unlock reference points' }).click();
  await dragBy();
  await expect(x).not.toHaveValue(before);
});

test('the measurement table generates stations and shows them on the board', async ({ page }) => {
  await page.goto('/app');
  await editorReady(page);
  await openSection(page, 'Reference points');
  await page.getByLabel(/^Station spacing/).fill('30');
  await page.getByRole('button', { name: 'Generate stations' }).click();
  await expect(page.getByRole('status')).toHaveText(/\d+ points added\./);
  await expect(page.getByLabel('Width 1', { exact: true })).toBeVisible();

  // Editing a row selects its point, which the outline view's header then shows.
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await page.getByLabel('Width 1', { exact: true }).fill('500');
  await page.getByLabel('Width 1', { exact: true }).press('Enter');
  await expect(page.getByLabel('Reference point editor')).toBeVisible();
});

test('the 3D view draws reference points without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { canvas, position } = await openOutline(page);
  await canvas.click({ button: 'right', position });
  await page.getByRole('menuitem', { name: 'Add reference point' }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForTimeout(1500);
  const shot = test.info().outputPath('reference-points-3d.png');
  await page.locator('canvas').first().screenshot({ path: shot });
  await test.info().attach('reference-points-3d', { path: shot, contentType: 'image/png' });
  expect(errors).toEqual([]);
});
