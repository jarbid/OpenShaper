import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { editorReady } from './helpers';
import {
  badge,
  divider,
  drag,
  drawing,
  entry,
  list,
  menu,
  rebuilt,
  savedText,
  selectPoint,
  trackErrors,
  updates,
} from './workspace-helpers';

/**
 * The rails board as the document (rails-engine.ts), edited in the workspace: with the NURBS and rails
 * switches on, a template is converted to a rails board and the editor is the design list over the board and
 * the drawing. The outline, then a station's deck curve and bottom curve are edited in their steps, a station
 * is added, undo steps back, the board is saved and reopened as the same text, and an STL is exported. The 3D
 * model updates after each edit and nothing logs an error.
 */
test.describe('the rails board as the document', () => {
  test.setTimeout(240_000);

  test('edit, add a station, undo, save, reopen, export', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');
    await editorReady(page);

    // both switches on, through Settings: how a person turns the workspace on
    await menu(page, 'Edit').click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.getByLabel('Engine: NURBS (experimental)').check();
    await page.getByLabel('Rails engine (experimental)').check();
    await page.getByRole('button', { name: 'Apply' }).click();

    // a template, converted into the rails board
    await menu(page, 'File').click();
    await page.getByRole('menuitem', { name: 'Funboard', exact: true }).click();
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
    await expect(badge(page)).toHaveText('NURBS (experimental) — editing');

    // the workspace, in place of the view tabs, opening on the outline
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Views' })).toHaveCount(0);
    await expect(entry(page, 'Outline')).toHaveAttribute('aria-current', 'step');
    await expect(divider(page)).toBeVisible();
    let n = await updates(page);

    // an outline point: a drag of it rebuilds the board
    const hit = await selectPoint(page, [0.04, 0.97], [0.14, 0.9]);
    await drag(page, hit, -10);
    await rebuilt(page, n);
    n = await updates(page);

    // Deck: the cross-section pane edits the station's deck curve, with no Deck | Bottom control to choose
    await entry(page, 'Deck').click();
    await expect(entry(page, 'Deck')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('heading', { name: 'Cross-section: deck' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Curve to edit' })).toHaveCount(0);
    const deck = await selectPoint(page, [0.6, 0.92]);
    await drag(page, deck, -12);
    await rebuilt(page, n);
    n = await updates(page);

    // Bottom: the slice and the plan from below; Edit curve shows the same pane, the bottom curve
    await entry(page, 'Bottom').click();
    await page.getByRole('button', { name: 'Edit curve' }).first().click();
    await expect(page.getByRole('heading', { name: 'Cross-section: bottom' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Curve to edit' })).toHaveCount(0);
    const bottom = await selectPoint(page, [0.6, 0.92]);
    await drag(page, bottom, 10);
    await rebuilt(page, n);
    n = await updates(page);

    // the steps have not written the cross-section tab's saved Deck | Bottom choice
    await page.waitForTimeout(800);
    const view = JSON.parse(
      await page.evaluate(() => localStorage.getItem('bs.viewState') ?? '{}'),
    );
    expect(view.railsCurve ?? 'deck').toBe('deck');

    // a station added (the header shows the point editor, not the controls, while a point is selected)
    const pane = (await drawing(page).boundingBox())!;
    await page.mouse.click(pane.x + 6, pane.y + 6);
    await page.getByRole('button', { name: 'Add cross-section' }).click();
    await rebuilt(page, n);
    n = await updates(page);

    // undo twice
    await page.keyboard.press('Control+z');
    await rebuilt(page, n);
    n = await updates(page);
    await page.keyboard.press('Control+z');
    await rebuilt(page, n);

    // save, reopen: the same text
    const saved = await savedText(page);
    expect(JSON.parse(saved)).toMatchObject({ model: 'rails' });
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'rails.board',
        mimeType: 'application/json',
        buffer: Buffer.from(saved),
      });
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 30_000 });
    await expect(list(page)).toBeVisible();
    expect(await savedText(page)).toBe(saved);

    // an STL of the rails board
    await menu(page, 'Export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'STL', exact: true }).click(),
    ]);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.length).toBe(84 + 50 * bytes.readUInt32LE(80));
    expect(bytes.readUInt32LE(80)).toBeGreaterThan(10_000);

    expect(errors).toEqual([]);
  });
});
