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
    { url: 'fin', revision: 'fin0' },
    { url: 'offline.html', revision: 'def' },
    { url: 'static-loader-data-manifest-8zwffmvx8g.json', revision: null },
    { url: 'manifest.webmanifest', revision: 'ghi' },
    { url: 'favicon.svg', revision: 'jkl' },
    { url: 'assets/app-BN5.css', revision: null, size: 48_000 },
    { url: 'assets/index-CCE.js', revision: null, size: 852_000 },
    { url: 'assets/app-BzR.js', revision: null, size: 500_000 },
    { url: 'assets/FinApp-Cpg.js', revision: null, size: 356_000 },
    { url: 'assets/fin-mesh.worker-DKz.js', revision: null, size: 16_000 },
    { url: 'assets/FinPreview3D-DYN.js', revision: null, size: 16_000 },
    { url: 'assets/FinPage-DQk.js', revision: null, size: 2_000 },
    { url: 'icons/icon-192.png', revision: 'mno', size: 6_000 },
    // Post-rewrite form: the guard runs after rewriteAppShellUrl in vite.config.ts.
    { url: 'docs/fin-designer', revision: 'd0' },
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
  // Without this, docs are cached under a URL nobody navigates to and the offline
  // page shows instead — cached, but unreachable.
  it('maps docs pages to their canonical no-trailing-slash URLs', () => {
    const out = rewriteAppShellUrl([{ url: 'docs/fin-designer/index.html', revision: 'a' }]);
    expect(out.map((e) => e.url)).toEqual(['docs/fin-designer']);
  });

  it("maps the fin designer's shell to the canonical '/fin' URL", () => {
    const out = rewriteAppShellUrl([{ url: 'fin/index.html', revision: 'x' }]);
    expect(out).toEqual([{ url: 'fin', revision: 'x' }]);
  });

  it('leaves every other entry untouched', () => {
    const entries = [
      { url: 'privacy/index.html', revision: 'a' },
      { url: 'assets/app-BzR.js', revision: null },
    ];
    expect(rewriteAppShellUrl(entries)).toEqual(entries);
  });

  it('does not mutate the input array', () => {
    const entries: PrecacheEntry[] = [{ url: 'fin/index.html', revision: 'x' }];
    rewriteAppShellUrl(entries);
    expect(entries.map((e) => e.url)).toEqual(['fin/index.html']);
  });
});

describe('assertEditorPrecache', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => assertEditorPrecache(validManifest())).not.toThrow();
  });

  it('requires the fin designer shell, rewritten', () => {
    const missing = validManifest().filter((e) => e.url !== 'fin');
    expect(messageOf(() => assertEditorPrecache(missing))).toContain(
      "missing the fin designer shell ('fin')",
    );
    missing.push({ url: 'fin/index.html', revision: 'x' });
    expect(messageOf(() => assertEditorPrecache(missing))).toContain(
      "'fin/index.html' was not rewritten",
    );
  });

  // openfinshaper.com serves the fin designer alone: none of the board editor.
  it('rejects the board editor, its shell or its code', () => {
    const shell = [...validManifest(), { url: 'app', revision: 'a' }];
    expect(messageOf(() => assertEditorPrecache(shell))).toMatch(/no other page.*app/);
    const code = [...validManifest(), { url: 'assets/EditorPage-DQk.js', revision: null }];
    expect(messageOf(() => assertEditorPrecache(code))).toMatch(/board editor must not ship/);
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

  it('rejects any other precached page', () => {
    const entries = [...validManifest(), { url: 'privacy/index.html', revision: 'a' }];
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/no other page/);
  });

  it('rejects a docs glob that matched nothing', () => {
    const entries = validManifest().filter((e) => !e.url.startsWith('docs/'));
    expect(messageOf(() => assertEditorPrecache(entries))).toMatch(/docs glob/);
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
    expect((caught as Error).message).toMatch(/missing the fin designer shell/);
    expect((caught as Error).message).toMatch(/offline\.html/);
  });
});
