// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { editorReady } from './helpers';
import { badge, menu, seedSwitches, trackErrors } from './workspace-helpers';

/**
 * File > New board… (NewBoardDialog.tsx): with the NURBS and rails engines on, a gallery of kinds of board and
 * then a size. The board that is made is the starter template at that size, as the document, with an empty
 * undo history. Done with the pointer, with the keyboard alone, and on a tablet by touch.
 */

/** The dimensions the top bar's headline shows: the board's specs, in the editor's unit (millimetres here). */
const headline = (page: Page) => page.getByText(/ × .+ × /).first();

const gallery = (page: Page) => page.getByRole('dialog', { name: 'New board' });

async function openEditor(page: Page): Promise<void> {
  await seedSwitches(page);
  await page.goto('/app');
  await editorReady(page);
}

test.describe('File > New board…', () => {
  test.setTimeout(180_000);

  test('choose a kind, type a length and a width, and the board opens at that size', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openEditor(page);
    await expect(headline(page)).toContainText('1879.6 mm × 469.9 mm × 59.6 mm');

    // the gallery is the first thing under New, above the named boards
    await menu(page, 'File').click();
    await expect(page.getByRole('menu').getByRole('menuitem').first()).toHaveText('New board…');
    await expect(
      page.getByRole('menuitem', { name: 'Swallow shortboard', exact: true }),
    ).toBeVisible();
    await page.getByRole('menuitem', { name: 'New board…' }).click();

    await expect(gallery(page)).toBeVisible();
    const cards = gallery(page).getByRole('radio');
    await expect(cards).toHaveCount(5);
    await expect(gallery(page).getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(gallery(page).getByRole('button', { name: 'Create board' })).toBeDisabled();

    // a card says what the board is and the size it is drawn at, in the editor's unit
    const swallow = gallery(page).getByRole('radio', { name: 'Swallow shortboard' });
    await expect(swallow).toContainText('swallow tail');
    await expect(swallow).toContainText('1879.6 mm × 469.9 mm × 59.6 mm');
    await swallow.click();
    await expect(swallow).toBeChecked();

    // the size starts at the drawn size, with the range under each field
    const length = gallery(page).getByRole('textbox', { name: 'Length' });
    const width = gallery(page).getByRole('textbox', { name: 'Width' });
    await expect(length).toHaveValue('1879.6');
    await expect(width).toHaveValue('469.9');
    await expect(gallery(page).getByRole('textbox', { name: 'Thickness' })).toHaveValue('59.6');
    await expect(gallery(page).getByText('1625.6 mm to 2133.6 mm')).toBeVisible();

    await length.fill('1850');
    await width.fill('480');
    await gallery(page).getByRole('button', { name: 'Create board' }).click();

    // it is the document: the rails engine builds it, the dialog is gone and the specs are its own
    await expect(gallery(page)).toHaveCount(0);
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
    await expect(headline(page)).toContainText('1850.0 mm × 480.0 mm × 59.6 mm', {
      timeout: 30_000,
    });

    // and it starts with nothing to undo
    await menu(page, 'Edit').click();
    await expect(page.getByRole('menuitem', { name: /^Undo/ })).toBeDisabled();
    await page.keyboard.press('Escape');

    expect(errors).toEqual([]);
  });

  test('is done with the keyboard alone, and Escape gives the focus back to the File menu', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openEditor(page);

    // File, then its first item, New board…
    await menu(page, 'File').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'New board…' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(gallery(page)).toBeVisible();

    // the first card has the focus; the arrow keys move through the grid and choose
    const cards = gallery(page).getByRole('radio');
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(gallery(page).getByRole('radio', { name: 'Longboard' })).toBeChecked();
    await expect(gallery(page).getByRole('radio', { name: 'Longboard' })).toBeFocused();
    // Enter goes on to the size
    await page.keyboard.press('Enter');
    const length = gallery(page).getByRole('textbox', { name: 'Length' });
    await expect(length).toBeFocused();
    await expect(length).toHaveValue('2743.2');

    // a nudge, then a number typed past the end of the range is held to it, never refused
    await page.keyboard.press('ArrowUp');
    await expect(length).toHaveValue('2753.2');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('9000');
    await page.keyboard.press('Tab');
    await expect(gallery(page).getByRole('textbox', { name: 'Width' })).toBeFocused();
    await expect(length).toHaveValue('3352.8');
    await expect(gallery(page).getByRole('alert')).toHaveCount(0);

    // Escape closes it without making a board, and the focus is back on File
    await page.keyboard.press('Escape');
    await expect(gallery(page)).toHaveCount(0);
    await expect(menu(page, 'File')).toBeFocused();
    await expect(headline(page)).toContainText('1879.6 mm × 469.9 mm × 59.6 mm');

    // again, and Enter in a field makes the board
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(gallery(page)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('2300');
    await page.keyboard.press('Enter');
    await expect(gallery(page)).toHaveCount(0);
    await expect(headline(page)).toContainText('2300.0 mm × 546.1 mm × 69.8 mm', {
      timeout: 60_000,
    });
    expect(errors).toEqual([]);
  });

  test('is a sheet that fits a tablet, with touch targets of 44 px', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1023, height: 768 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await openEditor(page);
    await menu(page, 'File').tap();
    await page.getByRole('menuitem', { name: 'New board…' }).tap();
    await expect(gallery(page)).toBeVisible();
    await gallery(page).getByRole('radio', { name: 'Fish shortboard' }).tap();

    // the dialog is inside the screen, and all of what it has to ask is in reach
    const box = (await gallery(page).getByRole('button', { name: 'Create board' }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1023);
    const panel = (await gallery(page).locator('> div').first().boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.y + panel.height).toBeLessThanOrEqual(768);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1023,
    );
    await expect(gallery(page).getByRole('button', { name: 'Create board' })).toBeInViewport();

    // every control is 44 px each way, but for the text fields' width
    const small = await gallery(page).evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('button, input')]
        .map((el) => ({
          name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? '',
          h: Math.round(el.getBoundingClientRect().height),
          w: Math.round(el.getBoundingClientRect().width),
        }))
        .filter((t) => t.h < 44 || t.w < 44),
    );
    expect(small).toEqual([]);

    // and it makes the board by touch
    await gallery(page).getByRole('button', { name: 'Create board' }).tap();
    await expect(gallery(page)).toHaveCount(0);
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
    await context.close();
  });
});
