# Analytics — anonymous PostHog events

## What's tracked

Five product actions, chosen as a proxy for "serious usage" beyond casual browsing:

- `template_loaded` — `{ template }` — New board from Shortboard/Funboard/Longboard
- `save_board` — `{ format: 'board' | 'brd' }` — File → Save / Legacy .brd
- `export_board` — `{ format }` — STL / DXF (polyline or spline) / PDF 1:1

Plus PostHog's own automatic pageview capture. Nothing else — no autocapture of
clicks/inputs, no session replay, no heatmaps, no surveys.

## Why it's anonymous, not just "privacy-friendly"

OpenShaper has no accounts and no backend, so we didn't want analytics to become
the one thing on the site that needs a cookie-consent banner. PostHog's default
SDK persists a `distinct_id` via `localStorage`/cookie to recognize returning
visitors — a non-essential identifier that would legally require consent from EU
visitors (the same ePrivacy rule Google Analytics has always been subject to).

Instead the client is configured for the same anonymous/cookieless posture
Plausible and Umami use by default:

- `persistence: 'memory'` — no localStorage, no cookie, no cross-session identity.
  Each page load is independent; there's nothing to consent to.
- `autocapture: false`, `disable_session_recording: true`, `disable_surveys: true` —
  only the explicit `track(...)` calls below ever send anything.
- Mirrored at the PostHog project level (`anonymize_ips`, `autocapture_opt_out`,
  `surveys_opt_in: false`, `heatmaps_opt_in: false`) as a second layer, independent
  of what any given client build sends.

The tradeoff: no cross-session visitor identity, so retention/cohort analysis
isn't possible — only aggregate counts of which actions happen and how often.
That's an accepted limitation, not an oversight.

## Wiring

`apps/web/src/analytics.ts` exports `initAnalytics()` (called once from `App.tsx`
on mount) and `track(event, props?)`. Both are no-ops if `VITE_POSTHOG_KEY` isn't
set at build time — so a fresh clone, a fork, or a PR preview build never loads
the PostHog script at all.

## Env vars

See `apps/web/.env.example`. `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` are read via
`import.meta.env` at build time, same pattern as `VITE_SITE_URL`
(`apps/web/src/seo/site.ts`). Local dev key goes in `apps/web/.env.local`
(gitignored); the production build sets it as a Cloudflare Workers dashboard
build variable.
