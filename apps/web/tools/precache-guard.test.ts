// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  assertEditorPrecache,
  PrecacheGuardError,
  rewriteAppShellUrl,
  type PrecacheEntry,
} from './precache-guard';

/** A manifest shaped like a real, correct build. */
function validManifest(): PrecacheEntry[] {
  return [
    { url: 'app', revision: 'abc' },
    { url: 'offline.html', revision: 'def' },
    { url: 'static-loader-data-manifest-8zwffmvx8g.json', revision: null },
    { url: 'manifest.webmanifest', revision: 'ghi' },
    { url: 'favicon.svg', revision: 'jkl' },
    { url: 'assets/app-BN5.css', revision: null, size: 48_000 },
    { url: 'assets/index-CCE.js', revision: null, size: 852_000 },
    { url: 'assets/app-BzR.js', revision: null, size: 500_000 },
    { url: 'assets/App-Cpg.js', revision: null, size: 356_000 },
    { url: 'assets/specs-worker-DKz.js', revision: null, size: 16_000 },
    { url: 'assets/tessellate.worker-DYN.js', revision: null, size: 16_000 },
    { url: 'assets/EditorPage-DQk.js', revision: null, size: 2_000 },
    { url: 'icons/icon-192.png', revision: 'mno', size: 6_000 },
    // Post-rewrite form: the guard runs after rewriteAppShellUrl in vite.config.ts.
    { url: 'docs', revision: 'd0' },
    { url: 'docs/editing', revision: 'd1' },
    { url: 'docs/shortcuts', revision: 'd2' },
  ];
}

const messageOf = (run: () => void): string => {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected assertEditorPrecache to throw');
};

describe('rewriteAppShellUrl', () => {
  it("maps the prerendered shell to the canonical '/app' URL", () => {
    const out = rewriteAppShellUrl([{ url: 'app/index.html', revision: 'x' }]);
    expect(out).toEqual([{ url: 'app', revision: 'x' }]);
  });

  // Without this, docs are cached under a URL nobody navigates to and the offline
  // page shows instead — cached, but unreachable.
  it('maps docs pages to their canonical no-trailing-slash URLs', () => {
    const out = rewriteAppShellUrl([
      { url: 'docs/index.html', revision: 'a' },
      { url: 'docs/fins/index.html', revision: 'b' },
    ]);
    expect(out.map((e) => e.url)).toEqual(['docs', 'docs/fins']);
  });

  it('leaves every other entry untouched', () => {
    const entries = [
      { url: 'about/index.html', revision: 'a' },
      { url: 'assets/app-BzR.js', revision: null },
    ];
    expect(rewriteAppShellUrl(entries)).toEqual(entries);
  });

  it('does not mutate the input array', () => {
    const entries: PrecacheEntry[] = [{ url: 'app/index.html', revision: 'x' }];
    rewriteAppShellUrl(entries);
    expect(entries.map((e) => e.url)).toEqual(['app/index.html']);
  });
});

describe('assertEditorPrecache', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => assertEditorPrecache(validManifest())).not.toThrow();
  });

  it('rejects a manifest whose app shell was never rewritten', () => {
    const entries = validManifest().filter((e) => e.url !== 'app');
    entries.push({ url: 'app/index.html', revision: 'x' });
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/was not rewritten/);
  });

  it('rejects a missing editor shell', () => {
    const entries = validManifest().filter((e) => e.url !== 'app');
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/missing the editor shell/);
  });

  it('rejects a missing offline fallback', () => {
    const entries = validManifest().filter((e) => e.url !== 'offline.html');
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/offline\.html/);
  });

  // The SSG loader manifest is hash-named and changes every build, so it can
  // only be matched by glob — an easy thing to typo into matching nothing.
  it('rejects zero or multiple static-loader-data manifests', () => {
    const none = validManifest().filter((e) => !e.url.startsWith('static-loader-data-manifest-'));
    expect(messageOf(() => assertEditorPrecache(none))).toMatch(/found 0/);

    const two = [...validManifest(), { url: 'static-loader-data-manifest-other.json' }];
    expect(messageOf(() => assertEditorPrecache(two))).toMatch(/found 2/);
  });

  it('rejects a glob that silently matched no app code', () => {
    const entries = validManifest().filter((e) => !e.url.endsWith('.js'));
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/matched nothing/);
  });

  it('rejects precached marketing HTML', () => {
    const entries = [...validManifest(), { url: 'about/index.html', revision: 'a' }];
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/marketing HTML/);
  });

  // Docs are the one exception: they're precached deliberately so they're
  // readable in a workshop with no signal.
  it('accepts precached docs pages', () => {
    const entries = [...validManifest(), { url: 'docs/fins', revision: 'd' }];
    expect(() => assertEditorPrecache(entries)).not.toThrow();
  });

  it('rejects a docs glob that matched nothing', () => {
    const entries = validManifest().filter((e) => !e.url.startsWith('docs/'));
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/docs glob/);
  });

  it('rejects precached guide images', () => {
    const entries = [...validManifest(), { url: 'images/guides/rocker.webp', revision: 'a' }];
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/guide images/);
  });

  it('rejects raster assets outside icons/', () => {
    const entries = [...validManifest(), { url: 'og-cover.png', revision: 'a' }];
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/outside icons/);
  });

  it('rejects a precache over the byte budget', () => {
    const entries = [...validManifest(), { url: 'assets/huge.js', size: 40 * 1024 * 1024 }];
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/over the .* budget/);
  });

  it('reports every problem at once, as a PrecacheGuardError', () => {
    const broken: PrecacheEntry[] = [{ url: 'assets/only.js' }];
    let caught: unknown;
    try {
      assertEditorPrecache(broken);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PrecacheGuardError);
    expect((caught as Error).message).toMatch(/missing the editor shell/);
    expect((caught as Error).message).toMatch(/offline\.html/);
  });
});
