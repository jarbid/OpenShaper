# openfinshaper.com: the site and its security (2026-11)

OpenFinShaper replaces OpenShaper on its own domain, `openfinshaper.com`. The deployed site is the
fin designer and nothing else: no board editor, no surfboard pages.

## What the site serves

| Path                 | What                                                            |
| -------------------- | --------------------------------------------------------------- |
| `/`                  | 301 to `/fin` (`public/_redirects`); `pages/Home` if unhonoured |
| `/fin`               | The designer: a client-only island, precached for offline use   |
| `/docs/fin-designer` | Help, precached                                                 |
| `/privacy`           | What analytics collects, and the consent switch                 |
| `/edge/*`            | Same-origin PostHog proxy (`worker/index.ts`)                   |

Anything else is a 404. `routes.tsx` lists only these, so the build neither prerenders nor
bundles the board editor (`EditorPage`, `App`, the board docs), although that source is still in
the repository. `tools/precache-guard.ts` fails the build if an `EditorPage` chunk or any other
page reaches the precache, and the offline e2e suite checks that `/app`, `/about`, `/docs` and the
surfboard guides answer 404.

The surfboard marketing pages, their layout (`MarketingLayout`), their structured data (`JsonLd`)
and their ~2.7 MB of guide images were deleted. `/privacy` moved to `FinHelpLayout`, the bare frame
the help page uses, and now describes what the fin designer collects.

What still says OpenShaper, on purpose:

- **"A fork of OpenShaper"** in the designer's status bar, linking to the upstream repository
  (`UPSTREAM_URL`). OpenFinShaper is a GPL-3.0-or-later fork; the credit was the owner's call.
- **The `openshaper-fin` format marker** in `.fin.json` files, so existing files keep opening.
- **Internal package names** (`@openshaper/kernel` and so on). They never reach a page.

## Branding in exported files

The STEP writer named "OpenShaper" and "Made with OpenShaper · openshaper.com" as the originating
system, and the STL header began "OpenShaper STL". Fin exports now pass `FIN_BRAND`
(`packages/export/src/brand.ts`); board exports pass `BOARD_BRAND`. The brand is a required
argument, not a default, so the board's credit cannot reach the fin bundle by accident.

## Response headers

`public/_headers` sets, on everything: `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options: SAMEORIGIN`, HSTS (no `includeSubDomains`) and a `Permissions-Policy` that turns
off camera, microphone, location, payment and USB.

**Content-Security-Policy** is added at build time (`tools/csp.ts`, called from `vite.config.ts`'s
`onFinished`). vite-react-ssg writes small inline scripts into each prerendered page whose text
changes every build, so the build hashes each one and lists the hashes in `script-src`, instead of
allowing `'unsafe-inline'`. The policy:

- `script-src 'self'`, the inline hashes, and PostHog's asset host (for a build that talks to
  PostHog directly instead of through `/edge`);
- `connect-src 'self' https://*.posthog.com`, for the same reason;
- `style-src 'self' 'unsafe-inline'`: prerendered markup has style attributes and `offline.html`
  has a `<style>`. Styles can't run code;
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`.

`tools/serve-dist.mjs` now applies `_headers` and `_redirects` the way Cloudflare does, so the
offline e2e suite runs with the real policy enforced and fails on any blocked script.

## The Worker

- `CANONICAL_HOST` is `openfinshaper.com`: `http://` and `www.` redirect to it.
- `HOME_PATH` is gone. The `/` → `/fin` redirect is `_redirects`' job, and is now a 301.
- The proxy only caches PostHog's static bundles when upstream answered 2xx. It used to cache any
  response, so one upstream 404 or 5xx would have been served to every visitor at that datacentre
  until it expired.

`wrangler.toml`'s `name` is still `openshaper`. It must match the Worker's name in the Cloudflare
dashboard, so change it there and here together, or leave both.

## Checked and fine

- The one `dangerouslySetInnerHTML` (the board's construction sheet, not shipped) renders SVG
  built with `escapeXml`.
- SVG import parses with `DOMParser` and reads path data only; nothing imported is inserted into
  the page.
- No secrets are tracked: `.env` and `.env.local` are gitignored; `.env.production` holds only the
  feedback address.
- The Buy Me a Coffee button is a plain link, not the vendor's script.

## Known, not fixed

- `react-router` 6.x has two moderate advisories fixed only in 7.x. They concern server-side data
  routers and redirects from loaders, which this static site doesn't use. Moving to 7 is a
  separate change.
- Dev-only advisories in build tooling (`deepmerge`, `glob`, `minimatch` via workbox and eslint).
  They never reach the site.
