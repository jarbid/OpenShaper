// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addCspToHeaders, buildCsp, inlineScripts, scriptHash } from './csp';

describe('inlineScripts', () => {
  it('finds inline scripts and skips external and JSON ones', () => {
    const html =
      '<head><script>window.a=1</script><script type="module" src="/assets/x.js"></script>' +
      '<script type="application/ld+json">{"@type":"x"}</script></head>' +
      '<body><script>\nwindow.b=2\n</script></body>';
    expect(inlineScripts(html)).toEqual(['window.a=1', '\nwindow.b=2\n']);
  });
});

describe('scriptHash', () => {
  // The browser hashes the exact text between the tags, whitespace included.
  it('is the base64 sha256 of the exact script text', () => {
    const body = 'window.__VITE_REACT_SSG_HASH__ = "abc"';
    const expected = createHash('sha256').update(body).digest('base64');
    expect(scriptHash(body)).toBe(`'sha256-${expected}'`);
  });
});

describe('buildCsp', () => {
  const csp = buildCsp(["'sha256-B'", "'sha256-A'", "'sha256-B'"]);

  it('allows each inline script by hash, never by unsafe-inline', () => {
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).toContain("'sha256-A' 'sha256-B'");
    expect(scriptSrc.match(/sha256-B/g)).toHaveLength(1);
    expect(scriptSrc).not.toContain('unsafe');
  });

  it('forbids plugins, base rewriting and framing by other sites', () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });
});

describe('addCspToHeaders', () => {
  const headers = '# comment\n/*\n  X-Frame-Options: SAMEORIGIN\n\n/assets/*\n  Cache-Control: x\n';

  it('adds the policy to the catch-all block, and only there', () => {
    const out = addCspToHeaders(headers, "default-src 'self'");
    expect(out).toBe(
      "# comment\n/*\n  Content-Security-Policy: default-src 'self'\n  X-Frame-Options: SAMEORIGIN\n\n/assets/*\n  Cache-Control: x\n",
    );
  });

  it('refuses headers with no catch-all block, or a policy already set', () => {
    expect(() => addCspToHeaders('/assets/*\n  A: b\n', 'x')).toThrow(/no "\/\*" block/);
    expect(() => addCspToHeaders(addCspToHeaders(headers, 'x'), 'x')).toThrow(/already/);
  });
});
