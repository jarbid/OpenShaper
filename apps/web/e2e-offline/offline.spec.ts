import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Offline behaviour of the /app editor.
 *
 * The product rule these specs encode: the editor works with no network, and
 * everything else keeps working exactly as if there were no service worker —
 * real pages online, a branded fallback offline, nothing marketing-related ever
 * cached. See docs/design/offline.md.
 *
 * These use the canonical `/app` (no trailing slash), which is what Cloudflare
 * serves and what the precache is keyed on — tools/serve-dist.mjs reproduces
 * that behaviour so the specs exercise the real URL.
 */
const APP = '/app';

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

/** Load the editor and wait until the worker controls the page and the precache is populated. */
async function warmServiceWorker(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => {
    const key = (await caches.keys()).find((n) => n.includes('precache'));
    if (!key) return false;
    return (await (await caches.open(key)).keys()).length > 20;
  });
}

test.describe('offline editor', () => {
  test('the editor still loads and computes with the network cut', async ({ page, context }) => {
    await warmServiceWorker(page);
    const errors = trackErrors(page);

    await context.setOffline(true);
    await page.reload();

    // The live spec readouts only appear once the board is parsed and the specs
    // worker has answered — so this asserts the whole offline path, not just HTML.
    await expect(page.getByText(/Length/i).first()).toBeVisible();
    await expect(page.getByText(/Volume/i).first()).toBeVisible();
    await expect(page.getByText(/Unexpected Application Error/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('marketing routes fall back to the branded offline page', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(true);

    // A cold document navigation in a fresh tab is what exercises the worker's
    // catch handler; navigating inside the already-loaded editor is handled by
    // the client router from precached chunks instead.
    const fresh = await context.newPage();
    await fresh.goto('/about').catch(() => {
      /* offline navigations may reject even when the SW answers */
    });

    await expect(fresh).toHaveTitle(/Offline/i);
    await expect(fresh.getByRole('heading', { level: 1 })).toContainText(/You're offline/i);
    await expect(fresh.getByRole('link', { name: /design app/i })).toHaveAttribute('href', '/app');
  });

  test('marketing routes serve real content when online', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(false);

    // Guards the classic navigateFallback bug, where the worker serves a cached
    // shell to routes it should have left alone.
    await page.goto('/about');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/building things/i);
    await expect(page.getByText(/You're offline/i)).toHaveCount(0);
  });

  test('unknown paths still 404 rather than being served the editor shell', async ({
    page,
    context,
  }) => {
    await warmServiceWorker(page);

    // The site has no SPA catch-all: a too-broad navigation route in the worker
    // would silently turn every 404 into the editor.
    const online = await page.goto('/nope');
    expect(online?.status()).toBe(404);

    await context.setOffline(true);
    const fresh = await context.newPage();
    await fresh.goto('/nope').catch(() => {});
    await expect(fresh).toHaveTitle(/Offline/i);
  });

  test('only the editor is cached — no marketing HTML or guide images', async ({ page }) => {
    await warmServiceWorker(page);

    const cached = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) {
          paths.push(new URL(req.url).pathname);
        }
      }
      return paths;
    });

    expect(cached).toContain('/app');
    expect(cached).toContain('/offline.html');
    expect(cached.filter((p) => p.startsWith('/images/'))).toEqual([]);
    expect(cached.filter((p) => /^\/(about|privacy|surfboard-|build-a-)/.test(p))).toEqual([]);
    // Both module workers must be precached or the editor loses live specs / 3D offline.
    expect(cached.some((p) => /specs-worker/.test(p))).toBe(true);
    expect(cached.some((p) => /tessellate\.worker/.test(p))).toBe(true);
  });
});
