import { readFileSync } from 'node:fs';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * The experimental NURBS viewer on the section model (docs/design/m1-model.md §3): with
 * `?engine=nurbs` the 3D view converts the board in a worker (tens of milliseconds) and
 * shows the NURBS surface under a read-only badge, updates it on every classic edit,
 * explains a board it refuses, and offers board2's test boards; without the flag the app
 * has none of it.
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

const updateCount = async (page: Page): Promise<number> =>
  Number((await page.getByTestId('nurbs-badge').getAttribute('data-update')) ?? 0);

test.describe('NURBS viewer, flag on', () => {
  test.setTimeout(120_000);

  test('shows the NURBS hull of the sample board with the badge and a rendered canvas', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/app?engine=nurbs');
    await open3D(page);

    const badge = page.getByTestId('nurbs-badge');
    await expect(badge).toHaveText('NURBS (experimental) — read-only');
    await expect(badge).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
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
    await analysis.selectOption({ label: 'Zebra' });

    // The classic mesh is one click away, and the details popover lists the findings.
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await expect(badge).toHaveAttribute('data-showing', 'classic');
    await page.getByRole('button', { name: 'NURBS conversion details' }).click();
    await expect(page.getByTestId('nurbs-info')).toContainText('Station fit');
    await expect(page.getByTestId('nurbs-info')).toContainText('Volume');

    // A canvas with real pixels: not blank.
    const painted = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 0 && c.height > 0;
    });
    expect(painted).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a classic edit updates the NURBS surface at once, with no quiet period', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/app?engine=nurbs');
    await editorReady(page);
    await page.keyboard.press('1'); // quad: the outline editor beside the 3D view
    const badge = page.getByTestId('nurbs-badge');
    await expect(badge).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
    await expect(badge).toHaveAttribute('data-showing', 'nurbs');

    const box = (await page.locator('canvas').first().boundingBox())!;
    const L = 187.96;
    const s = (box.width - 48) / L;
    const wide = { x: box.x + 24 + 90.13362308681752 * s, y: box.y + box.height / 2 - 23.49 * s };
    const knot = [wide, { x: wide.x, y: box.y + box.height / 2 + 23.49 * s }];
    let from: { x: number; y: number } | null = null;
    for (const c of knot) {
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.up();
      if (
        await page
          .getByLabel(/ position editor$/)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        from = c;
        break;
      }
    }
    expect(from).not.toBeNull();

    const before = await updateCount(page);
    await page.mouse.move(from!.x, from!.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from!.x + i, from!.y - i * 0.6);
      await page.waitForTimeout(40);
    }
    // Updates arrive while the button is still down: the edit is not "settled" yet.
    await expect.poll(() => updateCount(page), { timeout: 10_000 }).toBeGreaterThan(before + 2);
    await expect(badge).toHaveAttribute('data-ladders-reused', 'true');
    await page.mouse.up();
    // The gesture's end re-derives the ladders.
    await expect(badge).toHaveAttribute('data-ladders-reused', 'false', { timeout: 10_000 });
    await expect(badge).toHaveAttribute('data-showing', 'nurbs');
    expect(errors).toEqual([]);
  });

  test('the test-board picker shows a board2 test board in every analysis mode', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/app?engine=nurbs');
    await open3D(page);
    const badge = page.getByTestId('nurbs-badge');
    await expect(badge).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });

    const picker = page.getByTestId('nurbs-test-board');
    await picker.selectOption({ label: 'Swallow' });
    await expect(badge).toHaveAttribute('data-test-board', 'swallow', { timeout: 30_000 });
    await expect(page.getByTestId('nurbs-status')).toHaveText('Showing the swallow test board');

    const analysis = page.getByTitle(/^Surface analysis/);
    await analysis.selectOption({ label: 'Mean curvature' });
    await expect(page.getByRole('status', { name: 'Mean curvature legend' })).toContainText(
      'Convex',
    );
    await analysis.selectOption({ label: 'Zebra' });

    await picker.selectOption({ label: 'Asymmetric' });
    await expect(badge).toHaveAttribute('data-test-board', 'asymmetric', { timeout: 30_000 });
    await page.getByRole('button', { name: 'NURBS conversion details' }).click();
    await expect(page.getByTestId('nurbs-info')).toContainText('test boards');

    await picker.selectOption({ label: 'My board' });
    await expect(badge).not.toHaveAttribute('data-test-board', /.+/, { timeout: 30_000 });
    await expect(page.getByTestId('nurbs-status')).toHaveText('Showing the NURBS surface');
    expect(errors).toEqual([]);
  });

  test('a board the converter refuses shows the reason and falls back to the classic mesh', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/app?engine=nurbs');
    await open3D(page);
    const badge = page.getByTestId('nurbs-badge');
    await expect(badge).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });

    // A synthetic file whose deck dips below its rocker (every 6.985 cm deck height becomes -3 cm):
    // no surface can hold that, whatever the classic editor does with it.
    const fixture = readFileSync(
      '../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx',
      'utf8',
    );
    const dipped = fixture.split('<z>6.985</z>').join('<z>-3</z>');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'deck-below-rocker.s3dx',
        mimeType: 'text/xml',
        buffer: Buffer.from(dipped),
      });
    await page
      .getByRole('button', { name: 'Import anyway' })
      .click({ timeout: 3000 })
      .catch(() => {});
    await expect(badge).toHaveAttribute('data-phase', 'failed', { timeout: 30_000 });
    await expect(badge).toHaveAttribute('data-showing', 'classic');
    await expect(page.getByTestId('nurbs-status')).toContainText('classic shown');
    await page.getByRole('button', { name: 'NURBS conversion details' }).click();
    await expect(page.getByTestId('nurbs-refusal')).toContainText('cannot hold this board yet');
    await expect(page.getByTestId('nurbs-info')).toContainText('no thickness');
    // The classic 3D view is still there.
    await expect(page.locator('canvas').first()).toBeVisible();
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
