import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * The experimental NURBS viewer (docs/design/board2.md, "V1 viewer"): with
 * `?engine=nurbs` the 3D view converts the board in a worker (10 to 20 s) and shows
 * the NURBS surface under a read-only badge; without the flag the app has none of it.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !/webgl|WebGL|GPU/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const open3D = async (page: Page) => {
  await editorReady(page);
  await page.getByRole('button', { name: /^3D$/ }).first().click();
};

test.describe('NURBS viewer, flag on', () => {
  test.setTimeout(240_000);

  test('converts the sample board, shows the badge and a rendered canvas', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app?engine=nurbs');
    await open3D(page);

    const badge = page.getByTestId('nurbs-badge');
    await expect(badge).toHaveText('NURBS (experimental) — read-only');
    // The classic mesh is on screen while the conversion runs.
    await expect(page.getByTestId('nurbs-status')).toContainText(/settle|Converting to NURBS/);

    await expect(badge).toHaveAttribute('data-phase', 'ready', { timeout: 200_000 });
    await expect(badge).toHaveAttribute('data-showing', 'nurbs');
    await expect(page.getByTestId('nurbs-status')).toHaveText('Showing the NURBS surface');

    // Exact analysis on the NURBS surface, and the deviation from classic.
    const analysis = page.getByTitle(/^Surface analysis/);
    await analysis.selectOption({ label: 'Mean curvature' });
    await expect(page.getByRole('status', { name: 'Mean curvature legend' })).toContainText(
      'Convex',
    );
    await analysis.selectOption({ label: 'Deviation from classic' });
    await expect(page.getByRole('status', { name: 'Deviation from classic legend' })).toContainText(
      'On this board',
    );

    // The classic mesh is one click away, and the details popover lists the findings.
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await expect(badge).toHaveAttribute('data-showing', 'classic');
    await page.getByRole('button', { name: 'NURBS conversion details' }).click();
    await expect(page.getByTestId('nurbs-info')).toContainText('Outline fit');

    // A canvas with real pixels: not blank.
    const painted = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 0 && c.height > 0;
    });
    expect(painted).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('NURBS viewer, layer chunk unavailable', () => {
  // The setting persists, so a layer chunk that will not load (offline, or removed by a
  // deploy) must never take the editor down: the classic view stays and a note says why.
  test('the editor still loads and shows a note when the layer cannot be fetched', async ({
    page,
  }) => {
    await page.route(/nurbs-layer/, (route) => route.abort());
    await page.goto('/app?engine=nurbs');
    await open3D(page);
    await expect(page.getByTestId('nurbs-unavailable')).toHaveText(
      'NURBS viewer unavailable (offline?)',
    );
    await expect(page.getByText(/Something didn't load/)).toHaveCount(0);
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('nurbs-badge')).toHaveCount(0);
  });
});

test.describe('NURBS viewer, flag off', () => {
  test('the default app has no NURBS UI and no NURBS code requests', async ({ page }) => {
    const errors = trackErrors(page);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto('/app');
    await open3D(page);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('nurbs-badge')).toHaveCount(0);
    await expect(page.getByTestId('nurbs-layer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Classic', exact: true })).toHaveCount(0);
    const options = await page
      .getByTitle(/^Surface analysis/)
      .locator('option')
      .allTextContents();
    expect(options.join('|')).not.toContain('Deviation from classic');
    expect(
      requests.filter((u) =>
        /nurbs-(layer|client|viewer|core|worker|surface)|packages\/(board2|geom)\//i.test(u),
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Settings offers the engine toggle, off by default', async ({ page }) => {
    await page.goto('/app');
    await editorReady(page);
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    const box = page.getByLabel('Engine: NURBS (experimental)');
    await expect(box).not.toBeChecked();
  });
});
