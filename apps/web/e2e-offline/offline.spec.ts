import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { openSection } from '../e2e/helpers';

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

  /**
   * "Engine: NURBS (experimental)" is a persisted setting, so with it saved the editor
   * lazy-imports the NURBS layer on every load. The small layer chunk is precached; the
   * heavy worker and core are not. Offline, the editor must still load and the layer show
   * its badge.
   * (Before the layer chunk was precached, the rejected import reached the route error
   * screen and the canvas never appeared.)
   */
  test('the editor loads offline with the experimental NURBS engine saved', async ({
    page,
    context,
  }) => {
    await warmServiceWorker(page);
    await page.evaluate(() => localStorage.setItem('bs.settings', '{"nurbsEngine":true}'));
    await context.setOffline(true);
    await page.reload();

    await expect(page.getByText(/Something didn't load/)).toHaveCount(0);
    await page.locator('canvas').first().waitFor();
    await page.getByRole('button', { name: /^3D$/ }).first().click();
    await expect(page.getByText(/Something didn't load/)).toHaveCount(0);
    await expect(page.getByText(/Length/i).first()).toBeVisible();

    // The layer chunk came from the precache. (Whether the worker then runs depends on
    // the browser: Chromium's offline emulation does not always reach worker script
    // fetches, so its outcome is not asserted; a failed worker is a failed conversion
    // on the classic mesh, covered by the client and viewer unit tests.)
    await expect(page.getByTestId('nurbs-badge')).toBeVisible();
    await expect(page.getByTestId('nurbs-unavailable')).toHaveCount(0);
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  /**
   * M2 review R1: a session's NURBS document must survive a reload in which the NURBS chunks cannot be
   * loaded (offline, or a stale app shell). They are cached at first use, not precached; here the cache is
   * emptied as well, so they are really unavailable. The document is kept, and the notice says so.
   */
  test('a session NURBS document is kept when the NURBS chunks cannot load', async ({
    page,
    context,
  }) => {
    await warmServiceWorker(page);
    await page.evaluate(() => localStorage.setItem('bs.settings', '{"nurbsEngine":true}'));
    await page.reload();
    await page.locator('canvas').first().waitFor();
    const sessionText = () =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const req = indexedDB.open('bs.session');
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('session')) return resolve(null);
              const get = db.transaction('session').objectStore('session').get('current');
              get.onsuccess = () => {
                const v = get.result as { sectionsJson?: string } | undefined;
                db.close();
                resolve(v?.sectionsJson ?? null);
              };
              get.onerror = () => resolve(null);
            };
          }),
      );
    // the document was converted, loaded and autosaved with the chunks available
    await expect.poll(sessionText, { timeout: 60_000 }).not.toBeNull();
    const before = await sessionText();

    // The chunks become unavailable: what the service worker holds for them is replaced by something
    // that is not a script, which stands for a 404 after a deploy or a miss offline (Chromium's offline
    // emulation does not always reach the fetches behind a cached module).
    const replaced = await page.evaluate(async () => {
      const urls = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\/assets\/nurbs-(core|worker)-[^/]+\.js$/.test(n));
      await caches.delete('nurbs-chunks');
      const cache = await caches.open('nurbs-chunks');
      for (const u of urls) {
        await cache.put(u, new Response('gone', { headers: { 'content-type': 'text/plain' } }));
      }
      return urls.length;
    });
    expect(replaced).toBeGreaterThan(0);
    await context.setOffline(true);
    await page.reload();
    await page.locator('canvas').first().waitFor();
    await expect(page.getByText(/could not be loaded \(offline\?\)/)).toBeVisible({
      timeout: 30_000,
    });
    // let the debounced autosave run; the saved document is the one that was there
    await page.waitForTimeout(2000);
    expect(await sessionText()).toBe(before);
  });

  // Docs are precached deliberately: being unable to read how a feature works is
  // worst precisely when there's no signal. This also pins the URL rewrite —
  // they're emitted as docs/fins/index.html but navigated to as /docs/fins, and
  // without the rewrite they'd be cached under a key nobody ever requests.
  test('reference docs are readable offline', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.setOffline(true);

    const fresh = await context.newPage();
    await fresh.goto('/docs/fins').catch(() => {});
    await expect(fresh.getByRole('heading', { level: 1 })).toContainText(/Fins/i);

    await fresh.goto('/docs/shortcuts').catch(() => {});
    await expect(fresh.getByRole('heading', { level: 1 })).toContainText(/shortcuts/i);
  });

  /**
   * The strongest claim the share feature makes, stated as a test: the link
   * *is* the board. Nothing is fetched to open one, so a cached editor can
   * open a shared design with the network cut entirely.
   */
  test('a shared link opens with no network at all', async ({ page, context }) => {
    await warmServiceWorker(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Make a link while still online — only the editor itself needs the network.
    await page.getByRole('button', { name: 'Share board' }).click();
    await page.getByLabel('Board model').fill('Offline Fish');
    await expect(page.getByText(/Link size:/)).toBeVisible();
    await page.getByRole('button', { name: 'Copy link' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain('/app#board=v1.');

    // The confirm path needs work to lose. Autosave is debounced (800 ms after
    // load), and with everything precached the steps above can finish first,
    // in which case the new tab finds no session and, correctly, opens the link
    // without asking. Wait for the snapshot so the test is not a race.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const req = indexedDB.open('bs.session');
              req.onerror = () => resolve(false);
              req.onsuccess = () => {
                const db = req.result;
                const done = (found: boolean) => {
                  db.close();
                  resolve(found);
                };
                if (!db.objectStoreNames.contains('session')) return done(false);
                const get = db.transaction('session').objectStore('session').get('current');
                get.onsuccess = () => done(!!get.result);
                get.onerror = () => done(false);
              };
            }),
        ),
      )
      .toBe(true);

    await context.setOffline(true);

    const fresh = await context.newPage();
    const errors = trackErrors(fresh);
    await fresh.goto(link).catch(() => {
      /* offline navigations may reject even when the SW answers */
    });

    // This tab shares the context's IndexedDB, so the warm page's autosaved
    // session (waited for above) is there — which makes this the confirm path, exercised
    // with no network. Asserted rather than skipped past: if the prompt ever
    // stops appearing, that is a precedence regression worth failing on.
    await expect(fresh.getByText('Open shared board?')).toBeVisible();
    await fresh.getByRole('button', { name: 'Open shared board' }).click();

    await expect(fresh.getByText(/Shared board opened as an editable copy/)).toBeVisible();
    // Board info is a collapsed sidebar section: open it the way a user does.
    await openSection(fresh, 'Board info');
    await expect(fresh.getByLabel(/^model$/i)).toHaveValue('Offline Fish');
    await expect(fresh.getByText(/Unexpected Application Error/i)).toHaveCount(0);
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
    // The NURBS layer (small) is precached for a saved engine setting; its worker and
    // core (~0.6 MB) are fetched only by a user who turns the engine on.
    expect(cached.some((p) => /\/assets\/nurbs-layer-/.test(p))).toBe(true);
    expect(cached.filter((p) => /\/assets\/nurbs-(core|worker)-/.test(p))).toEqual([]);
  });
});
