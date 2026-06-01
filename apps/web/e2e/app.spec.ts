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

    // The sample board loads on mount; the Specs panel should show real values.
    await expect(page.getByText('Length')).toBeVisible();
    await expect(page.getByText('Volume')).toBeVisible();
    // Loading… should have been replaced by actual rows.
    await expect(page.getByText('Loading…')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('switches through all five views via tab buttons and number keys', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');

    for (const name of ['Quad', 'Outline', 'Rocker', 'Cross-section', '3D']) {
      await page.getByRole('button', { name, exact: true }).click();
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

  test('toggles units between inches and centimetres', async ({ page }) => {
    await page.goto('/app');
    const toggle = page.getByRole('button', { name: 'in', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: 'cm', exact: true })).toBeVisible();
  });

  test('drag on the outline canvas does not crash the app', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/app');
    await page.getByRole('button', { name: 'Outline', exact: true }).click();

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
