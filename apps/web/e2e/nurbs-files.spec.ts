import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { editorReady, openSection } from './helpers';

/**
 * Files, templates and session for the NURBS engine (docs/design/m2-editor.md §5, step 5): a template
 * edited and reloaded comes back as the same document, a classic `.brd` opened with the engine on is
 * converted and saved as a version 3 file, and a version 3 file opened with the engine off asks how.
 * "The same document" is checked on the saved file's text, byte for byte.
 */
const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });

/** File ▸ Save, and the text of the file it downloads. */
async function savedText(page: Page): Promise<string> {
  await menu(page, 'File').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Save\b/ }).click(),
  ]);
  return readFileSync((await download.path())!, 'utf8');
}

const badge = (page: Page) => page.getByTestId('nurbs-badge');

test.describe('NURBS files', () => {
  test.setTimeout(120_000);

  test('a template, edited and reloaded, is the same document', async ({ page }) => {
    await page.goto('/app?engine=nurbs');
    await editorReady(page);
    await page.keyboard.press('1');
    await expect(badge(page)).toHaveAttribute('data-source', 'doc', { timeout: 30_000 });

    await menu(page, 'File').click();
    await page.getByRole('menuitem', { name: 'Fish shortboard', exact: true }).click();
    // the template is open when the Board shape section shows its tail
    await openSection(page, 'Board shape');
    await expect(
      page.getByRole('group', { name: 'Tail type' }).getByRole('button', { name: 'Fish' }),
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });

    // Edit it: a double concave, which the classic file could not hold.
    await openSection(page, 'Bottom features');
    await page.getByRole('button', { name: 'Double concave', exact: true }).click();
    await expect(page.getByRole('group', { name: /^Double concave/ })).toBeVisible();

    const before = await savedText(page);
    expect(before).toContain('"notched"');
    expect(before).toContain('"concave"');
    expect(before).toContain('"name": "Fish shortboard"');

    // The autosave is debounced and flushed when the page is hidden; give it a moment, then reload.
    await page.waitForTimeout(1500);
    await page.reload();
    await editorReady(page);
    await expect(badge(page)).toHaveAttribute('data-source', 'doc', { timeout: 30_000 });
    expect(await savedText(page)).toBe(before);
  });

  test('a .brd opened with the engine on is converted and saved as a version 3 file', async ({
    page,
  }) => {
    await page.goto('/app?engine=nurbs');
    await editorReady(page);
    await expect(badge(page)).toHaveAttribute('data-source', 'doc', { timeout: 30_000 });

    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'my-funboard.brd',
        mimeType: 'application/octet-stream',
        buffer: readFileSync('src/funboard.brd'),
      });
    await expect(badge(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
    await expect(badge(page)).toHaveAttribute('data-source', 'doc');

    const text = await savedText(page);
    const doc = JSON.parse(text) as { version: number; model: string; stations: unknown[] };
    expect(doc.version).toBe(3);
    expect(doc.model).toBe('sections');
    expect(doc.stations.length).toBeGreaterThan(2);
    // the specs in the sidebar are measured on the NURBS mesh
    await expect(page.getByTestId('engine-refusal')).toHaveCount(0);
  });

  test('a version 3 file opened with the engine off asks, then opens as a copy or in the engine', async ({
    page,
  }) => {
    const file = readFileSync('src/templates/swallow-shortboard.board', 'utf8');
    const pick = () =>
      page
        .locator('input[type=file]')
        .first()
        .setInputFiles({
          name: 'swallow.board',
          mimeType: 'application/json',
          buffer: Buffer.from(file),
        });

    await page.goto('/app');
    await editorReady(page);
    await pick();
    const prompt = page.getByRole('dialog', { name: 'Open NURBS board?' });
    await expect(prompt).toContainText('This board uses the NURBS engine');
    await expect(prompt).toContainText('Swallow shortboard');

    // A classic copy: the classic editors, none of the NURBS UI, the file untouched.
    await prompt.getByRole('button', { name: 'Open a classic copy' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
    await expect(page.getByText('Opened a classic copy')).toBeVisible();

    // Again, and this time turn the engine on: the board opens as it was written.
    await pick();
    await prompt.getByRole('button', { name: 'Turn on and open' }).click();
    await page.keyboard.press('1');
    await expect(badge(page)).toHaveAttribute('data-source', 'doc', { timeout: 30_000 });
    await expect(badge(page)).toHaveAttribute('data-phase', 'ready');
    expect(await savedText(page)).toBe(file);
  });
});
