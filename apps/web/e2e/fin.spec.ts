// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * The fin designer (/fin), end to end: one design session the way a shaper runs it —
 * pick a fin, set its numbers, choose a foil, place it on the tab, export it for CNC
 * and printing, save it, open it again, and find it still there after a reload.
 * (docs/design/fin-designer.md, step 17.)
 *
 * Dragging points on the canvases is covered by the component tests
 * (fin-curve-editor.test.tsx, fin-panes.test.tsx), which find a point by probing
 * rather than by hard-coded pixels; a pixel-coordinate drag here would only test the
 * current layout.
 */

const measurement = (page: Page, label: string) =>
  page
    .getByLabel('Fin measurements')
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');

async function openFin(page: Page) {
  await page.goto('/fin');
  await expect(page.getByRole('img', { name: 'Profile' })).toBeVisible();
  await expect(page.getByLabel('Fin measurements')).toContainText('mm²');
}

/** Start a new fin from the header's New fin menu. */
async function pickNewFin(page: Page, label: string) {
  await page.getByRole('menuitem', { name: 'New fin' }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

/** Press the save dialog's `action` button, after typing `name` in its first field if given. */
async function confirmSave(page: Page, action: 'Save' | 'Export', name?: string) {
  const dialog = page.getByRole('dialog');
  if (name !== undefined) await dialog.getByRole('textbox').first().fill(name);
  await dialog.getByRole('button', { name: action, exact: true }).click();
}

/** Save the fin through the save dialog. */
async function saveVia(page: Page, name?: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await confirmSave(page, 'Save', name);
}

/** Export through the Export menu's item `item` and the save dialog. */
async function exportVia(page: Page, item: string, name?: string) {
  await (await exportItem(page, item)).click();
  await confirmSave(page, 'Export', name);
}

/** The Export menu's item `name`, the menu opened first if it is closed. */
async function exportItem(page: Page, name: string) {
  const item = page.getByRole('menuitem', { name, exact: true });
  if (!(await item.isVisible())) await page.getByRole('menuitem', { name: /^Export/ }).click();
  return item;
}

/** Type into a labelled number field and commit it, as a user does. */
async function setField(page: Page, label: RegExp, value: string) {
  const field = page.getByLabel(label);
  await field.fill(value);
  await field.press('Enter');
}

test.describe('Fin designer', () => {
  test('a design session: shape, place, export, save, reopen', async ({ page }) => {
    await openFin(page);

    // Start from a right-hand side fin and size it.
    await pickNewFin(page, 'Side, right');
    await expect(page.getByRole('button', { name: 'Right', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await setField(page, /^Depth/, '110');
    await expect(measurement(page, 'Depth')).toHaveText('110.0 mm');
    await setField(page, /Cant/, '6');
    // Each view's controls come with it into the large pane.
    await page.getByRole('button', { name: 'Show Thickness in the large pane' }).click();
    await setField(page, /Base thickness/, '7.5');

    // A cambered NACA foil.
    await page.getByRole('button', { name: 'Show Foil in the large pane' }).click();
    await page.getByLabel('NACA preset').selectOption('2410');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByLabel('Inside share of the thickness (%)')).toBeVisible();

    // Nudge it forward on the tab, then undo the second nudge.
    const overhang = measurement(page, 'Front overhang');
    const start = await overhang.textContent();
    await page.getByRole('button', { name: 'Move the fin forward' }).click();
    await page.keyboard.press('ArrowUp');
    const twice = await overhang.textContent();
    expect(twice).not.toBe(start);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(overhang).not.toHaveText(twice!);

    // No rule broken, so export is open. STEP for CNC: two solids, in mm.
    await expect(page.getByRole('status')).toHaveCount(0);
    const [step] = await Promise.all([
      page.waitForEvent('download'),
      exportVia(page, 'STEP for CNC'),
    ]);
    expect(step.suggestedFilename()).toBe('fin-side-right.step');
    const stepText = await readFile((await step.path())!, 'utf8');
    expect(stepText.startsWith('ISO-10303-21;')).toBe(true);
    expect(stepText.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
    expect(stepText).toContain('.MILLI.');

    // STL for printing.
    const [stl] = await Promise.all([
      page.waitForEvent('download'),
      exportVia(page, 'STL for 3D printing'),
    ]);
    expect(stl.suggestedFilename()).toBe('fin-side-right.stl');
    const stlBytes = await readFile((await stl.path())!);
    const triangles = stlBytes.readUInt32LE(80);
    expect(stlBytes.length).toBe(84 + 50 * triangles);

    // Save the design, start a different fin, and open the saved one back.
    const [saved] = await Promise.all([page.waitForEvent('download'), saveVia(page)]);
    expect(saved.suggestedFilename()).toBe('fin-side-right.fin.json');
    const savedPath = (await saved.path())!;
    await pickNewFin(page, 'Centre');
    await expect(page.getByText(/^Centre fin/)).toBeVisible();
    await page.getByLabel('Open a fin file').setInputFiles(savedPath);
    await expect(page.getByText(/^Side fin/)).toBeVisible();
    await expect(measurement(page, 'Depth')).toHaveText('110.0 mm');
    await expect(page.getByLabel(/Cant/)).toHaveValue('6.0');

    // The autosave keeps it through a reload.
    await page.waitForTimeout(1200); // past the autosave's debounce
    await page.reload();
    await expect(page.getByRole('img', { name: 'Profile' })).toBeVisible();
    await expect(measurement(page, 'Depth')).toHaveText('110.0 mm');
    await expect(page.getByLabel('Inside share of the thickness (%)')).toBeVisible();
  });

  test('a foil slice: add, shape, export, save and reopen', async ({ page }) => {
    await openFin(page);
    await page.getByRole('button', { name: 'Add control section' }).click();
    await page.getByRole('button', { name: 'Show Foil in the large pane' }).click();
    const tabs = page.getByRole('tablist', { name: 'Foil' });
    await expect(tabs.getByRole('tab')).toHaveText(['Base', 'Tip', '62.0 mm']);
    await page.getByLabel('NACA preset').selectOption('0008');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('status')).toHaveCount(0); // no rule broken

    const [step] = await Promise.all([
      page.waitForEvent('download'),
      exportVia(page, 'STEP for CNC'),
    ]);
    expect(
      (await readFile((await step.path())!, 'utf8')).match(/MANIFOLD_SOLID_BREP\(/g),
    ).toHaveLength(2);

    const [saved] = await Promise.all([page.waitForEvent('download'), saveVia(page)]);
    const savedPath = (await saved.path())!;
    expect(JSON.parse(await readFile(savedPath, 'utf8')).version).toBe(3);
    await pickNewFin(page, 'Centre');
    await expect(tabs.getByRole('tab')).toHaveText(['Base', 'Tip']); // no slices
    await page.getByLabel('Open a fin file').setInputFiles(savedPath);
    await expect(tabs.getByRole('tab')).toHaveText(['Base', 'Tip', '62.0 mm']);
  });

  test('a canard on the FCS single tab exports for CNC', async ({ page }) => {
    await openFin(page);
    await pickNewFin(page, 'Canard, left (FCS single)');
    await expect(page.getByLabel('Tab', { exact: true })).toHaveValue('fcs-single');
    await expect(page.getByLabel(/^Cant/)).toBeDisabled();
    await expect(page.getByRole('status')).toHaveCount(0);
    const [step] = await Promise.all([
      page.waitForEvent('download'),
      exportVia(page, 'STEP for CNC', 'canard-left'),
    ]);
    expect(step.suggestedFilename()).toBe('canard-left.step');
    expect(
      (await readFile((await step.path())!, 'utf8')).match(/MANIFOLD_SOLID_BREP\(/g),
    ).toHaveLength(2);
  });

  test('exports a left and a right fin with the option ticked', async ({ page }) => {
    await openFin(page);
    await (await exportItem(page, 'STEP for CNC')).isVisible();
    await page.getByRole('menuitemcheckbox', { name: /^Left and right fin/ }).click();
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await exportVia(page, 'STL for 3D printing');
    await expect.poll(() => downloads.length).toBe(2);
    expect(downloads.sort()).toEqual(['fin-side-left.stl', 'fin-side-right.stl']);
  });

  test('explains a foil a centre fin cannot take', async ({ page }) => {
    await openFin(page);
    await pickNewFin(page, 'Centre');
    await page.getByRole('button', { name: 'Show Foil in the large pane' }).click();
    await page.getByLabel('NACA preset').selectOption('other');
    await page.getByLabel('NACA 4-digit code').fill('2412');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('alert')).toContainText('symmetric');
    await expect(page.getByText('— inside')).toHaveCount(0); // still symmetric
  });

  test('refuses to export a fin that breaks a rule, and says why', async ({ page }) => {
    await openFin(page);
    // A file can hold a fin that breaks a rule (saved mid-edit, or hand-edited): here
    // a side fin's cant is set past the 20° limit, then opened.
    const [saved] = await Promise.all([page.waitForEvent('download'), saveVia(page)]);
    const doc = JSON.parse(await readFile((await saved.path())!, 'utf8')) as { cant: number };
    doc.cant = 30;
    await page.getByLabel('Open a fin file').setInputFiles({
      name: 'too-much-cant.fin.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await expect(page.getByRole('status')).toContainText('Cant must be 0° to 20°');
    await expect(await exportItem(page, 'STEP for CNC')).toBeDisabled();
    await expect(await exportItem(page, 'STL for 3D printing')).toBeDisabled();
    await page.keyboard.press('Escape');
    // Fixing it opens export again.
    await setField(page, /Cant/, '12');
    await expect(await exportItem(page, 'STEP for CNC')).toBeEnabled();
  });

  test('links to its documentation', async ({ page }) => {
    await openFin(page);
    await page.getByRole('link', { name: 'Help' }).click();
    await expect(page.getByRole('heading', { name: 'OpenFinShaper help', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'fin designer', exact: true })).toHaveAttribute(
      'href',
      '/fin',
    );
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('shows the panes and exports', async ({ page }) => {
      await openFin(page);
      await expect(page.getByRole('img', { name: 'Foil' })).toBeAttached();
      await expect(page.getByRole('img', { name: 'Thickness' })).toBeAttached();
      const [stl] = await Promise.all([
        page.waitForEvent('download'),
        exportVia(page, 'STL for 3D printing'),
      ]);
      expect(stl.suggestedFilename()).toMatch(/\.stl$/);
    });
  });
});
