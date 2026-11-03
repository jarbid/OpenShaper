import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * Exports from the NURBS document (docs/design/m3-exports.md, steps 1 and 2): with the engine on, STL, DXF,
 * STEP and the 1:1 PDF each download a non-empty file of the right type, made in the export worker, and lose the
 * "(classic projection)" label; the exports that are still the projection keep it.
 */
const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });

async function openEngineEditor(page: Page) {
  await page.goto('/app?engine=nurbs');
  await editorReady(page);
  await expect(page.getByTestId('nurbs-badge')).toHaveAttribute('data-source', 'doc', {
    timeout: 30_000,
  });
}

test.describe('NURBS exports', () => {
  test.setTimeout(120_000);

  test('the labels: only the projection exports say so', async ({ page }) => {
    await openEngineEditor(page);
    await menu(page, 'Export').click();
    for (const name of ['STL', 'DXF (polyline)', 'DXF (spline)', 'STEP (surfaces)…', 'PDF 1:1…']) {
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Rail bands (classic projection)…', 'Legacy .brd (classic projection)']) {
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
    }
  });

  test('STL downloads a binary STL of the surface', async ({ page }) => {
    await openEngineEditor(page);
    await menu(page, 'Export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'STL', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.stl$/);
    const bytes = readFileSync((await download.path())!);
    const facets = bytes.readUInt32LE(80);
    expect(facets).toBeGreaterThan(50_000);
    expect(bytes.length).toBe(84 + 50 * facets);
  });

  test('DXF downloads a drawing with the outline and sections', async ({ page }) => {
    await openEngineEditor(page);
    await menu(page, 'Export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'DXF (polyline)', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.dxf$/);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).toContain('ENTITIES');
    expect(text).toContain('CROSSSECTION');
    expect(text.trimEnd().endsWith('EOF')).toBe(true);
  });

  test('STEP downloads a solid made from the NURBS board', async ({ page }) => {
    await openEngineEditor(page);
    await menu(page, 'Export').click();
    await page.getByRole('menuitem', { name: 'STEP (surfaces)…', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.step$/);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    expect(text.length).toBeGreaterThan(50_000);
  });

  test('PDF 1:1 downloads a PDF from its dialog', async ({ page }) => {
    await openEngineEditor(page);
    await menu(page, 'Export').click();
    await page.getByRole('menuitem', { name: 'PDF 1:1…', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-1to1\.pdf$/);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(5_000);
  });
});
