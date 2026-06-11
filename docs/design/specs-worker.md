# Specs worker — moving `selectSpecs` off the main thread

Status: **steps 1–4 done** — all main-thread integration work is now off the
main thread. AppShell computes specs and the volume-distribution overlay via
`useSpecsWorker(settledBoard, { wantDistribution, distributionIntervals })`,
with a synchronous fallback where `Worker` is unavailable (jsdom tests, SSG
prerender). The weight estimate reads `specs.area` from the worker result instead
of calling `getArea` redundantly on the main thread. Code:
`apps/web/src/workers/specs-protocol.ts`,
`apps/web/src/workers/specs-worker.ts`, `apps/web/src/use-specs-worker.ts`.

## Problem

Volume, planshape area, and center of mass are numerical integrals
(`selectSpecs` in `packages/store/src/selectors.ts`). Today App.tsx computes
them synchronously from the _settled_ board (`useSettledBoard`), so the cost is
paid on edit commit rather than per pointer-move — but it still lands on the
main thread and can stretch a paint frame on complex boards (more so if anyone
raises the now-parameterizable integration splits). CLAUDE.md principle 4 says
heavy compute belongs in a Web Worker.

## Boundary design

### Message types (`specs-protocol.ts`)

- `SpecsRequest { id, board }` — main → worker.
- `SpecsResponse { id, ok: true, specs } | { id, ok: false, error }` — worker → main.

### Transfer

`BezierBoard` is immutable plain data (splines = arrays of knots of `Vec2`s),
so it crosses by **structured clone** — no transferables, no serialization
code. A board is a few KB; clone cost is microseconds, negligible next to the
integrals. `BoardSpecs` is a flat record of numbers, equally cheap coming back.

### Cancellation = supersession

True mid-integral abort isn't worth the complexity (a full `selectSpecs` is tens
of ms). Instead the main thread keeps a monotonically increasing request `id`:

- every new settled board bumps the id and posts a request;
- the worker answers every request in arrival order;
- the hook drops any response whose `id !== idRef.current`.

A flood of commits therefore costs at most one wasted compute per queued
request, and the UI only ever applies the newest result. If profiling ever
shows queue buildup, the worker can skip to the latest pending message
(coalesce in `onmessage` with a microtask), without protocol changes.

### Memoization

`selectSpecs`'s `WeakMap` cache moves with it into the worker and keys on the
cloned board instance per request, so it stops being effective across requests
(each clone is a fresh object). That's fine: the main thread only posts when
the settled board _reference_ changes, which is exactly when the cache would
miss anyway. The App-side `useSpecsWorker` state is the cross-render cache.

## Wiring plan (follow-up PR)

1. In `AppShell`, replace `const specs = settledBoard ? selectSpecs(settledBoard) : null`
   with `const specs = useSpecsWorker(settledBoard)`.
2. Keep a sync fallback (`typeof Worker === 'undefined'`) for jsdom tests and
   the vite-react-ssg prerender pass.
3. Async consequence: `specs` is `null` for one tick after load and _stale_
   (previous board) for a few ms after a commit. Consumers already handle
   `specs === null`; staleness is invisible at these latencies but the resize
   form should read the response's board, not the live one, if exactness matters.
4. **Done.** Volume-distribution overlay samples (41 × `getCrossSectionAreaAt`)
   and `getArea` for the weight estimate moved behind the same worker boundary.
   `SpecsRequest` now carries `wantDistribution?: boolean` and
   `distributionIntervals?: number`; the response carries `distribution?`.
   The weight estimate reads `specs.area` from the worker result.
5. Ghost-board specs (`ghostSpecs`) can reuse the same worker; they're computed
   once per ghost load, so they can simply queue behind board requests.

Vite bundles `new Worker(new URL(..., import.meta.url), { type: 'module' })`
natively, including under vite-react-ssg, so no config changes are needed.
