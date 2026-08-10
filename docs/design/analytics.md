# Analytics — two-tier PostHog tracking, gated by consent

## The two tiers

**Tier 1 — anonymous baseline (everyone, always, no consent needed):**

- `cookieless_mode: 'on_reject'` — no localStorage, no cookie, nothing written
  to the browser at all. Identity is a privacy-preserving hash computed on
  PostHog's servers from `(team_id, daily_salt, ip, user_agent, hostname)`;
  the salt is regenerated daily, so the hash is not reversible and does not
  carry across days. See [what the data can and cannot say](#what-the-data-can-and-cannot-say)
  for what that buys and what it still can't measure.
- `autocapture: false`, `disable_session_recording: true`,
  `disable_surveys: true` — only the explicit `track(...)` calls and the UX
  signals below ever send anything.
- Hand-instrumented product actions, chosen as a proxy for "serious usage"
  beyond casual browsing — see the [event catalogue](#event-catalogue) for the
  full list and the rules governing it. Plus PostHog's own automatic pageview
  capture, which since 2026-08-11 includes SPA route changes — see
  [pageviews](#pageviews-include-spa-route-changes).
- UX signals that don't touch identity: Core Web Vitals, rageclick, dead-click
  detection (canvas/SVG excluded from the latter — see `analytics.ts`).
- **Exception autocapture** (`capture_exceptions`): uncaught JS errors and
  unhandled promise rejections (not `console.error`, which is left off since
  arbitrary logged content is harder to reason about than a genuine crash).
  This lives in Tier 1, not Tier 2, because it's independent of
  autocapture/session recording in `posthog-js` and its `$exception` events
  carry no more identity risk than the pageview capture already sends today
  (same unmasked `$current_url`; stack frames reference bundled asset URLs
  like `/assets/index-xyz.js`, never filesystem paths or identity). Worth
  having from every visitor, not just consenting ones, given this is a
  canvas/WebGL-heavy app (2D editors + Three.js) where a real crash is easy
  to miss otherwise.

This tier is the same anonymous/cookieless posture Plausible and Umami use by
default, and it's what every visitor gets until they make a choice — accepting
or rejecting the consent banner both dismiss it permanently, but only Accept
changes anything.

**Tier 2 — full tracking (only after explicit Accept):**

- `persistence: 'localStorage+cookie'` — a real, persistent `distinct_id`/
  `device_id`, set via an actual cookie in addition to localStorage.
- `autocapture: true` — full click/input capture.
- Session recording/replay, turned on live via `posthog.startSessionRecording()`.
- `capture_heatmaps: true` — click/scroll density per page, gated here (not
  Tier 1) even though it's technically independent of session recording in
  `posthog-js`, since it's an autocapture-adjacent signal like the ones
  above.
- A `tracking_tier: 'full'` super property (`posthog.register(...)`), tagging
  every subsequent event from this browser — lets any dashboard/insight
  segment full-tracking vs. baseline-only traffic without a cohort, and is
  what makes retention analysis (D1/D7/D30 return) possible for the first
  time, since Tier 1 has no persistent identity to measure return visits
  against. Cleared via `downgradeFromFullTracking()` (calls
  `posthog.unregister('tracking_tier')`) when a visitor turns tracking back
  off on `/privacy`, right before the page reloads.

The upgrade happens **in place**, with no reload: `posthog.opt_in_capturing()`
is what leaves cookieless mode, and posthog-js picks the storage backend from
the consent state itself — there is no `set_config({ persistence })` call any
more.

**It is not identity-continuous, and that is a deliberate loss.** Under the
old `persistence: 'memory'` baseline the in-memory `distinct_id` could be
re-persisted into the new backend, so pre- and post-consent activity shared one
id. The server-side hash has no such handle: it is computed on ingest and is
deliberately not reversible into a client-side `distinct_id`. A visitor who
accepts therefore starts a new id at the moment of consent, and their
pre-consent pageviews stay attached to the hash. Funnels that straddle the
Accept click will show a drop that isn't real. This is the price of the
baseline actually counting people at all; the alternative (memory persistence)
bought continuity across an event almost nobody triggers, at the cost of every
unique-visitor number in the project.

### Session replay does not show the board — deliberately (decided 2026-07-28)

Replays show the toolbar, menus and panels, and a **blank rectangle where the
editor is**. That is expected, not a misconfiguration, and it is not going to
be fixed.

Replay is rrweb, which serializes DOM mutations. A `<canvas>` is an opaque
pixel buffer with no DOM inside it, so it records as an empty box — and
OpenShaper's whole editing surface is a canvas (`SplineEditor.tsx`) plus a
three.js view (`Board3DView.tsx`). Capturing it needs canvas recording enabled
in the project's replay settings, which PostHog keeps opt-in precisely because
[canvas contents cannot be masked](https://posthog.com/docs/session-replay/canvas-recording).

We leave it off. The canvas isn't chrome, it's the visitor's board geometry —
their actual design work — and there is no way to redact it once captured.
Storing that, unmaskable, against a project whose stated posture is "anonymous
analytics only, no cookies, no persistent visitor id" is not a trade worth
making to watch someone drag a control point.

Two things to know if this is ever revisited:

- The 3D pane would stay black even with canvas recording on. WebGL capture
  needs `preserveDrawingBuffer: true` on the context or `toDataURL()` reads
  back blank; react-three-fiber defaults it to `false` and `Board3DView.tsx`
  passes no `gl` prop. Setting it costs render performance on every frame for
  every visitor, not just recorded ones.
- Watching people use the editor is what the hand-instrumented events are
  for — `session_summary`, `editor` view usage, `overlay_toggled` — precisely
  because neither replay nor autocapture can see inside a canvas.

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
- **`initAnalytics()` calls `posthog.opt_out_capturing()` for anyone who
  hasn't accepted, and this is load-bearing.** Under
  `cookieless_mode: 'on_reject'`, posthog-js treats an *undecided* visitor as
  opted out and captures **nothing at all** until a choice is made
  (`isOptedOut()` returns true while consent is pending — see
  [posthog-js#2841](https://github.com/PostHog/posthog-js/issues/2841)).
  Since most visitors never touch the banner, leaving this to the default
  would silently drop nearly all baseline traffic. Declaring the rejection up
  front puts undecided visitors straight onto the cookieless baseline, which
  is the behaviour the banner copy already promises. Pinned by
  `analytics.test.ts`.

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
- `downgradeFromFullTracking()` — clears the `tracking_tier` super property;
  called from `/privacy`'s "turn off" control right before it reloads the
  page (the reload itself resets everything else back to the Tier 1
  baseline).
- `track(event, props?)` — unchanged; gated only on `initAnalytics()` having
  run (i.e. a key being configured), never on consent.

All of the above are no-ops if `VITE_POSTHOG_KEY` isn't set at build time — so
a fresh clone, a fork, or a PR preview build never loads the PostHog script at
all.

## Project-level settings (verified 2026-07-28)

Every client-side switch above needs a matching project-level toggle, because
`startSessionRecording()`, `capture_heatmaps` and `capture_exceptions` are all
no-ops if the corresponding product is off for the project. An earlier privacy
pass had set `autocapture_opt_out: true`, which would have silently overridden
a consenting visitor's client-side `autocapture: true`.

All of it was read back from project `521211` on 2026-07-28 and is correct:

| Setting                          | Value   |
| -------------------------------- | ------- |
| `autocapture_opt_out`            | `false` |
| `session_recording_opt_in`       | `true`  |
| `heatmaps_opt_in`                | `true`  |
| `autocapture_exceptions_opt_in`  | `true`  |
| `autocapture_web_vitals_opt_in`  | `true`  |
| `capture_dead_clicks`            | `true`  |
| `anonymize_ips`                  | `true`  |
| `surveys_opt_in`                 | `false` |
| `cookieless_server_hash_mode`    | `1`     |

`anonymize_ips` and `surveys_opt_in` match the client config (`disable_surveys`).
No error-tracking rate limits are configured.

`cookieless_server_hash_mode` was `0` (disabled) until 2026-08-06 and is the
server half of `cookieless_mode: 'on_reject'` — without it the client change is
inert. It is set to `1` (**stateless**) rather than `2` (stateful): the two
differ only in whether PostHog keeps a Redis-backed counter to stop a visitor
colliding with themselves across `identify()` calls, and OpenShaper has no
accounts and never calls `identify()`, so the counter is permanently zero and
both modes compute the same hash. Stateless gets there without PostHog holding
per-visitor state.

Note `anonymize_ips: true` does not conflict with the hash: the IP is an input
to the hash at ingest time and is dropped rather than stored.

**Resolved 2026-08-11:** exception capture is confirmed working end to end.
This previously recorded a standing worry that `$exception` had logged zero
events since launch and that a flat zero should be treated as unverified rather
than as good news. It has since fired 6 times in 30 days, so the pipeline is
live and the caveat no longer applies.

## What the data can and cannot say

Constraints that fall out of the design above and shape every dashboard:

- **Within a UTC day, unique visitors and sessions are real.** The server-side
  hash is stable for the same (ip, user-agent, host) pair for as long as the
  daily salt lives, so same-day visitor counts, session counts and
  session-scoped funnels are honest for baseline traffic.
- **Across days, they are not.** The salt is regenerated daily, so a returning
  visitor is a new person tomorrow. Cross-day retention, DAU-vs-WAU ratios and
  "returning visitor" splits remain unmeasurable for baseline traffic —
  anything claiming otherwise is either scoped to `tracking_tier: 'full'` or
  wrong.
- **The hash can collide.** Two visitors sharing an IP and user-agent string
  (an office, a campus, a NAT, two phones on the same carrier) merge into one
  person. Same-day visitor counts are therefore a slight *under*-count, in a
  direction that varies with audience. Treat them as a good floor, not a
  headcount.
- **Within-session depth is the strongest signal.** `/app` is an SPA, so one
  page load is one entire editing session. Funnels and `session_summary` are
  honest for that reason and were unaffected by the identity change.

`recent_board_opened` remains the one return-visitor signal that survives the
daily reset: the recent list lives in `localStorage` (`bs.recent`), so
reopening from it proves a repeat visit with no persistent analytics identity
involved.

### The bug this replaced (fixed 2026-08-06)

The baseline previously ran `persistence: 'memory'`, which stored *nothing* —
and with `cookieless_server_hash_mode` disabled at the project level there was
no server-side fallback either. Every page load therefore minted a fresh
`distinct_id`, `device_id` **and** `session_id`. Measured across 90 days before
the fix: 4,910 events collapsed into 308 persons and 371 sessions against 303
pageviews — i.e. persons ≈ sessions ≈ pageviews, to within rounding.

Two things are worth remembering from it:

- The original write-up documented the effect on *persons* but not on
  *sessions*. `session_id` lives in the same persistence backend, so memory
  persistence silently took session counting with it, and "sessions" was a
  page-load count wearing a different label for the project's whole life.
- Both halves were required. The client config alone does nothing while
  `cookieless_server_hash_mode` is `0` — the events still arrive, just with no
  usable identity, which is exactly the failure mode that looks like success.

`/app` vs `/app/` was split across two paths before the `drop-trailing-slash`
fix. A project-level path-cleaning rule (`^/app/$` → `/app`) collapses the
historical rows at query time, which the code fix cannot do retroactively.

### Pageviews include SPA route changes (fixed 2026-08-11)

`capture_pageview` was `true`, which captures a pageview on the **initial page
load only**. posthog-js resolves it to `'history_change'` on its own only from
`defaults: '2025-05-24'` onward, and `defaults` was never set. Every internal
link is a React Router `<Link>`, so client-side navigation produced no pageview
at all and the whole journey collapsed into one pageview for whatever URL the
visitor happened to land on.

What that cost, measured over the 30 days before the fix:

- **The `/` → `/app` funnel did not exist.** `/app`'s 123 pageviews were direct
  landings; everyone who arrived at `/` and clicked the CTA was invisible.
- **`/docs` recorded 3 pageviews**, not because nobody reads it but because it
  is reached by navigation. `/docs/shortcuts` had 5.
- Bounce rate was inflated (every session looked single-page) and the Paths
  insight was meaningless.

Now set explicitly to `'history_change'`, and pinned by `analytics.test.ts` —
the failure mode is silent, so the config comment alone isn't enough.

**Reading trends across this date:** pageviews step up because more of them are
recorded, not because traffic grew. The same applies to any per-session or
per-path metric. Landing-page counts are the one comparable series, since a
landing pageview was always captured.

Note this interacts with the identity fix above: while `persistence: 'memory'`
was live, every page load also started a new session, so no session could ever
hold more than one pageview (the pre-fix distribution was 383 sessions with
exactly one and 89 with none — never two). Both fixes have to ship before
pageviews-per-session means anything.

## Internal traffic

PostHog's usual "internal users" cohort cannot work here — the cookieless hash
resets daily, so a cohort pinned to a person id would go empty every night
(before the cookieless switch there was no id to match on at all, and the
cohort sat at 0 members permanently). Own-dev traffic is instead marked at the
source:
`resolveInternalTraffic()` in `analytics.ts` stores one boolean under
`bs.internal` when the page is loaded with `?internal=1` (`?internal=0` clears
it), and registers `internal_traffic: true` as a super property. The project's
test-account filter excludes it.

That single key is the deliberate exception to the no-persistent-storage rule:
one boolean, in my own browser, carrying no visitor data. A super property is
used rather than `opt_out_capturing()` so my traffic stays inspectable in
isolation instead of disappearing.

## Event catalogue

Three rules govern every event:

1. **Never send user content.** No file names, no board names, no trace images.
   Categorical facets and counts only. (`ImportWarningsDialog.tsx` already
   `ph-mask`s a filename for replay — same principle.)
2. **Never track raw canvas interaction.** Drags fire at frame rate. Continuous
   work is aggregated into one `session_summary` per session instead.
3. **All calls live in `apps/web`**, behind `track()`. Nothing analytics-related
   enters `kernel` / `store` / `io` — that would violate the pure-kernel rule.

| Event                 | Properties                                                                   | Why                                                                       |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `template_loaded`     | `template`                                                                   | Which starter board people begin from                                     |
| `save_board`          | `format` (`board` \| `brd`)                                                  | Native vs legacy round-tripping                                           |
| `export_board`        | `format` (`stl` \| `dxf` \| `dxf-spline` \| `pdf-1to1-custom`)               | The "got real value" action                                               |
| `recent_board_opened` | `position`                                                                   | The only return-visitor proof on the baseline                             |
| `board_imported`      | `source`, `warning_count`, `dropped_count`                                   | The BoardCAD on-ramp, previously unmeasured                               |
| `import_failed`       | `source`, `reason`                                                           | Worst outcome in the app; used to fail silently                           |
| `units_changed`       | `units`                                                                      | Imperial vs metric vs fractions — who the audience actually is            |
| `overlay_toggled`     | `overlay`, `enabled`                                                         | Whether the comb / CoM / distribution overlays earn their upkeep          |
| `hws_template_opened` | —                                                                            | Templating is the roadmap phase in progress                               |
| `hws_template_exported` | `format`, `nested`, `parts`                                                | …and this is it actually being used; the gap between the two is the signal |
| `spec_sheet_opened`   | —                                                                            |                                                                           |
| `trace_image_loaded`  | `target`                                                                     | Distinctive feature, zero prior visibility                                |
| `consent_banner`      | `action` (`shown` \| `accepted` \| `rejected`)                               | Distinguishes bad copy from a banner nobody sees                          |
| `pwa_installed`       | —                                                                            | The install conversion; fires online, so unlike offline usage it sends     |
| `session_summary`     | `edits`, `views_used`, `view_count`, `exported`, `saved`, `imported`, `template_used`, `duration_s` | Session depth without a per-action stream |

`session_summary` (`apps/web/src/session-metrics.ts`) is emitted once on
`pagehide`. `edits` is read from the undo stack's depth at flush time rather
than counted per edit, so the drag path is untouched. `views_used` is how editor
usage is measured — autocapture cannot see the panes, because they are canvases.

### `display_mode` (super property)

`resolveDisplayMode()` registers `display_mode: 'standalone' | 'browser'` on every
event, so all of the above can be split by installed-PWA vs browser tab. Without
it the two are indistinguishable and the offline/install work looks unused rather
than unmeasured. It describes the window, not the visitor — no identity, nothing
persistent — so it belongs to the anonymous baseline. Detection is the
`(display-mode: standalone)` media query plus `navigator.standalone` for iOS
Safari, which never implemented the query for home-screen apps.

**Offline usage is deliberately not tracked.** `posthog-js` holds failed requests
in an in-memory queue (exponential backoff, flushed on the browser's `online`
event), and the baseline runs `persistence: 'memory'`, so events captured offline
are lost on reload or tab close. Any "offline sessions" metric would under-count
in an unknown, non-random way — worse than not measuring. If it becomes important,
the honest version is a local counter reported once on the next online load.
See `docs/design/offline.md`.

Known gap: `board_imported` reports warning *counts* only. `ImportWarning`
(`packages/io/src/import-warning.ts`) carries a free-text `message` with line
numbers interpolated into it, which would make a useless high-cardinality
breakdown. Giving that type a stable `code` is the follow-up that would make
warning *kinds* analysable.

## Dashboards

- [OpenShaper — Product](https://us.posthog.com/project/521211/dashboard/1916803)
  (primary): funnels, template and format splits, plus a consent-tier section.
- [OpenShaper — Health & UX](https://us.posthog.com/project/521211/dashboard/1916806):
  Web Vitals, exceptions, and the dead-click signal.
- [Starter (archived)](https://us.posthog.com/project/521211/dashboard/1878189):
  PostHog's generated content, unpinned. Its DAU/WAU/retention tiles measure
  cross-visit identity and are misleading here — see the constraints above.

Each dashboard leads with a text tile restating the caveats, so a number is
never read out of context.

## Known gaps

**No reverse proxy.** `api_host` points straight at `us.i.posthog.com`, so any
visitor running an ad-blocker, uBlock Origin, Brave shields or Firefox strict
mode has their events dropped before they leave the browser. This is invisible
from inside PostHog — blocked events never arrive, so there is no metric that
shows the loss, and no amount of client-side config detects it. It is plausibly
a larger distortion than either identity bug above, and it biases towards
under-counting exactly the technical audience most likely to use a CAD tool.

The fix is proxying `/ingest/*` through our own origin, which PostHog still
lists as an incomplete setup task for the project. It is deferred because
`wrangler.toml` is deliberately an assets-only Worker with no server code
(see its header comment); proxying means adding a fetch handler and moving the
deploy off that model, which is a separate change with its own risk.

## Env vars

See `apps/web/.env.example`. `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` are read via
`import.meta.env` at build time, same pattern as `VITE_SITE_URL`
(`apps/web/src/seo/site.ts`). Local dev key goes in `apps/web/.env.local`
(gitignored); the production build sets it as a Cloudflare Workers dashboard
build variable.
