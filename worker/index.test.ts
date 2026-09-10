import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

/**
 * The proxy's failure modes are all silent — nothing errors, events keep
 * flowing, and the damage only shows up as wrong numbers in a dashboard weeks
 * later. That is the same class of bug this proxy was written alongside (see
 * docs/design/analytics.md), so the routing is pinned rather than trusted.
 */

const assetsFetch = vi.fn(async () => new Response('static site'));
const env = { ASSETS: { fetch: assetsFetch } };
const ctx = { waitUntil: vi.fn() };

/** Captures what the Worker sends upstream without touching the network. */
let upstream: Request | null;

beforeEach(() => {
  upstream = null;
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    upstream = typeof input === 'string' ? new Request(input, init) : input;
    return new Response('upstream');
  });
  // No cache hits by default, so the asset path exercises its fetch branch.
  vi.stubGlobal('caches', {
    default: { match: async () => undefined, put: async () => undefined },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const call = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env, ctx);

describe('static site passthrough', () => {
  it.each(['https://openshaper.com/', 'https://openshaper.com/app', 'https://openshaper.com/docs'])(
    'hands %s to the assets binding, untouched',
    async (url) => {
      await call(url);
      expect(assetsFetch).toHaveBeenCalledOnce();
      expect(upstream).toBeNull();
    },
  );

  // The prefix must not swallow a real route that merely starts with the same
  // letters — /edgeboard is a plausible future marketing page.
  it('does not capture paths that merely share the prefix', async () => {
    await call('https://openshaper.com/edgeboard');
    expect(assetsFetch).toHaveBeenCalledOnce();
    expect(upstream).toBeNull();
  });
});

describe('PostHog proxying', () => {
  it('forwards ingestion to the API host, preserving path and query', async () => {
    await call('https://openshaper.com/edge/e/?ip=1', { method: 'POST', body: '{}' });
    expect(assetsFetch).not.toHaveBeenCalled();
    const sent = new URL(upstream!.url);
    expect(sent.hostname).toBe('us.i.posthog.com');
    expect(sent.pathname).toBe('/e/');
    expect(sent.search).toBe('?ip=1');
    expect(upstream!.method).toBe('POST');
  });

  // Bundles live on a different upstream host than the ingestion endpoints;
  // sending them to the API host returns 404 and silently breaks replay.
  it('routes /static/ bundles to the asset host', async () => {
    await call('https://openshaper.com/edge/static/recorder.js');
    expect(new URL(upstream!.url).hostname).toBe('us-assets.i.posthog.com');
    expect(new URL(upstream!.url).pathname).toBe('/static/recorder.js');
  });

  /**
   * The one that matters most. A Worker's outbound fetch presents Cloudflare's
   * egress IP, and the cookieless person hash takes the client IP as an input —
   * so if this header is dropped, every visitor hashes to the same person and
   * unique visitors collapse to 1.
   */
  it('forwards the real client IP so the cookieless hash stays per-visitor', async () => {
    await call('https://openshaper.com/edge/e/', {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    expect(upstream!.headers.get('X-Forwarded-For')).toBe('203.0.113.9');
  });

  it('never forwards our own cookies to the analytics vendor', async () => {
    await call('https://openshaper.com/edge/e/', {
      headers: { cookie: 'bs.consent=accepted', 'CF-Connecting-IP': '203.0.113.9' },
    });
    expect(upstream!.headers.get('cookie')).toBeNull();
  });

  it('serves a cached bundle without a second upstream fetch', async () => {
    vi.stubGlobal('caches', {
      default: { match: async () => new Response('cached'), put: async () => undefined },
    });
    const res = await call('https://openshaper.com/edge/static/recorder.js');
    expect(await res.text()).toBe('cached');
    expect(upstream).toBeNull();
  });
});

/**
 * `http://openshaper.com` served a 200 for months. localStorage is partitioned
 * by origin, so a visitor who landed there got a different bucket from the one
 * holding their analytics consent and was asked to accept or reject all over
 * again — on a device where they had already answered. The same split made the
 * absolute `VITE_POSTHOG_HOST` cross-origin, so posthog-js's requests failed
 * CORS and those visits went unrecorded. Both symptoms, one missing redirect.
 */
describe('canonical origin', () => {
  const scheme = (s: string) => ({ headers: { 'CF-Visitor': JSON.stringify({ scheme: s }) } });

  it('sends http to https, keeping the path and query', async () => {
    const res = await call('http://openshaper.com/docs?a=1', scheme('http'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://openshaper.com/docs?a=1');
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it('sends www to the apex', async () => {
    const res = await call('https://www.openshaper.com/app', scheme('https'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://openshaper.com/app');
  });

  // Cloudflare terminates TLS ahead of the Worker, so request.url can already
  // read https: on a request the visitor made over http. CF-Visitor is the
  // header that still knows.
  it('trusts CF-Visitor over the rewritten request scheme', async () => {
    const res = await call('https://openshaper.com/', scheme('http'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://openshaper.com/');
  });

  it('leaves the canonical origin alone', async () => {
    await call('https://openshaper.com/app', scheme('https'));
    expect(assetsFetch).toHaveBeenCalledOnce();
  });

  // Bouncing a preview deploy at the production domain would make it untestable.
  it('does not redirect preview deploys', async () => {
    await call('https://openshaper.workers.dev/app');
    expect(assetsFetch).toHaveBeenCalledOnce();
  });
});
