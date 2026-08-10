/**
 * Cloudflare Worker sitting in front of the prerendered static site.
 *
 * It exists for exactly one reason: to proxy PostHog ingestion through our own
 * origin. Pointing `api_host` straight at `us.i.posthog.com` means every
 * visitor running uBlock Origin, Brave shields or Firefox strict mode has
 * their events dropped before they leave the browser — a loss that is
 * invisible from inside PostHog, since blocked events simply never arrive.
 * Same-origin requests are not on those blocklists.
 *
 * Everything that is not the proxy prefix is handed straight back to the
 * static-asset serving that used to be this Worker's entire job, so the
 * site's behaviour (including 404s for unknown paths) is unchanged.
 *
 * See docs/design/analytics.md.
 */

/** PostHog US cloud: ingestion API. */
const API_HOST = 'us.i.posthog.com';
/** PostHog US cloud: static bundles (recorder.js, surveys.js, toolbar.js). */
const ASSET_HOST = 'us-assets.i.posthog.com';

/**
 * Deliberately not `/analytics`, `/tracking`, `/telemetry` or `/posthog` —
 * those are themselves on blocklists, which would defeat the point. `/edge`
 * reads as ordinary infrastructure and collides with nothing the site serves
 * (every real route is prerendered; see wrangler.toml).
 */
const PROXY_PREFIX = '/edge';

interface Env {
  /** Static-assets binding — the prerendered site in apps/web/dist. */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

interface ExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Cloudflare's per-datacentre HTTP cache; absent from the standard lib types. */
declare const caches: { default: Cache };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isProxied =
      url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`);
    return isProxied ? proxy(request, url, ctx) : env.ASSETS.fetch(request);
  },
};

async function proxy(request: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  // Strip the prefix: /edge/e/?ip=1 upstream is /e/?ip=1.
  const path = url.pathname.slice(PROXY_PREFIX.length) || '/';
  // posthog-js fetches its optional bundles from `${api_host}/static/...`,
  // which upstream live on a different host than the ingestion endpoints.
  const isAsset = path.startsWith('/static/');

  const upstream = new URL(url);
  upstream.protocol = 'https:';
  upstream.port = '';
  upstream.hostname = isAsset ? ASSET_HOST : API_HOST;
  upstream.pathname = path;

  // Immutable static bundles: serve from Cloudflare's edge cache so a replay
  // recorder download doesn't cost an origin round-trip per visitor.
  if (isAsset) {
    const hit = await caches.default.match(request);
    if (hit) return hit;
    const fetched = await fetch(upstream.toString(), { method: 'GET' });
    const cacheable = new Response(fetched.body, fetched);
    ctx.waitUntil(caches.default.put(request, cacheable.clone()));
    return cacheable;
  }

  const forwarded = new Request(upstream.toString(), request);
  // Our own first-party cookies are no business of PostHog's, and forwarding
  // them would hand an analytics vendor session state it never asked for.
  forwarded.headers.delete('cookie');
  // Load-bearing for the cookieless baseline, not just for geolocation: the
  // server-side person hash takes the client IP as an input. A Worker's
  // outbound fetch presents Cloudflare's egress IP, so without this every
  // visitor would hash to the *same* person and unique-visitor counts would
  // collapse to 1 — the exact failure this proxy is meant to avoid trading for.
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) forwarded.headers.set('X-Forwarded-For', clientIp);

  return fetch(forwarded);
}
