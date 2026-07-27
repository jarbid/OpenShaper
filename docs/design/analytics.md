# Analytics — two-tier PostHog tracking, gated by consent

## The two tiers

**Tier 1 — anonymous baseline (everyone, always, no consent needed):**

- `persistence: 'memory'` — no localStorage, no cookie, no cross-session
  identity. Each page load is independent; there's nothing to consent to.
- `autocapture: false`, `disable_session_recording: true`,
  `disable_surveys: true` — only the explicit `track(...)` calls and the UX
  signals below ever send anything.
- Five product actions, chosen as a proxy for "serious usage" beyond casual
  browsing:
  - `template_loaded` — `{ template }` — New board from Shortboard/Funboard/Longboard
  - `save_board` — `{ format: 'board' | 'brd' }` — File → Save / Legacy .brd
  - `export_board` — `{ format }` — STL / DXF (polyline or spline) / PDF 1:1
  - Plus PostHog's own automatic pageview capture.
- UX signals that don't touch identity: Core Web Vitals, rageclick, dead-click
  detection (canvas/SVG excluded from the latter — see `analytics.ts`).

This tier is the same anonymous/cookieless posture Plausible and Umami use by
default, and it's what every visitor gets until they make a choice — accepting
or rejecting the consent banner both dismiss it permanently, but only Accept
changes anything.

**Tier 2 — full tracking (only after explicit Accept):**

- `persistence: 'localStorage+cookie'` — a real, persistent `distinct_id`/
  `device_id`, set via an actual cookie in addition to localStorage.
- `autocapture: true` — full click/input capture.
- Session recording/replay, turned on live via `posthog.startSessionRecording()`.

The upgrade happens **in place**, with no reload and no identity
discontinuity: `posthog.set_config({ persistence: 'localStorage+cookie' })`
re-persists the same in-memory `distinct_id`/`device_id` into the new storage
backend, so a visitor's anonymous activity and post-consent activity share
one id.

## Consent flow

- `apps/web/src/consent.ts` — a tiny reactive store (`useSyncExternalStore`
  compatible) backed by localStorage key `bs.consent`. Three states:
  `'accepted' | 'rejected' | null` (undecided).
- `apps/web/src/ConsentBanner.tsx` — a non-blocking, site-wide bottom bar,
  shown only while consent is `null`. Doesn't gate access to anything; the
  anonymous baseline runs whether or not a visitor ever interacts with it.
- **Reject is a real, terminal choice — not an opt-out.** It just means "stay
  on the anonymous baseline forever": the events in Tier 1 keep flowing
  exactly as if no decision had been made. This is deliberate — the site
  owner wants the aggregate/anonymous signal regardless of whether a given
  visitor wants full tracking.
- `/privacy` (`apps/web/src/pages/Privacy.tsx`) documents both tiers in
  visitor-facing language and lets anyone change their choice later,
  including turning full tracking back **off**. Because `autocapture`'s DOM
  listeners have no clean live "detach" once attached (only the
  `capture()`-level gate stops events from sending, not the listeners
  themselves), turning tracking off reloads the page so the next
  `initAnalytics()` run reads the new consent and never attaches them.
- `respect_dnt: true` is set unconditionally — a browser's Do Not Track
  signal forces PostHog's own consent state to denied, overriding *even* the
  anonymous baseline. This is a stronger, standing signal than our own
  accepted/rejected state.

## Session-recording masking

Default `posthog-js` masking covers `<input>`/`<textarea>` values
(`maskAllInputs: true`, password fields forced-masked) but **not** arbitrary
non-input DOM text. One known exception was found and fixed: imported file
names (user-controlled, from the visitor's own filesystem) render as plain
heading text in `ImportWarningsDialog.tsx` — that element carries an explicit
`ph-mask` class, which `posthog-js` respects with no extra config. Re-check
for similar cases (any user-entered value rendered as plain text rather than
inside a form control) before adding new UI that might be recorded.

## Wiring

`apps/web/src/analytics.ts` exports:

- `initAnalytics()` — the anonymous baseline init. Called once from
  `apps/web/src/layouts/RootLayout.tsx`, a pathless layout that wraps every
  route (marketing pages and `/app` alike) — the one site-wide mount point,
  also used for `<ConsentBanner/>`. (Previously this only ran inside the
  `/app` editor — the marketing/content pages had no analytics coverage at
  all; that gap is now fixed.) If consent is already `'accepted'` from a
  prior visit, `initAnalytics()` calls the upgrade immediately — no banner,
  no gap.
- `upgradeToFullTracking()` — the Tier 1 → Tier 2 upgrade, called from the
  banner's Accept button, `/privacy`'s Accept button, and from `initAnalytics()`
  for returning consenting visitors.
- `track(event, props?)` — unchanged; gated only on `initAnalytics()` having
  run (i.e. a key being configured), never on consent.

All of the above are no-ops if `VITE_POSTHOG_KEY` isn't set at build time — so
a fresh clone, a fork, or a PR preview build never loads the PostHog script at
all.

## Project-level requirement (manual, not yet verified)

An earlier privacy pass set project-level settings including
`autocapture_opt_out: true`. **That needs revisiting** — if the project-level
autocapture opt-out is enforced via PostHog's remote config, it could silently
override a consenting visitor's client-side `autocapture: true`. Likewise,
session recording is typically a project-level product toggle independent of
the client SDK call — `startSessionRecording()` is a no-op if the project
itself doesn't have session replay enabled. Before relying on Tier 2 data in
production, check (via the PostHog dashboard or MCP connector) that:

- Autocapture is allowed at the project level (not opted out).
- Session replay/recording is enabled as a product for this project.

## Env vars

See `apps/web/.env.example`. `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` are read via
`import.meta.env` at build time, same pattern as `VITE_SITE_URL`
(`apps/web/src/seo/site.ts`). Local dev key goes in `apps/web/.env.local`
(gitignored); the production build sets it as a Cloudflare Workers dashboard
build variable.
