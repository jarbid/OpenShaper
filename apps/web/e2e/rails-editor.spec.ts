import { readFileSync } from 'node:fs';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * The rails board as the document (rails-engine.ts): with the NURBS and rails switches on, a template is
 * converted to a rails board, the outline and a station's deck and bottom curves are edited, a station is
 * added, undo steps back, the board is saved and reopened as the same text, and an STL is exported. The 3D
 * model updates after each edit and nothing logs an error.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !/webgl|WebGL|GPU/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });
const badge = (page: Page) => page.getByTestId('nurbs-badge');
const updates = async (page: Page): Promise<number> =>
  Number((await badge(page).getAttribute('data-update')) ?? 0);

/** Wait until the 3D model has been rebuilt more than `since` times. */
const rebuilt = (page: Page, since: number) =>
  expect.poll(() => updates(page), { timeout: 20_000 }).toBeGreaterThan(since);

async function savedText(page: Page): Promise<string> {
  await menu(page, 'File').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Save\b/ }).click(),
  ]);
  return readFileSync((await download.path())!, 'utf8');
}

/**
 * Click on a grid of points over canvas `pane` of the quad view until a control point (of the wanted
 * station curve, if one is named) is selected; leave it selected.
 */
async function selectPoint(
  page: Page,
  pane: number,
  _curve?: 'deck' | 'bottom',
  fxRange: [number, number] = [0.04, 0.97],
): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas').nth(pane).boundingBox())!;
  for (let fy = 0.06; fy < 0.95; fy += 0.025) {
    for (let fx = fxRange[0]; fx < fxRange[1]; fx += 0.02) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      await page.mouse.click(x, y);
      if (
        !(await page
          .getByLabel(/ position editor$/)
          .first()
          .isVisible()
          .catch(() => false))
      )
        continue;
      return { x, y };
    }
  }
  throw new Error(`no point found on pane ${pane} ${_curve ?? ''}`);
}

async function drag(page: Page, from: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    // both ways: a point held on one axis (a handle on the stringer) still moves on the other
    await page.mouse.move(from.x + (Math.abs(dy) * i) / 8, from.y + (dy * i) / 8);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

test.describe('the rails board as the document', () => {
  test.setTimeout(240_000);

  test('edit, add a station, undo, save, reopen, export', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');
    await editorReady(page);

    // both switches on, through Settings
    await menu(page, 'Edit').click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.getByLabel('Engine: NURBS (experimental)').check();
    await page.getByLabel('Rails engine (experimental)').check();
    await page.getByRole('button', { name: 'Apply' }).click();

    // a template, converted into the rails board
    await menu(page, 'File').click();
    await page.getByRole('menuitem', { name: 'Funboard', exact: true }).click();
    await page.keyboard.press('1');
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
    await expect(badge(page)).toHaveText('NURBS (experimental) — editing');
    let n = await updates(page);

    // an outline point
    const hit = await selectPoint(page, 0);
    await drag(page, hit, -10);
    await rebuilt(page, n);
    n = await updates(page);

    // the cross-section tab: a deck point, then a bottom point
    await expect(page.getByRole('group', { name: 'Curve to edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deck' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const deck = await selectPoint(page, 1, 'deck', [0.6, 0.88]);
    await drag(page, deck, -12);
    await rebuilt(page, n);
    n = await updates(page);
    await page.getByRole('button', { name: 'Bottom' }).click();
    await expect(page.getByRole('button', { name: 'Bottom' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const bottom = await selectPoint(page, 1, 'bottom', [0.6, 0.88]);
    await drag(page, bottom, 10);
    await rebuilt(page, n);
    n = await updates(page);

    // a station added (the header shows the point editor, not the controls, while a point is selected)
    const pane = (await page.locator('canvas').nth(1).boundingBox())!;
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
