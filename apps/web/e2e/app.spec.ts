import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Collect console errors + uncaught page errors for the lifetime of a test so we
 * can assert that view/mode switching never throws. WebGL "context" warnings from
 * headless Chrome are filtered out — they are environmental, not app bugs.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !/webgl|WebGL|GPU/.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test.describe('OpenShaper marketing', () => {
  test('landing renders and links into the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /Design surfboards/i })).toBeVisible();
    // Primary CTA points at the editor route.
    await expect(page.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/app');
  });

  test('content pages load with their own headings', async ({ page }) => {
    await page.goto('/about');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/building things/i);

    await page.goto('/surfboard-design-guide');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Surfboard design/i);

    await page.goto('/surfboard-construction-methods');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/built/i);
  });
});

test.describe('OpenShaper editor', () => {
  test('loads the default board and shows live specs', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');

    // The sample board loads on mount and the Specs panel should show real values.
    //
    // Assert the computed numbers rather than the labels. "Length" and "Thickness"
    // each appear twice — the Specs readout and the Resize panel both use them — and
    // the Resize panel only renders once the specs worker returns, so a label lookup
    // passes or fails depending on how warm the dev server is. That is a flaky test,
    // which is worse than a failing one.
    const headline = page.getByRole('button', { name: 'Copy dimensions' });
    await expect(headline).toBeVisible();
    await expect(headline, 'the headline should carry real dimensions').toHaveText(/\d/);
    // Volume is the signature computed spec, and the only one of these labels that is
    // unambiguous (`exact` keeps it off the "Volume distribution" overlay toggle).
    await expect(page.getByText('Volume', { exact: true })).toBeVisible();
    // Loading… should have been replaced by actual rows.
    await expect(page.getByText('Loading…')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('switches through all five views via tab buttons and number keys', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');

    // Scoped to the view tab strip: the trace-image panel in the sidebar has its own
    // "Outline" and "Rocker" buttons, so an unscoped lookup matches two elements.
    const views = page.getByRole('group', { name: 'Views' });
    for (const name of ['Quad', 'Outline', 'Rocker', 'Cross-section', '3D']) {
      await views.getByRole('button', { name, exact: true }).click();
    }
    // Keyboard shortcuts 1–5 map to the same views.
    for (const key of ['1', '2', '3', '4', '5']) {
      await page.keyboard.press(key);
    }
    expect(errors).toEqual([]);
  });

  test('switches all four 3D render modes without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');
    await page.getByRole('button', { name: '3D', exact: true }).click();

    for (const mode of ['Shaded', '+Wire', 'Wire', 'Normals']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
    }
    expect(errors).toEqual([]);
  });

  test('switches the display unit, and every length follows it', async ({ page }) => {
    // Units were a pair of buttons once; they are a single picker now, and on a phone
    // it lives in the bottom sheet rather than the toolbar. What matters is not where
    // the control is but the rule it enforces (see apps/web/CLAUDE.md): no length is
    // ever shown in a fixed unit, so changing the picker must change the readout.
    await page.goto('/app');
    const units = page.getByLabel('Display units');
    await expect(units).toBeVisible();

    // The dimensions headline is the densest formatted length in the app and it has
    // an accessible name, so it is a stable thing to read the unit off.
    const headline = page.getByRole('button', { name: 'Copy dimensions' });

    await units.selectOption('cm');
    await expect(headline).toContainText('cm');

    await units.selectOption('in');
    await expect(headline).not.toContainText('cm');
    await expect(headline, 'inches should render as a quote mark').toContainText('"');
  });

  test('drag on the outline canvas does not crash the app', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');
    await page
      .getByRole('group', { name: 'Views' })
      .getByRole('button', { name: 'Outline', exact: true })
      .click();

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Drag across the middle of the editor; whether or not it grabs a control
      // point, the interaction path must not throw.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 5 });
      await page.mouse.up();
    }
    expect(errors).toEqual([]);
  });
});
