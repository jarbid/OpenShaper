import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Offline behaviour of the /fin designer, on the production build as Cloudflare
 * serves it — including `_headers`, so every spec here also runs under the real
 * Content-Security-Policy (tools/serve-dist.mjs).
 *
 * The product rule these specs encode: the designer and its help work with no
 * network, and everything else keeps working exactly as if there were no service
 * worker — real pages online, a branded fallback offline, no other page ever
 * cached. See docs/design/offline.md.
 *
 * These use the canonical `/fin` (no trailing slash), which is what Cloudflare
 * serves and what the precache is keyed on.
 */
const FIN = '/fin';

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

/** Load the designer and wait until the worker controls the page and the precache is populated. */
async function warmServiceWorker(page: Page) {
  await page.goto(FIN);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => {
    const key = (await caches.keys()).find((n) => n.includes('precache'));
    if (!key) return false;
    return (await (await caches.open(key)).keys()).length > 10;
  });
}

/** The designer has drawn and measured the default fin: the kernel ran. */
async function expectDesignerWorking(page: Page) {
  await expect(page.getByRole('heading', { name: 'OpenFinShaper' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Profile' })).toBeVisible();
  await expect(page.getByLabel('Fin measurements')).toContainText('mm²');
  await expect(page.getByText(/Unexpected Application Error/i)).toHaveCount(0);
}

test.describe('the production site', () => {
  // The CSP lists hashes of this build's inline scripts. A wrong hash (or a new
  // inline script) blocks it, which shows up as a console error, not a test failure,
  // unless something listens.
  test('the designer runs under the Content-Security-Policy, with nothing blocked', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const response = await page.goto(FIN);
    expect(response?.headers()['content-security-policy']).toMatch(/script-src 'self' 'sha256-/);
    await expectDesignerWorking(page);
    expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the home page goes to the designer', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/fin$/);
  });

  // openfinshaper.com is the fin designer alone: the board editor and the
  // surfboard pages it was forked from are not part of the site.
  test('none of the board editor or its pages are served', async ({ request }) => {
    for (const path of ['/app', '/about', '/docs', '/docs/fins', '/surfboard-design-guide']) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
});

test.describe('offline designer', () => {
  test('the designer still loads and computes with the network cut', async ({ page, context }) => {
    await warmServiceWorker(page);
    const errors = trackErrors(page);

    await context.setOffline(true);
    await page.reload();

    await expectDesignerWorking(page);
    expect(errors).toEqual([]);
  });

  // Help is precached deliberately: being unable to read how a feature works is
  // worst precisely when there's no signal. This also pins the URL rewrite —
  // it's emitted as docs/fin-designer/index.html but navigated to as
  // /docs/fin-designer, and without the rewrite it'd be cached under a key nobody
  // ever requests.
  test('the help page is readable offline', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(true);

    const fresh = await context.newPage();
    await fresh.goto('/docs/fin-designer').catch(() => {});
    await expect(fresh.getByRole('heading', { level: 1 })).toContainText(/OpenFinShaper help/);
  });

  test('other pages fall back to the branded offline page', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(true);

    // A cold document navigation in a fresh tab is what exercises the worker's
    // catch handler; navigating inside the already-loaded designer is handled by
    // the client router from precached chunks instead.
    const fresh = await context.newPage();
    await fresh.goto('/privacy').catch(() => {
      /* offline navigations may reject even when the SW answers */
    });

    await expect(fresh).toHaveTitle(/Offline/i);
    await expect(fresh.getByRole('heading', { level: 1 })).toContainText(/You're offline/i);
    await expect(fresh.getByRole('link', { name: 'Open OpenFinShaper' })).toHaveAttribute(
      'href',
      '/fin',
    );
  });

  test('other pages serve real content when online', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(false);

    // Guards the classic navigateFallback bug, where the worker serves a cached
    // shell to routes it should have left alone.
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/What we track/i);
    await expect(page.getByText(/You're offline/i)).toHaveCount(0);
  });

  test('unknown paths still 404 rather than being served the designer shell', async ({
    page,
    context,
  }) => {
    await warmServiceWorker(page);

    // The site has no SPA catch-all: a too-broad navigation route in the worker
    // would silently turn every 404 into the designer.
    const online = await page.goto('/nope');
    expect(online?.status()).toBe(404);

    await context.setOffline(true);
    const fresh = await context.newPage();
    await fresh.goto('/nope').catch(() => {});
    await expect(fresh).toHaveTitle(/Offline/i);
  });

  test('only the designer and its help are cached', async ({ page }) => {
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

    expect(cached).toContain('/fin');
    expect(cached).toContain('/docs/fin-designer');
    expect(cached).toContain('/offline.html');
    expect(cached.filter((p) => /^\/(privacy|app)/.test(p))).toEqual([]);
  });
});
