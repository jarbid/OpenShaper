# Analytics — two-tier PostHog tracking, gated by consent

## The two tiers

**Tier 1 — anonymous baseline (everyone, always, no consent needed):**

- `cookieless_mode: 'on_reject'` — no localStorage, no cookie, nothing written
  to the browser at all. Identity is a privacy-preserving hash computed on
  PostHog's servers from `(team_id, daily_salt, ip, user_agent, hostname)`;
  the salt is regenerated daily, so the hash is not reversible and does not
  carry across days. See [what the data can and cannot say](#what-the-data-can-and-cannot-say)
  for what that buys and what it still can't measure.
- `autocapture: false`, `disable_session_recording: true` — only the explicit
  `track(...)` calls and the UX signals below ever send anything. Surveys are
  not disabled in config but never load here either; posthog-js gates them on
  consent itself (see [surveys](#surveys)).
- Hand-instrumented product actions, chosen as a proxy for "serious usage"
  beyond casual browsing — see the [event catalogue](#event-catalogue) for the
  full list and the rules governing it. Plus PostHog's own automatic pageview
  capture, which since 2026-08-11 includes SPA route changes — see
  [pageviews](#pageviews-include-spa-route-changes-fixed-2026-08-11).
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
- **Surveys** — in-app questions, the only way this app can ask a visitor
  anything (see [surveys](#surveys)).
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
  signal forces PostHog's own consent state to denied, overriding _even_ the
  anonymous baseline. This is a stronger, standing signal than our own
  accepted/rejected state.
- **`initAnalytics()` calls `posthog.opt_out_capturing()` for anyone who
  hasn't accepted, and this is load-bearing.** Under
  `cookieless_mode: 'on_reject'`, posthog-js treats an _undecided_ visitor as
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

## Surveys

In-app questions — "what are you building?", "what's missing?" — shown to
consenting visitors only. Enabled 2026-08-15.

**Why they earn their place despite that reach.** OpenShaper has no accounts and
no in-app feedback endpoint: nothing receives a message from inside the editor,
and the only listed contact is an email address a visitor has to go find. A
PostHog survey is therefore the only channel that can ask a visitor a question
at the moment they are actually using the thing.

**We write no consent logic for them.** posthog-js gates surveys itself:

```
else if (config.cookieless_mode && consent.isOptedOut())
  → "Not loading surveys in cookieless mode without consent."
```

Every Tier 1 visitor is opted out (that is what `cookieless_mode: 'on_reject'`
means here), so the survey script never loads for them. `disable_surveys` is
therefore absent from the config rather than set to `false` — adding our own
check would duplicate a gate the SDK already enforces, with two places to get
it wrong. The same guard covers `conversations`.

**This is why `cookieless_mode: 'always'` stays rejected.** It would take
surveys down with session replay, since both hang off the same consent gate —
two features, not one. That trade was reconsidered on 2026-08-15 and the
two-tier design kept for exactly this reason.

**Reach is small and should be planned around.** Surveys reach only the ~28% of
visitors who accept (45 accepted / 160 shown / 14 rejected over the fortnight
to 2026-08-15) — on current traffic, roughly 4–5 people a day. Enough for a
slow-burn open question; not enough to A/B the wording or read anything as
statistically significant. The lever, if more is needed, is the banner's accept
rate rather than the survey itself.

**Storage.** Survey state (`seenSurvey_<id>`, `lastSeenSurveyDate`) is written
straight to `localStorage`, bypassing posthog-js's persistence backend. That
does not breach the no-storage-before-consent rule only because surveys cannot
load pre-consent at all — the gate above is what keeps it honest. Anything that
would load a survey earlier breaks that guarantee.

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

| Setting                         | Value   |
| ------------------------------- | ------- |
| `autocapture_opt_out`           | `false` |
| `session_recording_opt_in`      | `true`  |
| `heatmaps_opt_in`               | `true`  |
| `autocapture_exceptions_opt_in` | `true`  |
| `autocapture_web_vitals_opt_in` | `true`  |
| `capture_dead_clicks`           | `true`  |
| `anonymize_ips`                 | `true`  |
| `surveys_opt_in`                | `true`  |
| `cookieless_server_hash_mode`   | `1`     |

`surveys_opt_in` was `false` until 2026-08-15; see [surveys](#surveys) for why
it was turned on and what gates them. No error-tracking rate limits are
configured.

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
  person. Same-day visitor counts are therefore a slight _under_-count, in a
  direction that varies with audience. Treat them as a good floor, not a
  headcount.
- **Within-session depth is the strongest signal.** `/app` is an SPA, so one
  page load is one entire editing session. Funnels and `session_summary` are
  honest for that reason and were unaffected by the identity change.
- **PostHog's own Web Analytics scene is currently unusable here.** Since
  2026-08-11 cookieless sessions never reach PostHog's `sessions` table, so
  every session-derived metric counts consenting visitors only — see
  [sessions do not materialise](#cookieless-sessions-do-not-materialise-2026-08-11).
  Read visitor numbers from `events`, not from Web Analytics.

`recent_board_opened` remains the one return-visitor signal that survives the
daily reset: the recent list lives in `localStorage` (`bs.recent`), so
reopening from it proves a repeat visit with no persistent analytics identity
involved.

### Cookieless sessions do not materialise (2026-08-11)

**This is a PostHog-side bug, not ours, and it is not fixed.** Reported to the
PostHog team on 2026-08-13.

From 2026-08-11, baseline (cookieless) sessions are recorded with a `$session_id`
that never lands in PostHog's `sessions` table. Full-tracking sessions — the ones
with a real client-side id, from visitors who accepted consent — still do.

Measured on 2026-08-13, sessions present in `events` vs in the `sessions` table:

| Day   | In `events` | In `sessions` |
| ----- | ----------- | ------------- |
| 08-13 | 12          | 3             |
| 08-12 | 20          | 9             |
| 08-11 | 21          | 16            |
| 08-10 | 20          | 20            |
| 08-09 | 16          | 16            |
| 08-06 | 60          | 60            |

Through 08-10 every session materialised. From 08-11 the count in `sessions`
matches the number of sessions carrying a string-UUID id exactly, and **not one**
session in the newer form has ever materialised. The split tracks consent tier:
on 08-13 all 7 baseline sessions used the new form and none materialised, while
3 of 5 full-tracking sessions used the string form and all 3 did.

What it costs:

- **Everything session-derived measures the consenting minority only** — the Web
  Analytics scene, bounce rate, session duration, entry/exit pages, channels and
  paths. On 08-13 `query-web-overview` reported 2 visitors against 11 real people
  in `events`.
- **Raw event counts are unaffected.** Pageviews, `uniq(person_id)` and every
  hand-instrumented event in the catalogue below are trustworthy, because they
  read `events` directly and never touch the `sessions` table.

Two things that make this hard to spot, worth remembering if it recurs:

- **It looks exactly like a traffic collapse**, and it worsens daily as more
  visitors roll onto the new form — so it reads as a trend rather than a bug.
- **The two surfaces disagree with no indication which is right.** Nothing in the
  UI warns that a class of sessions is missing. The diagnostic is to compare the
  two directly:

  ```sql
  SELECT uniq($session_id) FROM events WHERE timestamp >= toStartOfDay(now())
  SELECT count() FROM sessions WHERE $start_timestamp >= toStartOfDay(now())
  ```

  They agreed until 08-10 and have diverged since. When they agree again, this
  is fixed.

Note the dashboards in the section below predate this and do not carry the
caveat; treat any session-based tile on them as unreliable until the two queries
above reconcile.

### The bug this replaced (fixed 2026-08-06)

The baseline previously ran `persistence: 'memory'`, which stored _nothing_ —
and with `cookieless_server_hash_mode` disabled at the project level there was
no server-side fallback either. Every page load therefore minted a fresh
`distinct_id`, `device_id` **and** `session_id`. Measured across 90 days before
the fix: 4,910 events collapsed into 308 persons and 371 sessions against 303
pageviews — i.e. persons ≈ sessions ≈ pageviews, to within rounding.

Two things are worth remembering from it:

- The original write-up documented the effect on _persons_ but not on
  _sessions_. `session_id` lives in the same persistence backend, so memory
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

| Event                   | Properties                                                                                          | Why                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `template_loaded`       | `template`                                                                                          | Which starter board people begin from                                      |
| `save_board`            | `format` (`board` \| `brd`)                                                                         | Native vs legacy round-tripping                                            |
| `export_board`          | `format` (`stl` \| `step` \| `dxf` \| `dxf-spline` \| `pdf-1to1-custom` \| `rail-bands`)             | The "got real value" action                                                |
| `recent_board_opened`   | `position`                                                                                          | The only return-visitor proof on the baseline                              |
| `board_imported`        | `source`, `warning_count`, `dropped_count`                                                          | The BoardCAD on-ramp, previously unmeasured                                |
| `import_failed`         | `source`, `reason`                                                                                  | Worst outcome in the app; used to fail silently                            |
| `units_changed`         | `units`                                                                                             | Imperial vs metric vs fractions — who the audience actually is             |
| `overlay_toggled`       | `overlay`, `enabled`                                                                                | Whether the comb / CoM / distribution overlays earn their upkeep           |
| `hws_template_opened`   | —                                                                                                   | Templating is the roadmap phase in progress                                |
| `hws_template_exported` | `format`, `nested`, `parts`                                                                         | …and this is it actually being used; the gap between the two is the signal |
| `rail_bands_opened`     | —                                                                                                   | The dialog asks for a marking mode before it gives anything — see below     |
| `rail_bands_exported`   | `angle_mode`, `manual_by`, `bands`, `stations`, `paper`, `detail_pages`, `varied_along_board`, `cuts_inside`, `warnings` | …and this is a shaper who got through it                                   |
| `spec_sheet_opened`     | —                                                                                                   | Cheapest thing in the Export menu; the floor the others are read against    |
| `trace_image_loaded`    | `target`                                                                                            | Distinctive feature, zero prior visibility                                 |
| `consent_banner`        | `action` (`shown` \| `accepted` \| `rejected`)                                                      | Distinguishes bad copy from a banner nobody sees                           |
| `pwa_installed`         | —                                                                                                   | The install conversion; fires online, so unlike offline usage it sends     |
| `session_summary`       | `edits`, `views_used`, `view_count`, `exported`, `saved`, `imported`, `template_used`, `duration_s` | Session depth without a per-action stream                                  |

### Rail bands, and the two questions it was built to answer

`rail_bands_exported` (`ExportRailBandsDialog.tsx`) carries more than the other
export events because two of its properties are not dashboard filler — they are
the open questions the feature shipped with.

- **`angle_mode`** (`ladder` | `least-foam` | `manual`). The mode set was cut from
  four to three and `manual` was added in its place, on the argument that a shaper
  who wants a particular rail will mark it themselves rather than accept a fit.
  That argument is a guess until this splits.
- **`cuts_inside`**. Manual marks are deliberately *not* corrected when they cut
  into the finished section — the depth is measured and flagged instead, on the
  reasoning that silently moving a shaper's line is worse than telling them about
  it. If this is always zero the checker is dead weight; if it is common, the
  dialog should be doing more than counting.

The rest are ordinary: `bands` and `stations` size the sheet, `paper` and
`detail_pages` say how it is printed, and `varied_along_board` records only
*whether* the tail/nose disclosure was used, never what was put in it.

It fires from the dialog rather than from `App.tsx` because the plan — and so the
warning counts — is already computed there; `ConstructionPanel` reports the HWS
export the same way. `export_board` still fires alongside it, so rail bands stay
in the one export funnel with every other format.

### Keeping this table honest

`analytics.coverage.test.ts` reads every `track()` call in `apps/web/src` and every
row of the table above, and fails the build if they disagree in either direction.
It was written because the table had already drifted: `export_board` was missing
the `rail-bands` format it had been sending for a release, and `spec_sheet_opened`
sat here with an empty reason. Same limit as the `/docs` coverage test — it proves
a row exists, never that the properties beside it are complete.

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

Known gap: `board_imported` reports warning _counts_ only. `ImportWarning`
(`packages/io/src/import-warning.ts`) carries a free-text `message` with line
numbers interpolated into it, which would make a useless high-cardinality
breakdown. Giving that type a stable `code` is the follow-up that would make
warning _kinds_ analysable.

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

## Reverse proxy (added 2026-08-11)

`api_host` pointed straight at `us.i.posthog.com`, so any visitor running
uBlock Origin, Brave shields or Firefox strict mode had their events dropped
before they left the browser. That loss is invisible from inside PostHog —
blocked events never arrive, so no metric shows it and no client-side config
detects it — and it biases towards under-counting exactly the technical
audience most likely to use a CAD tool.

Events now go to `/edge` on our own origin, which `worker/index.ts` forwards to
PostHog. Same-origin requests are not on those blocklists.

**How it fits the deploy.** `wrangler.toml` was deliberately an assets-only
Worker with no server code. It now has a `main`, but the Worker does only two
things: proxy the `/edge` prefix, and hand every other request to the `ASSETS`
binding. Static serving — `html_handling`, `_headers`, 404s for unknown paths —
is unchanged because it is still the assets runtime doing it.

Three details that are load-bearing:

- **The client IP must be forwarded.** A Worker's outbound `fetch` presents
  Cloudflare's egress IP, and the cookieless person hash takes the client IP as
  an input. Without `X-Forwarded-For` set from `CF-Connecting-IP`, every
  visitor would hash to the _same_ person and unique visitors would collapse to
  1 — trading one silent identity bug for a worse one. Pinned by
  `worker/index.test.ts`.
- **`/static/` goes to a different upstream host.** posthog-js fetches its
  optional bundles from `${api_host}/static/...`, but those live on
  `us-assets.i.posthog.com`, not the ingestion host. Sending them to the API
  host 404s and silently breaks session replay.
- **`ui_host` must be set.** With a proxied `api_host`, posthog-js otherwise
  builds toolbar and settings links against our own domain, which serves no
  such pages.

The prefix is `/edge` rather than `/ingest`, `/analytics` or `/posthog`
precisely because those names appear in blocklists themselves. The proxy
changes where events are sent, not what is collected — `/privacy` describes the
same data either way.

The service worker needs no changes: it only intercepts
`request.mode === 'navigate'` (`apps/web/src/sw.ts`), and analytics calls are
`fetch`/XHR.

**Still unverified:** whether this measurably recovers traffic. The gain is by
construction invisible in the before/after — the events it recovers were never
recorded to compare against. A step up in pageviews after the proxy goes live is
recovered ad-blocked traffic, not growth.

### The proxy that wasn't (2026-08-11 to 2026-08-14)

The Worker shipped on 2026-08-11 and worked from day one. The client never used
it. `VITE_POSTHOG_HOST` was set in the Cloudflare build variables to
`https://us.i.posthog.com` — the direct host — which is byte-for-byte equivalent
to leaving it unset, because that same host is the code-level fallback. The
deployed bundle initialised with `api_host:"https://us.i.posthog.com"` and the
string `/edge` appeared in it zero times.

So for three days the project had a working reverse proxy that nothing pointed
at, and ad-blocked visitors kept being dropped exactly as before.

Why it went unnoticed, and what to do about it:

- **Every surface said success.** The Worker answered (`/edge/e/`, `/edge/decide/`
  and `/edge/static/recorder.js` all returned 200), the dashboard showed the
  variable set, events kept flowing, and no metric moved. Nothing anywhere
  reported the proxy as unused.
- **The only reliable check is the built artifact**, not the dashboard and not
  the Worker:

  ```sh
  curl -s https://openshaper.com/ | grep -oE '/assets/app-[A-Za-z0-9_-]+\.js'
  curl -s https://openshaper.com/assets/app-<hash>.js | grep -c -- '/edge'   # must be >= 1
  ```

  An unchanged bundle hash after a config change means the build did not pick it
  up — which is equally consistent with "no rebuild ran" and "the variable was
  set as a runtime rather than build variable". Check the Deployments timestamp
  to tell those apart.

- **`apps/web/.env.example` was the proximate cause.** It carried the proxy URL
  in a comment and assigned the direct host, so copying it into the hosting
  dashboard produced precisely this. It now assigns the production value, with
  the direct host demoted to a comment for local dev and forks.
- **After the proxy does go live, confirm visitors did not collapse to 1.** The
  Worker must forward `X-Forwarded-For` from `CF-Connecting-IP`, because the
  cookieless person hash takes client IP as an input;
  `worker/index.test.ts` pins the behaviour but cannot prove it survives
  Cloudflare's real edge:

  ```sql
  SELECT uniq(person_id) FROM events WHERE timestamp >= now() - INTERVAL 1 DAY
  ```

## Env vars

See `apps/web/.env.example`. `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` are read via
`import.meta.env` at build time, same pattern as `VITE_SITE_URL`
(`apps/web/src/seo/site.ts`). Local dev key goes in `apps/web/.env.local`
(gitignored); the production build sets it as a Cloudflare Workers dashboard
build variable.

**`VITE_POSTHOG_HOST` must be set to `https://openshaper.com/edge` in the
Cloudflare build variables** for the reverse proxy above to be used.

It **is** defaulted in code — `analytics.ts` reads
`import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'` — so that
local dev, forks and any deploy without the Worker keep working. Three
consequences, all learned the hard way (see
[the proxy that wasn't](#the-proxy-that-wasnt-2026-08-11-to-2026-08-14)):

- **Unset and "set to the direct host" are the same thing.** Both produce a
  bundle that talks straight to PostHog. A dashboard showing
  `VITE_POSTHOG_HOST=https://us.i.posthog.com` looks configured and is not.
- **The variable is read at build time, not runtime.** Vite inlines it into the
  bundle, so it must be a Cloudflare **build** variable. Set as a runtime
  variable/binding (or in `wrangler.toml`'s `[vars]`) the Worker sees it and the
  browser never does — and the bundle is byte-identical to the broken one.
- **Editing it changes nothing until a new build runs.** Rolling back to, or
  republishing, an existing deployment reuses the stored artifact.

Verify after deploy with the checklist in the proxy section — never by reading
the dashboard, which cannot distinguish any of the three failures above.
