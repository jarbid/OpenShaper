# Analytics — two-tier PostHog tracking, gated by consent

## The two tiers

**Tier 1 — anonymous baseline (everyone, always, no consent needed):**

- `persistence: 'memory'` — no localStorage, no cookie, no cross-session
  identity. Each page load is independent; there's nothing to consent to.
- `autocapture: false`, `disable_session_recording: true`,
  `disable_surveys: true` — only the explicit `track(...)` calls and the UX
  signals below ever send anything.
- Hand-instrumented product actions, chosen as a proxy for "serious usage"
  beyond casual browsing — see the [event catalogue](#event-catalogue) for the
  full list and the rules governing it. Plus PostHog's own automatic pageview
  capture.
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

The upgrade happens **in place**, with no reload and no identity
discontinuity: `posthog.set_config({ persistence: 'localStorage+cookie' })`
re-persists the same in-memory `distinct_id`/`device_id` into the new storage
backend, so a visitor's anonymous activity and post-consent activity share
one id.

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

`anonymize_ips` and `surveys_opt_in` match the client config (`disable_surveys`).
No error-tracking rate limits are configured.

One thing this does **not** establish: `$exception` has recorded zero events
since launch despite both ends being enabled. At current traffic that is
plausible rather than alarming, but it has not been confirmed by a deliberate
test throw — so treat a flat zero as unverified, not as good news. The
"Any JS exception" alert on the Health & UX dashboard exists to settle this the
first time one fires.

## What the data can and cannot say

Two constraints fall out of the design above and shape every dashboard:

- **`persistence: 'memory'` means one page load is one "person."** Confirmed in
  the data: over the first 30 days `$pageview` was 70 events across 70 people.
  Unique-user counts, DAU/WAU and cross-visit retention are therefore
  unmeasurable for baseline traffic — not merely noisy. Anything claiming
  otherwise is either scoped to `tracking_tier: 'full'` or wrong.
- **What _is_ measurable is within-session depth.** `/app` is an SPA, so one
  page load is one entire editing session and the anonymous id survives it.
  Funnels and `session_summary` are honest for that reason.

The one exception to the first constraint is `recent_board_opened`: the recent
list lives in `localStorage` (`bs.recent`), so reopening from it proves a repeat
visit with no persistent analytics identity involved. It is the only
return-visitor signal the baseline has.

`/app` vs `/app/` was split across two paths before the `drop-trailing-slash`
fix. A project-level path-cleaning rule (`^/app/$` → `/app`) collapses the
historical rows at query time, which the code fix cannot do retroactively.

## Internal traffic

PostHog's usual "internal users" cohort cannot work here — with no stable person
id there is nothing for it to match on, and the cohort sat at 0 members
permanently. Own-dev traffic is instead marked at the source:
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

## Env vars

See `apps/web/.env.example`. `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` are read via
`import.meta.env` at build time, same pattern as `VITE_SITE_URL`
(`apps/web/src/seo/site.ts`). Local dev key goes in `apps/web/.env.local`
(gitignored); the production build sets it as a Cloudflare Workers dashboard
build variable.
